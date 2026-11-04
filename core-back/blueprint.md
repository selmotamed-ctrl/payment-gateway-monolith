<!-- GENERATED FILE. Edit project-design/parts/** instead. Do not hand-edit this file. -->

# core-back blueprint

Generated from: `core.foundations`, `core.api`, `core.engine`, `core.ledger`, `core.governance`, `core.workers`, `core.storage`, `core.data`, `core.search`, `core.backup`, `core.seeder`, `core.tests`.

## Core Foundations

> Status: `partial` · Last verified: 2026-11-04

## 1. Purpose and scope

This part describes the process boundary and the foundation layer of `core-back`: the Express application, the global middleware order, raw-body handling, the error envelope, the Prisma client and storage-engine ownership, the schema-version check, the TLS listener and the channel routers.

It is the entry point for reading the rest of `01-core-back/**`. It does not document every route (`01-api-surface.md`) or the rail engine internals (`02-engine.md`), but it defines the request lifecycle those parts assume.

## 2. Design intent (extracted and synthesized from ./design)

The historical design makes `core-back` the only trusted service:

- It owns the database (`prisma/`), the database credentials, the KMS master key, the ledger and the outbound gateway engine.
- It listens only on the private LAN with mTLS 1.3 and client-certificate verification.
- It serves three internal namespaces, each bound to one edge certificate common name.
- It re-validates every request: the bearer token, the user/merchant state, the authority, the payload schema, the link/attempt state and the money invariants.
- It keeps the raw bytes for webhook/upload routes so signatures and document sniffing work.
- It returns a stable error envelope with a request reference.
- It owns a storage engine with explicit ports rather than ad-hoc database access.

The design also expects a startup schema gate and a health/readiness contract. The actual code implements most of the boundary and middleware, but the schema gate is seed-time only and health is queue-only (see `00-platform/04-observability.md`).

## 3. As-built architecture

### 3.1 Process boundary

`core-back/index.ts` is the entry point. When run as the main module, or when `NODE_ENV !== "test"`, it calls `start()`. Tests usually import `createApp()` and `createHttpsServer()` instead of running the full process.

`start()`:

1. Asserts that the durable background-job queue is drainable.
2. Optionally configures Redis invalidation.
3. Creates the HTTPS server (which creates the Express app and reads the TLS material).
4. Creates the storage-engine singleton.
5. Wires the platform runtime and access-log sink to the storage engine.
6. Starts the production worker runtime when workers are enabled.
7. Listens on `HOST:PORT`.
8. Installs `SIGTERM`/`SIGINT` handlers.

The process is a single Bun process that owns the API and the workers. There is no separate worker process in the current tree; horizontal scaling runs multiple complete core processes and relies on database claim semantics.

### 3.2 Express application

`createApp(options)` builds one Express 5 app:

```ts
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", env.TRUST_PROXY);
app.use(requestIdMiddleware);
app.use(requestLoggerMiddleware);
app.use(rawBodyMiddleware);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.get("/health", ...);
app.use("/internal", internalRouter);
app.use("/api", apiRouter);
app.use(errorHandler);
```

`CreateAppOptions` allows tests to inject a `db` for the queue health probe and a `now` clock. Production uses the `client` proxy.

The app does not mount Helmet, a CORS middleware, compression, a body-size guard beyond the parsers, a CSRF guard or a request timeout middleware. Those concerns are either not needed for the internal mTLS service or handled at the edge/reverse proxy.

### 3.3 Route mounting

`core-back/api/index.ts` builds:

```ts
const router = express.Router();
router.use("/public", publicRouter);
export const internalRouter = express.Router();
internalRouter.use("/admin", requireEdgeIdentity("admin-back"), adminInternalRouter);
internalRouter.use("/merchant", requireEdgeIdentity("merchant-back"), merchantInternalRouter);
internalRouter.use("/checkout", requireEdgeIdentity("checkout-back"), checkoutInternalRouter);
export const apiRouter = router;
```

`publicRouter` is an Express router with a 15-request/hour limiter and no route. It is mounted at `/api/public`; a request to any `/api/public/*` path reaches the terminal 404 handler after the limiter.

`api/internal/index.ts` only re-exports the three channel routers; the live mounting, and therefore the certificate binding, is in `api/index.ts`.

### 3.4 Authentication and authority middleware

The internal routers apply authentication themselves:

- Admin: `router.use(requireAuthentication)` after the channel health route; `requireAuthorities` on business handlers where declared (some authenticated dashboard/options routes have no specific authority).
- Merchant: `router.use(requireAuthentication)` after the merchant health and public auth routes; onboarding and business routes require a bearer.
- Checkout: no bearer authentication; link key/attempt token is the payer capability.

`authDoubleCheck.ts` also exports `principalOf`, `requireAuthorities`, `requireMerchantScope`, `fingerprint`, `parseAuthorities`, `ipAllowed` and the principal types. The admin and merchant routers use different subsets; see `00-platform/02-security-and-mtls.md` and `01-api-surface.md`.

### 3.5 Raw body handling

`rawBodyMiddleware` must run before `express.json` because the JSON parser would consume and destroy the exact bytes used for signatures and document sniffing.

It matches:

- `RAW_BODY_PATHS`: `/internal/checkout/inbound`, `/internal/merchant/onboarding/kyb-documents`, `/internal/admin/reconciliation/upload`.
- `RAW_BODY_PATTERNS`: `/internal/admin/join-requests/:id/kyb-documents`.

The collector is `express.raw({ type: () => true, limit: "25mb" })`. Matching is exact or prefix-based for the paths and regex-based for the join-request document route. Every other path continues to the JSON/urlencoded parsers.

The checkout webhook handler reads `Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)`, so a mis-mounted parser would silently produce an empty body rather than a crash. The upload handlers enforce a declared MIME and magic-byte check in the route layer.

### 3.6 Error envelope

`core-back/lib/error/index.ts` defines `ApiError` and `toErrorEnvelope`:

```ts
{
  code: string,
  message: string,
  reference?: string,
  details?: unknown
}
```

- An `ApiError` keeps its status, code, message, details and optional reference.
- A non-`ApiError` becomes `{ code: "SERVER_ERROR", message: "Internal server error", ...(reference ? { reference } : {}) }`.
- A `SyntaxError` from a body parser gets HTTP 400, but the envelope is still the generic `SERVER_ERROR` because `toErrorEnvelope` only special-cases `ApiError`.
- The error handler logs only non-`ApiError` messages, prefixed with `[requestId]`.
- If response headers are already sent, the handler returns without writing.

`parseOrThrow(schema, data)` throws `ApiError(400, "INVALID_BODY", "Invalid request data", issues)` with `path`, `code` and `message` per Zod issue.

### 3.7 Request IDs and logging

`requestIdMiddleware` validates an incoming `x-request-id` against `^[A-Za-z0-9._:-]{1,128}$`; an invalid or absent value becomes a UUID. The value is stored on `request.requestId` and returned as the `x-request-id` response header.

`requestLoggerMiddleware` is mounted immediately after the request-id middleware. It creates a console logger, records request-scoped messages, and on response finish writes an access record to the configured `LogSinkPort`. The console logger uses its own short id, which is not the request id; see `00-platform/04-observability.md`.

### 3.8 Database client ownership

`core-back/prisma/client/base.ts` creates Prisma clients with `@prisma/adapter-pg`:

```ts
new PrismaClient({
  adapter: new PrismaPg(buildPostgresPoolConfig(databaseUrl)),
  log: [],
});
```

`core-back/prisma/client/index.ts` wraps the base client in a Proxy so routes can import `client` without connecting at module load. `ensureSchemaVersion()` connects, reads `schema_versions` row `id = 1`, and requires version 8.

The storage engine creates its own primary client from `DATABASE_URL` (and replica clients from `DATABASE_REPLICA_URLS`). It is the owner of the `UnitOfWork`, `ReadStore`, cache, audit and log ports. The runtime `PlatformRuntime` uses the database client for metadata reads and the storage engine for transactional writes when a storage engine is present.

The schema version is checked by the seeders, not by `createApp` or `start`. A database with schema version 7 can boot the API; the first incompatible query fails. This is a material gap for rollout safety.

### 3.9 Storage engine ownership

`getStorageEngine()` lazily builds a singleton:

- `PostgresUnitOfWorkAdapter` with the primary client.
- `PostgresReplicaReadStore` with the replica set and the lag monitor.
- `RedisCacheAdapter` or `MemoryCacheAdapter`.
- `DedicatedAuditDatabaseDriver` when `AUDIT_DATABASE_URL` is set.
- `DedicatedPostgresLogSink` over `LOG_DATABASE_URL` when set.

`shutdownStorageEngine()` stops the LSN monitor, closes the log sink, closes the cache and disconnects the primary, replicas, audit pool and log pool. The engine is process-global; there is no per-request storage instance.

### 3.10 TLS server boundary

`createHttpsServer()` creates the Express app and a plain HTTP server, then a TLS server with the server key/cert/CA, `requestCert: true`, `rejectUnauthorized: true` and `minVersion: "TLSv1.3"`. It bridges `secureConnection` sockets into the HTTP server. A missing certificate file aborts startup with a clear error.

The channel guard is not the TLS handshake alone: `requireEdgeIdentity` inspects the peer certificate CN after the handshake and rejects the wrong channel with `403 FORBIDDEN_SERVICE_IDENTITY`.

### 3.11 Request lifecycle summary

```text
TCP + TLS 1.3 handshake (client cert required)
-> secureConnection -> http.Server -> Express app
-> requestIdMiddleware
-> requestLoggerMiddleware
-> rawBodyMiddleware (only opaque paths)
-> express.json / express.urlencoded
-> GET /health or /internal/:channel/* or /api/public/*
-> requireEdgeIdentity(channel CN)
-> channel router: auth (admin/merchant) -> Zod parse -> business handler -> DB/storage/engine
-> response -> access log on finish
-> terminal error handler on throw
```

## 4. Contracts and invariants

1. **Core is not a public HTTP service.** It must be reachable only over the private LAN with mTLS.
2. **The channel CN is the first authorization decision.** No internal business route runs before `requireEdgeIdentity`.
3. **Raw bytes precede JSON parsing** for webhook and upload paths.
4. **Every response carries a request id.** The request id is either the validated client value or a UUID.
5. **Business errors use the envelope.** A thrown `ApiError` maps to its status/code/message/details.
6. **Unexpected errors do not leak internals.** The response is `SERVER_ERROR` with `Internal server error` and a reference.
7. **The database client is lazy and process-global.** Module import does not connect.
8. **The storage engine is the transactional owner.** Routes should not open ad-hoc long transactions when a storage port exists.
9. **Schema version 9 is required.** The seeders enforce it; the API currently does not at boot.
10. **The TLS server requires a client certificate.** There is no optional-client-cert mode in production startup.

## 5. Data / API / config / deployment surface

### 5.1 Foundation code paths

| Concern | Code |
| :--- | :--- |
| App, health, TLS, startup | `core-back/index.ts` |
| Channel mounting | `core-back/api/index.ts`, `core-back/api/internal/index.ts` |
| Request id | `requestIdMiddleware` in `core-back/index.ts` |
| Request logger/access log | `core-back/lib/requestLogger/index.ts` |
| Raw body | `core-back/lib/rawBody/index.ts` |
| Errors | `core-back/lib/error/index.ts` |
| Auth primitives | `core-back/api/middleware/authDoubleCheck.ts` |
| CN guard | `core-back/api/middleware/mtlsGuard.ts` |
| Prisma client | `core-back/prisma/client/base.ts`, `index.ts` |
| Schema version | `core-back/prisma/schemaVersion.ts` |
| Storage engine | `core-back/lib/storageEngine/index.ts` |

### 5.2 Foundation env keys

- `PORT`, `HOST`, `NODE_ENV`, `TRUST_PROXY`.
- `MTLS_CA_CERT_PATH`, `MTLS_SERVER_CERT_PATH`, `MTLS_SERVER_KEY_PATH`.
- `DATABASE_URL`, `DATABASE_REPLICA_URLS`, `AUDIT_DATABASE_URL`, `LOG_DATABASE_URL`.
- `REDIS_URL`, `REDIS_NODES`.
- `WORKER_ENABLED`, `WORKER_BACKGROUND_JOBS_ENABLED` for the boot guard.
- `KMS_MASTER_KEY` for session derivation and vault.

### 5.3 Foundation routes

- `GET /health` (core queue health).
- `GET /internal/admin/health`, `GET /internal/merchant/health`, `GET /internal/checkout/health`.
- All business routes under the three internal routers.
- `/api/public` mount with no routes.

## 6. Operational usage

### 6.1 Boot order for a developer

1. Generate certs.
2. Set `DATABASE_URL`.
3. Apply migrations.
4. Seed (this also checks schema version 9).
5. `bun run start`.
6. Probe `/health` over mTLS with a client cert.

### 6.2 Test harness

Tests import `createApp({ db, now })` and use a fake queue database. `createHttpsServer()` is used where the TLS layer itself is under test. `test/setup.ts` sets a test `LOG_LEVEL` even though the logger does not consume it.

### 6.3 Add a foundation concern

- Request id: keep the regex; do not accept arbitrary header values.
- Raw body: add the path to `RAW_BODY_PATHS` or a pattern, and mount the middleware before JSON.
- Error shape: use `ApiError` and `parseOrThrow`; do not return ad-hoc error bodies.
- Auth: add the guard at the router or handler, and repeat business validation in core.
- Storage: add a port/adaptor rather than a raw pool in a route.

## 7. Status and deviations

### Implemented

- Express 5 app with a deterministic middleware order.
- Three channel routers with certificate CN binding.
- Raw-body preservation for webhook/KYB/reconciliation uploads.
- Stable error envelope and request id.
- Lazy Prisma client with `@prisma/adapter-pg`.
- Storage-engine singleton and shutdown.
- TLS 1.3 server with required client certificates.
- Queue-drainability boot guard.

### Partial

- **Schema version.** `ensureSchemaVersion` exists and is tested through seeders, but the API does not call it.
- **Error semantics.** A malformed JSON body returns 400 with `SERVER_ERROR`, which is less precise than a dedicated `INVALID_JSON` code.
- **Request logging.** Console and access logs do not share an id; access logs have no actor or query timing.
- **Public router.** `/api/public` has a limiter but no endpoints.
- **Process supervision.** Workers start before `listen`; a listen failure does not stop them.

### Missing / deferred

- A boot-time migration/version gate.
- A structured error taxonomy for parser failures.
- Graceful drain of in-flight requests on `SIGTERM` beyond closing the server; there is no request-drain counter.
- A readiness route separate from queue health.
- A per-request timeout middleware.

### Known bugs / risks

- **Code gap:** a stale schema can boot.
- **Code gap:** `SyntaxError` maps to HTTP 400 but `SERVER_ERROR`; clients cannot distinguish invalid JSON from an internal failure by code alone.
- **Code gap:** the public router is dead surface.
- **Risk:** `app.set("trust proxy", env.TRUST_PROXY)` defaults false, but access logging and API-token IP checks prefer forwarded headers; the private boundary is the compensating control.

## 8. Verification and tests

- `core-back/test/phase1-mtls-and-schema.test.ts` verifies the PKI and schema-version contract.
- `core-back/test/internal-routes.test.ts` verifies route mounting and internal channel health.
- `core-back/test/runtime/raw-body.test.ts` verifies raw-body selection and preservation.
- `core-back/test/runtime/production-adapters.test.ts` verifies the production composition.
- `core-back/test/db-connection-config.test.ts` verifies PostgreSQL-only URL and pool behavior.
- `core-back/test/exhaustive/05-api-matrix/mtls-channel-isolation.test.ts` verifies channel identity.
- `core-back/test/runtime/rotating-refresh-token.test.ts` covers a foundation-adjacent persistence path used by the consumer.

No build or test was run for this documentation change.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` §2.1 service roles, §2.2 mTLS transport, §15? request/response envelope context.
- `design/90-archive/delivery-logs/opencode_technical_delivery_design.md` §4.1 server/CN guard, §28 storage runtime.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` §2.1 ports and §2.2 unit of work.
- `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md` §15 stable error envelope.

### Code paths

- `core-back/index.ts`, `core-back/api/index.ts`, `core-back/api/internal/index.ts`.
- `core-back/lib/error/index.ts`, `lib/rawBody/index.ts`, `lib/requestLogger/index.ts`.
- `core-back/api/middleware/mtlsGuard.ts`, `authDoubleCheck.ts`.
- `core-back/prisma/client/base.ts`, `core-back/prisma/client/index.ts`, `core-back/prisma/schemaVersion.ts`.
- `core-back/lib/storageEngine/index.ts`.

### Generated appendices

- `project-design/appendices/code-surface-map.md`
- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`

## 10. Change history

- 2026-11-03: Initial canonical core foundations part written against `5a24f6f+working-tree`.

## Core API Surface

> Status: `partial` · Last verified: 2026-11-04

## 1. Purpose and scope

This part maps the actual HTTP surface of `core-back`: the internal namespaces and every route group they expose, the authentication and authority behavior, the shared list/export/summary contract, the maker-checker proposal and decision routes, and the concrete gaps between the design and the implementation.

The canonical inventory is generated in `project-design/appendices/api-route-matrix.md`. The matrix below is the narrative map, grouped by namespace and domain. Counts are from the source at verification time: 243 routes in `api/internal/admin.ts`, 5 backup routes mounted under the admin namespace, 62 in `api/internal/merchant.ts`, 12 in `api/internal/checkout.ts`, and no routes in `api/public/index.ts`.

## 2. Design intent (extracted and synthesized from ./design)

The historical design defines three machine surfaces and one optional public surface:

- **Admin internal API** at `/internal/admin/*`, called only by `admin-back` over mTLS. It is the operator back office: users, join requests, KYB, merchants, approvals, AML, gateways/rails/routes, credentials, reconciliation, disputes, adjustments, cash-outs, commissions, velocity, finance, settings, audit logs and backups.
- **Merchant internal API** at `/internal/merchant/*`, called only by `merchant-back`. It covers auth, authenticated onboarding, wallets, applications, links, payments, disputes, cash-outs, tokens, credential sets, users, POS and stats. The external API at `/api/v1/external/*` uses `pg_live_` bearer tokens with scopes and optional IP CIDRs.
- **Checkout internal API** at `/internal/checkout/*`, called only by `checkout-back`. It resolves a link, initiates an attempt, confirms/resends/cancels, handles browser hints and returns, and accepts raw inbound webhooks. It never accepts a client-supplied amount or currency.
- **Public API** at `/api/public/*` was reserved but is not part of the designed checkout/merchant/admin paths.

The design expects:

- A stable error envelope.
- Zod validation at the edge and again in core.
- Stable list contracts with server-side filters, sorting and pagination.
- Export and summary variants for the admin tables.
- Maker-checker for every sensitive decision, with maker != checker.
- Authority checks on every admin operation.
- Idempotency for money-moving client calls.
- Asynchronous webhook processing with a fast ack where possible.
- No hidden handlers: every proposal route should have an execution path.

## 3. As-built architecture

### 3.1 Namespace mounting and authentication

| Namespace | Core prefix | Edge caller | Transport identity | Bearer behavior |
| :--- | :--- | :--- | :--- | :--- |
| Admin | `/internal/admin` | `admin-back` | client cert CN `admin-back` | `requireAuthentication` after `/health`; per-route authorities |
| Merchant | `/internal/merchant` | `merchant-back` | client cert CN `merchant-back` | public auth routes before `requireAuthentication`; onboarding and business routes require a session or `pg_live_` token |
| Checkout | `/internal/checkout` | `checkout-back` | client cert CN `checkout-back` | no bearer; link key/attempt token capability |
| Public | `/api/public` | none | mTLS server still requires a client cert | no routes |
| Backups | `/internal/admin/system/backups` | `admin-back` | admin channel | admin auth plus `security:*` |

The edge maps its public paths to these prefixes:

- Admin edge `/api/v1/admin/*` -> `/internal/admin/*`.
- Merchant edge `/api/v1/merchant/*` -> `/internal/merchant/*`; `/api/v1/external/*` -> `/internal/merchant/external/*`.
- Checkout edge `/api/v1/pay/*` -> `/internal/checkout/pay/*`; `/api/v1/return/*` -> `/internal/checkout/return/*`; `/api/v1/inbound/*` -> `/internal/checkout/inbound/*`.

### 3.2 Admin namespace

The admin router is the largest surface. `/health`, `/auth/login`, `/auth/mfa` and `/auth/me` are registered before `router.use(requireAuthentication)`. Every route after that line requires a valid bearer credential. `GET /auth/me` is before the guard and returns static platform data.

The domain groups below list every route in `api/internal/admin.ts`. The authority column is the guard used by the group; where a group mixes read/write, the split is shown.

#### Auth, search, stats, options

| Routes | Authority |
| :--- | :--- |
| `POST /auth/login`, `POST /auth/mfa` | none (before auth) |
| `GET /auth/me` | none (before auth) |
| `POST /search` | authenticated; no explicit authority |
| `GET /stats/recent-activity`, `GET /stats/recent-activity/export` | `security:read` |
| `GET /stats/overview` | authenticated; no explicit authority |
| `POST /stats/export-audit` | authenticated; no explicit authority |
| `GET /options/:kind` | authenticated; no explicit authority |
| `GET /health` | mTLS channel only |

#### Users

| Routes | Authority |
| :--- | :--- |
| `GET /users`, `GET /users/export`, `GET /users/summary`, `GET /users/summary/export`, `GET /users/:id` | `user:read` or `security:read` |
| `POST /users`, `PATCH /users`, `PATCH /users/:id` | `user:write` or `security:write` |

`POST /users`, `PATCH /users` and `PATCH /users/:id` create `USER` approval requests in the pending path and return `202`; the approval handler executes the change.

#### Join requests and onboarding

| Routes | Authority |
| :--- | :--- |
| `GET /join-requests`, `GET /join-requests/export`, `GET /join-requests/summary`, `GET /join-requests/summary/export`, `GET /join-requests/:id` | `kyb:read` or `compliance:read` |
| `POST /join-requests/admin-assisted` | `kyb:write` or `compliance:write` |
| `PATCH /join-requests/:id/profile`, `POST /join-requests/:id/beneficial-owners`, `PATCH /join-requests/:id/beneficial-owners/:ownerId`, `DELETE /join-requests/:id/beneficial-owners/:ownerId`, `POST /join-requests/:id/kyb-documents`, `DELETE /join-requests/:id/kyb-documents/:docId`, `POST /join-requests/:id/submit`, `POST /join-requests/:id/withdraw`, `PATCH /join-requests/:id/checklist`, `POST /join-requests/:id/screening/retry`, `POST /join-requests/:id/assign`, `POST /join-requests/:id/request-info`, `POST /join-requests/:id/decide` | `kyb:write` or `compliance:write` |
| `GET /kyb-documents/:id/content` | `kyb:read` or `compliance:read` |

Some decision paths create `JOIN_REQUEST` approvals; the approve/reject route executes them.

#### KYB documents

| Routes | Authority |
| :--- | :--- |
| `GET /kyb-documents`, `GET /kyb-documents/export`, `GET /kyb-documents/summary`, `GET /kyb-documents/summary/export`, `GET /kyb-documents/:id` | `kyb:read` or `compliance:read` |
| `POST /kyb-documents/:id/review`, `POST /kyb-documents/:id/request-replacement`, `POST /kyb-documents/:id/request-revalidation` | `kyb:write` or `compliance:write` |

#### Merchants and applications

| Routes | Authority |
| :--- | :--- |
| `GET /merchants`, `GET /merchants/export`, `GET /merchants/summary`, `GET /merchants/summary/export`, `GET /merchants/:id/summary/export`, `GET /merchants/:id`, `GET /merchants/:id/transactions`, `GET /merchants/:id/applications`, `GET /merchants/:id/wallets`, `GET /merchants/:id/cashouts`, `GET /merchants/:id/disputes`, `GET /merchants/:id/adjustments`, `GET /merchants/:id/notifications`, `GET /merchants/:id/audit-events`, `GET /merchants/:id/stats`, `GET /merchants/:id/pending-changes`, `GET /merchants/:id/detail-changes` | `merchant:read` |
| `PATCH /merchants/:id/descriptive`, `POST /merchants/:id/propose-edit`, `POST /merchants/:id/suspend`, `POST /merchants/:id/reinstate`, `POST /merchants/:id/close`, `POST /merchants/:id/pending-changes/:approvalId/withdraw` | `merchant:write` |

Sensitive merchant changes create `MERCHANT` approvals. Suspension has an emergency path that can take effect immediately and be ratified later; reinstatement/close require approval. `APPLICATION` sensitive changes are created in the merchant router, not here.

#### Approvals

| Routes | Authority |
| :--- | :--- |
| `GET /approvals`, `GET /approvals/export`, `GET /approvals/summary`, `GET /approvals/summary/export`, `GET /approvals/:id` | `approval:read` |
| `POST /approvals/:id/approve`, `POST /approvals/:id/reject` | `approval:check` or `approval:write` + checker authority |

The approve/reject routes call `actorFromRequest`, `assertCheckerAuthority` and `assertCheckerIsNotMaker`. The approve route also handles `BACKUP_POLICY` out of band and dispatches every other subject to `executeApprovalSubject`.

#### AML and compliance

| Routes | Authority |
| :--- | :--- |
| `GET /aml/screenings`, `/export`, `/summary`, `/summary/export`, `GET /aml/screenings/:id` | confidential AML role or authority |
| `POST /aml/matches/:id/disposition` | confidential AML role or authority |
| `GET /aml/cases`, `/export`, `/summary`, `/summary/export`, `GET /aml/cases/:id` | confidential AML role or authority |
| `POST /aml/cases/:id/propose` | confidential AML role or authority; creates an `AML_CASE` approval |
| `GET /aml/rules`, `/export`, `/summary`, `/summary/export`, `GET /aml/rules/:id` | confidential AML role or authority |
| `POST /aml/rules` | confidential AML role or authority; creates an `AML_RULE` approval |
| `GET /aml/reporting-rules`, `POST /aml/reporting-rules` | confidential AML role or authority |
| `POST /aml/reporting-rules/:id/promote` | reporting authority; creates a `REPORTING_RULE` approval |
| `GET /aml/reports`, `/export`, `/summary`, `/summary/export`, `GET /aml/reports/:id` | confidential AML role or authority |
| `POST /aml/reports` | confidential AML role or authority; creates a `REGULATORY_REPORT` approval |
| `POST /aml/reports/:id/submit`, `POST /aml/reports/:id/acknowledge` | reporting authority (`MLRO`/`COMPLIANCE` role or `report:approve`/`report:review` authority) |

`assertConfidential` uses `hasConfidentialAmlAccess`; `assertReportingAuthority` additionally requires an MLRO/COMPLIANCE role or a reporting authority when a user is neither.

#### Operator cases, inquiries and attempts

| Routes | Authority |
| :--- | :--- |
| `GET /operator-cases`, `/export`, `/summary`, `/summary/export`, `GET /operator-cases/:id` | `case:read` or `operator:read` |
| `POST /operator-cases/bulk-inquire`, `POST /operator-cases/bulk-assign`, `POST /operator-cases/bulk-state`, `PATCH /operator-cases/:id`, `POST /operator-cases/:id/resolve` | `case:write` or `operator:write` |
| `GET /gateway-inquiries`, `GET /gateway-inquiries/summary`, `GET /gateway-inquiries/:id` | `case:read` or `operator:read` |
| `POST /gateway-inquiries/:id/cancel`, `/run-now`, `/retry` | `case:write` or `operator:write` |
| `GET /attempts/:id` | `attempt:read` |
| `POST /attempts/:id/inquire` | `attempt:inquire` |

`POST /operator-cases/:id/resolve` proposes an `OPERATOR_CASE` approval; execution is handled by the approval route.

#### Gateways, versions, credential sets

| Routes | Authority |
| :--- | :--- |
| `GET /gateways/ai-transcript` | `gateway:read` |
| `POST /gateways/spec-verify`, `POST /gateways/spec-import` | `gateway:write` |
| `GET /gateways`, `/export`, `/summary`, `/summary/export`, `GET /gateways/:id`, `GET /gateways/:id/versions`, `GET /gateway-versions/:vid` | `gateway:read` |
| `POST /gateways`, `PATCH /gateways/:id`, `POST /gateways/:id/versions`, `POST /gateway-versions/:vid/clone`, `POST /gateways/:id/rollback` | `gateway:write` |
| `GET /credential-sets`, `GET /credential-sets/:id` | `credential:read` or `gateway:read` |
| `POST /credential-sets`, `PUT /credential-sets/:id`, `POST /credential-sets/:id/verify`, `POST /credential-sets/:id/revoke` | `credential:write` or `gateway:write` |
| `PUT /gateway-versions/:vid/environments`, `/auth`, `/settings`, `/crypto-profiles`, `/flows`, `/channels`, `/status-rules`, `/error-maps` | `gateway:write` |
| `POST /gateway-versions/:vid/dry-run`, `/run-suite` | `gateway:test` |
| `POST /gateway-versions/:vid/submit-approval` | `gateway:write`; creates a `GATEWAY_VERSION` approval |
| `PUT /gateway-versions/:vid/rollback-version` | `gateway:write` |

The spec importer route runs the four verification layers, materializes a DRAFT version in one transaction and then runs a live credential check; a failed check marks the credential set `FAILING` but keeps the draft.

#### Rails, routes and assets

| Routes | Authority |
| :--- | :--- |
| `GET /rails`, `/export`, `/summary`, `/summary/export`, `GET /rails/:id` | `gateway:read` |
| `POST /rails`, `PATCH /rails/:id`, `PUT /rails/:id/fields` | `gateway:write` |
| `GET /routes`, `/export`, `/summary`, `/summary/export`, `GET /routes/:id` | `gateway:read` |
| `POST /routes`, `PATCH /routes/:id`, `POST /routes/:id/state` | `gateway:write` |
| `GET /assets`, `GET /assets/:id` | `gateway:read` |
| `POST /assets` | `gateway:write` |

#### Reconciliation

| Routes | Authority |
| :--- | :--- |
| `GET /reconciliation/sources` | `reconciliation:read` |
| `POST /reconciliation/sources`, `PATCH /reconciliation/sources/:id` | `reconciliation:write` |
| `GET /reconciliation/runs`, `GET /reconciliation/summary`, `GET /reconciliation/summary/export`, `GET /reconciliation/runs/:id`, `GET /reconciliation/runs/:id/export` | `reconciliation:read` |
| `POST /reconciliation/upload` | `reconciliation:write`; raw multipart/body, enqueues a `RECONCILIATION_RUN` |

#### Disputes, adjustments, cash-outs, commissions and velocity

| Routes | Authority |
| :--- | :--- |
| `GET /disputes`, `/export`, `/summary`, `/summary/export`, `GET /disputes/:id` | `dispute:read` |
| `POST /disputes/:id/evidence`, `POST /disputes` | `dispute:write` |
| `GET /adjustments`, `/export`, `/summary`, `/summary/export`, `GET /adjustments/:id` | `finance:read` |
| `POST /adjustments` | `finance:write`; creates an `ADJUSTMENT` approval and a `PENDING_REVIEW` adjustment |
| `GET /cashouts`, `/export`, `/summary`, `/summary/export`, `GET /cashouts/:id` | `cashout:read` |
| `POST /cashouts/:id/process` | `cashout:review` or `finance:write`; executes the cash-out state/money transition directly |
| `GET /commission-profiles`, `GET /commission-profiles/summary`, `GET /commission-profiles/:id/history` | `commission:read` or `finance:read` |
| `POST /commission-profiles` | `commission:write`; creates an active profile directly |
| `POST /commission-profiles/:id/expire` | `commission:write`; creates a `COMMISSION_PROFILE` approval |
| `GET /velocity-rules`, `GET /velocity-rules/:id/history`, `GET /velocity-rules/summary` | `velocity:read` or `compliance:read` |
| `POST /velocity-rules` | `velocity:write` or `compliance:write`; creates an active rule directly |
| `POST /velocity-rules/:id/deactivate` | `velocity:write` or `compliance:write`; creates a `VELOCITY_RULE` approval |

#### Finance, settings, academy and audit

| Routes | Authority |
| :--- | :--- |
| `GET /finance/profitability`, `/export`, `GET /finance/route-caps`, `GET /finance/liquidity`, `/export`, `GET /finance/invariant-check`, `/export` | `finance:read` |
| `GET /settings/checkout-support`, `/history`, `/summary`, `/summary/export` | `settings:read` |
| `PUT /settings/checkout-support` | `settings:write`; direct versioned write |
| `GET /academy/progress`, `PUT /academy/progress` | authenticated; current user only |
| `GET /academy/progress/overview`, `/summary`, `/export`, `/summary/export` | `user:read` |
| `GET /audit-logs`, `/export`, `/summary`, `/summary/export`, `GET /audit-logs/:id` | `security:read` |
| `GET /settings` | `settings:read` |
| `POST /settings/restore-preview` | `settings:read` |
| `POST /settings/restore-apply`, `PUT /settings` | `settings:write`; direct writes |
| `GET /settings/export`, `/summary`, `/summary/export` | `settings:read` |

#### Backups (`/system/backups`)

| Routes | Authority |
| :--- | :--- |
| `GET /overview` | `security:read` or `gateway:read` |
| `POST /trigger` | `security:write` |
| `POST /drill` | `security:write` |
| `PUT /policy` | `security:write`; creates or executes a `BACKUP_POLICY` approval |
| `GET /catalog` | `security:read` or `gateway:read` |

### 3.3 Merchant namespace

| Domain | Routes |
| :--- | :--- |
| Health | `GET /health` |
| Auth (public within channel) | `POST /auth/register`, `/auth/verify-identity`, `/auth/accept-invitation`, `/auth/login`, `/auth/google` (501), `/auth/mfa/verify`, `GET /auth/me` |
| Options | `GET /options/:kind` |
| Onboarding | `GET/PUT /onboarding/join-request`, `GET /onboarding/kyb-revalidations`, `POST /onboarding/kyb-documents`, `GET/POST /onboarding/beneficial-owners`, `DELETE /onboarding/beneficial-owners/:id`, `POST /onboarding/submit` |
| Wallets | `GET/POST /wallets`, `GET /wallets/:id`, `GET /wallets/:id/balance`, `GET /wallets/:id/statements`, `GET /wallets/:id/statements/:month/export` |
| Applications | `GET/POST /applications`, `GET/PATCH /applications/:id` |
| Links | `GET/POST /links`, `GET /links/:id`, `POST /links/:id/cancel`, `GET /links/:id/attempts` |
| Payments | `GET /payments` |
| Disputes | `GET /disputes`, `GET /disputes/:id`, `POST /disputes/:id/evidence` |
| Cash-outs | `GET/POST /cashouts` |
| Tokens | `GET/POST /tokens`, `PUT /tokens/:id/ips`, `DELETE /tokens/:id` |
| Credential sets | `GET/POST /credential-sets`, `PUT/GET /credential-sets/:id`, `POST /credential-sets/:id/verify` |
| Users | `GET/POST /users`, `PATCH /users`, `PATCH /users/:id` |
| POS | `GET/POST /pos/terminals`, `GET/PATCH /pos/terminals/:id`, `POST /pos/terminals/:id/screens`, `GET /pos/screens/:screenCode/stream` |
| Stats | `GET /stats/overview` |
| External (requires `pg_live_`) | `POST /external/links`, `GET /external/links/:key`, `POST /external/links/:key/cancel`, `GET /external/payments/:reference` |

Authentication behavior:

- All routes except `/health` and the six auth routes before `router.use(requireAuthentication)` require a bearer credential. Onboarding is authenticated; it is mounted under the edge public router for routing convenience, not because it is anonymous.
- The principal must have a `merchantId`; `merchantIdOf` rejects otherwise with `403 MERCHANT_CONTEXT_REQUIRED`.
- Queries are scoped by `merchantId`; a merchant cannot read another merchant's wallet/application/link.
- API tokens are bound to a merchant and optionally an application; the token hash, revocation and CIDR checks happen in core.
- There is no per-route `requireAuthorities` call. API-token scopes and session authorities do not gate individual merchant endpoints.
- Sensitive application changes (`assignedWalletId`, `railWhitelist`, `redirectDomainAllowlist`) create an `APPLICATION` approval instead of applying directly.

### 3.4 Checkout namespace

| Route | Behavior |
| :--- | :--- |
| `GET /health` | channel health |
| `GET /pay/:linkKey` | resolves link, merchant, fee breakdown, visible rails, excluded reasons, support config and rail fields |
| `POST /pay/:linkKey/initiate` | validates rail/form/idempotency, resolves visible route, runs guard pipeline, creates attempt, calls engine initiate; rejects client amount/currency at the edge |
| `GET /pay/:linkKey/logs/:attemptId` | attempt state summary; `clientAction: null` and `publicOutputs: {}` are hard-coded |
| `GET /pay/:linkKey/logs/:attemptId/status` | SSE stream that polls the database every 2 seconds for up to 10 minutes |
| `POST /pay/:linkKey/logs/:attemptId/confirm` | atomic claim, engine SUBMIT, trusted-success facts, ledger post |
| `POST /pay/:linkKey/logs/:attemptId/resend` | checks AWAITING_CUSTOMER and cooldown, updates `lastOtpSentAt`; does not call the gateway |
| `POST /pay/:linkKey/logs/:attemptId/cancel` | atomic cancel, release slot, before point of no return |
| `POST /pay/:linkKey/logs/:attemptId/client-event` | untrusted hint; always triggers engine inquiry |
| `GET /return/:attemptToken` | resolves attempt by reference/gateway reference, runs inquiry, returns redirect path |
| `POST /return/:attemptToken` | same as GET |
| `POST /inbound/:gateway/:env/:pathToken` | raw bytes, channel/environment checks, dedupe, inbox row, synchronous verification, ack template |

Checkout has no bearer auth. The link key and attempt id are capabilities. The route never accepts amount or currency; the edge additionally rejects monetary fields before forwarding.

### 3.5 Public namespace

`api/public/index.ts` creates a router, installs a 15-request/hour `express-rate-limit` middleware and exports it with no route. It is mounted at `/api/public`. Every path under that prefix falls through to the Express 404 after the limiter. There is no public health or discovery endpoint.

### 3.6 List, export and summary pattern

`core-back/lib/listQuery.ts` is the shared contract:

- `parseListQuery`: `page >= 1`, `pageSize` clamped to 1..200, `sortDirection` `asc|desc`, scalar query keys copied.
- `buildListQuery(raw, spec)`:
  - `search`: OR over configured paths with case-insensitive `contains`.
  - `contains`: query key -> one/many paths, OR within the key.
  - `equals`: exact path equality.
  - `in`: comma-separated values.
  - `booleans`: `"true"`/`"false"`.
  - `dates`: `from`/`to` or `<name>From`/`<name>To`; date-only `from` is start-of-day UTC and `to` is end-of-day UTC.
  - `ranges`: `amountMin/amountMax`, `minScore/maxScore`; decimals use `Prisma.Decimal`.
  - `sortable`: allowlist of client sort keys -> model paths.
  - `defaultSort`, `orderBy` with `id desc` tie-break.
  - `skip = (page - 1) * pageSize`, `take = pageSize`.
- `listResponse(key, rows, total, built)` returns `{ [key]: rows, total, page, pageSize }`.

Offset pagination is the default. Since 2026-11-04 `buildListQuery` returns a `keyset` plan when every ORDER BY term is a top-level NOT NULL column (`createdAt`, `updatedAt`, `id` plus the spec `keysetFields`); `listResponse` then emits an opaque base64url `nextCursor` for a full page and a valid `cursor` query parameter replaces OFFSET (`skip = 0`). `includeTotal=false` skips the COUNT (`countUnlessSkipped`). Only `GET /internal/merchant/payments` and `/links` pass the helpers so far; the other lists remain offset until adopted.

Export endpoints follow a repeated shape:

- Reuse the same `buildListQuery` spec as the list.
- Fetch up to 5000 rows with `take: 5000` and no `skip`.
- Include the total count and `exported`, sometimes `truncated`.
- Write an audit row for the export before responding.
- Return JSON, not a server-generated XLSX binary. The portals consume the JSON through the shared frontend export pipeline.

Summary endpoints are domain-specific aggregates (counts by status/role/severity/etc.) and have a `summary/export` variant that returns the snapshot plus `exportedAt` and writes an audit row. Not every summary endpoint has all four variants.

### 3.7 Maker-checker endpoints and execution coverage

Proposal/decision routes:

| Flow | Maker/proposal route | Checker/decision route | Execution handler |
| :--- | :--- | :--- | :--- |
| Generic approval | created by each subject route | `POST /approvals/:id/approve`, `/reject` | `executeApprovalSubject` or backup-specific branch |
| Adjustment | `POST /adjustments` | approve | `executeAdjustment` |
| Merchant edit/suspend/reinstate/close | `POST /merchants/:id/propose-edit`, `/suspend`, `/reinstate`, `/close` | approve | `executeMerchantPatch` or lifecycle handler |
| Join request decision | `POST /join-requests/:id/decide` | approve | `activateApprovedJoinRequest` / rejection branch |
| User authority change | `POST/PATCH /users` | approve | `executeUserAuthorityChange` |
| Gateway version go-live | `POST /gateway-versions/:vid/submit-approval` | approve | `activateGatewayVersionInTransaction` |
| AML case resolution | `POST /aml/cases/:id/propose` | approve | `executeAmlCaseResolution` |
| AML rule activation | `POST /aml/rules` | approve | AML rule update |
| Reporting rule promotion | `POST /aml/reporting-rules/:id/promote` | approve | reporting rule confirmation |
| Regulatory report | `POST /aml/reports` | approve, then submit/acknowledge | report approval/submission |
| Commission expiry | `POST /commission-profiles/:id/expire` | approve | `executeCommissionProfileExpiry` |
| Velocity deactivation | `POST /velocity-rules/:id/deactivate` | approve | `executeVelocityRuleDeactivation` |
| Operator case resolution | `POST /operator-cases/:id/resolve` | approve | `executeOperatorCaseResolution` |
| Backup policy | `PUT /system/backups/policy` | approve (or policy route with `approvalRequestId`) | daemon `updatePolicy` |

`executeApprovalSubject` handles: `AML_CASE`, `OPERATOR_CASE`, `ADJUSTMENT`, `REGULATORY_REPORT`, `REPORTING_RULE`, `AML_RULE`, `JOIN_REQUEST`, `MERCHANT`, `COMMISSION_PROFILE`, `VELOCITY_RULE`, `USER`, `GATEWAY_VERSION`. Anything else throws `409 NO_EXECUTABLE_SUBJECT`.

`application` sensitive changes create an `APPLICATION` approval in `core-back/api/internal/merchant.ts:1537`, but `executeApprovalSubject` has no `APPLICATION` branch. `CASHOUT_REQUEST`, `GATEWAY`, `CREDENTIAL_SET`, `KYB_DOCUMENT` and `PLATFORM_SETTING` are in the approval domain map but have no generic handler either. `BACKUP_POLICY` is handled by the approve route.

The following money-adjacent routes bypass the approval queue and execute under a single actor:

- `POST /cashouts/:id/process` (cash-out approval/rejection).
- `POST /commission-profiles` (creates an active profile).
- `POST /velocity-rules` (creates an active rule).
- `PUT /settings`, `PUT /settings/checkout-support`, `POST /settings/restore-apply`.
- `POST /disputes`, `POST /disputes/:id/evidence` (intake/evidence, not a ledger movement).
- `POST /gateway-versions/:vid/dry-run` and `/run-suite` (test execution).

This is narrower than the historical four-eyes matrix, which expects commission changes, velocity/AML rule changes and platform compliance settings to be checked.

### 3.8 Checkout and webhook behavior

- `GET /pay/:linkKey` resolves visible rails using the same formula as the engine (`VisibleRailsResolver`) and includes `excludedRails` with reasons.
- `POST /initiate`:
  - Enforces link usability and a per-link idempotency key lookup for an existing attempt.
  - Resolves the visible rail and the top-ranked route.
  - Requires a live gateway version.
  - Validates rail fields before any outbound call.
  - Computes `expiresAt = min(platformCeiling, gateway.sessionTtlSeconds)` and a 24-hour grace.
  - Runs the guard pipeline inside a transaction that creates the attempt and reserves the slot.
  - Returns `403`/`409` for BLOCK, `202` for HOLD, otherwise calls `engine.initiate` with `slotReserved`.
- `POST /confirm`:
  - Accepts `AUTHORIZING`/`CREATED`/`INITIATING`/`AWAITING_CUSTOMER`/`VERIFYING`/`UNKNOWN`.
  - Computes an idempotency hash and uses the atomic claim.
  - Returns the persisted status and sets `x-pg-min-lsn` when the engine produced a commit LSN.
- `POST /client-event` never trusts the browser event; it runs `engine.inquire`.
- `POST /return` also runs `engine.inquire` and returns a redirect path.
- `POST /inbound`:
  - Resolves the channel by path token and checks gateway code and enabled environment.
  - Dedupes by SHA-256 of channel id + raw body, creating `inbound_events`.
  - Correlates the attempt by the channel selector.
  - Verifies the callback synchronously with the full headers and processes it before responding.
  - Updates `verified`, `verificationError`, `processedAt` and `processingResult`.
  - Returns the channel's ack status/body template.

The inbound worker also exists and can drain unprocessed inbox rows, but the live route already completes verification before the ack. The design's "queue and ack fast" behavior is not the current request path.

## 4. Contracts and invariants

1. **Internal routes require the channel certificate.** There is no bearer-only access from a non-edge caller.
2. **Admin business routes check authorities.** The semantics are OR over the required list; `*` satisfies.
3. **Merchant routes are merchant-scoped, not authority-scoped.** The merchant id on the principal is the tenant boundary.
4. **Checkout does not accept money fields.** The amount and currency come from the payment link.
5. **Checkout confirm is single-winner.** The atomic claim allows only one SUBMIT; duplicates return the persisted state.
6. **Resend is cooldown-only.** It does not send an OTP.
7. **List filters are server-side.** Pagination is offset-based with a hard page-size cap of 200.
8. **Exports are capped.** Most export routes take at most 5000 rows and audit the export.
9. **Error envelope is stable.** `ApiError` -> `{code,message,reference?,details?}`.
10. **Maker-checker is enforced on the approve route.** But not every sensitive route uses the queue.

## 5. Data / API / config / deployment surface

### 5.1 Route counts

| Namespace | Declarations | Notes |
| :--- | ---: | :--- |
| Admin (`api/internal/admin.ts`) | 243 | includes health/auth/search/stats and all back-office domains |
| Admin backups (`api/internal/backups.ts`) | 5 | mounted at `/internal/admin/system/backups` |
| Merchant (`api/internal/merchant.ts`) | 62 | includes health/auth/onboarding and external |
| Checkout (`api/internal/checkout.ts`) | 12 | includes health, pay, return, inbound |
| Public (`api/public/index.ts`) | 0 | limiter only |
| **Total core declarations** | **322** | before method/path expansion of edge routes |

### 5.2 Edge mapping

| Edge path | Core path | Edge file |
| :--- | :--- | :--- |
| `POST /api/v1/admin/auth/login`, `/mfa`; `GET /me` | `/internal/admin/auth/*` | `admin-back/api/public/auth.ts` |
| `/api/v1/admin/*` | `/internal/admin/*` | `admin-back/api/protected/**` |
| `/api/v1/admin/system/backups/*` | `/internal/admin/system/backups/*` | `admin-back/api/protected/backups.ts` |
| `/api/v1/merchant/auth/*` | `/internal/merchant/auth/*` | `merchant-back/api/public/auth.ts` |
| `/api/v1/merchant/onboarding/*` | `/internal/merchant/onboarding/*` | `merchant-back/api/public/onboarding.ts` |
| `/api/v1/merchant/*` | `/internal/merchant/*` | `merchant-back/api/protected/**` |
| `/api/v1/external/*` | `/internal/merchant/external/*` | `merchant-back/api/external/index.ts` |
| `/api/v1/pay/*` | `/internal/checkout/pay/*` | `checkout-back/api/public/pay.ts` |
| `/api/v1/return/*` | `/internal/checkout/return/*` | `checkout-back/api/public/return.ts` |
| `/api/v1/inbound/*` | `/internal/checkout/inbound/*` | `checkout-back/api/public/inbound.ts` |

### 5.3 List/export/summary spec keys

Most admin list endpoints define a subset of:

- `search`: paths.
- `contains`, `equals`, `in`, `booleans`.
- `dates` with `createdAt`, `updatedAt`, `submittedAt`, `slaDueAt`, `lastUsedAt`, etc.
- `ranges` for amount/score.
- `sortable`.
- `defaultSort`, `defaultPageSize` (often 20 or 50).

The generated route matrix is the complete method/path inventory. The route groups above are complete at the domain level; use the appendix for a one-row-per-route listing.

## 6. Operational usage

### 6.1 Exercise an admin route

```bash
curl --cert certs/admin-back-client.crt \
     --key certs/admin-back-client.key \
     --cacert certs/internal-ca.crt \
     -H "Authorization: Bearer $ADMIN_SESSION" \
     "https://127.0.0.1:4000/internal/admin/merchants?page=1&pageSize=20&sortKey=createdAt&sortDirection=desc"
```

A wrong channel certificate fails at the CN guard. A missing/invalid session fails at `requireAuthentication`. A missing authority fails with `403 AUTHORITY_REQUIRED` and `details.required`.

### 6.2 Exercise checkout

1. `GET /internal/checkout/pay/:linkKey` -> visible rails.
2. `POST /internal/checkout/pay/:linkKey/initiate` with `railCode`, `formData`, `idempotencyKey`.
3. Poll `GET .../logs/:attemptId/status` or wait for the gateway webhook.
4. `POST .../confirm` with OTP/evidence if the rail requires it.
5. `POST .../cancel` only before the point of no return.

### 6.3 Add a new admin list endpoint

1. Define a `ListSpec`.
2. Call `buildListQuery` and `listResponse`.
3. Add the `/export`, `/summary` and `/summary/export` variants if the domain uses the pattern.
4. Add `requireAuthorities` and a `git diff --check`/test update.
5. Regenerate `api-route-matrix.md`; do not hand-edit it.

### 6.4 Add an approval subject

1. Create the approval request with a stable subject type.
2. Add the subject to `APPROVAL_DOMAIN_SUBJECT_TYPES` if it belongs to a domain.
3. Implement a branch in `executeApprovalSubject` with the maker/checker re-check.
4. Add a test that proves maker != checker and that approval executes atomically.

Without step 3 the request remains pending and returns `409 NO_EXECUTABLE_SUBJECT` on approve.

## 7. Status and deviations

### Implemented

- Complete admin, merchant and checkout route groups with Zod validation.
- Channel CN guard and admin authority checks.
- Session and `pg_live_` authentication.
- Offset list/export/summary patterns.
- Maker-checker proposal/decision routes and database/middleware enforcement.
- Checkout link resolution, initiate, confirm, cancel, client-event, return and inbound.
- Backup overview/trigger/drill/policy/catalog.
- Raw upload routes for KYB and reconciliation.
- Audit writes on exports and sensitive actions.

### Partial

- **Approval execution.** `APPLICATION` and several other approval subject types have no executable handler.
- **Maker-checker coverage.** Cash-out process, commission create, velocity create and settings writes bypass the queue.
- **Merchant authorization.** No per-route authority or token-scope enforcement.
- **Pagination.** Offset by default; keyset/cursor available through `buildListQuery` and adopted by merchant `/payments`.
- **Webhook processing.** Synchronous verification/processing before ack; the worker is secondary.
- **Exports.** JSON-only server responses with a 5000-row cap; no server-side XLSX generation in core.
- **Idempotency.** Attempts have an idempotency key; link creation accepts one but does not use it.
- **Checkout status.** SSE polls the primary database every 2 seconds instead of subscribing to the transition bus.

### Missing / deferred

- Handlers for `APPLICATION`, `CASHOUT_REQUEST`, `GATEWAY`, `CREDENTIAL_SET`, `KYB_DOCUMENT` and `PLATFORM_SETTING` approvals.
- A true `resend` flow that calls the gateway.
- Keyset pagination and cursor contracts.
- A public API surface under `/api/public`.
- A gateway-wire/step log route for operators beyond the current attempt data.
- A dedicated `clientAction`/`publicOutputs` read model on the attempt log endpoint.
- Per-endpoint merchant authorities and token-scope enforcement.

### Known bugs / risks

- **Code gap:** `GET /internal/checkout/pay/:linkKey/logs/:attemptId` returns `clientAction: null` and `publicOutputs: {}` even when the attempt row has them.
- **Code gap:** `POST .../resend` only updates `lastOtpSentAt`; the payer may see a cooldown but no new OTP.
- **Code gap:** `POST /internal/admin/stats/overview`, `POST /stats/export-audit` and `GET /options/:kind` require authentication but no specific authority.
- **Code gap:** `GET /internal/admin/auth/me` and the merchant `GET /auth/me` are static and not protected by the same business authority model.
- **Code gap:** the webhook route verifies synchronously; a slow verifier delays the ack, which is the opposite of the design's fast-ack goal.
- **Risk:** the inbox stores only content-type/content-length; replay through the worker has less signature context than the live path.
- **Risk:** export audit writes happen after the data read, so a failed audit write does not prevent the export response in every route.
- **Documentation gap:** historical route counts and API lists are superseded by the generated matrix and this part.

## 8. Verification and tests

- `core-back/test/internal-routes.test.ts` verifies mount points, health and core routing.
- `core-back/test/list-query.test.ts` covers filters, date ranges, decimals, sorting and pagination.
- `core-back/test/approval-queue.test.ts` covers approval listing, state and age.
- `core-back/test/governance-execution.test.ts` covers executable subject handlers and maker/checker refusals.
- `core-back/test/checkout-confirm-concurrency.test.ts` covers the atomic confirm claim and duplicate behavior.
- `core-back/test/checkout-cancel.test.ts` covers cancellation and slot release.
- `core-back/test/backup-admin/backup-admin-routes.test.ts` covers the backup route contract.
- `core-back/test/exhaustive/05-api-matrix/admin-endpoints-rbac-fuzz.test.ts` covers admin authority fuzzing.
- `core-back/test/exhaustive/05-api-matrix/list-query-filters-all-27-endpoints.test.ts` covers list filters across endpoints.

No build or test was run for this documentation change. Database-backed route tests require PostgreSQL.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` §16.1 checkout, §16.2 merchant, §16.3 admin.
- `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md` §14.1 wizard, §15.4 four-eyes matrix.
- `design/10-fixes/_0001_operator_cases.md` for the operator-case route family.
- `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md` §15 API surface and observability.

### Code paths

- `core-back/api/index.ts`, `core-back/api/internal/index.ts`.
- `core-back/api/internal/admin.ts`, `merchant.ts`, `checkout.ts`, `backups.ts`, `reconciliationUpload.ts`.
- `core-back/api/middleware/authDoubleCheck.ts`, `makerCheckerGuard.ts`.
- `core-back/lib/listQuery.ts`, `approvalQueue.ts`.
- `core-back/engine/governance/GovernanceExecution.ts`.
- `admin-back/api/protected/**`, `merchant-back/api/**`, `checkout-back/api/public/**` for the edge mapping.

### Generated appendices

- `project-design/appendices/api-route-matrix.md` (authoritative one-row-per-route inventory)
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/stale-claims-register.md` (SC-011, SC-027)

## 10. Change history

- 2026-11-03: Initial canonical core API part written against `5a24f6f+working-tree`; records the complete namespace map, the approval-handler gap and the synchronous webhook path.

## Core Engine

> Status: `partial` · Last verified: 2026-11-03

## 1. Purpose and scope

This part describes the universal payment rail engine inside `core-back`: how a gateway is represented declaratively, how an attempt moves through the state machine, how steps are executed and secured, how authentication and signatures are applied, how the visible rails are resolved, how gateway configuration is validated/imported, and how the engine is composed at runtime.

It covers the engine and its supporting primitives. The ledger posting internals are owned by `01-core-back/03-ledger.md`; the workers are owned by `05-workers.md`; storage is owned by `06-storage-engine.md`. Where the engine calls those subsystems, this part describes the boundary and the exact call.

## 2. Design intent (extracted and synthesized from ./design)

The engine is a voucher-inspired, zero-code provider engine applied to payments. An operator describes:

1. How to authenticate (`GatewayAuth`, credential sets, `ApiConsumer`).
2. What the customer must enter (`RailField`).
3. Which HTTP calls pre-validate, initiate, confirm, inquire, cancel, refund and void (`Flow`, `FlowStep`, `StepParameter`, `StepOutput`).
4. How the result arrives (`ConfirmationChannel`).
5. How gateway status/error codes map to canonical statuses (`StatusRule`, `ErrorMap`).
6. How money settles (`CredentialSet` ownership and `LedgerPoster`).

The historical design names ten declarative phases: `CREDENTIAL_CHECK`, `PRE_INITIATE`, `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, `REFUND`, `VOID`, `CAPTURE`, `SETTLEMENT_FETCH`. The actual runtime executes seven of them plus a separate credential-check path.

The design contract is a six-method universal engine:

| Method | Intent |
| :--- | :--- |
| `preInitiate` | Optional read-only eligibility/quote check before initiation |
| `initiate` | Validate the customer form, execute the initiation stack, return a declarative client action |
| `confirm` | Execute the SUBMIT stack, enforce the point of no return, verify trusted success, post the ledger atomically |
| `verifyCallback` | Verify a webhook/IP/inquiry hint, dedupe, correlate and trigger inquiry when required |
| `inquire` | Ask the gateway for authoritative status; resolve `UNKNOWN`, expiry and operator checks |
| `refund` | Execute REFUND or VOID through the gateway, then book the adjustment |

The design's core invariants are:

- Browser callbacks and return URLs are never trusted.
- A timeout/reset/5xx/extraction failure on a `MOVES_MONEY` step becomes `UNKNOWN`, never a blind retry.
- Trusted success requires status, reference, amount within tolerance, currency and environment.
- The slot reservation is held through `UNKNOWN` and released only on terminal non-success.
- Gateway configuration is immutable per version and pinned on the attempt.
- The transform library is closed and pure; there is no `eval` or `Function`.
- Secrets are host-pinned and redacted.
- The engine never posts money by itself; the ledger poster is the only posting path.

## 3. As-built architecture

### 3.1 Runtime composition

`core-back/engine/runtime/index.ts` exposes a lazy singleton `PlatformRuntime`:

- `getPlatformRuntime(db)` creates it once.
- `getPlatformRuntimeAsync(db)` de-duplicates concurrent construction.
- `setPlatformStorage(storage)` updates the storage reference.
- `resetPlatformRuntime()` closes the consumer registry and clears the singleton.

`createPlatformRuntime(db, { storage })` in `engine/runtime/platform.ts` constructs:

| Component | Implementation | Role |
| :--- | :--- | :--- |
| `vault` | `new Vault()` | AES-256-GCM secrets, redaction |
| `crypto` | `new CryptoEngine()` | canonicalization/signing |
| `repositories` | `new PrismaRepositories(db)` | repository ports |
| `consumerRegistry` | `new ConsumerRegistry(...)` | outbound consumer cache |
| `stepExecutor` | `new StepExecutor(...)` | declarative steps |
| `ledgerPoster` | `createLedgerPoster(db)` | double-entry posting |
| `attempts` | `PrismaAttemptRepository` | attempt projection/update |
| `slots` | `PrismaSlotReservationStore` | link slot reservation |
| `flowProvider` | `PrismaFlowProvider` | declarative flow projection |
| `callbackVerifier` | `PrismaCallbackVerifier` | webhook verification |
| `contextCipher` | `VaultContextCipher(vault)` | encrypted attempt context |
| `reportingEvaluator` | `ReportingRuleEvaluator` | reporting rules on success |
| `credentialCheck` | `CredentialCheckService` | CREDENTIAL_CHECK/probe |
| `engine` | `DynamicRailEngine` | universal contract |
| `screening` | `CachedScreeningProvider(InternalWatchlistProvider)` | merchant screening |
| `guardPipeline` | `AttemptGuardPipeline` | velocity/AML/slot guard |

When a storage engine is present, the runtime uses `storage.uow.run` for transactions and records the commit LSN per attempt in an in-process map. When it is absent (tests/tools), it falls back to `db.$transaction` and reports `"0/0"` as the LSN.

The runtime is constructed with `transactionRunner`, `credentialResolver`, `operatorCaseSink`, `reportingEvaluator`, `invalidationBus`, `logSink` and an attempt repository. The consumer registry is keyed by `(gatewayId, env, credentialSetId, gatewayVersionId?)`; the version is part of the key so two pinned versions with different auth recipes do not share a consumer.

### 3.2 Attempt projection and state machine

`PrismaAttemptRepository` projects a `payment_attempts` row into `DynamicAttempt`, deriving:

- `ownershipMode`: `INTERNAL` when the pinned gateway kind is `INTERNAL`; `MERCHANT_DIRECT` when the settlement target is `MERCHANT_DIRECT`; otherwise `PLATFORM_CLEARING`.
- `gatewayId`: from the pinned gateway version relation (the attempt table has no `gateway_id` column).
- `mismatchTolerance`: from the pinned route's `mismatch_policy.tolerance_amount`.
- `feeAccrual`: from the pinned route's `cost_model.accrue_fee_at_confirm`.
- Amounts as 4-decimal strings.

The 14 statuses are:

```text
CREATED, INITIATING, AWAITING_CUSTOMER, AUTHORIZING, VERIFYING,
UNKNOWN, SUCCEEDED, FAILED, EXPIRED, CANCELLED, BLOCKED,
PARTIALLY_REFUNDED, REFUNDED, DISPUTED
```

`ALLOWED_TRANSITIONS` is explicit. Noteworthy edges:

- `CREATED` can go to `INITIATING`, `AWAITING_CUSTOMER`, `VERIFYING`, `BLOCKED`, `CANCELLED`, `EXPIRED`, `FAILED`.
- `INITIATING` can go to `AWAITING_CUSTOMER`, `VERIFYING`, `FAILED`, `BLOCKED`, `CANCELLED`, `EXPIRED`, `UNKNOWN`.
- `AWAITING_CUSTOMER` can go to `AUTHORIZING`, `AWAITING_CUSTOMER` (retryable OTP), `VERIFYING`, `FAILED`, `CANCELLED`, `EXPIRED`, `BLOCKED`, `UNKNOWN`.
- `AUTHORIZING` and `VERIFYING` can go to `VERIFYING`, `SUCCEEDED`, `FAILED`, `UNKNOWN`, `AWAITING_CUSTOMER`.
- `UNKNOWN` can go to `VERIFYING`, `SUCCEEDED`, `FAILED`, `UNKNOWN`.
- `SUCCEEDED` can go to `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED`.
- `FAILED` and `EXPIRED` can go to `SUCCEEDED` for a late success.
- `CANCELLED` and `BLOCKED` are terminal.
- `DISPUTED` can go to `PARTIALLY_REFUNDED` or `REFUNDED`.

Every transition calls `attempts.updateAttempt`, then publishes `attempt:transition` to the invalidation bus. Terminal transitions also enqueue an `attempt.transitioned` outbox event. A terminal attempt sets `terminalAt` and clears `nextCheckAt`.

### 3.3 DynamicRailEngine methods

`preInitiate(attempt, formData)`:
- Loads the current attempt.
- Applies the optional normalizer, without validation (`validate=false`).
- Executes the `PRE_INITIATE` stack and persists state/outputs.
- Returns the result. It does not transition to a terminal state.

`initiate(attempt, formData, { slotReserved })`:
- Loads the current attempt.
- Normalizes and validates the form.
- If a `PRE_INITIATE` flow exists, executes it; a FAILED/BLOCKED result transitions and releases a caller-owned slot.
- Reserves the slot if the caller did not already reserve it.
- Transitions to `INITIATING`.
- Executes the `INITIATE` stack, persists outputs.
- `UNKNOWN` -> transition `UNKNOWN`.
- `FAILED`/`BLOCKED` -> transition and release the slot.
- Otherwise -> transition `AWAITING_CUSTOMER` with public outputs.
- Wipes PAN fields in a `finally` block.

`confirm(attempt, evidence, { claim })`:
- Loads the current attempt; an already-`SUCCEEDED` attempt returns its persisted state.
- If a `claim` function is provided, calls it. Only the winner continues; a loser returns the persisted state without contacting the gateway. The winner sets `AUTHORIZING`, `pointOfNoReturn=true`, publishes the transition and executes.
- Without a claim, an `UNKNOWN` attempt with `pointOfNoReturn` throws `409 POINT_OF_NO_RETURN`; otherwise it transitions to `AUTHORIZING` with `pointOfNoReturn=true`.
- Executes the `SUBMIT` stack.
- `UNKNOWN` -> transition `UNKNOWN`.
- `AWAITING_CUSTOMER` with a `RETRYABLE_OTP` error -> increments `otpAttempts`; at the max it transitions `FAILED` and releases the slot, otherwise it returns to `AWAITING_CUSTOMER`.
- `FAILED` -> transition `FAILED`, release the slot.
- `VERIFYING` -> transition `VERIFYING`.
- Otherwise, combines the request evidence with the response, verifies the five trusted-success facts, and either transitions `UNKNOWN` with `TRUSTED_SUCCESS_FACTS_FAILED` or finalizes success.

`verifyCallback(channel, rawRequest)`:
- Requires a callback verifier; otherwise `501 CALLBACK_VERIFIER_MISSING`.
- Verifies the channel; an unverified/missing attempt throws `401 CALLBACK_VERIFICATION_FAILED`.
- Loads the attempt.
- Builds a dedupe key from the channel plus an explicit `dedupeKey`/`dedupe_key`, or `channel:attemptId`. If a callback inbox is configured, an already-seen key returns the persisted state.
- Checks the callback environment against the attempt environment; mismatch -> `409 CALLBACK_ENVIRONMENT_MISMATCH`.
- If `mustInquire`, runs `inquire` and returns its result.
- Otherwise verifies trusted success and either transitions `UNKNOWN` or finalizes success.

`inquire(attempt)`:
- Already `SUCCEEDED` -> return persisted state.
- `FAILED`/`EXPIRED` are late-success candidates and do not get forced back to `VERIFYING`; other non-`UNKNOWN`/`VERIFYING` states transition to `VERIFYING`.
- Executes the `VERIFY` stack.
- `UNKNOWN` -> transition `UNKNOWN`.
- `FAILED` -> if the stored context observed a trusted success, freeze as `UNKNOWN` with `CONFLICTING_TRUSTED_SIGNALS` and open a P1 `CONFLICT` operator case; otherwise transition `FAILED` and release the slot.
- `VERIFYING`/`AWAITING_CUSTOMER` -> transition and return.
- Otherwise verify trusted success and either `UNKNOWN` or finalize success.

`refund(attempt, amount, adjustmentId)`:
- Validates a positive amount not exceeding `totalChargedAmount`.
- Chooses `VOID` when `settledAmount` is undefined, otherwise `REFUND`.
- Sets `adjustmentState=EXECUTING`.
- Executes the phase.
- `UNKNOWN`/`FAILED` keep `EXECUTING` and schedule reconciliation.
- On success, posts the ledger scenario (`INTERNAL_REFUND` for internal rails, otherwise `FULL_REFUND`) and transitions `REFUNDED` or `PARTIALLY_REFUNDED`.

The engine has a `FlowPhase` union of `PRE_INITIATE`, `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, `REFUND`, `VOID`. It has no public `cancel` method, and `CANCEL` is not executed anywhere in the current callers.

### 3.4 Phase execution

`executeSteps(phase, attempt, input, steps)`:

1. Decrypts the attempt context into `state`.
2. Merges stored customer fields with the input.
3. Resolves credentials through `credentialResolver`.
4. Iterates steps in order.
5. Builds a `StepExecutionContext` with attempt, customer fields, credentials, state, previous response, URLs and the transform context.
6. Calls `StepExecutor.execute`.
7. Records step logs.
8. Merges `STATE` and `PUBLIC` outputs.
9. Captures `SETTLED_AMOUNT`, `PROVIDER_FEE`, `PROVIDER_REF` and `NETWORK_REF`.
10. Stops on `BLOCKED`, `UNKNOWN`, `FAILED`, `AWAITING_CUSTOMER` or `VERIFYING`.
11. Handles a `BRANCH` result by jumping to the `thenStepId`/`elseStepId` within the same stack.
12. Returns `SUCCEEDED` when the stack completes (or `AWAITING_CUSTOMER` for an empty non-SUBMIT phase; an empty SUBMIT phase is treated as success).

`persistOutputs` encrypts the state with `contextCipher`, stores `publicOutputs`, provider/network references and the settled amount. The context cipher is `VaultContextCipher(vault)`; without it the previous ciphertext is retained.

`phaseStatus` is phase-agnostic: any non-empty stack that completes returns `SUCCEEDED`. The caller interprets the result per phase. This means a PRE_INITIATE flow is expected to signal a business failure through an explicit step status, not through an HTTP 200 with an empty stack.

### 3.5 Trusted success and finalization

`verifyTrustedSuccessFacts(evidence, attempt)` reads either `evidence.trustedFacts` or the evidence itself and requires:

| Fact | Check |
| :--- | :--- |
| `status` | One of `SUCCESS`, `SUCCEEDED`, `PAID`, `CAPTURED`, `CONFIRMED`, `APPROVED` (case-insensitive) |
| `reference` | Present and equal to `gatewayReference` or `reference` |
| `amount` | Present and equal to `totalChargedAmount`, or within the pinned route tolerance |
| `currency` | Present and equal to the attempt currency (case-insensitive) |
| `environment` | Present and equal to the attempt `env` |

All five must be true. A missing environment fact makes the result untrusted. The callback verifier derives the environment from the attempt, so webhook evidence is safe; a declarative sync response must map an environment value for confirmation to succeed.

`finalizeSuccess` runs inside the runtime transaction when available:

1. Calls `slots.commitSlot(attempt, transaction)`.
2. If the slot outcome is `SUSPENSE`, updates the attempt to `SUCCEEDED` with `substatus=SUSPENSE_SETTLEMENT` and the suspense journal entry id.
3. Otherwise posts the payment confirmation through `ledgerPoster.postPaymentConfirmation` with ownership mode, fee bearer, fee accrual, requested amount, surcharge, commission, merchant amount and gateway/provider fee.
4. Updates the attempt to `SUCCEEDED` with the ledger entry id.
5. Publishes the success transition.
6. Sets `trustedSuccessObserved` in the context.
7. Opens a `LATE_SUCCESS` P2 case if the previous status was `FAILED` or `EXPIRED`.
8. Evaluates reporting rules.

The commission is always taken from the pinned `platformCommissionAmount` (or the context); there is no default rate. A missing commission throws `COMMISSION_NOT_RESOLVED`.

The slot store implements the single-use invariant with a conditional `UPDATE` on `payment_links`. A settlement that cannot commit a slot is posted to `SUSPENSE` through the ledger, an automatic refund adjustment is drafted, a P1 operator case is opened, and the merchant is not credited. The engine returns `settlement: "SUSPENSE"` with `substatus` so callers cannot mistake it for a normal success.

### 3.6 StepExecutor

`StepExecutor` supports six step types:

| Type | Behavior |
| :--- | :--- |
| `HTTP` | Builds and sends an HTTP request, maps status rules, extracts outputs, retries only safe non-money steps |
| `COMPUTE` | Resolves a named compute operation from the registry, applies transforms, extracts outputs |
| `RENDER` | Builds a declarative `ClientAction` payload, applies transforms |
| `WAIT` | Waits for a duration/event with timeout |
| `ASSERT` | Evaluates assertions and fails the step on a mismatch |
| `BRANCH` | Evaluates a condition and returns a `then`/`else` branch |

Parameter places: `HEADERS`, `QUERY`, `PATH`, `BODY`, `FORM`, `MULTIPART`, `XML`.

Parameter sources: `GATEWAY_META`, `ROUTE_META`, `CREDENTIAL`, `ATTEMPT`, `CUSTOMER_FIELD`, `STATE`, `PREVIOUS_RESPONSE`, `URLS`, `CLIENT_CONTEXT`, `CONSTANT`, `NOW`, `RANDOM`, `COMPUTED`, `CRYPTO_SIGNATURE`.

Output stores: `STATE`, `PUBLIC`, `SETTLED_AMOUNT`, `PROVIDER_FEE`, `PROVIDER_REF`, `NETWORK_REF`.

HTTP behavior:

- Method default `POST`; content types JSON, form-urlencoded, multipart, XML, or JSON-by-default.
- URL templates support `{name}`/`{{name}}` base URL placeholders; path parameters are encoded and cannot contain `/`, `\`, CR, LF or NUL.
- Headers reject CR/LF/NUL.
- Query arrays support indices, brackets and repeat formats.
- XML placeholders are escaped; destination-aware encoding is used.
- Idempotency config can inject a rendered key as a header or a body field.
- `CRYPTO_SIGNATURE` parameters resolve a crypto profile and sign the canonical payload.
- Retry: `MOVES_MONEY` always has one attempt; safe steps retry on retryable status/errors according to `max_attempts`.
- A `MOVES_MONEY` step without a matched status rule and a failed/5xx response becomes `UNKNOWN`.
- A missing required output on a money step becomes `UNKNOWN`.
- Response reader: 2 MiB cap, JSON depth 64, XML DTD/entity block.
- Redirects are blocked (`manual` and a 3xx error).
- DNS guard: all resolved addresses must be public; `localhost`, `.localhost`, `.local` rejected.
- Final URL is re-validated for HTTPS, host allowlist, no userinfo/fragment, no traversal/encoded separators.
- PAN field names are wiped from customer fields and state after the step.

`COMPUTE` uses the production registry:

- `MOAMALAT_LIGHTBOX_PAYLOAD`.
- `NEOMPAY_QR_PAYLOAD`.
- `LOCAL_SETTLEMENT_RECONCILE`.

A missing compute operation throws `UNKNOWN_COMPUTE_OPERATION`. A `RENDER` step maps one of the five client actions: `SHOW_OTP_FORM`, `HTTP_REDIRECT`, `RENDER_EMBEDDED`, `SHOW_QR_OR_CODE`, `SHOW_PUSH_OR_TRANSFER`.

Status mapping uses declarative `status_rules` first; a matched rule wins even on a money step. An unmatched 2xx is `SUCCEEDED`; an unmatched non-2xx on a money step is `UNKNOWN`, otherwise `FAILED`.

### 3.7 ApiConsumer and ConsumerRegistry

`ApiConsumer` supports ten auth methods: `NONE`, `API_KEY`, `PERMANENT_TOKEN`, `TOKEN_ENDPOINT`, `REFRESH_TOKEN`, `USERNAME_PASSWORD`, `BASIC`, `REQUEST_SIGNATURE`, `OAUTH2_CLIENT_CREDENTIALS`, `MUTUAL_TLS`.

Behaviors:

- Auth can be applied as header, query or body (API key).
- `REQUEST_SIGNATURE` signs `${timestamp}.${payload}` with HMAC-SHA256/512 and sets timestamp/signature headers, plus `X-API-KEY` when present.
- Token refresh is single-flight: concurrent callers share one `refreshPromise`.
- A rotated refresh token is persisted through the configured callback **before** the refresh promise resolves.
- Refresh scheduling uses a chained `setTimeout` with ±10% jitter and a 30-second accelerated retry on failure.
- A 401/403 on a safe pre-money step triggers one refresh and one retry. A money/point-of-no-return step never retries.
- Transport timeouts use an `AbortController`; a timeout on a money step is `moneyUncertain`.
- Redirects are blocked; response size/depth/XML limits match `StepExecutor`.
- Host allowlist and DNS/IP SSRF checks match the engine; the Fake Rails exception is the same three-condition allowlist.
- Mutual TLS uses credential-provided cert/key/ca via a fetch `tls` extension.
- `responseError` marks 5xx as retryable, but the money-step boundary prevents retry.

`ConsumerRegistry`:

- `consumersMap` maps a cache key to `Promise<ApiConsumer>`.
- The promise is stored synchronously before the DB config load, so concurrent callers share one initialization.
- The key is `${gatewayId}:${env}:${credentialSetId}[:${gatewayVersionId}]`.
- A failed initialization removes the promise from the map.
- It subscribes to `credential:*` invalidation and stops consumers for the matching credential set.
- `invalidateGateway` stops all consumers for a gateway.
- `close` stops all and unsubscribes.

### 3.8 Crypto and vault

`CryptoEngine` canonicalization modes:

- `MOAMALAT_SECURE_HASH`
- `DPAY_WEBHOOK_VERIFY`
- `PLUTU_CALLBACK_HASH`
- `MYPAY_RAW_BODY`
- `SORTED_KEY_VALUE_AMP`
- `TIMESTAMP_DOT_RAW_BODY`
- `SORTED_VALUES_HASH`
- `TEMPLATE_STRING`
- `JSON_CANONICAL`
- `RAW_BODY`

Algorithms: `HMAC_SHA256`, `HMAC_SHA512`, `RSA_SHA256`, `SHA256`. Key encodings: `UTF8`, `HEX`, `BASE64`. Output encodings: `HEX_LOWER`, `HEX_UPPER`, `BASE64`.

`Vault`:

- AES-256-GCM with a 12-byte IV and a 16-byte tag.
- Key id as AAD.
- Payload format `keyId:iv:authTag:ciphertext`, all base64 segments.
- Strict base64 decoding and length checks.
- HKDF-SHA256 per-key derivation from a master key, or direct `KMS_KEYS_JSON` keys, or a custom `VaultKms`.
- `redactPayload` handles objects, arrays, cycles, Buffers, sensitive field names, literal secrets and Luhn-valid PANs.
- `timingSafeStringEqual` hashes both sides to fixed length before `timingSafeEqual`.

### 3.9 Transform library (39 operations)

The closed union has exactly 39 operations:

```text
scale, MUL_INT, DIV_DECIMAL, round, format_decimal, to_int, to_number,
to_string, concat, template, lowercase, uppercase, trim, pad_left,
pad_right, substring, mask, prepend, arabic_digits_to_ascii,
phone_normalize, sort_keys, values_only, join_pairs, format_date,
epoch_seconds, epoch_millis, uuid, numeric_random, base64_encode,
hex_lower, hex_upper, url_encode, json_encode, xml_escape, sha256,
sha512, hmac_sha256, hmac_sha512, rsa_sha256_sign
```

`validate` enforces arity, integer positions, rounding modes, decimal divisors, timezones, phone styles, key encodings and secret-reference non-emptiness. `validateForStore` additionally forbids `to_number` on `SETTLED_AMOUNT` and `PROVIDER_FEE`, because those stores are money and must not pass through a float. The spec importer's `SPEC_TRANSFORM_OPERATIONS` is the same list and a test asserts equality.

`TransformPipeline.apply` is sequential and type-aware. It uses `Decimal`/bigint-style decimal helpers for numeric operations, not native floats, and can resolve secrets through a `TransformSecretResolver`.

### 3.10 Visible rails

`VisibleRailsResolver.resolve` implements:

```text
visible =
  application rail whitelist ∩ link rail whitelist
  ∩ rail not blocked
  ∩ rail currency = link currency
  ∩ a live/active commission profile
  ∩ at least one route with a verified credential set
  ∩ route ACTIVE and HEALTHY
  ∩ amount within min/max
  ∩ daily cap not exceeded
  ∩ outside maintenance windows
  ∩ in merchant/application/risk-tier/channel scope
```

The application and link whitelists are intersected when both exist; a single list is used when only one exists; `null` means no restriction. Commission profiles are resolved by hierarchy: merchant+application+rail, merchant+rail, platform+rail, platform+`default`. The newest effective profile wins.

Credential resolution respects the route policy:

- `PLATFORM`: only a platform-owned verified set.
- `MERCHANT_REQUIRED`: only a verified merchant-owned set for the application's merchant.
- `MERCHANT_OR_PLATFORM`: platform or the merchant's own set.

A platform set wins when both are available.

Route ranking uses `EFFECTIVE_COST` (default; effective cost then priority), `STRICT_PRIORITY` (priority descending) or `WEIGHTED` (weight descending). Ties fall back to gateway id, credential-set id and route id. The daily cap is `processed + amount <= cap`; the processed volume comes from succeeded attempts in the gateway timezone business day.

Exclusion reasons are returned to the caller, so the daily cap is observable at checkout.

### 3.11 Native adapters and Mock Gateway

`NativeAdapterRegistry` stores adapters by code and supports register/unregister/get/require/has/list/clear. A `NativeAdapter` has the same six methods as the engine.

`MockGatewayServer` is the only production-code class that implements `NativeAdapter`. It supports 15 scenarios:

```text
HAPPY_PATH, WRONG_OTP_RETRY_SUCCESS, EXPIRED_OTP, INSUFFICIENT_FUNDS,
CUSTOMER_LIMIT_HIT, CANCEL, CONFIRM_5XX, CONFIRM_TIMEOUT,
MALFORMED_RESPONSE, DUPLICATE_WEBHOOK, OUT_OF_ORDER_WEBHOOK,
LATE_WEBHOOK_AFTER_EXPIRY, AMOUNT_MISMATCH, THREE_DECIMAL_ROUNDING,
CROSS_ENVIRONMENT_WEBHOOK
```

It returns deterministic client actions (`SHOW_OTP_FORM`), scenarios for wrong OTP, timeout/5xx uncertainty, malformed responses, amount mismatch, duplicate/out-of-order/late webhooks and cross-environment webhooks. It can also start a small HTTP server for manual testing.

The production `PlatformRuntime` does **not** register native adapters and does not consult `NativeAdapterRegistry`. The mock is used by the admin sandbox suite and by tests, not by the live `DynamicRailEngine` path. The native-adapter escape hatch is therefore a primitive, not a wired production route.

### 3.12 Spec importer and Smart AI onboarding

`engine/specImporter/**` implements a four-layer importer:

1. **Schema & version:** `IntegrationSpecSchema` (Zod) and `SPEC_VERSION = "1.0"`.
2. **Semantic & security guard:** `validateSpecSemantics` checks closed sets, URL templates, credential references, unsafe combinations, mobile/inquiry requirements, channel verification strength, PAN handling and similar rules.
3. **Offline vector simulation:** `simulateSpec` drives the real `StepExecutor` against the spec's `test_vectors` with synthetic secrets and an in-memory transport. No gateway host is contacted.
4. **Collision check:** a callback checks whether the gateway/rail code exists and how many versions exist.

The failure report includes diagnostics with `path`, `code`, `message` and an `aiFixHint`, plus `buildRepairPrompt` for an external AI. The transcript builder (`buildTranscriptKit`) emits a Markdown/schema kit the admin hands to an external AI; it exposes the closed vocabularies so the AI cannot invent operations.

`materializeSpec` re-runs the full verification inside core (the Double-Check Rule), then in one transaction:

- Creates or reuses a gateway.
- Creates a new `GatewayVersion` in `DRAFT` with a SHA-256 snapshot hash.
- Writes environments, auth, settings, crypto profiles, rail/fields, flows/steps/parameters/outputs, status rules, error maps, confirmation channels, a route and an optional credential set.
- Encrypts supplied secrets with the vault; missing secret values do not fail the import.
- Returns ids and counts.

It never marks the version live. The admin route then runs a live credential check and leaves the draft for secret binding and go-live approval.

### 3.13 Go-live gates and credential check

`GoLiveGateValidator` evaluates the twelve gates against persisted evidence (sandbox suite, contract tests, channel strength, rollback version, route/commission/statement preview, PCI scope, canary plan, alerts). `activateGatewayVersionInTransaction` refuses activation unless the gates pass and shares the transaction with the state change.

`CredentialCheckService`:

- Resolves the credential set and the pinned (or live) gateway version.
- If the version defines `CREDENTIAL_CHECK` steps, executes them through the `StepExecutor` with real credentials.
- Otherwise probes the environment base URL through `ApiConsumer`, exercising the auth recipe.
- Records `VERIFIED`/`FAILING` and `lastVerifiedAt` on the credential set.
- Is called by the merchant/admin verify routes and lazily on the first `INITIATING` attempt through the engine's `credentialResolver`.

The probe is generic when no check flow exists: a base-URL request with the auth recipe. It does not prove a payment capability.

## 4. Contracts and invariants

1. **Six-method contract.** `preInitiate`, `initiate`, `confirm`, `verifyCallback`, `inquire`, `refund`.
2. **Pinned configuration.** An attempt uses its pinned version, route, credential set and commission profile, not the latest live rows.
3. **Single-winner confirm.** The atomic claim is owned by the caller; the engine only executes SUBMIT for the winner.
4. **Point of no return.** A money-moving `UNKNOWN` attempt with `pointOfNoReturn` cannot be resubmitted.
5. **Five trusted facts.** Status, reference, amount within tolerance, currency and environment.
6. **Money steps never retry.** Enforced in both `StepExecutor` and `ApiConsumer`.
7. **Slot invariant.** A single-use link never commits more than its `use_count`; excess settlements go to `SUSPENSE`.
8. **Atomic success.** Slot commit + ledger posting + SUCCEEDED status share one transaction.
9. **No default commission.** A missing pinned commission is an error, not a rate.
10. **Closed transform library.** 39 pure operations, validated before use; no scripting.
11. **Closed auth/step vocabularies.** The spec importer accepts only names the runtime supports.
12. **Secrets are host-pinned and redacted.** The engine never logs a decrypted secret.

## 5. Data / API / config / deployment surface

### 5.1 Engine data model

- `gateways`, `gateway_versions`, `gateway_environments`, `gateway_auth`, `gateway_settings`.
- `credential_sets` with encrypted entries.
- `rails`, `rail_fields`, `rail_routes`.
- `flows`, `flow_steps`, `step_parameters`, `step_outputs`, `status_rules`, `error_maps`.
- `crypto_profiles`, `confirmation_channels`, `widget_definitions`, `redirect_definitions`, `poll_policies`.
- `payment_attempts`, `attempt_step_logs`, `inbound_events`.
- `commission_profiles`, `velocity_rules`, `operator_cases`, `journal_entries`, `journal_lines`.

### 5.2 Engine/env keys

- `KMS_MASTER_KEY`, optional `KMS_KEYS_JSON` for the vault.
- `CORE_REQUEST_TIMEOUT_MS` on the edge, per-step `timeout_ms` in the flow.
- `WORKER_*` for inquiry/poll/expiry workers.
- `FAKE_RAILS_ENABLED`, `ALLOW_FAKE_RAILS_HOSTS`, `FAKE_RAILS_ALLOWED_HOSTS` for the optional tier.
- `NOTIFICATION_WEBHOOK_URL` for notification steps outside the engine.

### 5.3 Engine routes

- Admin spec/transcript: `GET /gateways/ai-transcript`, `POST /gateways/spec-verify`, `POST /gateways/spec-import`.
- Admin dry-run/suite: `POST /gateway-versions/:vid/dry-run`, `POST /gateway-versions/:vid/run-suite`.
- Admin credential check: `POST /credential-sets/:id/verify`.
- Merchant credential check: `POST /credential-sets/:id/verify`.
- Checkout execution: `POST /pay/:linkKey/initiate`, `POST .../confirm`, `POST .../client-event`, `GET/POST /return/:attemptToken`.
- Admin inquiry: `POST /attempts/:id/inquire`.
- Worker-driven inquiry: `ExpirySweeperWorker`, `PollWorker`.

### 5.4 Compute operations

| Name | Used by |
| :--- | :--- |
| `MOAMALAT_LIGHTBOX_PAYLOAD` | Moamalat embedded lightbox blueprint |
| `NEOMPAY_QR_PAYLOAD` | NeomPay internal QR blueprint |
| `LOCAL_SETTLEMENT_RECONCILE` | no-inquiry rails reconciled from local state |

A declarative flow that names any other compute operation fails with `UNKNOWN_COMPUTE_OPERATION`.

### 5.5 Client actions

The engine recognizes five declarative actions from `RENDER`/public outputs:

- `SHOW_OTP_FORM`
- `HTTP_REDIRECT`
- `RENDER_EMBEDDED`
- `SHOW_QR_OR_CODE`
- `SHOW_PUSH_OR_TRANSFER`

`clientActionFrom` accepts either `{type,payload}` in `public.clientAction` or flat `actionType`/`type` keys in public outputs.

## 6. Operational usage

### 6.1 Add a declarative gateway

1. Build the spec/transcript or edit through the admin builder.
2. Run `POST /gateways/spec-verify` and inspect the four layers.
3. Import with `POST /gateways/spec-import` in `CREATE_NEW` or `NEW_VERSION`.
4. Bind remaining secrets in the admin portal; run `POST /credential-sets/:id/verify`.
5. Run the sandbox suite and go-live gates.
6. Submit the version for approval; a different checker approves it.
7. Activate the route; attempts pin the new version.

### 6.2 Diagnose an attempt

- `GET /internal/admin/attempts/:id` for status/substatus/context.
- `POST /internal/admin/attempts/:id/inquire` to resolve `UNKNOWN`.
- Inspect `attempt_step_logs` for the phase/step outcome (redacted).
- Check `operator_cases` for `CONFLICT`, `LATE_SUCCESS`, `SUSPENSE_SETTLEMENT` or `UNMATCHED_STATEMENT`.
- Check the ledger entry and the journal lines for the money outcome.

### 6.3 Re-run a sandbox scenario

`POST /gateway-versions/:vid/run-suite` runs the 15 mock scenarios and persists evidence for the go-live gate. The mock is deterministic and does not contact a gateway.

### 6.4 Add a native adapter

1. Implement `NativeAdapter` with the six methods.
2. Register it in a `NativeAdapterRegistry` in the composition root.
3. Add a gateway kind/registration lookup in the engine.

Step 3 is not present today; registering an adapter alone does not make the live engine use it.

## 7. Status and deviations

### Implemented

- Six-method `DynamicRailEngine` with a 14-status transition graph.
- Seven runtime phases plus the separate `CREDENTIAL_CHECK` flow.
- Attempt pinning, slot reservation/release/commit, SUSPENSE settlement.
- Trusted-success facts, retryable OTP, late success, conflicting signals, UNKNOWN resolution.
- `StepExecutor` with HTTP/COMPUTE/RENDER/WAIT/ASSERT/BRANCH, parameter sources/places/output stores, idempotency, crypto signatures, SSRF guards and response caps.
- `ApiConsumer` with ten auth methods, single-flight refresh, rotated-token persistence, jitter and money-safe retries.
- Crypto canonicalization/signing and AES-GCM vault/redaction.
- Closed 39-operation transform library with monetary-store validation.
- Visible-rails resolution, ranking, daily caps and exclusion reasons.
- 15-scenario mock gateway and go-live gate validator.
- Four-layer spec importer, transcript builder and DRAFT materializer.
- Credential check flow/probe and lazy first-use verification.

### Partial

- **Phase coverage.** `CANCEL` is in the union and flow mapping but has no engine method or caller. `CAPTURE` and `SETTLEMENT_FETCH` are in the database/spec enum but not in the runtime union or flow mapping.
- **Native adapters.** The registry and mock exist, but production composition does not consult native adapters.
- **Pre-initiate.** The method exists; the checkout route does not call it directly, relying on `initiate` to run the PRE_INITIATE stack.
- **Refund scenarios.** Any successful refund posts `FULL_REFUND` (or `INTERNAL_REFUND`) even when the amount is partial; the resulting status correctly becomes `PARTIALLY_REFUNDED`, but the ledger scenario is not partial-specific.
- **Trusted success.** A sync response must explicitly map `environment`; otherwise an otherwise successful payment is held as `UNKNOWN`.
- **Credential probe.** Without a `CREDENTIAL_CHECK` flow, the check is a generic base-URL probe, not a payment-capability proof.
- **Mock coverage.** The 15 scenarios are unit-level; the 20-gateway blueprint suite is not a live partner contract.

### Missing / deferred

- CAPTURE and SETTLEMENT_FETCH runtime executors and routes.
- A production native-adapter registration/invocation path.
- A true gateway CANCEL flow execution on the checkout cancel route.
- A partial-refund ledger scenario distinct from `FULL_REFUND`.
- A generic OTP resend flow (the API route is a cooldown-only stub).
- Arbitrary scripting (intentionally prohibited).
- A universal live test harness for every partner gateway.

### Known bugs / risks

- **Code gap:** `FlowPhase` includes `CANCEL`; `PrismaFlowProvider` maps it; no engine method or caller executes it.
- **Code gap:** a `MOVES_MONEY` step with a 2xx but missing required output is `UNKNOWN` (correct), but the caller must resolve it through inquiry; no automatic resolution is guaranteed.
- **Code gap:** partial refunds use the full-refund scenario; verify the ledger template handles partial amounts and commission split correctly before relying on it.
- **Code gap:** `evidence.environment` is required for trusted success; declarative flows must output it.
- **Risk:** the in-process commit-LSN map is per core node; a confirm response with `x-pg-min-lsn` followed by a read on another node may not observe the commit.
- **Risk:** `NativeAdapterRegistry` and `MockGatewayServer` can give a false sense that native adapters are live; they are not wired into `PlatformRuntime`.
- **Documentation gap:** historical claims of a "10-phase runtime" and 36 transforms are wrong; the actual counts are seven runtime phases plus a separate credential check, and 39 transforms.

## 8. Verification and tests

- `core-back/test/engine/step-executor.test.ts` covers step types, HTTP, compute, render, retry boundaries, idempotency, assertions, branches and mock scenarios.
- `core-back/test/engine/api-consumer.test.ts` and `api-consumer-primitives.test.ts` cover auth methods, refresh, SSRF, recursive set/select and URL compilation.
- `core-back/test/engine/transform-pipeline.test.ts` covers the 39-operation library and monetary-store restrictions.
- `core-back/test/engine/crypto.test.ts` covers canonicalization, signing, vault and redaction.
- `core-back/test/engine/attempt-state-machine.test.ts` covers allowed/forbidden transitions.
- `core-back/test/engine/pre-initiate.test.ts` covers the pre-initiate path.
- `core-back/test/engine/visible-rails.test.ts` and the exhaustive visible-rails formula matrix cover resolution/ranking/caps.
- `core-back/test/engine/suspense-settlement.test.ts` covers the slot/suspense/rollback contract.
- `core-back/test/engine/go-live-gates.test.ts` and `gateway-rollback-go-live.test.ts` cover go-live evidence and activation.
- `core-back/test/spec-importer.test.ts` and `spec-materializer.test.ts` cover the four layers, repair prompt and atomic materialization.
- `core-back/test/phase3-dynamic-engine-and-blueprints.test.ts` covers the blueprint flows.
- `core-back/test/exhaustive/04-rail-engine/all-20-gateways-24-scenarios.test.ts` is the broad blueprint matrix; it is a repository test, not a live partner certification.

No build or test was run for this documentation change. Tests that require PostgreSQL/Redis or partner sandboxes are environment-dependent.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` §8 engine contract/registry/transforms/crypto, §8.2 six methods, §8.4 transform library, §9 state machine and slot invariant, §14 go-live gates.
- `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md` §6 engine contract and §7 state machine.
- `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md` §5 flow engine, §9 confirmation/verification.
- `design/90-archive/delivery-logs/opencode_technical_delivery_design.md` §15 Smart AI onboarding.
- `design/08-ai-onboarding/smart_ai_rail_and_voucher_onboarding_plan.md`.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` for the emulator intent.

### Code paths

- `core-back/engine/runtime/index.ts`, `platform.ts`, `flowProvider.ts`, `attemptRepository.ts`, `slotStore.ts`.
- `core-back/engine/flow/DynamicRailEngine.ts`, `StepExecutor.ts`, `VisibleRailsResolver.ts`, `VisibleRailsCatalog.ts`, `NativeAdapterRegistry.ts`, `GoLiveGateValidator.ts`.
- `core-back/engine/apiConsumer/ApiConsumer.ts`, `ConsumerRegistry.ts`, `compileUrl.ts`, `recursiveSet.ts`, `recursiveSelect.ts`.
- `core-back/engine/crypto/Vault.ts`, `CryptoEngine.ts`.
- `core-back/engine/transforms/TransformPipeline.ts`.
- `core-back/engine/specImporter/**`.
- `core-back/engine/mockGateway/MockGatewayServer.ts`.
- `core-back/engine/runtime/computeRegistry.ts`.

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/stale-claims-register.md` (SC-002, SC-003, SC-006)

## 10. Change history

- 2026-11-03: Initial canonical core engine part written against `5a24f6f+working-tree`; records the seven runtime phases plus separate credential check, 39 transforms, and the reserved/unwired phases and native adapters.

## Double-Entry Ledger

> Status: `partial` · Last verified: 2026-11-04

## 1. Purpose and scope

This part owns the chart of accounts, journal construction and posting, posting idempotency, account-shard projection, checkpoints, and the system-wide double-entry invariant. It is the only code path allowed to write `journal_entries` and `journal_lines`.

It does not own commission calculation (the engine pins the commission profile onto the attempt), payment lifecycle transitions, approval workflows, or record retention. Those callers must pass a resolved amount, commission, fee, and ownership mode into the ledger. The ledger deliberately rejects an invented fee or an unbalanced template rather than guessing.

Primary dependencies:

- `core-back/engine/ledger/LedgerPoster.ts` — templates, validation, posting, account resolution.
- `core-back/lib/storageEngine/ledgerShardWriter.ts` and `shardBalances.ts` — per-attempt shard projection and shard reads.
- `core-back/engine/ledger/CheckpointService.ts` — checkpoint snapshot and live-balance calculation.
- `core-back/engine/ledger/InvariantVerifier.ts` — system-wide drift check.
- `core-back/prisma/seedGlAccounts.ts` — seeded system accounts and shards.

## 2. Design intent (extracted and synthesized from ./design)

The design requires an append-only, double-entry ledger with a fixed chart of accounts, money as `Decimal(18,4)`, and a system-wide invariant that is checked continuously. It also requires the ledger to support three fee-bearer modes and three ownership modes without allowing the caller to determine the money arbitrarily.

### Fee-bearer modes

| Mode | Payer is charged | Merchant receives | Platform books | Checkout display |
| :--- | :--- | :--- | :--- | :--- |
| `MERCHANT_ABSORBS` | link amount | link amount minus commission | commission gross | `Total: 100.00 LYD` |
| `PAYER_SURCHARGE` | link amount plus surcharge | link amount | commission gross | `100.00 + 3.00 Service Fee = 103.00 LYD` |
| `SPLIT` | link amount plus the payer share of the fee | link amount minus the merchant share | commission gross | shows the agreed split before confirmation |

`buildPaymentConfirmationTemplate` selects the scenario from `feeBearer`, `feeAccrual`, and `ownershipMode` (`core-back/engine/ledger/LedgerPoster.ts:586`). A platform-held confirmation without accrual deducts the provider fee at source; with accrual it books `GATEWAY_FEE_EXPENSE` and `GATEWAY_FEE_ACCRUAL`. A payer surcharge adds `surchargeAmount` on top; a split uses the caller-supplied `merchantAmount`.

### Ownership modes

| Mode | Meaning | Confirmation treatment |
| :--- | :--- | :--- |
| `PLATFORM_CLEARING` | the gateway owes the platform until settlement | debit `GATEWAY_CLEARING`, book provider or gateway fees, credit wallet and income |
| `INTERNAL` | first-party rail (NeomPay); no external clearing account | `INTERNAL_CONFIRMATION`: debit `TREASURY`, credit wallet and income |
| `MERCHANT_DIRECT` | merchant owns the gateway account and receives the money directly | commission only: debit `COMMISSION_RECEIVABLE`, credit `PLATFORM_INCOME`; netting later moves wallet against receivable |

`PROVIDER_HELD` is a valid `settlementTarget` in the schema but is treated as `PLATFORM_CLEARING` by the ownership-mode projection (`core-back/engine/runtime/attemptRepository.ts:56`).

### System-wide invariant

The design states:

```text
TREASURY + SUM(GATEWAY_CLEARING) + SUM(COMMISSION_RECEIVABLE)
==
SUM(MERCHANT_WALLET) + PLATFORM_INCOME
- PROVIDER_FEE_EXPENSE - GATEWAY_FEE_EXPENSE
+ GATEWAY_FEE_ACCRUAL + AML_HOLD + CHARGEBACK_RESERVE + SUSPENSE
```

The implemented verifier applies this equation to natural balances, where debit-positive accounts are taken as-is and credit-positive accounts are negated (`core-back/engine/ledger/InvariantVerifier.ts:27`). The design also describes database triggers for the invariant; the actual database only enforces positive line amounts, while the balance equation is application-level and scheduled.

### The 17 scenarios (design said 15 worked entries)

The historical design listed 15 worked entries. The code now defines 17 `LedgerScenario` values: the original 15 plus `SPLIT_SURCHARGE_CONFIRMATION` and `SUSPENSE_SETTLEMENT`. Three scenarios have multiple stages (merchant-direct netting, AML release, chargeback lost), so the exhaustive matrix contains 20 labels rather than 17.

## 3. As-built architecture

### 3.1 Chart of accounts and scoping

There are 11 `GlAccountType` values in `core-back/prisma/schema.prisma:85`. The account resolver narrows a lookup only by the dimensions that the account type carries:

| Account type | Scope | Natural side |
| :--- | :--- | :--- |
| `TREASURY` | global | debit |
| `GATEWAY_CLEARING` | gateway + environment + credential set | debit |
| `MERCHANT_WALLET` | merchant (`ownerId`) | credit |
| `PLATFORM_INCOME` | global | credit |
| `PROVIDER_FEE_EXPENSE` | global | debit |
| `GATEWAY_FEE_EXPENSE` | global | debit |
| `GATEWAY_FEE_ACCRUAL` | global | credit |
| `COMMISSION_RECEIVABLE` | global | debit |
| `AML_HOLD` | global | credit |
| `CHARGEBACK_RESERVE` | global | credit |
| `SUSPENSE` | global | credit |

`ACCOUNT_SCOPING` and `resolveAccountId` are in `core-back/engine/ledger/LedgerPoster.ts:263` and `:764`. Resolution order is:

1. explicit `selector.accountId`;
2. the caller's `context.accounts[accountType]` override;
3. a scoped `findFirst` using account type plus owner, gateway, credential set, environment, and currency where applicable;
4. a platform-wide fallback with the same account type and currency and null scope dimensions;
5. `GL_ACCOUNT_NOT_FOUND`.

The seed creates all 11 system account types per supported currency (`LYD`, `USD`, `EUR`) with a stable `seedKey` (`core-back/prisma/seedGlAccounts.ts:1`). A new settlement currency requires either a new seeded system account or an explicit account mapping; otherwise posting fails with `GL_ACCOUNT_NOT_FOUND`.

### 3.2 Posting pipeline

`LedgerPoster.post` (`core-back/engine/ledger/LedgerPoster.ts:652`):

1. validates the template: non-empty reference, at least one line, strictly positive amounts, and debit total equal to credit total;
2. checks `journalEntry.findFirst({ refType, refId })` and returns the existing entry as idempotent;
3. creates the journal entry;
4. resolves each line's GL account;
5. creates the journal line with a `Decimal` amount;
6. invokes the optional shard writer in the same transaction;
7. invokes the optional `ledger.entry_posted` outbox writer in the same transaction. Since 2026-11-04 `createLedgerPoster` does NOT emit it by default (`emitOutbox: true` opts in) because the topic has no consumer.

Since 2026-11-04 a posting is batched: one entry insert (`createManyAndReturn` with `skipDuplicates`, so a racing duplicate reference returns the existing entry without aborting the transaction), one account lookup (`findMany` over the OR of scoped and platform-wide predicates, same precedence as before), one journal-line `createManyAndReturn`, and one shard upsert (`unnest`, folded per (account, shard) and sorted so concurrent postings lock shard rows in the same order).

If the entry insert races another transaction, a Prisma `P2002`/`UNIQUE_CONSTRAINT_VIOLATION` is caught, the existing entry is looked up, and the call becomes idempotent (`LedgerPoster.ts:674`).

The production poster is built by `createLedgerPoster` (`core-back/lib/storageEngine/ledgerPosterFactory.ts:17`), which wires the shard writer and the transactional outbox writer. Tests and narrow callers may still construct `LedgerPoster` directly, in which case no shards or outbox rows are written.

### 3.3 Templates and the exact worked entries

All examples use `amount = 100.0000`, `commission = 3.0000`, `providerFee = 1.0000`, `gatewayFee = 0.8000`, `merchantAmount = 97.0000`, unless the scenario needs a different split. The code defaults are 3% commission, 1.0000 provider fee, and 0.8000 gateway fee for the raw scenario builder, but production confirmation is strict and requires the resolved commission and fee.

| # | Scenario | Stage / ref type | Worked entry |
| :---: | :--- | :--- | :--- |
| 1 | `PLATFORM_HELD_CONFIRMATION` | confirm, `PAYMENT_ATTEMPT` | `Dr TREASURY 99.0000`; `Dr PROVIDER_FEE_EXPENSE 1.0000`; `Cr MERCHANT_WALLET 97.0000`; `Cr PLATFORM_INCOME 3.0000` |
| 2 | `PLATFORM_HELD_FEE_ACCRUAL` | confirm, `PAYMENT_ATTEMPT` | `Dr GATEWAY_CLEARING 100.0000`; `Dr GATEWAY_FEE_EXPENSE 0.8000`; `Cr MERCHANT_WALLET 97.0000`; `Cr PLATFORM_INCOME 3.0000`; `Cr GATEWAY_FEE_ACCRUAL 0.8000` |
| 3 | `SETTLEMENT_SWEEP` | sweep, `SETTLEMENT_SWEEP` | `Dr TREASURY 99.2000`; `Dr GATEWAY_FEE_ACCRUAL 0.8000`; `Cr GATEWAY_CLEARING 100.0000` |
| 4 | `FEE_VARIANCE_TRUE_UP` | variance, `FEE_VARIANCE` | `Dr GATEWAY_FEE_EXPENSE 0.1000`; `Cr GATEWAY_FEE_ACCRUAL 0.1000` |
| 5 | `PAYER_SURCHARGE_CONFIRMATION` | confirm, `PAYMENT_ATTEMPT` | `Dr GATEWAY_CLEARING 103.0000`; `Dr GATEWAY_FEE_EXPENSE 0.8000`; `Cr MERCHANT_WALLET 100.0000`; `Cr PLATFORM_INCOME 3.0000`; `Cr GATEWAY_FEE_ACCRUAL 0.8000` |
| 6 | `SPLIT_SURCHARGE_CONFIRMATION` | confirm, `PAYMENT_ATTEMPT` | `Dr GATEWAY_CLEARING 101.5000`; `Dr GATEWAY_FEE_EXPENSE 0.8000`; `Cr MERCHANT_WALLET 98.5000`; `Cr PLATFORM_INCOME 3.0000`; `Cr GATEWAY_FEE_ACCRUAL 0.8000` |
| 7 | `MERCHANT_DIRECT_CONFIRMATION` | confirm, `PAYMENT_ATTEMPT` | `Dr COMMISSION_RECEIVABLE 3.0000`; `Cr PLATFORM_INCOME 3.0000` |
| 7b | `MERCHANT_DIRECT_CONFIRMATION` | netting, `COMMISSION_NETTING` | `Dr MERCHANT_WALLET 3.0000`; `Cr COMMISSION_RECEIVABLE 3.0000` |
| 8 | `AML_HOLD_AND_RELEASE` | hold, `PAYMENT_ATTEMPT` | `Dr GATEWAY_CLEARING 100.0000`; `Cr AML_HOLD 100.0000` |
| 8b | `AML_HOLD_AND_RELEASE` | release, `AML_RELEASE` | `Dr AML_HOLD 100.0000`; `Cr MERCHANT_WALLET 97.0000`; `Cr PLATFORM_INCOME 3.0000` |
| 9 | `CASHOUT` | execution, `ADJUSTMENT` | `Dr MERCHANT_WALLET 100.0000`; `Cr TREASURY 100.0000` |
| 10 | `FULL_REFUND` | execution, `ADJUSTMENT` | `Dr MERCHANT_WALLET 97.0000`; `Dr PLATFORM_INCOME 3.0000`; `Cr TREASURY 100.0000` |
| 11 | `CHARGEBACK_RESERVE_AND_LOST` | reserve, `DISPUTE_OUTCOME` | `Dr MERCHANT_WALLET 97.0000`; `Dr PLATFORM_INCOME 3.0000`; `Cr CHARGEBACK_RESERVE 100.0000` |
| 11b | `CHARGEBACK_RESERVE_AND_LOST` | lost, `DISPUTE_OUTCOME` | `Dr CHARGEBACK_RESERVE 100.0000`; `Cr TREASURY 100.0000` |
| 12 | `AML_VOID` | void, `AML_VOID` | `Dr AML_HOLD 100.0000`; `Cr TREASURY 100.0000` |
| 13 | `CHARGEBACK_WON` | outcome, `DISPUTE_OUTCOME` | `Dr CHARGEBACK_RESERVE 100.0000`; `Cr MERCHANT_WALLET 97.0000`; `Cr PLATFORM_INCOME 3.0000` |
| 14 | `INTERNAL_CONFIRMATION` | confirm, `PAYMENT_ATTEMPT` | `Dr TREASURY 100.0000`; `Cr MERCHANT_WALLET 97.0000`; `Cr PLATFORM_INCOME 3.0000` |
| 15 | `INTERNAL_REFUND` | refund, `ADJUSTMENT` | `Dr MERCHANT_WALLET 97.0000`; `Dr PLATFORM_INCOME 3.0000`; `Cr TREASURY 100.0000` |
| 16 | `CHARGEBACK_INSUFFICIENT` | outcome, `DISPUTE_OUTCOME` | `Dr MERCHANT_WALLET 97.0000`; `Dr PLATFORM_INCOME 3.0000`; `Cr CHARGEBACK_RESERVE 100.0000` |
| 17 | `SUSPENSE_SETTLEMENT` | settlement, `PAYMENT_ATTEMPT` | `Dr TREASURY 100.0000` for `INTERNAL`, otherwise `Dr GATEWAY_CLEARING 100.0000`; `Cr SUSPENSE 100.0000` |

The exact builders are in `core-back/engine/ledger/LedgerPoster.ts:285` through `:576`. The split example deliberately uses a `1.5000` payer surcharge and `98.5000` merchant amount to demonstrate that the template balances only when the caller supplies a consistent merchant amount; the raw builder will produce an invalid template otherwise and `validateTemplate` will reject it.

### 3.4 Strict confirmation vs raw scenario builder

`buildPaymentConfirmationTemplate` (`LedgerPoster.ts:586`) is the production path from the engine (`core-back/engine/flow/DynamicRailEngine.ts:1020`). It enforces:

- `PLATFORM_CLEARING` requires `commissionAmount`;
- `PAYER_SURCHARGE` and `SPLIT` require both `gatewayFeeAmount` and `surchargeAmount`;
- `MERCHANT_ABSORBS` with `feeAccrual` requires `gatewayFeeAmount`;
- `MERCHANT_ABSORBS` without accrual requires `providerFeeAmount`;
- `INTERNAL` and `MERCHANT_DIRECT` bypass the fee checks.

The raw `buildLedgerTemplate` is still public and is used by settlement sweeps, fee variance, suspense, AML, adjustments, cash-out, and tests. Its defaults are convenience defaults, not a production authority: any new production caller should pass explicit money.

### 3.5 Shard writer and shard balances

`createLedgerShardWriter` (`core-back/lib/storageEngine/ledgerShardWriter.ts:8`) projects every journal line into `gl_account_shards`:

- default shard count is 16 (`DEFAULT_SHARD_COUNT`);
- `MERCHANT_WALLET` uses one shard, `shard_id = 0`;
- every other account type uses `fnv1aHash(refId) % shardCount`;
- a debit is a positive delta, a credit is negative;
- the insert uses `ON CONFLICT (gl_account_id, shard_id) DO UPDATE` and creates the shard row on demand;
- the write runs inside the same transaction as the journal line.

`shardIdForAttempt` receives `line.refId` for every reference type, not only payment attempts. An adjustment, dispute, settlement batch, or fee variance therefore hashes its own reference. `ensureAccountShards` exists to pre-provision all shards for an account, but production does not call it; the seed provisions shards for the seeded system accounts and merchant shards are created on first posting.

`naturalShardBalance` (`core-back/lib/storageEngine/shardBalances.ts:86`) negates credit-positive accounts so a shard sum can be displayed as a natural balance. `loadShardBalanceRows` groups by account and returns only accounts that actually have shard rows.

### 3.6 Checkpoints

`CheckpointService.captureCheckpoint` (`core-back/engine/ledger/CheckpointService.ts:44`):

1. locks the GL account with `SELECT ... FOR UPDATE` when raw SQL is available;
2. sums all journal lines up to `asOf`;
3. chooses `lastCheckpointId` from the latest journal entry, or a synthetic `checkpoint:<account>:<timestamp>` string;
4. writes `checkpointBalance`, `checkpointAt`, and `lastCheckpointId` onto `gl_accounts`.

`getLiveBalance` adds the checkpoint balance to lines strictly after `checkpointAt` (`CheckpointService.ts:94`). There is no checkpoint-history table; the checkpoint is represented only by the three fields on `gl_accounts`. `captureCheckpoint` has no production caller: only the ledger tests and the exhaustive checkpoint suite exercise it. The runtime reads `checkpointBalance`/`checkpointAt` in the verifier and in the admin fallback, but no scheduled job captures new checkpoints.

### 3.7 Invariant verifier

`InvariantVerifier.verify` accepts either a Prisma-like client or a balance provider. With a client it loads every GL account and sums the lines after that account's checkpoint (`InvariantVerifier.ts:107`). It groups natural balances by account type and computes the invariant. `assertInvariant` throws on non-zero drift.

Production uses the verifier in two places:

- `LedgerInvariantWorker` checks every 60 seconds and opens one open `MISMATCH`/`P1` operator case when drift is non-zero (`core-back/engine/workers/LedgerInvariantWorker.ts:16`);
- the admin finance/invariant endpoint computes the same snapshot on demand (`core-back/api/internal/admin.ts:15090`).

### 3.8 Balance-read reality

There is no single balance-read path. The actual sources are:

| Reader | Source | Behavior when shards are absent |
| :--- | :--- | :--- |
| Merchant `GET /wallets/:id/balance` | shard sum first | falls back to `checkpointBalance + every journal line` (`core-back/api/internal/merchant.ts:1370`) |
| `merchantWalletBalance` helper | shard sum first | falls back to `checkpointBalance + every journal line` (`core-back/lib/merchantOps.ts:176`) |
| Admin ledger balances | shard sum first | falls back to `checkpointBalance + lines since checkpointAt` (`core-back/api/internal/admin.ts:14626`) |
| Invariant verifier | checkpoint plus lines since checkpoint | always journal-based |
| Merchant `getWalletBalance` repository | sum of shard rows | returns zero when no shard rows exist (`core-back/engine/db/repositories.ts:162`) |

The merchant fallbacks start from the checkpoint balance and then add *all* journal lines. As long as no checkpoint has been captured (`checkpointBalance = 0`, `checkpointAt = null`) this is correct. If `CheckpointService` is ever activated, those fallbacks will double count the checkpoint window. This is a code gap, not an intentional design.

## 4. Contracts and invariants

1. Every journal entry must have at least one debit and one credit, debit total must equal credit total, and every line amount must be strictly positive. `validateTemplate` enforces this before insertion (`LedgerPoster.ts:740`).
2. `(refType, refId)` is unique. Posting is idempotent for that pair. A duplicate returns the existing entry with `created: false`, `idempotent: true`, and an empty `lines` array.
3. Money is `Decimal(18,4)`; no floating-point arithmetic is used in posting or validation.
4. Journal lines are append-only. The application exposes no update or delete path, and retention deliberately excludes `journal_entries` and `journal_lines`.
5. A zero optional leg is omitted rather than booked as a zero line (`optionalLine`, `LedgerPoster.ts:252`).
6. Account resolution never invents an account: a missing scoped account falls back only to the same type and currency, and then fails with `GL_ACCOUNT_NOT_FOUND`.
7. Shard projection is in the same transaction as the journal line. A shard balance is the signed sum of every line projected to that shard; the natural balance negates credit-positive accounts.
8. A checkpoint is a snapshot, not a replacement for journal lines. A live balance is checkpoint plus later lines. A checkpoint must serialize against postings to the same account.
9. The invariant equation is the authoritative system-wide check. A non-zero drift is an operational incident and opens a P1 case.
10. Adjustment, refund, chargeback, cash-out, AML release/void, and suspense postings use the same ledger and the same idempotency contract.

## 5. Data / API / config / deployment surface

### Schema

- `GlAccount`: `accountType`, `ownerId`, `gatewayId`, `credentialSetId`, `env`, `currency`, `lastCheckpointId`, `checkpointBalance`, `checkpointAt`, `seedKey`.
- `GlAccountShard`: composite primary key `(glAccountId, shardId)`, `currentBalance`, `updatedAt`.
- `JournalEntry`: unique `(refType, refId)`; `JournalRefType` values are `PAYMENT_ATTEMPT`, `ADJUSTMENT`, `AML_RELEASE`, `AML_VOID`, `SETTLEMENT_SWEEP`, `FEE_VARIANCE`, `COMMISSION_NETTING`, `DISPUTE_OUTCOME`.
- `JournalLine`: `entryId`, `glAccountId`, `direction`, `amount`; primary key `(id, createdAt)` because the table is monthly range-partitioned; indexes on `(entryId, createdAt)` and `(glAccountId, createdAt)`.
- Database checks: `journal_lines_amount_positive`; no balance trigger.

### Configuration

- `STORAGE_SHARD_COUNT` defaults to 16 and is capped at 16 (`core-back/lib/env/index.ts:63`).
- Supported currencies are seeded from `SUPPORTED_CURRENCIES = ["LYD", "USD", "EUR"]` (`core-back/prisma/seedGlAccounts.ts`).
- The production poster is constructed once in `core-back/engine/runtime/platform.ts:132`; the same instance is given to the engine, governance execution, and the background-job handlers.

### Read surfaces

- Merchant wallet balance: `GET /internal/merchant/wallets/:id/balance`.
- Admin invariant/liquidity: finance routes backed by `InvariantVerifier` and `loadLedgerBalances`.
- Worker: `LedgerInvariantWorker` every 60 seconds.
- No public ledger API exists. The ledger is internal to `core-back`; edges never receive database credentials.

## 6. Operational usage

### Posting a journal

Use `postPaymentConfirmation` for a settled payment. Supply the pinned commission and fee; do not rely on the raw builder defaults:

```text
postPaymentConfirmation(attemptId, {
  ownershipMode,
  feeBearer,
  feeAccrual,
  amount,
  surchargeAmount,
  commissionAmount,
  merchantAmount,
  gatewayFeeAmount,
  providerFeeAmount,
})
```

Use `postScenario` for settlement sweeps, fee variance, suspense, AML, and adjustments. Set a stable `refId`; the ledger dedupes on `(refType, refId)`.

### Adding an account or currency

1. Add/seed `gl_accounts` rows for every currency-scoped account type.
2. Seed or allow the shard writer to create shards. `ensureAccountShards` is available for explicit provisioning.
3. Add the currency to the seed and to any currency validation before accepting payments in it.
4. Verify a posting in that currency resolves every account type it uses; otherwise the confirmation fails with `GL_ACCOUNT_NOT_FOUND`.

### Investigating a balance

1. Read `gl_accounts.checkpoint_balance` and `checkpoint_at`.
2. Read `gl_account_shards` for the account. If rows exist, their signed sum is the intended fast balance.
3. If no shard rows exist, use the admin/journal fallback: checkpoint plus lines since `checkpointAt`.
4. Do not use the merchant fallback as the authority once checkpoints are active; it adds all lines.
5. Run the invariant verifier. Non-zero drift means the journal itself is inconsistent, not merely a stale shard.

## 7. Status and deviations

### Implemented

- 11 GL account types and currency-scoped system-account seeding.
- 17 scenario builders and strict payment-confirmation builder.
- Balanced-template validation, positive line validation, idempotent posting.
- Account resolution with scoped and platform-wide fallback.
- Transactional shard projection with 16-way hashing and one-shard merchant wallets.
- Checkpoint capture/get-live-balance service (code-complete, not scheduled).
- Scheduled invariant worker and on-demand verifier.
- Suspense routing and AML hold/release/void posting.
- Adjustment, refund, chargeback, cash-out, settlement sweep, and fee-variance postings.

### Partial

- **Checkpoint lifecycle** — the service exists but no runtime schedules it, no checkpoint history is retained, and no administrative route captures one.
- **Shard lifecycle** — writes are projected, but there is no rebuild, reconciliation, or drift detector for shards; `ensureAccountShards` is test-only.
- **Balance reads** — three different read paths exist. Admin and verifier use “since checkpoint”; merchant fallbacks use “all lines”.
- **Scenario coverage** — some scenarios are exercised mainly by template tests (`PLATFORM_HELD_*`, `PAYER_SURCHARGE`, `SPLIT`, `MERCHANT_DIRECT` netting) rather than by every runtime path. The engine and governance paths use the main confirmation, sweep, suspense, AML, refund, chargeback, and cash-out scenarios.
- **Database enforcement** — only the positive-amount check and the approval maker/checker constraint are in PostgreSQL; journal balance is application-level.

### Missing / deferred

- No database trigger or deferred constraint that rejects an unbalanced journal entry.
- No `ledger_checkpoints` table or checkpoint audit trail.
- No shard repair/rebuild command.
- No automatic shard-to-journal reconciliation alert separate from the invariant worker.
- No support for currencies beyond the seeded `LYD`, `USD`, `EUR` without manual seeding.

### Known bugs / risks

- **Code gap:** merchant wallet and `merchantWalletBalance` fallbacks double count a captured checkpoint because they add every line to `checkpointBalance`. They are currently masked because no checkpoint is captured in production.
- **Code gap:** idempotent replay of the same `(refType, refId)` with a different template silently returns the first entry; it does not compare the line set or amounts. A caller that reuses a reference for a different economic event loses the second posting.
- **Code gap:** `getWalletBalance` in the repository returns `0` when an account has no shard rows, unlike the API helper that falls back to journal lines. Callers using the repository directly must not treat zero as authoritative before shards exist.
- **Documentation gap:** `core-back/test/engine/ledger.test.ts` describes “all 16 journal entry templates”; the exhaustive matrix header says “15” and asserts 20 labels. The canonical count is 17 scenarios / 20 staged variants.
- **Risk:** the raw scenario builder defaults commission/provider/gateway fee. A production caller that forgets a fee will silently book the default rather than fail. Use `postPaymentConfirmation` or pass every amount explicitly.

## 8. Verification and tests

Run:

```bash
cd core-back && bun test test/engine/ledger.test.ts
cd core-back && bun test test/phase2-ledger-and-governance.test.ts
cd core-back && bun test test/exhaustive/02-ledger
cd core-back && bun test test/storage-engine/ledger-shards.test.ts
```

Coverage:

- `test/engine/ledger.test.ts` — template balance, scenario semantics, strict fee resolution, idempotency, unbalanced rejection, checkpoint service, invariant provider.
- `test/exhaustive/02-ledger/all-15-templates-matrix.test.ts` — 20 labels × 3 currencies × 5 amount tiers × 4 fee configurations = 1,200 template constructions.
- `test/exhaustive/02-ledger/checkpoints-and-invariant.test.ts` — checkpoint snapshot, no double count, 500-entry fuzz drift, deliberate drift detection; requires PostgreSQL and skips otherwise.
- `test/exhaustive/02-ledger/commission-hierarchy-and-bearers.test.ts` / `property-fuzzer-10k.test.ts` — commission precedence, fee-bearer matrices, 10,000 deterministic monetary iterations.
- `test/storage-engine/ledger-shards.test.ts` / `uow.test.ts` / `write-path.integration.test.ts` — 16-shard distribution, merchant one-shard rule, parity after concurrent postings, `ensureAccountShards`, atomic ledger/outbox/shard write path; live PostgreSQL required.

The unit suites run without PostgreSQL. The checkpoint, shard, UoW, and write-path integration suites require PostgreSQL 18 and report as skipped when the database is unavailable.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` §11 — fee bearers, invariant, 15 worked entries; `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md` §9 — original ledger model and entries.
- `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md` §10 — clearing account rationale and merchant-direct model; `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` §3.1 — sharded sub-accounts and read path.
- `core-back/test/exhaustive/02-ledger/all-15-templates-matrix.test.ts` — current 20-label matrix despite the historical title.

### Code paths

- `core-back/engine/ledger/LedgerPoster.ts`
- `core-back/engine/ledger/CheckpointService.ts`
- `core-back/engine/ledger/InvariantVerifier.ts`
- `core-back/lib/storageEngine/ledgerShardWriter.ts`
- `core-back/lib/storageEngine/shardBalances.ts`
- `core-back/lib/storageEngine/ledgerPosterFactory.ts`
- `core-back/lib/storageEngine/uowAdapter.ts`
- `core-back/engine/flow/DynamicRailEngine.ts`
- `core-back/engine/governance/GovernanceExecution.ts`
- `core-back/engine/runtime/slotStore.ts`
- `core-back/engine/workers/BackgroundJobHandlers.ts`
- `core-back/prisma/seedGlAccounts.ts`
- `core-back/prisma/schema.prisma`

### Generated appendices

- `project-design/appendices/schema-catalog.md` — GL, journal, and shard models.
- `project-design/appendices/migration-catalog.md` — baseline, storage-engine, and hardening migrations.
- `project-design/appendices/test-inventory.md` — ledger suite inventory.

## 10. Change history

- 2026-11-03 — Baseline verification against `5a24f6f+working-tree`: documented the 17 scenarios, 11 account types, shard writer, checkpoint and verifier behavior, balance-read differences, and the missing database balance enforcement.

## Governance and Compliance

> Status: `partial` · Last verified: 2026-11-03

## 1. Purpose and scope

This part owns the four-eyes approval wrapper, governance execution handlers, merchant onboarding and KYB, AML screening and rules, AML cases and hold escrow, disputes and adjustments, cash-outs, regulatory reporting, operator cases and inquiry schedules, confidentiality/tipping-off controls, and the authority model.

It does not own the ledger templates themselves (see `core.ledger`), the rail engine, or the payment lifecycle. It calls those subsystems inside its transactions. It also does not own the frontend approval screens; it defines the server-side contracts they use.

## 2. Design intent (extracted and synthesized from ./design)

The design defines ten roles (`GATEWAY_ADMIN`, `SECURITY_ADMIN`, `FINANCE`, `OPERATOR`, `COMPLIANCE`, `MLRO`, `SUPPORT`, `MERCHANT_ADMIN`, `MERCHANT_STAFF`, `MERCHANT_CASHIER`), a closed `authorities_map` catalogue, and a single `approval_requests` wrapper for every sensitive action. The intended lifecycle is `DRAFT -> PENDING_REVIEW -> APPROVED -> EXECUTED`, with a rejection returning to `DRAFT`. Maker and checker must differ, and the database enforces this with a `CHECK` constraint and an update trigger.

The design's four-eyes matrix covers:

| Action | Intended maker | Intended checker |
| :--- | :--- | :--- |
| Adjustment (refund, chargeback, manual credit/debit, correction) | `FINANCE`, `OPERATOR`, or system drafting | `FINANCE`, different user |
| Cash-out completion/subtraction | `FINANCE` | `FINANCE`, different user |
| Commission profile create/change | `FINANCE` | `FINANCE` or `SECURITY_ADMIN` |
| Sensitive merchant fields | `OPERATOR`, `COMPLIANCE`, or merchant request | `COMPLIANCE` or `FINANCE` by field domain |
| Sensitive application fields | merchant admin or operator | operator or compliance |
| Velocity and AML rules | `COMPLIANCE`/`FINANCE` | `MLRO` for AML; `SECURITY_ADMIN`/`FINANCE` for velocity |
| AML case release/void/freeze | `COMPLIANCE` | `MLRO` |
| Regulatory report submission | `COMPLIANCE` | `MLRO` |
| Join-request decision | `OPERATOR`/`COMPLIANCE` | per `join_request.four_eyes_policy` |
| Merchant suspension | `OPERATOR`/`COMPLIANCE` | emergency ratification within 24 h |
| Merchant reinstatement | `OPERATOR`/`COMPLIANCE` | `COMPLIANCE`/`MLRO`, never emergency |
| Gateway version go-live and credential changes | `GATEWAY_ADMIN` | `SECURITY_ADMIN` |
| Admin user/role/authority changes | `SECURITY_ADMIN` | another `SECURITY_ADMIN` |
| `platform_settings` compliance keys | `COMPLIANCE`/`FINANCE` | `MLRO`/`SECURITY_ADMIN` |

The design also specifies the onboarding state machine, KYB document controls, field classification and pending-change semantics, the seven-layer AML program, declarative AML rules, dispute intake and automated drafting, regulatory reporting as configuration, operator cases, and strict no-tipping-off rules.

## 3. As-built architecture

### 3.1 Authority model

Authentication is bearer-token based (`core-back/api/middleware/authDoubleCheck.ts`). A session resolves the user's `authoritiesMap`; an API token resolves its `scopes` and optional IP allowlist. Empty authorities are rejected for a session. `requireAuthorities` accepts a request if the principal has any one of the listed authorities or `*`; it is an OR check, not an AND check.

`actorFromRequest` requires a human user, rejects the `SYSTEM_AUTOMATION` role, and marks the actor as a checker only when `approval:check` is present (`core-back/api/middleware/makerCheckerGuard.ts:13`). `assertCheckerIsNotMaker` is reused by the admin routes.

The seeded production roles are inconsistent with the design matrix: only `FINANCE` receives `approval:check` and `approval:write`; `COMPLIANCE`, `MLRO`, `OPERATOR`, `SECURITY_ADMIN`, and `SUPPORT` do not (`core-back/prisma/seed.ts:160`). The approval route therefore cannot be exercised as designed by the seeded compliance roles without a custom authority grant.

### 3.2 Approval lifecycle as implemented

`ApprovalService` (`core-back/engine/governance/ApprovalService.ts:270`):

- `proposeApproval` validates the maker, JSON patch shape, and base version, then creates the row directly in `PENDING_REVIEW` (not `DRAFT`); `DRAFT` exists in the enum and UI filters but most producers do not use it.
- `approveRequest` allows a request in `PENDING_REVIEW` or `APPROVED`, rejects maker = checker, verifies `baseVersion`, applies the patch callback, executes the handler callback, and sets `EXECUTED` (or `APPROVED` when `executeImmediately === false`).
- `rejectRequest` requires a reason and sets `REJECTED`; it does not return the request to `DRAFT`.
- `emergencyExecuteWithRatification` executes immediately without a checker, records `EMERGENCY_RATIFICATION`, and sets a ratification deadline. The ratifier only records `checkerUserId` and a note; the request is already `EXECUTED`, and the ratification does not re-run the execution.
- `SYSTEM_AUTOMATION` is rejected as a checker and as a human actor.

The actual admin approve route (`core-back/api/internal/admin.ts:6014`) is more specific than the service:

- requires `approval:check` (via `assertCheckerAuthority`) and either `approval:check` or `approval:write` in the route guard;
- permits `PENDING_REVIEW` or `DRAFT`;
- rejects expired requests;
- enforces maker ≠ checker;
- adds a join-request admin-assisted maker check and a merchant payload checker-domain check;
- special-cases `BACKUP_POLICY` through the backup daemon;
- queues `ADJUSTMENT` execution as a background job and executes everything else through `executeApprovalSubject` in one transaction;
- records a decision checklist audit row.

### 3.3 Execution coverage by subject type

`executeApprovalSubject` (`core-back/engine/governance/GovernanceExecution.ts:3035`) dispatches only the following subject types:

| Subject type | Handler | Notes |
| :--- | :--- | :--- |
| `AML_CASE` | `executeAmlCaseResolution` | Release/void posts ledger, finalises attempt and slot; `MERCHANT_DIRECT` is case-only. |
| `OPERATOR_CASE` | `executeOperatorCaseResolution` | `MARK_SUCCEEDED`, `MARK_FAILED`, `CLOSE_CASE`; may post confirmation or release a slot. |
| `ADJUSTMENT` | `executeAdjustment` | Chargeback, refund, correction, manual credit/debit; refund runs three phases around the gateway call. |
| `REGULATORY_REPORT` | `executeRegulatoryReportApproval` | Sets report to `APPROVED`; submission is a separate route. |
| `REPORTING_RULE` | `executeReportingRuleApproval` | Promotes a rule to `CONFIRMED`. |
| `AML_RULE` | inline handler | Activates the rule and increments its version. |
| `JOIN_REQUEST` | `activateApprovedJoinRequest` or inline rejection | Approval activates merchant and KYB; rejection sets merchant `REJECTED` when still pending. |
| `MERCHANT` | `executeMerchantPatch` / `executeMerchantLifecycle` | Sensitive field patch, suspend, emergency suspension, reinstate, close. |
| `COMMISSION_PROFILE` | `executeCommissionProfileExpiry` | Only the expiry lifecycle is executable; create/change does not create an approval. |
| `VELOCITY_RULE` | `executeVelocityRuleDeactivation` | Only deactivation is executable; create is direct. |
| `USER` | `executeUserAuthorityChange` | Applies role/authority map. |
| `GATEWAY_VERSION` | `activateGatewayVersionInTransaction` | Runs the go-live gates and supersedes the previous live version. |

**Missing handlers:** `APPLICATION`, `CASHOUT_REQUEST`, and `PLATFORM_SETTING` have no branch. The merchant application route does create `APPLICATION` approval rows for sensitive changes (`core-back/api/internal/merchant.ts:1537`), but approving one fails with `NO_EXECUTABLE_SUBJECT`. `CASHOUT_REQUEST` appears in the approval-domain map but no cash-out approval is created. `PLATFORM_SETTING` appears in the settings domain and the schema links settings to approvals, but `PUT /admin/settings` writes new versions directly (`core-back/api/internal/admin.ts:16132`).

Other subject types that appear in the queue/domain map but have no `executeApprovalSubject` branch are `KYB_DOCUMENT`, `GATEWAY`, and `CREDENTIAL_SET`. `BACKUP_POLICY` is handled by a special branch in the approve route rather than by the dispatcher.

The dispatcher enforces maker ≠ checker and rejects system automation, but it does not re-check a domain-specific role for AML, regulatory reporting, user administration, or gateway version go-live. Within the dispatcher, only chargeback execution checks that the checker is a finance checker (`assertFinanceChecker` in `GovernanceExecution.ts`).

### 3.4 Detail change log

Admin merchant descriptive edits write `detail_change_logs` rows directly inside the update transaction (`core-back/api/internal/admin.ts:5369`). Emergency suspension writes status field rows tied to the approval (`admin.ts:5511`). Approved sensitive merchant patches write one row per JSON Patch operation inside `executeMerchantPatch`, with the checker as actor, the approval id as request id, and source `ADMIN` (`GovernanceExecution.ts:942`).

`DetailChangeService` implements recursive JSON diffing and optional redaction, but no production route constructs or calls it. The implemented log therefore has narrower coverage than the design's “every edit, with source/request/IP” semantics, and the actor recorded for a sensitive change is the checker rather than the maker.

### 3.5 Onboarding and KYB

The join-request state machine is implemented in `core-back/api/internal/admin.ts`:

- admin-assisted creation starts in `DRAFT`; submit performs profile/owner/document checks, runs onboarding screening, computes the four-eyes decision, refreshes duplicate flags, and sets `SUBMITTED`, `IN_REVIEW`, or a screening outcome;
- assign moves to `IN_REVIEW`;
- request-info pauses the SLA by storing `slaPausedAt` and `slaRemainingSeconds` and sets `INFO_REQUESTED`;
- decide enforces readiness, blocks open confirmed-match cases, creates an approval when `fourEyesRequired`, or executes approval/rejection inline when it is not;
- withdraw invalidates a pending approval and sets `WITHDRAWN`;
- `JoinRequestExpiryWorker` expires abandoned drafts and overdue reviews.

Readiness (`core-back/lib/joinRequestOnboarding.ts:249`) requires the canonical checklist, required accepted and unexpired documents, active beneficial owners meeting the ownership threshold, owner screening status, a non-blocked screening result, and a payout bank; it reports `approvalPending` separately rather than adding it to `blockers`. Duplicate detection compares tax id, registration, phone, and e-mail and hashes the payout account, owner national id, and document SHA-256 (`joinRequestOnboarding.ts:84`).

The four-eyes decision (`core-back/api/internal/merchant.ts:358`) reads `join_request.four_eyes_policy` and supports `ALWAYS`, `RISK_BASED`, and `NEVER`. Risk-based triggers include high risk tier, any screening match list, PEP owners, large ownership share, high-risk category, previous rejection, duplicate/related flags, payout owner mismatch, and expected volume above threshold.

KYB controls (`core-back/lib/kybReview.ts`) implement expiry state, actionable-document rules, duplicate justification, payout-holder name comparison, configurable required documents, refresh policy, and KYB status recomputation. `KybExpiryWorker` marks expired documents, queues 30/7-day notices, suspends after the grace period, starts periodic revalidations, and expires overdue revalidation requests.

### 3.6 AML program

The seven design layers map to code as follows:

| Layer | Actual implementation |
| :--- | :--- |
| L1 onboarding screening | `MerchantScreeningService.submitOnboarding`, called from join-request submit; confirmed match raises a case and blocks activation; provider error fails closed. |
| L2 ongoing screening | `PeriodicScreeningWorker` re-screens active merchants on the configured interval, refreshes list versions, raises one confirmed-match case and suspends the merchant. |
| L3 transaction-time posture | `AttemptGuardPipeline` checks merchant status, velocity, local watch-list, and AML rules inside the attempt-creation transaction; a confirmed sanctions match or a `BLOCK` rule creates a terminal blocked attempt. |
| L4 transaction monitoring | AML rules are evaluated at attempt initiation. There is no deferred confirmation pass and no daily batch analytics for structuring/fan-in/fan-out. |
| L5 case management | `aml_cases` with severity, SLA, reviewer, confidential flag; resolution is proposed by a confidential reviewer and approved by a different checker; release/void post the ledger and finalise the attempt. |
| L6 regulatory reporting | `ReportingRuleEvaluator` creates reports on settlement; manual report drafting, approval, submit, and acknowledge routes exist. Submission is not integrated with an authority adapter. |
| L7 record keeping | Audit rows, rule versions, detail changes, and the retention worker. Retention is opt-in and incomplete for AML evidence. |

Screening is a provider interface (`ScreeningProvider`) with Arabic normalization, name similarity, internal watch-list provider, mock provider, and a cached provider. `MerchantScreeningService` persists `aml_screenings` and `aml_screening_matches` with list versions and input hashes, applies owner screening status, and raises a confirmed-match case only. Potential matches remain in the screening queue for disposition.

The AML rule engine (`core-back/engine/guards/AmlRuleEngine.ts`) supports `SINGLE_AMOUNT`, `CUMULATIVE_WINDOW`, `STRUCTURING`, `RISK_TIER`, `COUNTERPARTY_COUNTRY`, `RAIL`, and `MERCHANT_DIRECT_AMOUNT`; actions are `HOLD`, `FLAG`, `BLOCK`, `CASE_ONLY`. Severity starts at the rule base, correlates with velocity, raises for high merchant tier, volume multiple, another open case, confirmed sanctions, and potential PEP. On a `HOLD`, the guard posts `Dr GATEWAY_CLEARING` / `Cr AML_HOLD` and stores the hold journal entry on the case.

AML case resolution (`GovernanceExecution.ts:1470`):

- `RELEASE` posts `AML_HOLD_AND_RELEASE` release lines, sets attempt `SUCCEEDED`, commits the link slot.
- `REJECT` posts `AML_VOID`, sets attempt `FAILED`, releases the slot.
- `ESCALATE` leaves the money in `AML_HOLD`, sets `ESCALATED_STR`, and opens a P1 operator case.
- `HOLD` freezes the case without moving money.
- `MERCHANT_DIRECT` cases never post.

### 3.7 Disputes and adjustments

Dispute intake is exposed as `POST /admin/disputes`; the route queues an `ADJUSTMENT_EXECUTION` job with `kind: DISPUTE_INTAKE` and answers `202`. The worker transaction calls `openDisputeWithDraftedAdjustment` (`core-back/engine/workers/BackgroundJobHandlers.ts:359`), which:

1. dedupes on `(gatewayId, externalDisputeRef)`;
2. locks the attempt, caps the chargeback to the unrefunded amount;
3. creates the dispute;
4. creates a `CHARGEBACK` adjustment in `PENDING_REVIEW` and a `SYSTEM_AUTOMATION` approval request;
5. posts the reserve leg for non-`MERCHANT_DIRECT` settlements;
6. writes audit rows.

There is no webhook or statement dispute-intake wiring in `DynamicRailEngine` or reconciliation; the admin manual route is the implemented intake path.

Adjustment execution supports `REFUND` (three phases: claim, gateway refund, finalize), `CHARGEBACK` (won/lost/insufficient), `CORRECTION` (fee variance), `MANUAL_DEBIT`/`CASHOUT_SUBTRACTION` (cash-out template), and `MANUAL_CREDIT` (internal confirmation with zero commission). Chargebacks require a finance checker; a missing dispute outcome or a breach of `negativeBalanceCeiling` holds the adjustment and opens an operator case. Refunds are capped to the unrefunded settled amount and are idempotent on the adjustment id.

### 3.8 Cash-outs

A merchant creates a `CashoutRequest` in `PENDING` with a destination bank snapshot (`core-back/api/internal/merchant.ts:1828`). The admin `POST /admin/cashouts/:id/process` route calls `executeCashout` directly (`core-back/api/internal/admin.ts:14219`). `executeCashout` creates a `CASHOUT_SUBTRACTION` adjustment, posts `CASHOUT` (`Dr MERCHANT_WALLET` / `Cr TREASURY`), sets the request to `COMPLETE`, and writes audit. Rejection creates a rejected adjustment and sets `REJECTED`.

No `CASHOUT_REQUEST` approval row is created and there is no `PENDING -> PROCESSING -> COMPLETE -> SUBTRACTED` transition; `PROCESSING` and `SUBTRACTED` exist in the enum but the execute path writes `COMPLETE` directly on approval. The route requires `cashout:review` or `finance:write`, but one actor can process a request without a recorded second approval.

### 3.9 Regulatory reporting

`ReportingRuleEvaluator` (`core-back/engine/compliance/ReportingRuleEvaluator.ts:130`) evaluates a settled attempt against effective rules. A `CONFIRMED` rule creates a `PENDING_CHECKER` report; a `PROVISIONAL` rule creates a `DRAFT` internal-only report. Evaluation is idempotent per rule and attempt, and the confirmation path calls it after a successful settlement.

Manual report creation (`createRegulatoryReportViaApproval`) creates a `PENDING_CHECKER` report and a `REGULATORY_REPORT` approval in one transaction. Approval sets `APPROVED`; submission is a separate reporting-authority route that requires an `APPROVED` report, enforces maker ≠ submitter when the approval has a maker, and rejects a report linked to a non-`CONFIRMED` rule. Acknowledgement records `ACKNOWLEDGED` or `REJECTED_BY_AUTHORITY` with a reason.

Report payloads generated by the evaluator are encrypted with `VaultContextCipher("reporting-payload")`. Manual report creation stores `JSON.stringify(payload)` directly in `payload_ciphertext` (despite the column name), and the admin read path parses it as plaintext JSON. This is a code gap against the confidentiality intent.

### 3.10 Operator cases and inquiry schedules

`PrismaOperatorCaseSink` opens an operator case at most once per `(attemptId, kind)` while the case is `OPEN`, `IN_PROGRESS`, or `PENDING_CHECKER` (`core-back/engine/compliance/OperatorCaseSink.ts`). The engine opens cases for `LATE_SUCCESS`, `CONFLICT`, expiring attempts, and other flow findings.

Operator resolution is a maker action: `POST /admin/operator-cases/:id/resolve` creates an `OPERATOR_CASE` approval and sets the case to `PENDING_CHECKER`; the approval executes `MARK_SUCCEEDED`, `MARK_FAILED`, or `CLOSE_CASE`. Bulk inquiry schedules a persisted `GatewayInquirySchedule` after eligibility checks (case state, attempt status, terminal state, gateway status-check support). Cancellation, run-now, and retry update the schedule and the attempt's `nextCheckAt`; the poll worker owns execution and schedule reconciliation.

### 3.11 Tipping-off and confidentiality

`core-back/engine/compliance/tippingOff.ts` rejects non-`INTERNAL` notification templates whose subject or body references AML variables, redacts AML-like payload keys for non-`INTERNAL` classes, and renders templates. The notification worker calls `assertNoTippingOff` before delivery, so a template that would tip off a merchant is recorded as a delivery failure (retried up to the cap) rather than sent.

AML reads are gated by `hasConfidentialAmlAccess`: `COMPLIANCE`/`MLRO` roles pass, or a principal with `aml:read`/`aml:write` passes. Every `/admin/aml/*` route calls `assertConfidential`. Reporting submission/acknowledgement additionally calls `assertReportingAuthority`. This gate is not applied to the generic `/admin/approvals/:id` route, so a principal with `approval:check` can approve an `AML_CASE` without confidential AML access.

## 4. Contracts and invariants

1. Maker and checker must be different users. The database has `approval_requests_checker_not_maker_insert` plus an update trigger; the application also checks.
2. `SYSTEM_AUTOMATION` can be a maker (for dispute drafts) but can never be a checker, ratifier, or human actor.
3. An approval can only execute from `DRAFT`/`PENDING_REVIEW` in the admin route, must not be expired, and a base-versioned approval must match the subject's current version or fail with `BASE_VERSION_MISMATCH`.
4. A rejection requires a reason and never executes.
5. A successful approval must execute its subject atomically with the state change where the handler supports it. Adjustments are queued; the job uses the checker recorded on the approval and never invents one.
6. AML release/void is the only writer for an `AML_HOLD` attempt. The expiry sweeper and customer cancel exclude held attempts.
7. A chargeback execution requires a finance checker; a chargeback without a known outcome or above the negative-balance ceiling is held, not posted.
8. A refund cannot exceed the unrefunded settled amount. A repeated refund is idempotent through the adjustment state and `(refType, refId)`.
9. `PROVISIONAL` reporting rules can create internal drafts but can never produce a live filing; submission requires `APPROVED` and a `CONFIRMED` rule.
10. Non-`INTERNAL` notification templates cannot reference AML variables.
11. AML data is restricted to confidential roles at the `/aml/*` routes; support cannot read it.

## 5. Data / API / config / deployment surface

### Schema

- `ApprovalRequest` (`approval_requests`): subject type/id, payload diff, mode, base version, expiry, ratification deadline, maker, checker, state, rejection reason, risk note.
- `JoinRequest`, `KybDocument`, `KybRevalidationRequest`, `BeneficialOwner`: onboarding state, documents, owners, screening status, revalidation.
- `AmlScreening`, `AmlScreeningMatch`, `AmlRule`, `AmlCase`: screening results, match dispositions, rule versions, severity/SLA, hold journal entry.
- `Dispute`, `Adjustment`, `CashoutRequest`: intake, drafted/executed adjustments, cash-out state.
- `ReportingRule`, `RegulatoryReport`: thresholds, status, encrypted payload, submission reference, approval.
- `OperatorCase`, `GatewayInquirySchedule`, `DetailChangeLog`, `AuditLog`, and `PlatformSetting` (with approval link and version).

### Admin routes (representative)

- Approvals: `GET /admin/approvals`, `/summary`, `/export`, `/:id`, `POST /:id/approve`, `/:id/reject`.
- Onboarding: `/join-requests` including `submit`, `decide`, `assign`, `request-info`, `checklist`, `screening/retry`, and `/kyb-documents/:id/review`, `request-replacement`, `request-revalidation`.
- AML: `/aml/screenings`, `/aml/matches/:id/disposition`, `/aml/cases`, `/:id/propose`, `/aml/rules`, `/aml/reporting-rules`, `/:id/promote`, `/aml/reports`, `/:id/submit`, `/:id/acknowledge`.
- Money, cases, and merchant changes: `/adjustments`, `/cashouts/:id/process`, `/disputes`, `/operator-cases/:id/resolve`, `/gateway-inquiries/:id/*`, `/merchants/:id/propose-edit|suspend|reinstate|close`, `/pending-changes`, `/detail-changes`.

### Platform settings and environment

Settings consumed: `join_request.four_eyes_policy` (policy, owner threshold, volume threshold, high-risk categories), `onboarding.required_documents`, `kyb.refresh_policy`, `screening.watchlist`, `screening.fail_closed`, and `OD-4` (retention). `AUDIT_DATABASE_URL` controls whether audit rows are mirrored to `audit_outbox`; `NOTIFICATION_WEBHOOK_URL` and timeout configure the notification transport; worker flags are described in `core.workers`.

## 6. Operational usage

### Applying a sensitive change

1. The maker calls the domain route (`propose-edit`, `suspend`, `aml/cases/:id/propose`, `operator-cases/:id/resolve`, `aml/reports`, etc.).
2. The route validates the request, creates the approval row, and returns `202` with the approval id.
3. A checker opens `GET /admin/approvals/:id`, reviews the subject context and diff, and calls `POST /admin/approvals/:id/approve` with the optional checklist.
4. The handler executes in the approval transaction. Adjustments are queued and executed by `BackgroundJobWorker`; the response is `202` with a job id.
5. Rejection records a reason and leaves the subject in its pre-approval state, except for audit/lifecycle side effects.

### Onboarding

1. Create the admin-assisted join request, add beneficial owners and KYB documents, then submit.
2. Fix any readiness blockers: required documents, owner threshold/screening, checklist, payout bank, duplicate justification.
3. If four-eyes is required, decide as maker and approve in the approvals queue; otherwise the decide route activates or rejects directly.
4. KYB expiry and periodic revalidation are handled by `KybExpiryWorker`.

### AML case

1. The guard or onboarding service creates the case and, for a platform-held hold, the escrow posting.
2. Compliance proposes `HOLD`/`RELEASE`/`REJECT`/`ESCALATE` through `/aml/cases/:id/propose`.
3. A checker approves. Release/void posts the ledger and finalises the attempt; escalate opens an operator case.
4. A potential screening match is dispositioned directly through `/aml/matches/:id/disposition`; that route is confidential-gated but is not an approval.

### Regulatory report

1. Let `ReportingRuleEvaluator` create a report on settlement, or draft one manually through `/aml/reports`.
2. Approve the `REGULATORY_REPORT` request.
3. Submit through `/aml/reports/:id/submit` with a submission reference, then acknowledge.

## 7. Status and deviations

### Implemented

- Maker/checker separation at service, route, and database levels; approval queue, summary, export, detail, approve, reject, and checklists.
- Governance execution for join requests, merchants, adjustments, cash-out execution, AML cases, operator cases, regulatory reports/rules, AML rules, commission expiry, velocity deactivation, users, gateway versions, and backup policy.
- Onboarding readiness, KYB review/revalidation, duplicate detection, four-eyes policy, screening provider abstraction, Arabic normalization, L1/L2/L3 screening, AML rule engine, cases, hold escrow, release/void.
- Dispute drafting with system maker and human checker, chargeback outcomes, negative-balance ceiling, regulatory report approval/submission/acknowledgement, operator cases, persisted inquiry schedules.
- Tipping-off template guard, AML payload redaction, and the confidential AML route gate.

### Partial

- **Approval coverage** — several sensitive actions are direct or lack execution handlers. Application-sensitive changes cannot complete through approvals; platform settings bypass approvals; cash-out processing is a direct route; commission-profile creation and velocity-rule creation are direct.
- **Approval lifecycle** — `DRAFT` is largely unused, rejections do not return to `DRAFT`, and emergency ratification records a note but does not run a second execution.
- **Domain checker enforcement** — only merchant payloads get a role-domain check. AML, reports, users, gateway versions, and platform settings do not enforce their intended checker roles in the dispatcher.
- **Detail change log** — descriptive and approved merchant edits are logged; other entities and the `DetailChangeService` redaction/diff pipeline are not fully wired.
- **AML L4** — rule evaluation happens at attempt creation, not at confirmation or in batch analytics. There is no structuring batch job, no rule dry-run, and no 24-hour emergency tightening workflow.
- **Retention** — the worker is opt-in, does not purge AML cases/screenings/KYB documents/regulatory reports, and keeps the ledger.
- **Dispute intake** — manual admin intake is implemented; webhook and statement channels are not wired.
- **Cash-out lifecycle** — `PROCESSING` and `SUBTRACTED` are not used by the execute path.

### Missing / deferred

- `executeApprovalSubject` handlers for `APPLICATION`, `CASHOUT_REQUEST`, and `PLATFORM_SETTING`.
- Approval rows for cash-out processing and platform-setting changes.
- Domain-scoped checker authority (`approvals.domains` equivalent).
- Maker-checker for commission-profile creation/change and velocity-rule creation.
- Deferred/batch AML monitoring and rule dry-run.
- Retention of AML/KYB/reporting evidence by the worker.
- Regulatory authority filing adapters.

### Known bugs / risks

- **Security gap:** the generic approval route is not confidential-gated. A principal with `approval:check` can approve an `AML_CASE` even without `aml:read`/`aml:write`; the seeded `FINANCE` role holds `approval:check`.
- **Security gap:** emergency suspension takes effect immediately by one actor and leaves an approval in `PENDING_REVIEW`; rejecting it records `MERCHANT_EMERGENCY_SUSPENSION_NOT_RATIFIED` but does not undo the suspension. The `ApprovalService` emergency path also executes without a checker, and `ratifyEmergencyRequest` only records a note.
- **Data gap:** manual regulatory report payloads are written as plaintext JSON in `payload_ciphertext`.
- **Coverage gap:** an `APPLICATION` approval can be created and listed but cannot be approved; the checker receives `NO_EXECUTABLE_SUBJECT`.
- **Configuration gap:** `PUT /admin/settings` requires `settings:write` and writes directly, despite the design's maker-checker requirement for compliance settings.
- **Seed gap:** the seeded `COMPLIANCE` and `MLRO` users lack `approval:check`, so the documented maker-checker role matrix is not exercised by the default deployment seed.

## 8. Verification and tests

Run the focused suites:

```bash
cd core-back && bun test test/engine/governance.test.ts
cd core-back && bun test test/governance-execution.test.ts
cd core-back && bun test test/approval-queue.test.ts
cd core-back && bun test test/onboarding-four-eyes.test.ts
cd core-back && bun test test/kyb-review.test.ts
cd core-back && bun test test/screening-and-caps.test.ts
cd core-back && bun test test/aml-resolution-finalization.test.ts
cd core-back && bun test test/regulatory-report-lifecycle.test.ts
cd core-back && bun test test/reporting-rule-evaluator.test.ts
cd core-back && bun test test/refund-three-phase.test.ts
cd core-back && bun test test/operator-cases.test.ts
cd core-back && bun test test/gateway-inquiry-schedules.test.ts
```

Coverage highlights:

- `engine/governance.test.ts` / `governance-execution.test.ts` — proposal state, maker/checker separation, JSON Patch base version, emergency ratification, AML release/void, merchant-direct case-only, dispute drafting, chargeback outcomes, cash-out execution/rejection, idempotency, refund caps, operator resolution.
- `onboarding-four-eyes.test.ts`, `kyb-review.test.ts`, `screening-and-caps.test.ts` — policy/risk triggers, expiry/duplicates/payout holder/refresh, L1/L2 screening, provider failure, watch-list invalidation.
- `regulatory-report-lifecycle.test.ts` / `reporting-rule-evaluator.test.ts` — report creation, provisional-rule block, maker/submitter separation, acknowledgement, evaluator idempotency.
- `phase4-onboarding-aml-disputes-recon.test.ts` and `exhaustive/07-workflows/onboarding-and-aml.test.ts` — AML rules, Arabic normalization, tipping-off, dispute dedupe/cap, reconciliation, broader workflows.

Some governance tests use fake clients; database-backed suites require PostgreSQL 18 and are skipped otherwise. Report skipped suites explicitly.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` Part IX (incorporates v4.1 §15–§22).
- `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md` §15 roles/authorities/four-eyes, §16 onboarding/KYB, §17 detail governance, §18 AML, §19 disputes, §20 profitability; `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md` §9 and §13.
- `design/10-fixes/_0001_operator_cases.md` — operator-case inquiry eligibility and bulk behavior.

### Code paths

- Governance: `core-back/engine/governance/{ApprovalService,GovernanceExecution,DetailChangeService}.ts`.
- Compliance and guards: `core-back/engine/compliance/{ReportingRuleEvaluator,tippingOff,OperatorCaseSink}.ts`, `core-back/engine/guards/{AmlRuleEngine,MerchantScreeningService,ScreeningProvider,AttemptGuardPipeline}.ts`.
- Libraries and API: `core-back/lib/{approvalQueue,joinRequestOnboarding,kybReview,merchantOps}.ts`, `core-back/lib/auth/confidentialAccess.ts`, `core-back/api/middleware/makerCheckerGuard.ts`, `core-back/api/internal/{admin,merchant}.ts`.
- Data: `core-back/prisma/schema.prisma`, `core-back/prisma/seed.ts`.

### Generated appendices

`project-design/appendices/schema-catalog.md`, `api-route-matrix.md`, and `test-inventory.md`.

## 10. Change history

- 2026-11-03 — Baseline verification against `5a24f6f+working-tree`: documented approval lifecycle deviations, missing `APPLICATION`/`CASHOUT_REQUEST`/`PLATFORM_SETTING` handlers, direct settings/cash-out/commission/velocity paths, authority and confidentiality gaps, onboarding/KYB, AML layers, disputes, reporting, operator cases, and retention gaps.

## Background Workers and Outboxes

> Status: `partial` · Last verified: 2026-11-04

## 1. Purpose and scope

This part owns the stateless background loops that drain durable work in `core-back`: attempt expiry and polling, inbound inbox processing, notification delivery, ledger invariant checks, onboarding expiry, periodic screening, KYB lifecycle, record retention, the durable background-job queue, the transactional outbox relay, and the audit shipper. It also documents the production worker composition and the startup/health contract.

It does not own the business logic that a worker invokes. The workers call the engine, repositories, screening service, notification transport, and ledger. The ledger and governance invariants are documented in their own parts.

## 2. Design intent (extracted and synthesized from ./design)

The design requires stateless worker processes that use PostgreSQL as the durable timer and queue:

- `payment_attempts.expires_at` and `next_check_at` are polled by stateless workers using `SELECT ... FOR UPDATE SKIP LOCKED`; an expiring attempt is asked (`inquire`) before it expires when the route supports inquiry.
- `inbound_events` is drained by an inbox worker so webhook processing is inbox-first and deduplicated; `notifications` is a transactional outbox drained by a sender.
- Terminal transitions are applied at most once with a conditional `UPDATE ... WHERE terminal_at IS NULL`, and the double-entry invariant is checked continuously.
- Statement reconciliation and dispute/adjustment execution use a durable queue with leases, backoff, and crash recovery.
- The retention worker removes evidence after the configured period without moving a balance; the transactional outbox maintains read models, and the audit outbox ships audit rows to a dedicated audit database with a hash chain.

The design also presents realtime fan-out as event-driven. The as-built behavior differs in several places: inbound handling is synchronous on the request path, checkout/POS SSE streams poll the database, and the ledger outbox does not project a read model.

## 3. As-built architecture

### 3.1 Worker base

`BaseWorker` (`core-back/engine/workers/workerRuntime.ts:40`) provides:

- a `start`/`stop` lifecycle with a single in-process timer chain;
- `setTimeout` scheduling with ±10% jitter (`jitter`), not `setInterval`;
- `unref()` on the timer so the timer does not keep the process alive;
- one `tick` at a time in a process: the next tick is scheduled only after the current tick resolves;
- error isolation: a failed tick is logged and the loop continues;
- `runOnce()` for tests and manual ticks.

The loop is not a distributed lock by itself. Cross-node safety comes from `FOR UPDATE SKIP LOCKED` claims plus conditional updates (or from leases for background jobs).

### 3.2 Production composition

`createProductionWorkerRuntime` (`core-back/engine/workers/productionRuntime.ts:207`) builds the workers and connects their ports:

- inquiry port -> `platform.engine.inquire`, so an expired or due attempt is asked before a terminal decision;
- inbound handler -> `platform.engine.verifyCallback`;
- notification sender -> `NotificationTransport` (webhook when `NOTIFICATION_WEBHOOK_URL` is set, otherwise the log transport);
- storage engine -> outbox relay and, only for a dedicated audit store, the audit shipper;
- background-job handlers -> reconciliation and adjustment/dispute execution.

`core-back/index.ts:259` starts the runtime when `WORKER_ENABLED` is true. `assertBackgroundJobQueueDrainable` refuses to boot if workers or background jobs are disabled, because statement upload and dispute intake answer `202` and would otherwise strand work (`productionRuntime.ts:121`). `WORKER_ENABLED` and `WORKER_BACKGROUND_JOBS_ENABLED` therefore default to true and cannot be safely disabled in the current API configuration.

### 3.3 Worker inventory

| Worker | Trigger and default cadence | Claim / concurrency | Behavior | Status |
| :--- | :--- | :--- | :--- | :--- |
| `ExpirySweeperWorker` | `expires_at <= now`, every `WORKER_POLL_INTERVAL_MS` (5 s) | `FOR UPDATE SKIP LOCKED`, batch `WORKER_BATCH_SIZE` (50) | Inquires inquiry-capable routes first; applies definitive outcome; expires otherwise; excludes `AML_HOLD`; releases slot on terminal failure/expiry/cancel. | Implemented |
| `PollWorker` | `next_check_at <= now`, every poll interval | `FOR UPDATE SKIP LOCKED`, batch | Reconciles inquiry schedules, applies route backoff `[5,15,30,60,120,300]` seconds with a 900 s default window, transitions terminal states once, updates schedule metadata. | Implemented |
| `InboundInboxWorker` | `processed_at IS NULL`, every poll interval | `FOR UPDATE SKIP LOCKED`, batch | Calls the engine callback verifier, retries `RETRYABLE` errors up to `maxAttempts` (production default 3; class default 5), opens an operator case on terminal failure. | Partial / idle |
| `OutboxNotificationWorker` | `status = QUEUED` and `next_attempt_at <= now`, every poll interval | `FOR UPDATE SKIP LOCKED`, batch | Finds template, treats missing/tipping-off templates as delivery failures, redacts AML payload, renders, sends; retries with exponential backoff up to 8 attempts. | Implemented |
| `LedgerInvariantWorker` | every 60 s | Single verifier pass | Verifies the system-wide invariant; logs drift and opens one open `MISMATCH`/`P1` operator case. | Implemented |
| `JoinRequestExpiryWorker` | every poll interval | Raw updates, batch on overdue reviews | Expires `DRAFT` older than 30 days; expires overdue `SUBMITTED`/`IN_REVIEW`/`INFO_REQUESTED` reviews; excludes `PENDING_CHECKER`. | Partial |
| `PeriodicScreeningWorker` | every poll interval; 24 h rescreen interval | `FOR UPDATE SKIP LOCKED` on due merchants, then merchant row lock | Refreshes watch-list versions, screens merchant and owners, applies owner statuses, raises one confirmed-match case and suspends the merchant. | Implemented (L2 only) |
| `KybExpiryWorker` | every 6 h (`WORKER_KYB_EXPIRY_INTERVAL_MS`), batch 200 | Query + per-merchant transaction | Marks expired documents, queues 30/7-day notices, suspends after grace, starts periodic revalidations, expires overdue revalidations. | Implemented |
| `RetentionWorker` | every hour when enabled; batch 500 | Bounded transactions per table | Purges notifications, inbound events, step logs, audit logs, detail logs, terminal attempts and dependents; never purges the ledger. | Partial / opt-in |
| `BackgroundJobWorker` | every 2 s when enabled, batch 10 | `FOR UPDATE SKIP LOCKED` claim + ONE batch `RUNNING` update + lease | Drains `RECONCILIATION_RUN` and `ADJUSTMENT_EXECUTION` jobs, retries with backoff, recovers expired leases. | Implemented |
| `OutboxRelayWorker` | every 250 ms (idle back-off to 2 s), batch >= 100 | `FOR UPDATE SKIP LOCKED`, one batch ack | Projects `attempt.transitioned` into `rm_merchant_daily_stats` and `rm_route_daily_volumes`; marks `processed_at`. Other declared topics are no-ops. | Partial |
| `AuditShipperWorker` | every 500 ms, batch >= 100 | Lease-claim batch then append to dedicated audit DB | Appends to the audit hash chain, then marks `audit_outbox.shipped_at`; prunes shipped rows after the retention window. | Partial / conditional |

### 3.4 Expiry sweeper

`ExpirySweeperWorker` (`core-back/engine/workers/ExpirySweeperWorker.ts`) selects attempts in `CREATED`, `INITIATING`, `AWAITING_CUSTOMER`, `AUTHORIZING`, or `VERIFYING` whose `expires_at` has passed and whose `substatus` is not `AML_HOLD`. It refreshes route inquiry support once per tick.

For each attempt:

- if the route supports inquiry and an inquiry port exists, it calls `inquire`; a definitive terminal outcome (`SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`) is applied with a conditional update; non-terminal outcomes update status/substatus and continue;
- an inquiry error moves the attempt to `UNKNOWN` with `nextCheckAt = now + 60 s`;
- otherwise it transitions to `EXPIRED` with a conditional `WHERE terminal_at IS NULL`, releases the link slot, and writes an audit row.

The production inquiry port calls `DynamicRailEngine.inquire`, which performs the VERIFY phase and posts the confirmation ledger when the inquiry returns a trusted success. The sweeper itself does not post a ledger entry.

### 3.5 Poll worker

`PollWorker` (`core-back/engine/workers/PollWorker.ts`) selects attempts with `next_check_at <= now` in the pollable statuses, including `UNKNOWN`. It first reconciles persisted inquiry schedules (`reconcileGatewayInquiries`). For each attempt:

- a route `stopOnStates` match clears `nextCheckAt` and completes the active schedule;
- a manual inquiry schedule owns its own window start; otherwise the attempt creation time is the reference;
- `computeBackoffDelaySeconds` returns the next step or `null` when the 900 s default window elapses; an elapsed window expires the schedule and clears `nextCheckAt`;
- the query calls `Platform.engine.inquire`; terminal states are applied with a conditional update; non-terminal states are stored with a new `nextCheckAt`;
- `FAILED` and `CANCELLED` release the link slot; `EXPIRED` and `BLOCKED` do not.

The schedule metadata (`GatewayInquirySchedule`) records source, status, window start, next run, attempts, last result/error, and completion/cancellation. The poll worker marks a schedule `RUNNING` before the inquiry and updates it to `COMPLETED`, `RETRYING`, `EXPIRED`, or leaves it for reconciliation.

### 3.6 Inbound inbox

`InboundInboxWorker` (`core-back/engine/workers/InboundInboxWorker.ts`) is a complete inbox drainer: it selects unprocessed events, calls the handler, marks processed/skipped/failed, retries only `RetryableInboundError`, and opens an `UNKNOWN` operator case on a terminal failure. It also exposes `persistInboundEvent` with a dedupe lookup and raw insert.

The actual checkout inbound route does **not** use the worker. `POST /internal/checkout/inbound/:gateway/:env/:pathToken` (`core-back/api/internal/checkout.ts:1477`) validates the channel, gateway, environment, and dedupe key, inserts the `inbound_events` row, correlates the attempt, calls `engine.verifyCallback` synchronously, and marks the event processed in the same request before returning the configured acknowledgement. The worker's handler is wired, but no producer enqueues unprocessed rows for it. This is the main design deviation for this part.

The synchronous route stores the raw body and a redacted header subset, not the full header set. It marks `verificationError = VERIFICATION_PENDING` initially and records the final verification result. The separate `persistInboundEvent` helper is not called by the route.

### 3.7 Notification outbox

`OutboxNotificationWorker` (`core-back/engine/workers/OutboxNotificationWorker.ts`) drains the `notifications` table, not `outbox_events`. For each queued row it:

1. finds the template by code/channel/language;
2. records a delivery failure when the template is missing;
3. calls `assertNoTippingOff` and records a delivery failure when a non-`INTERNAL` template references AML variables;
4. redacts AML-like payload keys for non-`INTERNAL` classes;
5. renders subject/body;
6. calls the sender;
7. writes `SENT` or `DELIVERED`, or re-queues with exponential backoff up to 8 attempts.

The production sender uses the webhook transport when `NOTIFICATION_WEBHOOK_URL` is configured and the log transport otherwise. The log transport reports `SENT`, never `DELIVERED`; `IN_APP` notifications are delivered by the notification row itself. The rendered body of an `INTERNAL` template is never written to the log.

### 3.8 Ledger invariant worker

`LedgerInvariantWorker` runs `InvariantVerifier` every 60 seconds. On non-zero drift it logs the left/right sides, calls the optional `onDrift`, and opens a single open `MISMATCH`/`P1` case with a four-hour SLA. It does not halt payouts itself; the operator case and the admin invariant panel are the control surface.

### 3.9 Onboarding expiry

`JoinRequestExpiryWorker` expires abandoned `DRAFT` rows older than 30 days and expires overdue reviews in `SUBMITTED`, `IN_REVIEW`, or `INFO_REQUESTED` whose `sla_due_at` has passed, explicitly excluding `PENDING_CHECKER`. It uses direct SQL updates and does not write an audit row or queue a notification. The batch is limited for overdue reviews, but the draft expiry is a single update.

### 3.10 Periodic screening and KYB

`PeriodicScreeningWorker` (`core-back/engine/workers/PeriodicScreeningWorker.ts`) selects active merchants whose latest merchant screening is older than the rescreen interval using `FOR UPDATE SKIP LOCKED`, re-checks the due condition under the merchant row lock, screens the merchant and active owners with trigger `PERIODIC`, applies owner statuses, and handles only a `CONFIRMED_MATCH`: it raises one case (prefix `SCREENING_CONFIRMED_MATCH`) and suspends an active merchant with `AML_CONFIRMED_MATCH`. A potential match does not suspend or open a case here; it remains for the screening queue.

`KybExpiryWorker` (`core-back/engine/workers/KybExpiryWorker.ts`) performs five bounded passes:

1. mark accepted/uploaded documents whose `expires_on` passed as `EXPIRED`;
2. queue 30-day and 7-day `KYB_DOC_EXPIRING` notices using unique event keys;
3. suspend an active merchant whose required document is past the grace period with no replacement, setting `KYB_EXPIRED` and queuing `KYB_EXPIRED_SUSPENSION`;
4. start periodic revalidation requests for due merchants and advance `nextKybReviewAt`;
5. expire overdue revalidation requests.

### 3.11 Retention

`RetentionWorker` (`core-back/engine/workers/RetentionWorker.ts`) is disabled by default (`WORKER_RETENTION_ENABLED=false`) because it removes evidence. It resolves the period from an explicit option, then platform setting `OD-4`, then a five-year default. It supports a dry run.

It purges, in dependency order and bounded transactions:

- `notifications` older than the cutoff;
- `inbound_events` received before the cutoff;
- `attempt_step_logs` older than the cutoff and belonging to an attempt older than the cutoff;
- `audit_log` and `detail_change_logs` older than the cutoff;
- terminal attempts older than the cutoff whose journal entry is retained, together with their adjustments, disputes, operator cases, inbound events, step logs, and free attempt groups.

It deliberately never purges `journal_entries` or `journal_lines`, because deleting a line without folding it into a checkpoint would silently change a merchant balance while the system-wide invariant still balanced. AML cases, screenings, KYB documents, KYB revalidations, regulatory reports, platform settings, background jobs, `outbox_events`, and `audit_outbox` are not in the retention scope.

### 3.12 Background job queue

`BackgroundJobWorker` (`core-back/engine/workers/BackgroundJobWorker.ts`) is the durable queue for statement reconciliation and dispute/adjustment execution:

- `claimDueJobs` selects `QUEUED` jobs whose `available_at <= now`, marks them `RUNNING` and sets `locked_at` inside one transaction; the row locks are held until the mark commits;
- `recoverExpiredLeases` re-queues `RUNNING` rows whose `locked_at` is older than the lease (default 300 s);
- a missing handler or thrown error increments attempts and re-queues with exponential backoff (30 s base, 30 min cap) until `maxAttempts` (default 5), then marks `FAILED`;
- success marks `SUCCEEDED`, `completed_at`, clears `locked_at`, and logs the job id/type/reference.

Handlers (`core-back/engine/workers/BackgroundJobHandlers.ts`):

- `RECONCILIATION_RUN` parses the uploaded statement, matches items, posts settlement sweeps for batch sources, and posts fee variance true-ups.
- `ADJUSTMENT_EXECUTION` handles `kind: DISPUTE_INTAKE` through `openDisputeWithDraftedAdjustment`, and `kind: ADJUSTMENT_EXECUTION` through `executeApprovalSubject` using the approval id and recorded checker.

The job payload never carries an independent checker; the executed adjustment uses the checker recorded on the approval request.

### 3.13 Outbox relay and audit shipper

`OutboxRelayWorker` (`core-back/lib/storageEngine/outboxWorkers.ts`) claims unprocessed `outbox_events` with `FOR UPDATE SKIP LOCKED` in one transaction, runs the per-topic handlers (topics with a batch handler receive all events of the batch at once), and acknowledges the whole batch with ONE `UPDATE ... WHERE id = ANY(...)`. Since 2026-11-04 an idle relay backs off exponentially (250 ms to 2 s; 500 ms to 5 s for the shipper) and re-polls immediately after a full batch. Default handlers:

| Topic | Handler |
| :--- | :--- |
| `attempt.transitioned` | Projects `rm_merchant_daily_stats` and `rm_route_daily_volumes` using the event kind (`created` vs terminal), status, merchant, route, currency, gross, and net. |
| `ledger.entry_posted` | No-op. No ledger-driven read model is projected. |
| `merchant.updated` | No-op. |
| `kyb.document_uploaded` | No-op. |
| `reconciliation.completed` | No-op. |
| `config.invalidated` | No-op. |

The relay is instantiated only when a storage engine is supplied. `attempt.transitioned` events of a batch are folded in memory (`aggregateAttemptTransitions`, decimal.js, no floats) into one delta per (merchant|route, day, currency) and applied with one `INSERT ... SELECT FROM unnest(...) ON CONFLICT DO UPDATE` per read model, sorted by key so concurrent relays lock rows in the same order. Processed rows older than `STORAGE_OUTBOX_RETENTION_MS` (default 1 h, 0 = keep) are pruned oldest-first in bounded batches strictly below the oldest unprocessed id (`OutboxRelayWorker.prune`), once a minute per worker. `rebuildAttemptReadModels(db, { fromDay, toDay })` recomputes both read models from `payment_attempts` after bulk loads.

`AuditShipperWorker` is instantiated only when `options.storage.auditStore` is a `DedicatedAuditDatabaseDriver`. It claims unshipped, unleased `audit_outbox` rows with a single `UPDATE ... SET lease_until = now() + leaseMs WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING` (the previous claim transaction committed before the append, so its `SKIP LOCKED` locks were already released while shipping and two shippers could ship the same rows), appends them to the dedicated audit database's SHA-256 hash chain, and sets `shipped_at` / clears the lease. It is idempotent on the source id; a crashed shipper's batch is re-claimed after `leaseMs` (default 30 s). Shipped rows older than `STORAGE_AUDIT_OUTBOX_RETENTION_MS` (default 1 h) are deleted by `AuditShipperWorker.prune`; the dedicated audit database is the durable copy. `writeAudit` only writes `audit_outbox` when `AUDIT_DATABASE_URL` is configured; otherwise `audit_log` is the only sink.

### 3.14 Realtime fan-out reality

The engine publishes attempt transition events on the invalidation bus, and the AML resolution path also publishes. The checkout status SSE (`core-back/api/internal/checkout.ts:1292`) and merchant POS SSE (`core-back/api/internal/merchant.ts:2392`) do **not** subscribe to that bus. They poll `payment_attempts` every 2 seconds (checkout, 10-minute deadline) or every 3 seconds (POS, 15-minute deadline) and write `event: status` / `event: attempts` frames. This is polling SSE, not a transition subscription.

### 3.15 Startup and health

`GET /health` (`core-back/index.ts:76`) reports `OK`/`DEGRADED` and a `queue` object with:

- whether workers and background jobs are enabled;
- queued job count;
- oldest queued job age;
- threshold (`WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS`, default 300 s);
- degraded flag.

It degrades when workers are disabled, the queue cannot be read, or the oldest queued job exceeds the threshold. It does not report per-worker liveness, tick age, notification backlog, inbound backlog, outbox lag, or audit-chain status. `readBackgroundJobQueueHealth` only reads `background_jobs`.

## 4. Contracts and invariants

1. A worker tick must not overlap with itself in the same process. Multiple nodes are allowed; claims use `FOR UPDATE SKIP LOCKED`.
2. Terminal attempt transitions are conditional on `terminal_at IS NULL`, so the same attempt is not expired, failed, or cancelled twice.
3. An `AML_HOLD` attempt is excluded from expiry sweeping, and the sweeper has a defense-in-depth check on `substatus`.
4. An expiring inquiry-capable attempt is asked before it is expired. An inquiry failure keeps it open (`UNKNOWN`/deferred) rather than silently expiring it.
5. A background job is executed at most once per claim, but handlers must be idempotent because a lease can expire and re-queue a job after a crash.
6. A notification delivery failure re-queues with backoff up to the attempt cap; a missing or tipping-off template is retried up to that cap and then marked `FAILED`.
7. The invariant worker opens at most one open `MISMATCH`/`P1` case for drift.
8. Retention never deletes ledger entries or lines and never deletes a terminal attempt whose ledger entry is missing; it stops rather than risk orphaning evidence.
9. Statement upload and dispute intake are queue-only; the service refuses to start if no background-job drain is enabled.
10. The notification worker never sends an AML variable to a non-`INTERNAL` template.
11. Outbox processing marks `processed_at`; the audit shipper marks `shipped_at`. Neither deletes rows.
12. SSE stream contract: checkout status ends on a terminal status or a 10-minute deadline; POS stream ends on a 15-minute deadline; both poll the database.

## 5. Data / API / config / deployment surface

### Tables and models

- Attempts and inbound: `payment_attempts` (`expires_at`, `grace_expires_at`, `next_check_at`, `terminal_at`, `substatus`) and `inbound_events` (body, redacted headers, dedupe key, verification, processed time/result).
- Queues and delivery: `notifications` (template, channel, language, payload, status, attempts, next attempt), `background_jobs` (type, reference, payload, state, attempts, availability, lease, error, completion), `outbox_events`, and `audit_outbox`.
- Lifecycle: `join_requests` (SLA fields), `merchants` (status, review date, suspension reason), `kyb_documents`, `kyb_revalidation_requests`, `aml_screenings`, `aml_cases`, `gateway_inquiry_schedules`.
- Read models: `rm_merchant_daily_stats`, `rm_route_daily_volumes`.

### Environment keys

| Key | Default | Purpose |
| :--- | :--- | :--- |
| `WORKER_ENABLED` | `true` | Starts the runtime; false is rejected at boot because queue-only routes exist. |
| `WORKER_POLL_INTERVAL_MS`, `WORKER_BATCH_SIZE` | 5000, 50 | Base cadence and batch for most workers. |
| `WORKER_CONCURRENCY`, `WORKER_MAX_ATTEMPTS` | 4, 3 | Concurrency is validated but unused; max attempts is passed to the inbound worker. |
| `WORKER_RESCREEN_INTERVAL_MS` | 86,400,000 | Periodic screening interval. |
| `WORKER_KYB_EXPIRY_INTERVAL_MS`, `WORKER_KYB_EXPIRY_BATCH_SIZE` | 21,600,000, 200 | KYB cadence and batch. |
| `WORKER_RETENTION_ENABLED`, `WORKER_RETENTION_INTERVAL_MS`, `WORKER_RETENTION_BATCH_SIZE` | `false`, 3,600,000, 500 | Retention enablement, cadence, batch. |
| `RETENTION_DRY_RUN` | `false` | Counts without deleting. |
| `WORKER_BACKGROUND_JOBS_ENABLED`, `WORKER_BACKGROUND_JOBS_INTERVAL_MS`, `WORKER_BACKGROUND_JOBS_BATCH_SIZE` | `true`, 2000, 10 | Durable queue enablement, cadence, batch. |
| `WORKER_BACKGROUND_JOBS_LEASE_SECONDS`, `WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS` | 300, 300000 | Crash-recovery lease and health degradation threshold. |

### Routes and surfaces

`GET /health` reports queue health only; `POST /internal/checkout/inbound/:gateway/:env/:pathToken` is the synchronous inbound path; admin gateway-inquiry routes schedule/cancel/run-now/retry persisted inquiry schedules. There is no worker-control or per-worker metrics endpoint.

## 6. Operational usage

### Starting and stopping

`core-back` is a single process that starts the HTTP(S) server and the worker runtime. `SIGTERM`/`SIGINT` stops the workers, clears storage/log sinks, closes Redis, shuts down the storage engine, and closes the server. There is no separate worker-only entrypoint in this repository.

### Observing

1. Check `GET /health` for queue depth, oldest queued age, and degraded state; for a stuck queue inspect `background_jobs` by `state`, `available_at`, `locked_at`, `attempts`, and `last_error`.
2. For expiry/poll issues inspect `payment_attempts.expires_at`, `next_check_at`, `terminal_at`, `substatus`, and `gateway_inquiry_schedules`; for notifications inspect `notifications.status`, `attempts`, `next_attempt_at`, and the template class.
3. For outbox/read-model lag inspect `outbox_events.processed_at`, `audit_outbox.shipped_at`, and the `rm_*` tables; for retention run with `RETENTION_DRY_RUN=true` first.

### Tuning

- Increase `WORKER_BATCH_SIZE` for throughput; the base worker still runs one tick at a time per process.
- Increase `WORKER_BACKGROUND_JOBS_BATCH_SIZE` carefully because each job may parse a statement or execute a refund, and increase the lease only when a legitimate handler can exceed it.
- Keep `WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS` below the operational SLA; do not rely on `WORKER_CONCURRENCY`, which has no runtime effect.

### Adding a worker

1. Extend `BaseWorker`, implement `tick`, and use a claim query with `FOR UPDATE SKIP LOCKED` or a conditional update; make every state change idempotent.
2. Add the worker to `createProductionWorkerRuntime`; gate evidence-destroying work behind an explicit env flag and a dry run.
3. Add a fake-DB test and a live PostgreSQL test where locking matters, and document its health/backlog surface.

## 7. Status and deviations

### Implemented

- Expiry sweeper with inquiry-first behavior, AML-hold exclusion, and conditional terminal updates; poll worker with route backoff, inquiry schedules, and terminal handling.
- Notification outbox with template lookup, tipping-off guard, redaction, rendering, backoff, and delivery states; ledger invariant worker and P1 operator case.
- Periodic screening (L2), KYB lifecycle, durable background-job queue with claim/lease/retry/handlers, outbox relay for attempt transitions, and audit shipper for a dedicated audit database.
- Startup guard for queue-only routes and queue health payload.

### Partial

- **Inbound inbox** — the worker is implemented and wired, but the checkout route processes synchronously and marks the event processed; the worker has no producer. The inbox-first asynchronous design is not in force.
- **Retention** — opt-in, dry-run capable, bounded, and ledger-safe, but the scope excludes AML/KYB/reporting evidence and the default is off.
- **Join-request expiry** — expires drafts/reviews but writes no audit row and sends no merchant notification.
- **Outbox relay / audit shipper** — only `attempt.transitioned` has a projection (`ledger.entry_posted` and four other topics are no-ops); the audit shipper only runs with a dedicated audit DB (it now prunes shipped rows after the retention window).
- **Realtime fan-out** — transition events are published, but checkout/POS clients receive polling SSE, not subscriptions.

### Missing / deferred

- Asynchronous webhook inbox processing on the request path.
- Transition-bus-backed SSE/WebSocket fan-out.
- Outbox and audit-outbox retention.
- Per-worker health, tick latency, backlog, and last-success metrics; separate worker deployment/entrypoint and real `WORKER_CONCURRENCY`.
- AML/KYB/report retention passes and batch/deferred AML monitoring worker.

### Known bugs / risks

- **Code gap:** `PollWorker` releases a link slot for `FAILED` and `CANCELLED` but not for `EXPIRED` or `BLOCKED`, unlike the expiry sweeper's terminal release path. A poll-discovered expiry can leave a slot reserved.
- **Code gap:** the synchronous inbound route marks the event processed even when verification fails; the event is not retried by the inbox worker. Verification failure is recorded but there is no asynchronous replay.
- **Code gap:** `InboundInboxWorker` retries `RetryableInboundError` on the next tick with no delay, so a persistent retryable failure can burn its attempt cap quickly.
- **Code gap:** merchant fallback balance reads can double count a checkpoint; this is documented in `core.ledger` but affects worker-written ledger balances too.
- **Risk:** retention and audit shipping are independent: retention purges `audit_log` and `detail_change_logs` on its own schedule without consulting `audit_outbox.shipped_at`, and the outbox rows are never purged.
- **Risk:** `OutboxRelayWorker` marks an unknown topic processed without a handler, so a newly added event type can be silently dropped until a handler is deployed.
- **Documentation gap:** the design describes an event-driven realtime and inbox-first system; the as-built system is synchronous on inbound and polling on SSE.

## 8. Verification and tests

Run:

```bash
cd core-back && bun test test/expiry-sweeper-aml.test.ts
cd core-back && bun test test/gateway-inquiry-schedules.test.ts
cd core-back && bun test test/retention-worker.test.ts
cd core-back && bun test test/background-jobs.test.ts
cd core-back && bun test test/worker-runtime-health.test.ts
cd core-back && bun test test/notifications-and-gl-accounts.test.ts
cd core-back && bun test test/screening-and-caps.test.ts
cd core-back && bun test test/storage-engine/outbox-workers.test.ts
cd core-back && bun test test/storage-engine/audit-chain.test.ts
cd core-back && bun test test/storage-engine/write-path.integration.test.ts
```

Coverage:

- `expiry-sweeper-aml.test.ts` / `gateway-inquiry-schedules.test.ts` — AML-held exclusion, normal expiry slot release, schedule running/complete/expire helpers.
- `retention-worker.test.ts` — cutoff boundaries, terminal attempt purge while retaining the journal, invariant preservation, dry run, platform-setting period, bounded batches, runtime registration.
- `background-jobs.test.ts` / `worker-runtime-health.test.ts` — single claim, second-node skip, backoff/failure, lease recovery, reconciliation, dispute intake, adjustment idempotency, no invented checker, startup guard, queue health.
- `notifications-and-gl-accounts.test.ts` / `screening-and-caps.test.ts` — transport selection, tipping-off rejection, delivery states, L2 screening, watch-list invalidation.
- `storage-engine/{outbox-workers,audit-chain,write-path.integration}.test.ts` and `exhaustive/06-concurrency/confirm-webhook-return-race.test.ts` — relay/projection, audit hash chain, atomic writes, confirmation races.

Database-backed suites require PostgreSQL 18; Redis-backed invalidation tests require Redis. Report skipped suites explicitly.

## 9. Source references

### Old design sections

- `design/90-archive/delivery-logs/opencode_technical_delivery_design.md` Phase 4 worker task; §10.5 governance/screening/observability; §12.4 operational defects; §28 delivery run 4; `design/10-fixes/_0001_operator_cases.md`.
- `design/01-platform-architecture/payment_gateway_final_design-v5.md` §9.1 rules 3 and 8; `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` §3.2.

### Code paths

- `core-back/engine/workers/{workerRuntime,productionRuntime,ExpirySweeperWorker,PollWorker,InboundInboxWorker,OutboxNotificationWorker,LedgerInvariantWorker,JoinRequestExpiryWorker,PeriodicScreeningWorker,KybExpiryWorker,RetentionWorker,BackgroundJobWorker,BackgroundJobHandlers,GatewayInquirySchedules}.ts`.
- `core-back/lib/storageEngine/{outboxWorkers,outbox}.ts`, `core-back/lib/audit/writeAudit.ts`, `core-back/api/internal/checkout.ts`, `core-back/index.ts`.

### Generated appendices

`project-design/appendices/schema-catalog.md`, `env-and-config-matrix.md`, and `test-inventory.md`.

## 10. Change history

- 2026-11-03 — Baseline verification against `5a24f6f+working-tree`: documented the worker inventory, synchronous inbound path, polling SSE, outbox/audit shipping, retention exceptions, leases/backoff, startup guard, health payload, and the actual partial status of each worker.

## 11. Multi-node audit shipping (2026-11-03)

- The dedicated audit database computes the hash chain in a BEFORE INSERT trigger under `pg_advisory_xact_lock(994001)`.
- `AuditShipperWorker` inserts without `prev_hash`/`row_hash` and reads the trigger-computed values from `RETURNING`, so concurrent shippers on HOST_A and HOST_B cannot fork the chain.
- `verify_audit_chain()` is available for live gate verification and backup drill checks.

## Storage Engine

> Status: `partial` · Last verified: 2026-11-04

## 1. Purpose and scope

The storage engine is the boundary between domain code and PostgreSQL 18, Redis, the dedicated audit database and the dedicated log database. It owns:

- the `StorageEngine` composition object and its ports;
- the transactional unit of work that couples domain writes, `outbox_events` and `audit_outbox`;
- the post-commit WAL flush watermark used by LSN-aware reads;
- primary/replica read routing and replica health tracking;
- Redis cache and sliding-window velocity counters, with an in-memory fallback;
- the dedicated audit hash-chain append adapter and audit query adapter;
- the buffered operational step/access log sink;
- GL account shard arithmetic and shard-aware ledger writes;
- the transactional outbox relay and audit shipper workers;
- the read-model projection for `rm_merchant_daily_stats` and `rm_route_daily_volumes`;
- the mTLS backup-control client used by `core-back` to reach `pg-backup-daemon`;
- the storage health snapshot API.

It does not own the Prisma schema or migration workflow (`core.storage` is paired with `core.data`), the backup daemon implementation (`07-deploy`), the global-search provider catalogue (`core.search`), or domain ledger/attempt decisions.

Dependent systems: `engine/**` through the platform runtime, `api/internal/{admin,merchant,checkout,backups}.ts`, the worker runtime, the global search route, and the storage-engine and backup-admin test suites.

## 2. Design intent (extracted and synthesized from ./design)

The historical storage blueprint defines a thin, ACID write path for a high-volume switch:

- A payment or ledger write touches the operational row, one `gl_account_shards` balance row, one `outbox_events` row and one `audit_outbox` row in a single transaction.
- The unit of work reports a commit WAL position so a caller can ask for a replica that has replayed at least that position.
- System GL accounts are split into 16 deterministic shards; merchant wallets use a single shard. Shard rows are locked in stable sorted order to avoid deadlocks.
- Outbox events project read models asynchronously so dashboards do not aggregate the ledger on the write path.
- Replica reads are selected by lag and LSN, with primary fallback.
- Redis provides L2 cache and Lua-backed velocity windows; it is never authoritative for money.
- Audit is shipped asynchronously to a dedicated append-only database with a SHA-256 hash chain and immutable rows.
- Operational step/access logs go to a separate log database so logging cannot block a payment.
- Backups are controlled through an mTLS daemon that wraps WAL-G or Barman.

The blueprint's implementation claims must not be repeated as current behavior. The actual code differs in these material ways:

- `ledger.entry_posted` is registered but its handler is a no-op; only `attempt.transitioned` projects read models. (As of 2026-11-04 the topic is not emitted unless `emitOutbox: true`.)
- The two read models are written but not read by dashboards or list endpoints.
- ~~`AuditShipperWorker` never deletes shipped rows~~ superseded 2026-11-04: both outboxes are pruned after a retention window (section 12).
- Replica routing is used by global search and three merchant list endpoints, not by all dashboards, lists and exports.
- ~~Pagination is offset-based, not keyset-based~~ partially superseded 2026-11-04: keyset is available in `listQuery` and used by the merchant payment list; other lists are offset.
- Access logs record zero database query metrics.
- There is no `gateway_wire_logs` table and no disk spool for the log sink.

## 3. As-built architecture

### 3.1 Composition root

`core-back/lib/storageEngine/index.ts` builds one `StorageEngine`:

- `createStorageEngine` resolves `DATABASE_URL`, `DATABASE_REPLICA_URLS`, `AUDIT_DATABASE_URL`, `LOG_DATABASE_URL` and Redis from the environment (`index.ts:56-71`).
- It creates the primary Prisma client and one Prisma client per replica URL (`index.ts:72-80`).
- It constructs `PostgresReplicaReadStore` and starts the LSN monitor (`index.ts:82-87`).
- It constructs `PostgresUnitOfWorkAdapter` with an optional post-commit callback (`index.ts:89-92`).
- It selects `RedisCacheAdapter` when a Redis URL exists, otherwise `MemoryCacheAdapter` (`index.ts:94-98`).
- It creates `DedicatedAuditDatabaseDriver` from a dedicated `pg.Pool` and `DedicatedPostgresLogSink` from a separate `pg.Pool` (`index.ts:100-114`).
- It exposes `uow`, `readStore`, `cache`, `auditStore`, `logSink`, `primary`, `health()` and `shutdown()` (`index.ts:116-209`).
- It exports `readThroughReplica` and `readThroughReplicaOrPrimary` helpers (`index.ts:227-268`) and a process-wide singleton (`index.ts:214-225`).

`core-back/index.ts` gets the singleton, installs it into the platform runtime, and installs the log sink into the request logger before listening (`index.ts:255-260`). Shutdown stops the LSN monitor, closes the log sink and cache, disconnects clients and ends both pools (`index.ts:198-207`, `core-back/index.ts:285-291`).

### 3.2 Ports and adapters

`core-back/lib/storageEngine/ports.ts` defines the contracts:

- `UnitOfWorkPort.run(fn, options)` returns `{ data, commitLsn, durationMs }`.
- `StorageTx` exposes `db`, `outbox`, `audit` and `lockGlAccountShardsSorted`.
- `ReadStorePort.execute(consistency, fn, options)` returns `{ data, servedBy, replicaLagMs? }`.
- `CachePort` exposes `get`, `getOrLoad`, `set`, `del`, `incrWindowCounter`, optional `publishInvalidation` and `close`.
- `AuditStorePort` exposes audit query, count, hash-chain verification and detail lookup.
- `LogSinkPort` exposes step/access log writes, attempt step-log queries, `flush` and `close`.
- `StorageEngine` aggregates the ports plus primary client, `health()` and `shutdown()`.

The concrete adapters are `PostgresUnitOfWorkAdapter`, `PostgresReplicaReadStore`, `MemoryCacheAdapter`, `RedisCacheAdapter`, `DedicatedAuditDatabaseDriver`, `DedicatedPostgresLogSink` and `BackupControlClient`.

### 3.3 Unit of work, outbox and audit outbox

`PostgresUnitOfWorkAdapter.run` opens a Prisma interaction transaction (`uowAdapter.ts:25-152`):

1. It sets a local statement timeout at least one second long and 250 ms below the transaction timeout (`uowAdapter.ts:26-30`).
2. It buffers outbox and audit envelopes in memory during the callback.
3. It deduplicates and sorts requested GL shard targets by account id and shard id, then selects them with `FOR UPDATE` in that order (`uowAdapter.ts:52-97`).
4. It runs the caller callback.
5. It inserts all buffered outbox events with `createMany` and all buffered audit rows with `createMany` inside the same transaction (`uowAdapter.ts:102-137`).
6. It reads `pg_current_wal_lsn()` inside the transaction (`uowAdapter.ts:139-142`).
7. After commit it calls the optional `onAfterCommit` wake-up, swallowing wake-up failures (`uowAdapter.ts:154-159`).
8. It reads `pg_current_wal_flush_lsn()` on the primary and replaces the in-transaction LSN when available (`uowAdapter.ts:161-172`). This is the post-commit flush LSN that makes an `atLeastLsn` replica read safe.

The audit id is generated by `uuidv7()` inside `StorageTx.audit.record` and preserved by the shipper for idempotent append (`ports.ts:24-51`, `uowAdapter.ts:46-50`).

### 3.4 Outbox relay and audit shipper

`OutboxRelayWorker` (`outboxWorkers.ts:134-248`) claims up to `batchSize` unprocessed rows with `FOR UPDATE SKIP LOCKED`, runs a handler, then updates `processed_at`. Registered handlers (`outboxWorkers.ts:149-157`):

| Topic | Handler |
| :--- | :--- |
| `attempt.transitioned` | `projectAttemptTransition` updates both read models |
| `ledger.entry_posted` | no-op |
| `merchant.updated` | no-op |
| `kyb.document_uploaded` | no-op |
| `reconciliation.completed` | no-op |
| `config.invalidated` | no-op |

`projectAttemptTransition` validates the payload shape defensively and uses `INSERT ... ON CONFLICT DO UPDATE` for `rm_merchant_daily_stats` and `rm_route_daily_volumes` (`outboxWorkers.ts:68-132`). It treats rows without an `event` marker as `created`, preserving the historical "every attempt counted at creation" behavior (`outboxWorkers.ts:82-90`).

`AuditShipperWorker` (`outboxWorkers.ts:268-385`) claims unshipped rows, appends them through `DedicatedAuditDatabaseDriver.appendBatch`, and then updates `shipped_at = now()` by id. The append is idempotent on the source id, so a crash between append and mark re-appends safely. There is no delete.

### 3.5 Replica read router

`PostgresReplicaReadStore` keeps one handle per replica with `healthy`, `lastReplayLsn`, `lagMs` and `consecutiveFailures` (`readStoreAdapter.ts:6-13`). A 150 ms interval monitor reads `pg_last_wal_replay_lsn()` and `now() - pg_last_xact_replay_timestamp()` (`readStoreAdapter.ts:31-76`). A replica becomes unhealthy after two consecutive monitor failures.

Selection is round-robin over healthy replicas:

- `"primary"` bypasses replicas.
- `"replica"` accepts a healthy replica whose `lagMs` is at or below `READ_REPLICA_MAX_LAG_MS`.
- `{ atLeastLsn, maxWaitMs }` accepts a replica whose replay LSN is at least the requested watermark, polling and refreshing watermarks until the deadline (`readStoreAdapter.ts:78-120`).
- If no replica qualifies, or the chosen replica throws, the query runs on the primary (`readStoreAdapter.ts:165-192`). A query failure marks the replica unhealthy.

Current replica call sites are:

- global search: `core-back/api/internal/admin.ts:687`;
- merchant wallet list: `core-back/api/internal/merchant.ts:1323`;
- merchant link list: `core-back/api/internal/merchant.ts:1661`;
- merchant payment list: `core-back/api/internal/merchant.ts:1744`.

No dashboard aggregate, export or other list uses the router.

### 3.6 Redis cache and velocity

`MemoryCacheAdapter` is a process-local map with TTLs, single-flight `getOrLoad`, prefix deletion and sliding windows (`redisCacheAndVelocityAdapter.ts:42-141`). It is the fallback when Redis is unavailable or not configured.

`RedisCacheAdapter` adds a local L1 cache, a JSON L2 cache with `EX` TTL, prefix deletion and a preloaded Lua velocity script (`redisCacheAndVelocityAdapter.ts:168-345`). The script:

- removes entries older than the window;
- adds the current amount/sequence member;
- sums amounts from member prefixes;
- returns count, amount, count-violation and amount-violation flags;
- refreshes the key TTL.

On any Redis error, `incrWindowCounter` falls back to the in-memory adapter (`redisCacheAndVelocityAdapter.ts:326-328`). `del` uses Redis `KEYS` followed by `DEL` (`redisCacheAndVelocityAdapter.ts:269-280`), which is a blocking scan on a large keyspace and is not production-safe at scale. `getOrLoad` exists but is not used by the core read paths; the main cache consumer is the attempt guard velocity store (`core-back/engine/guards/AttemptGuardPipeline.ts:1205-1216`). Redis invalidation is published through a separate invalidation bus, not `CachePort.publishInvalidation`.

### 3.7 Audit database adapter

`DedicatedAuditDatabaseDriver` (`auditAndLogAdapters.ts:99-331`) appends with `pg` directly:

- It opens a transaction and takes `pg_advisory_xact_lock(hashtext(tableName:hash-chain))` to serialize chain appends.
- It skips ids already present, inserts the audit fields without `prev_hash`/`row_hash`, and reads the values computed by the audit database BEFORE INSERT trigger (`pg_advisory_xact_lock(994001)` serializes all core nodes).
- It queries with SQL filters, cursor and offset support, caps `limit` at 5,000 and orders by `created_at DESC, id DESC`.
- It exposes `verifyHashChainIntegrity(limit?)`, recomputing each row and returning the first broken id.

The audit table itself is provisioned by `deploy/provisioners/auditAndLogDbProvisioner.ts` with an append-only trigger that rejects `UPDATE`, `DELETE` and `TRUNCATE`, plus least-privilege grants.

### 3.8 Operational log sink

`DedicatedPostgresLogSink` (`auditAndLogAdapters.ts:333-524`) buffers step and access rows in memory:

- The step buffer is bounded by `STORAGE_LOG_BUFFER_MAX`; when full it drops the oldest row (`auditAndLogAdapters.ts:368-371`).
- It keeps the last 500 step logs per attempt for in-memory fallback and caps remembered attempts at 1,000 when no log DB is configured (`auditAndLogAdapters.ts:372-383`).
- It flushes every `STORAGE_LOG_FLUSH_INTERVAL_MS`, when the step buffer reaches 250 rows, or on `close`.
- Flush batches up to 500 rows per table and uses multi-row inserts; step logs use `ON CONFLICT (id, created_at) DO NOTHING`.
- On a database error the step batch is put back if it still fits; the access batch is not explicitly requeued, so a failed flush can lose access-log rows.
- With no log DB, step logs are remembered in memory and access logs are dropped.

There is no disk spool. There is no `gateway_wire_logs` table. The request logger always supplies `dbQueries: 0` and `dbDurationMs: 0` (`core-back/lib/requestLogger/index.ts:185-203`).

### 3.9 Sharding and ledger writes

`shardBalances.ts` defines 16 default shards, excludes `MERCHANT_WALLET`, uses FNV-1a over the attempt/reference id and computes `shardId = hash % count`; unsharded accounts use shard 0 (`shardBalances.ts:1-32`). `ledgerShardWriter.ts` upserts `gl_account_shards` with a signed delta (`credit` negative, `debit` positive) and can pre-create all shards for an account (`ledgerShardWriter.ts:8-51`). `createLedgerPoster` wires the shard writer and an optional `ledger.entry_posted` outbox writer (`ledgerPosterFactory.ts:17-40`). The hardening migration adds a `0 <= shard_id < 16` check.

### 3.10 Read models

The CQRS migration creates `rm_merchant_daily_stats` and `rm_route_daily_volumes` with composite primary keys and a day index. Only `projectAttemptTransition` writes them. There is no `rm_merchant_dashboard_stats` and no `rm_wallet_statements` table. The read models are write-only in current application code.

### 3.11 Backup control client

`BackupControlClient` (`backupControlClient.ts:145-308`) is an HTTP client for the daemon:

- base URL from `BACKUP_DAEMON_URL`;
- keep-alive agents, TLS 1.3 minimum for HTTPS, optional CA/client cert/key from the environment;
- explicit JSON serialization, timeout handling, 502/504 error mapping and a typed `BackupDaemonNotConfiguredError`.

It exposes `overview`, `health`, `triggerBackup`, `runDrill`, `updatePolicy`, `listRuns` and `listDrills`. The internal backup router uses it for overview, trigger, drill and policy. There are no automatic retries or circuit-breaker semantics.

### 3.12 Health

`StorageEngine.health()` probes the primary with `SELECT 1`, each replica, cache set/get, audit pool and log pool with short timeouts (`index.ts:123-197`). It returns `StorageHealth` with primary latency, replica lag/watermarks, cache driver and audit/log configured flags.

The public `GET /health` in `core-back/index.ts:76-115` does not call `StorageEngine.health()`. It reports only background-job queue health. The storage snapshot is currently consumed by tests (`core-back/test/storage-engine/engine-factory.test.ts`) rather than by an operational endpoint.

## 4. Contracts and invariants

- Domain writes that use the UoW and both outbox writers commit the business row, `outbox_events` and `audit_outbox` atomically. A failure rolls back all three.
- The reported `commitLsn` is the post-commit `pg_current_wal_flush_lsn()` when readable; callers can treat an `atLeastLsn` replica as having replayed the commit.
- GL shard locks are taken in `(gl_account_id, shard_id)` order. Callers must pass all targets before making balance-dependent decisions.
- Audit ids are UUIDv7 generated in the UoW; the audit chain is append-only and idempotent by id.
- The audit hash chain canonicalizes JSONB with PostgreSQL `before_json::text`/`after_json::text`; verification reads the same text form. Any change to the trigger field list or canonicalization invalidates historical verification.
- Outbox handlers must be idempotent: a claimed batch is retried after a crash because `processed_at` is updated only after the handler completes.
- The outbox relay processes rows in ascending id order. Processed rows are deleted only after `STORAGE_OUTBOX_RETENTION_MS` and only below the oldest unprocessed id.
- Read consistency is one of `primary`, `replica` or `{ atLeastLsn, maxWaitMs? }`. A replica query failure falls back to the primary; callers must not assume a replica served the read.
- Cache contents are not authoritative. A Redis failure must not fail a payment; velocity falls back to local memory.
- The in-memory velocity fallback is per process and does not coordinate across core nodes.
- The log sink is best-effort. It may drop the oldest step log when its buffer is full, may drop access logs on a failed flush and does not spool to disk.
- `gl_account_shards.shard_id` is limited to `0..15`; the default shard count is 16 and `MERCHANT_WALLET` is always one shard.
- Backup daemon calls are mTLS when the base URL is HTTPS; a missing client certificate is not silently replaced by an insecure channel.
- `StorageEngine.shutdown()` must be called on process shutdown so monitors, buffers and pools are released.

## 5. Data / API / config / deployment surface

### Schema models

`GlAccountShard`, `OutboxEvent`, `AuditOutbox`, `BackupCatalogRun`, `BackupRestoreDrill`, `RmMerchantDailyStat` and `RmRouteDailyVolume` are the storage-engine-native models. The journal, attempt and audit-log tables are defined by the broader schema (see `core.data`).

### Internal APIs

- `GET /internal/admin/system/backups/overview`
- `POST /internal/admin/system/backups/trigger`
- `POST /internal/admin/system/backups/drill`
- `PUT /internal/admin/system/backups/policy`
- `GET /internal/admin/system/backups/catalog`
- `POST /internal/admin/search` (delegates to the read store, see `core.search`)

### Environment

| Key | Purpose | Default |
| :--- | :--- | :--- |
| `DATABASE_URL` | Primary PostgreSQL 18 URL | required |
| `DATABASE_REPLICA_URLS` | Comma-separated replica URLs | empty |
| `READ_REPLICA_MAX_LAG_MS` | Maximum acceptable replica lag | `2000` |
| `AUDIT_DATABASE_URL` | Dedicated audit DB URL | unset |
| `LOG_DATABASE_URL` | Dedicated log DB URL | unset |
| `REDIS_URL` / `REDIS_NODES` | Redis cache/velocity | unset / empty |
| `STORAGE_QUERY_TIMEOUT_MS` | Default query timeout budget | `5000` |
| `STORAGE_LOG_BUFFER_MAX` | Log buffer bound | `5000` |
| `STORAGE_LOG_FLUSH_INTERVAL_MS` | Log flush interval | `250` |
| `STORAGE_SHARD_COUNT` | GL shard count, max 16 | `16` |
| `STORAGE_OUTBOX_RETENTION_MS` | Processed `outbox_events` older than this are pruned (0 = keep) | `3600000` |
| `STORAGE_AUDIT_OUTBOX_RETENTION_MS` | Shipped `audit_outbox` rows older than this are pruned (0 = keep) | `3600000` |
| `BACKUP_DAEMON_URL` | Daemon base URL | unset |
| `BACKUP_DAEMON_CA_CERT_PATH` | Daemon CA | unset |
| `BACKUP_DAEMON_CLIENT_CERT_PATH` | Daemon client cert | unset |
| `BACKUP_DAEMON_CLIENT_KEY_PATH` | Daemon client key | unset |
| `BACKUP_DAEMON_TIMEOUT_MS` | Daemon request timeout | `15000` |

### Deployment

`deploy/lib/hostPlanner.ts` injects the core environment with the primary/replica/audit/log URLs and backup daemon client paths. Storage hosts receive certificates through `uploadStorageCertificates` in `deploy/deploy.ts`. Storage mTLS consumption by PostgreSQL and Redis is not implemented (see `07-deploy/05-storage-provisioners.md`).

## 6. Operational usage

- Start `core-back` with the primary URL; replica URLs are optional. Replica routing degrades to primary when none is configured.
- Watch `READ_REPLICA_MAX_LAG_MS` when adding lagging replicas; an oversized value makes stale reads more likely.
- Run the outbox relay and audit shipper through `createProductionWorkerRuntime` when `WORKER_ENABLED` is true. Without the audit store the shipper is not registered.
- Send writes through `UnitOfWorkPort`; do not write `outbox_events` or `audit_outbox` directly in new code.
- Use `readThroughReplicaOrPrimary` with the `x-pg-min-lsn` request header for read-after-write consistency. The header is consumed by the search route and the three merchant list routes.
- Inspect the storage snapshot through `getStorageEngine().health()` or the tests; do not assume `/health` includes storage checks.
- Treat Redis as disposable. If Redis is down, velocity evaluation uses process-local memory and does not coordinate across nodes.
- Monitor `audit_outbox` growth directly. The shipper marks rows shipped but does not remove them, so a retention job is required outside this code.
- Use `scripts/run-benchmarks.sh` with a real PostgreSQL 18 test database and, optionally, Redis to reproduce write-path numbers.

## 7. Status and deviations

### Implemented

- Ports/adapters and singleton composition (`ports.ts`, `index.ts`).
- Atomic UoW with transactional outbox, transactional audit outbox and sorted GL shard locks.
- Post-commit `pg_current_wal_flush_lsn()` watermark.
- Outbox relay with `FOR UPDATE SKIP LOCKED`, idempotent retry semantics and attempt read-model projection.
- Audit shipper with idempotent append and audit hash-chain verification.
- LSN/lag-aware replica router with primary fallback.
- Redis cache adapter with Lua velocity and memory fallback.
- 16-way shard arithmetic and shard-aware ledger writer.
- Dedicated audit DB and log DB adapters.
- Backup control client with TLS/mTLS support and typed errors.
- Storage health snapshot API.
- Read model tables and writer.
- Test coverage for primitives, UoW, read store, outbox workers, audit chain, log sink, shards, engine factory and performance thresholds.

### Partial

- Read-model adoption: `rm_*` tables are written (batched since 2026-11-04) but no dashboard or list reads them yet.
- Outbox projection: only `attempt.transitioned` has an effect; `ledger.entry_posted` and four other topics are no-ops.
- Replica routing: only global search and three merchant list endpoints use it.
- Cache: Redis/L1 is used primarily by velocity; `getOrLoad` is available but not used by core read paths.
- Audit/log retention: log partitions have a deploy-side retention function, but core `audit_outbox`, `outbox_events` and the dedicated audit table have no application-level retention job.
- Backup control: the client is implemented and tested, but deployment certificate ownership and daemon-side gaps remain (see `core.backup`).

### Missing / deferred

- Keyset pagination on every list: only the merchant payment list passes `cursor`/`nextCursor` (see section 12).
- `gateway_wire_logs` table and any raw gateway wire-log persistence. Evidence is stored in redacted step logs only.
- On-disk log spool and durable log backpressure. The buffer drops instead of spooling.
- Storage health endpoint. `StorageEngine.health()` is not wired to HTTP.
- Distributed velocity counters when Redis is unavailable.
- A real multi-node cache invalidation path through `CachePort.publishInvalidation` (the method is optional and unused).
- Read models for merchant dashboards or wallet statements. Only the two attempt-derived tables exist.
- A structural benchmark for sustained 1,000+ TPS, deep search or restore throughput (see `core.tests`).

### Known bugs / risks

- (Fixed 2026-11-04) `AuditShipperWorker` / `OutboxRelayWorker` retained every shipped/processed row; both now prune after a retention window.
- (Fixed 2026-11-04) `projectAttemptTransition` converted money with `Number(...).toFixed(4)`; amounts now go through decimal.js.
- A failed log flush requeues step logs but not access logs, so access-log rows can be silently lost. Code gap in `auditAndLogAdapters.ts:485-488`.
- `RedisCacheAdapter.del` uses `KEYS`, which blocks Redis on large keyspaces. Code risk.
- The Redis L1 cache returns a 30-second cached value even when the requested L2 TTL is different; invalidation must cover every node. Code risk.
- The replica LSN monitor runs per process and each core node probes every replica every 150 ms. At many nodes this is measurable probe load. Operational risk.
- A replica that throws is marked unhealthy immediately in `execute`, while the monitor requires two failures; the two paths can disagree briefly. Code risk.
- `readThroughReplica` falls back to the primary on any thrown error, including a caller bug, which can hide query errors. Code risk.
- Audit chain appends serialize on a single advisory lock. Throughput is intentionally bounded by the dedicated audit database, but a slow audit DB backpressures the shipper, not the write path. Operational risk.
- `lockGlAccountShardsSorted` returns only rows that already exist; missing shard rows are not created by the lock call. A caller that assumes a complete map can under-lock. Code risk; `ensureAccountShards` must have run.
- `StorageEngine.health()` returns `audit.ok = false` when the audit store is not configured, which conflates "not configured" with "unhealthy". Code risk in monitoring semantics.
- The backup client creates a keep-alive agent once from the environment. Certificate rotation requires a process restart or singleton reset. Operational risk.

## 8. Verification and tests

Relevant test files:

- `core-back/test/storage-engine/primitives.test.ts` — LSN comparison, UUIDv7 and stable JSON.
- `core-back/test/storage-engine/uow.test.ts` — atomicity, outbox/audit rows, shard locks and commit LSN.
- `core-back/test/storage-engine/write-path.integration.test.ts` — live-PostgreSQL write path.
- `core-back/test/storage-engine/outbox-workers.test.ts` — relay, audit shipper and read-model projection.
- `core-back/test/storage-engine/audit-chain.test.ts` — dedicated audit chain and immutability assumptions.
- `core-back/test/storage-engine/log-sink.test.ts` — buffering, flush and attempt lookups.
- `core-back/test/storage-engine/read-store.test.ts` — lag/LSN selection and fallback.
- `core-back/test/storage-engine/ledger-shards.test.ts` — shard arithmetic and balances.
- `core-back/test/storage-engine/cache-velocity.test.ts` — memory and live Redis velocity.
- `core-back/test/storage-engine/engine-factory.test.ts` — factory and health snapshot.
- `core-back/test/storage-engine/db-optimisation.test.ts` — DB-free tests of delta folding, retention SQL, lease claim, shard folding, batched poster, replica helper, live balance loader.
- `core-back/test/list-query-keyset.test.ts` — keyset cursor encode/decode and predicates.
- `core-back/test/storage-engine/performance/storage-performance.test.ts` — pure primitives, UoW, outbox drain, shard reads, audit append, Redis velocity.
- `core-back/test/storage-engine/performance/write-path-benchmark.test.ts` — audit write and shard-read latency.
- `core-back/test/backup-admin/*.test.ts` — backup client and internal routes.

Commands:

```bash
cd core-back && bun test test/storage-engine
cd core-back && bun test test/backup-admin
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test ./scripts/run-benchmarks.sh
```

Suites under `test/storage-engine` and `test/backup-admin` use `databaseIsReachable` and `redisIsReachable` probes. Without PostgreSQL 18 they skip the database `describe` blocks; without Redis they skip the live Redis velocity suite. The pure primitive and memory-cache tests still run. The benchmark runner requires `DATABASE_URL` (or `POSTGRES_TEST_DATABASE_URL` / `STORAGE_TEST_DATABASE_URL`) and exits with code 2 when none is set.

There is no benchmark in this part that proves the blueprint's 1,000+ TPS sustained target, deep-search latency or restore throughput. The performance tests assert generous regression ceilings on a developer machine, not production-scale capacity. No test run was performed for this documentation change.

## 9. Source references

### Old design sections

- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#2-segment-1--the-core-back-storage-driver-engine-core-backlibstorageengine`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#3-2-outbox-driven-read-models--uncompromised-20-group-deep-search-on-replicas`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#5-segment-4--backup-management-orchestrator--admin-control-plane-pg-backup-daemon--core-back--admin-front`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#6-segment-5--horizontal-node-scaling--multi-host-storage-orchestration-in-deploydeployenv--deploydeployts`
- `design/00-process/blueprint-management.md#5-documentation-corrections-backlog`

### Code paths

- `core-back/lib/storageEngine/ports.ts`
- `core-back/lib/storageEngine/index.ts`
- `core-back/lib/storageEngine/uowAdapter.ts`
- `core-back/lib/storageEngine/outbox.ts`
- `core-back/lib/storageEngine/outboxWorkers.ts`
- `core-back/lib/storageEngine/readStoreAdapter.ts`
- `core-back/lib/storageEngine/redisCacheAndVelocityAdapter.ts`
- `core-back/lib/storageEngine/auditAndLogAdapters.ts`
- `core-back/lib/storageEngine/shardBalances.ts`
- `core-back/lib/storageEngine/ledgerShardWriter.ts`
- `core-back/lib/storageEngine/ledgerPosterFactory.ts`
- `core-back/lib/storageEngine/backupControlClient.ts`
- `core-back/lib/storageEngine/lsn.ts`
- `core-back/lib/storageEngine/uuid.ts`
- `core-back/engine/workers/productionRuntime.ts`
- `core-back/lib/requestLogger/index.ts`
- `core-back/lib/listQuery.ts`
- `core-back/api/internal/admin.ts`
- `core-back/api/internal/merchant.ts`
- `core-back/api/internal/backups.ts`
- `core-back/prisma/migrations/20261103000000_postgres18_init/migration.sql`
- `core-back/prisma/migrations/20261103120000_postgres18_storage_engine/migration.sql`
- `core-back/prisma/migrations/20261103130000_cqrs_read_models/migration.sql`
- `core-back/prisma/migrations/20261103180000_storage_hardening/migration.sql`

### Generated appendices

- `project-design/appendices/schema-catalog.md` (generated; models, columns, indexes)
- `project-design/appendices/migration-catalog.md` (generated; migration application order)
- `project-design/appendices/env-and-config-matrix.md` (generated; storage environment keys)
- `project-design/appendices/api-route-matrix.md` (generated; backup and search routes)

## 10. Change history

- 2026-11-04 — DB read/write optimisation pass (section 12): batched outbox projection with retention, leased audit shipper, batched ledger posting, keyset pagination, single-statement balances, new/removed indexes, schema version 9. See `project-design/TRACKER.md`.
- 2026-11-03 — Initial canonical extraction. Records the actual UoW/outbox/audit behavior, replica adoption, Redis fallback, shard arithmetic, read-model no-op handlers, missing retention, missing keyset pagination, missing `gateway_wire_logs`, missing disk spool and zero DB log metrics. See `project-design/TRACKER.md`.

## 11. Two-machine routing and realtime additions (2026-11-03)

- `readThroughReplica` and `readThroughReplicaOrPrimary` record the serving store in an `AsyncLocalStorage` context. The core middleware emits `x-pg-served-by` (and the requested `x-pg-min-lsn` watermark) on the response. Checkout initiate/confirm also emit `x-pg-lsn` with the post-commit flush LSN.
- The admin merchant list now uses the replica-aware helper, so the T1/T3/T4/T5/T6/T7/T8 routing gate can prove list reads hit a replica and T2 falls back to primary.
- `AuditShipperWorker` no longer computes `prev_hash`/`row_hash` in Node. Inserts omit both columns and the audit database trigger computes them under `pg_advisory_xact_lock(994001)`; `RETURNING` supplies the actual hashes.
- `verifyHashChainIntegrity` reads `before_json::text`/`after_json::text` so it verifies the trigger canonical form.
- Attempt transitions are bridged to `realtime:attempt` on the existing Redis-backed invalidation bus; checkout SSE and merchant POS streams subscribe to it while retaining the database poll fallback.

## 12. 2026-11-04 database read/write optimisation

### 12.1 Plan (prioritised by hot-path impact)

1. **Write path (checkout confirm, ledger posting).** A 4-line posting cost 25-30 statements: per line `glAccount.findFirst` (+ fallback), `journalLine.create`, shard upsert, plus a never-consumed `ledger.entry_posted` outbox insert; shard upserts ran in template order (deadlock window). Batch to: 1 entry insert, 1 account lookup, 1 line insert, 1 sorted shard upsert.
2. **Outbox/audit.** Per-event double upsert and per-row ack in the relay; shipper claim locks were released before shipping; both tables unbounded; idle polling every 250/500 ms. Batch, lease, prune, back off.
3. **Reads on hot paths.** Rail catalog (every checkout page/initiate): uncached daily-volume SUM with a non-sargable COALESCE, full-table unfiltered reads incl. `entries_ciphertext`. Checkout re-reads and link/application/merchant loads on every attempt route. Merchant dashboard loaded every attempt of 90 days into JS. Balance fallbacks summed unbounded journal lines.
4. **Lists.** Offset pagination + COUNT, wide rows (`context_ciphertext`, customer JSON). Add keyset + `includeTotal=false` + column selects.
5. **Indexes.** Remove prefix-duplicates, add composites that match real WHERE/ORDER BY.
6. **Workers.** Batch claim updates; fix lock scope (open, GAP-DB-02).

### 12.2 As built

| Area | Before | After | Where |
| :--- | :--- | :--- | :--- |
| Ledger posting | findFirst entry + create + per-line (findFirst, create, upsert) + ledger outbox insert | `createManyAndReturn(skipDuplicates)` entry, one `findMany` account lookup, one line `createManyAndReturn`, one `unnest` shard upsert folded and sorted by (account, shard); no `ledger.entry_posted` by default. Clients without the batch methods (test doubles) keep the per-row path. | `engine/ledger/LedgerPoster.ts`, `lib/storageEngine/ledgerShardWriter.ts`, `ledgerPosterFactory.ts` |
| Attempt read-model projection | 2 upserts per event | one folded delta per key, one `unnest` upsert per read model, one batch ack; money via decimal.js; terminal `BLOCKED` counted as failure; success amounts tracked separately; route volume = succeeded volume | `lib/storageEngine/outboxWorkers.ts` |
| Outbox retention | none | `OutboxRelayWorker.prune` below the oldest unprocessed id, bounded batches | same |
| Audit shipper | claim tx committed before append; never pruned | single-statement lease claim (`lease_until`), `shipped_at`+lease clear, prune after retention | same |
| Poll cadence | fixed 250/500 ms | exponential idle back-off, immediate re-poll on a full batch | `nextPollDelayMs` |
| Replica helper | a failing query ran on the replica, then twice on the primary | the query runs on the primary at most once; the primary retry only happens when the read store failed before reaching the query | `lib/storageEngine/index.ts` |
| Balances | merchant balance + `merchantWalletBalance` summed every journal line on top of a debit-positive checkpoint; admin finance looped one query per account; merchant overview used the stale checkpoint | `loadLiveAccountBalances`: one statement, shard total or checkpoint + post-checkpoint lines, natural sign | `shardBalances.ts`, `merchantOps.ts`, `merchant.ts`, `admin.ts` |
| Invariant check | one `journal_lines` query per account every 60 s | one grouped SQL (opt-in `{ sql: true }` for PostgreSQL clients) | `engine/ledger/InvariantVerifier.ts` |
| Rail catalog | daily-volume SUM sequentially before four full-table reads incl. encrypted entries | all five in parallel; credential sets limited to VERIFIED rows and 7 columns; commission profiles 6 columns; daily volume served by a partial expression index | `engine/flow/VisibleRailsCatalog.ts` + migration |
| Checkout | link+application+merchant load on every attempt route; full-row status polls and re-reads | attempt scoped by `link.key` in one query; `select: { status }` re-reads; SSE poll selects 4 columns; widget/redirect/attempt reads in parallel; trimmed link include | `api/internal/checkout.ts` |
| Merchant API | overview loaded all attempts of the window; POS stream updated every 3 s and joined through applications; list/stream rows included encrypted context; statements ignored month/wallet; CSV filtered 1,000 rows in JS | overview = `groupBy` + one grouped SQL + `take: 6`; heartbeat once a minute; explicit attempt list select; month bounds in SQL; bounded link-attempts (500); disputes via relation filter | `api/internal/merchant.ts` |
| Pagination | offset only | `buildListQuery` returns `keyset`, accepts `cursor`, `includeTotal=false`; `listResponse` emits `nextCursor` | `lib/listQuery.ts` |
| Job claim | one UPDATE per claimed job | one `UPDATE ... id = ANY(...)` | `engine/workers/BackgroundJobWorker.ts` |

Indexes: see migration `20261104090000_db_read_write_optimisation` in `core.data`.

### 12.3 Bugs found and fixed

- `GET /internal/merchant/links`: the list filtered by a non-existent `payment_links.merchant_id` (and searched a non-existent `description`); Prisma rejects both. Now filtered by `application.merchantId`, search on `key`.
- `GET /internal/merchant/payments`: `confirmedAt` filter/sort used a non-existent column; mapped to `terminal_at`.
- `GET /wallets/:id/statements` ignored the month; CSV export took the latest 1,000 successes then filtered in JS (older months empty).
- Merchant balance fallback and `merchantWalletBalance` double-counted lines already folded into the checkpoint (no `created_at > checkpoint_at`) and applied a credit-positive sign to a debit-positive checkpoint.
- `projectAttemptTransition` used floating point for money.
- `AuditShipperWorker` claim did not hold locks while shipping.
- `readThroughReplica*` re-ran failing queries up to three times and swallowed the error type.
- `GET /disputes` loaded every DISPUTED attempt id and shipped it twice as an IN list.

### 12.4 Known pre-existing failures observed (not caused by this change)

- `dedicated audit database > concurrent and duplicate append calls serialize through the advisory lock` expects a gapless `seq_no` but duplicate appends consume sequence values.
- `writeAudit writes the compatibility row ...` and `300 transactional audit writes ...` fail with `audit_log_actor_id_fkey` against a freshly migrated, unseeded database (fixture needs a seeded actor).
- Hooks in `test/exhaustive/06-concurrency` exceed the 5 s default on a cold database (pass with `--timeout 60000`).

### 12.5 Open work

GAP-DB-02 (claim loops outside a transaction), GAP-DB-03 (KYB expiry has no cursor), GAP-DB-04 (engine re-reads, commission-receivable SUM scanning all receivable lines through a `pa.id::text` join, velocity per-rule queries, uncached flow/step/credential reads), GAP-DB-05 (admin lists/exports/summaries on the primary with wide columns, `reconciliation/runs` loading `file_content`, join-request mutations re-reading KYB `content_ciphertext`, bulk operator-case loops, `PUT /settings` per-entry reads), GAP-DB-06 (dashboards still do not read `rm_*`; merchant overview could use `rm_merchant_daily_stats` once per-rail and commission columns exist), and adoption of keyset pagination for the remaining lists.

## Data Schema and Migrations

> Status: `partial` · Last verified: 2026-11-04

## 1. Purpose and scope

This part owns the PostgreSQL 18 relational model, the committed migration history, the schema-version guard and the deterministic seeders that populate a baseline platform.

It covers:

- `core-back/prisma/schema.prisma` — 75 Prisma models and 105 enums;
- `core-back/prisma/migrations/**` — five committed migrations;
- `core-back/prisma/schemaVersion.ts` and `core-back/prisma/client/index.ts` — schema version 9 and the boot guard;
- `core-back/prisma/migrateDev/index.ts` — the migration creation/adoption workflow;
- `core-back/prisma/seed.ts`, `seedBlueprints.ts`, `seedGlAccounts.ts`, `seedGuides.ts` and `seedFakeRails.ts` — deterministic baseline data;
- `core-back/prisma/syntheticSeeder/**` — the optional multi-year synthetic history (documented separately in `core.seeder`).

It does not own domain state machines, ledger templates, API behavior, storage adapter behavior or backup policy. Those are documented in `core.engine`, `core.ledger`, `core.storage` and `core.backup`.

## 2. Design intent (extracted and synthesized from ./design)

The historical design treats PostgreSQL 18 as the only runtime database and the schema as the durable contract for the switch:

- money is stored as `DECIMAL(18,4)` and never as floating point;
- payments, ledger entries and audit/outbox records are written atomically;
- the ledger is append-only and enforced by constraints and shard projections;
- maker-checker is a database-enforced rule, not only an application convention;
- the append-only journal is range-partitioned by month for retention and maintenance;
- read models and the dedicated audit/log databases are separate physical targets;
- migrations are versioned and checked at boot so an outdated database cannot serve traffic.

The blueprint's stale counts are corrected here:

- the schema is not 64 models and 100 enums; it is 75 models and 105 enums;
- the schema version is 8, not 5 or 6;
- there is not one migration that creates shards, outboxes and all tables. The baseline creates the tables, the storage migration adds indexes, the CQRS migration adds read models, and the hardening migration adds partitions, checks and search indexes;
- `rm_merchant_dashboard_stats` and `rm_wallet_statements` do not exist. The actual read models are `rm_merchant_daily_stats` and `rm_route_daily_volumes`.

## 3. As-built architecture

### 3.1 Schema size and layout

`core-back/prisma/schema.prisma` contains:

- 75 `model` declarations;
- 105 `enum` declarations;
- 188 `@@index` / `@@unique` declarations in the datamodel;
- PostgreSQL provider configured through `DATABASE_URL` and the Prisma 7 `@prisma/adapter-pg` runtime.

The models are grouped by domain:

| Domain | Representative models |
| :--- | :--- |
| Merchant and onboarding | `Merchant`, `User`, `UserIdentity`, `JoinRequest`, `KybDocument`, `KybRevalidationRequest`, `BeneficialOwner`, `Application`, `Wallet`, `AccessToken`, `AccessTokenIp` |
| Payment collection | `PaymentLink`, `PosTerminal`, `PosScreen`, `AttemptGroup`, `PaymentAttempt`, `AttemptStepLog`, `InboundEvent`, `OperatorCase`, `GatewayInquirySchedule` |
| Ledger and balances | `GlAccount`, `JournalEntry`, `JournalLine`, `GlAccountShard`, `CommissionProfile` |
| Gateway catalogue and flow | `Gateway`, `GatewayVersion`, `GatewayVersionEvidence`, `GatewayEnvironment`, `GatewayAuth`, `GatewaySetting`, `CredentialSet`, `Asset`, `Rail`, `RailField`, `RailRoute`, `CryptoProfile`, `Flow`, `FlowStep`, `StepParameter`, `StepOutput`, `StatusRule`, `ErrorMap`, `ConfirmationChannel`, `PollPolicy`, `WidgetDefinition`, `RedirectDefinition`, `StatementSource`, `ManualInstruction` |
| Risk and collection operations | `VelocityRule`, `AmlCase`, `AmlScreening`, `AmlScreeningMatch`, `AmlRule`, `ReportingRule`, `RegulatoryReport`, `Dispute`, `Adjustment`, `CashoutRequest`, `ReconciliationRun`, `ReconciliationItem` |
| Governance and audit | `ApprovalRequest`, `DetailChangeLog`, `AuditLog`, `NotificationTemplate`, `Notification`, `PlatformSetting`, `BackgroundJob` |
| Health and operations | `GatewayHealthSample`, `BackupCatalogRun`, `BackupRestoreDrill` |
| Write-path infrastructure | `OutboxEvent`, `AuditOutbox` |
| Read models | `RmMerchantDailyStat`, `RmRouteDailyVolume` |

`core-back/generated/prisma/**` is the committed generated client. It must be regenerated with `bun run migrate-generate`, not hand-edited.

### 3.2 Schema version

`core-back/prisma/schemaVersion.ts` exports `REQUIRED_SCHEMA_VERSION = 9`.

`core-back/prisma/client/index.ts:17-37` implements `ensureSchemaVersion()`:

- it connects through the base client;
- it reads `schema_versions.version` where `id = 1`;
- it throws when the row is missing or does not equal 9;
- it caches the successful check and resets the cached promise after a failure so a later call can retry.

`core-back/prisma/seed.ts`, `seedFakeRails.ts` and `syntheticSeeder/index.ts` call `ensureSchemaVersion()` before writing. A stale database is therefore rejected by these seeders and by any caller that explicitly asserts the version. The core HTTP start path does not call it.

### 3.3 Migration history

There are exactly five committed migrations:

| Migration | Purpose |
| :--- | :--- |
| `20261103000000_postgres18_init` | Creates 74 tables: all baseline Prisma model tables plus the `schema_versions` support table. Creates enums and the initial indexes/FKs. Inserts schema version 7. |
| `20261103120000_postgres18_storage_engine` | Adds `pg_trgm` and `btree_gin`; replaces outbox/audit indexes with partial/BRIN indexes; adds covering/BRIN journal indexes; adds worker-claim partial indexes; adds attempt reference indexes and trigram search indexes. |
| `20261103130000_cqrs_read_models` | Creates `rm_merchant_daily_stats` and `rm_route_daily_volumes` plus their day indexes. |
| `20261103180000_storage_hardening` | Adds `pg_stat_statements` when available; sets `gl_account_shards.shard_id` default and range check; converts `journal_lines` to monthly range partitions; adds partition maintenance function; adds broader trigram indexes; updates schema version to 8. |
| `20261104090000_db_read_write_optimisation` | Part A (Prisma diff): drops the redundant `payment_attempts(link_id)`, `payment_attempts(merchant_id)`, `attempt_step_logs(attempt_id)`, `reconciliation_items(run_id)` and `audit_log(entity_type, entity_id)` indexes (each is a prefix of a kept or new composite); adds `approval_requests(subject_type, subject_id, state)`, `payment_attempts(link_id, created_at)`, `attempt_step_logs(attempt_id, created_at)`, `inbound_events(attempt_id, received_at)`, `reconciliation_items(run_id, created_at)` and `(created_at)`, `audit_log(created_at)` and `(actor_id, created_at)`; adds `audit_outbox.lease_until` and `rm_merchant_daily_stats.success_amount` / `success_net_amount`. Part B (raw SQL): partial expression index `payment_attempts_succeeded_settled_at_idx` on `COALESCE(terminal_at, created_at)` INCLUDE `(route_id, total_charged_amount)` WHERE `status = 'SUCCEEDED'` (daily route volume), `audit_outbox_unshipped_idx` recreated INCLUDE `lease_until`, `audit_outbox_shipped_idx` (partial btree) replacing the BRIN. Sets schema version 9. |

The baseline creates the tables, not the storage migration. The storage migration is index-only. The hardening migration is the one that rewrites `journal_lines` into a partitioned table:

- it renames the old table to `journal_lines_unpartitioned`;
- it creates the new partitioned parent with primary key `(id, created_at)`;
- it creates monthly partitions from 2023-01 through the 2028-11 partition and a default partition;
- it copies existing rows;
- it re-adds foreign keys and the positive-amount check;
- it recreates the covering and BRIN indexes;
- it creates `ensure_journal_line_partitions(months_ahead)` and runs it for 18 months.

The deploy engine installs a daily cron at `JOURNAL_LINE_PARTITION_MAINTENANCE_CRON = "30 1 * * *"` that calls `ensure_journal_line_partitions(18)` (`deploy/provisioners/backupEngineProvisioner.ts:333-336`). Partition creation outside that cron is not automatic. A write that falls outside all monthly ranges goes to the default partition.

### 3.4 Indexes

The index strategy has four layers:

1. Foreign-key and uniqueness indexes from the baseline.
2. Partial indexes for worker claim loops:
   - `outbox_events_unprocessed_idx` on `id` where `processed_at IS NULL`;
   - `audit_outbox_unshipped_idx` on `(created_at, id)` where `shipped_at IS NULL`;
   - `payment_attempts_active_expiry_partial_idx` and `payment_attempts_active_poll_partial_idx` for non-terminal attempts;
   - `inbound_events_unprocessed_partial_idx`, `background_jobs_queued_partial_idx` and `notifications_queued_partial_idx`.
3. Covering and BRIN indexes:
   - `journal_lines_account_id_cov_idx` includes direction, amount and created_at;
   - BRIN indexes on `journal_lines.created_at`, `payment_attempts.created_at`, `outbox_events.created_at` and `audit_outbox.shipped_at`;
   - `payment_attempts_merchant_keyset_cov_idx` backs keyset pagination of the merchant payment list (cursor predicate on `(created_at, id)`).
4. Trigram GIN indexes for search candidates on merchants, attempts, join requests, users, gateway inquiries, approvals, KYB documents, disputes, adjustments, reconciliations, AML cases/screenings/rules, regulatory reports, gateways, rails and `audit_log`.

### 3.5 Constraints and triggers

The database enforces the invariants that must not depend on a caller:

| Constraint | Definition | Purpose |
| :--- | :--- | :--- |
| `journal_lines_amount_positive` | `amount > 0` | Rejects zero/negative journal lines |
| `attempt_groups_single_success` | `success_count <= 1` | One success per attempt group |
| `payment_links_slot_reservation_invariant` | `infinite_use = true OR confirmed_count + active_locked_count <= use_count` | Prevents slot over-reservation |
| `approval_requests_checker_not_maker_insert` | `checker_user_id IS NULL OR checker_user_id <> maker_user_id` | Maker-checker on insert |
| `gl_account_shards_shard_id_range` | `shard_id >= 0 AND shard_id < 16` | Shard range |
| `journal_lines_entry_id_fkey` | FK to `journal_entries` with `ON DELETE RESTRICT` | No orphan ledger lines |
| `journal_lines_gl_account_id_fkey` | FK to `gl_accounts` with `ON DELETE RESTRICT` | No orphan account lines |

The baseline also creates the `approval_requests_checker_not_maker` trigger function and `approval_requests_checker_not_maker_update` before-update trigger, which raises when a checker is set equal to the maker. Unique indexes further enforce:

- `journal_entries(ref_type, ref_id)` — one journal entry per domain reference;
- `payment_attempts(reference)`, `payment_attempts(ledger_entry_id)` and `payment_attempts(link_id, idempotency_key)`;
- `inbound_events(channel_id, dedupe_key)`;
- `users(email)`, `user_identities(kind, identifier_normalized)` and `user_identities(provider_subject)`;
- `payment_links(key)`, `access_tokens(token_hash)`;
- `gateways(code)`, `gateway_versions(content_hash)` and `gateway_versions(gateway_id, version_number)`;
- `adjustments(dispute_id)` and `adjustments(journal_entry_id)`;
- `reconciliation_runs(file_hash)` and `platform_settings(key, scope, version)`.

### 3.6 UUID and timestamp conventions

- IDs are UUIDs stored as native PostgreSQL `uuid` (`@db.Uuid`).
- Most models declare `@id @default(uuid(7))`. The application also generates UUIDv7 directly through `core-back/lib/storageEngine/uuid.ts` for audit ids; `uuidv7()` is monotonic within a millisecond and preserves B-tree insert locality.
- Some infrastructure tables use non-UUID keys: `OutboxEvent.id` is `BigInt @default(autoincrement())`; `HttpAccessLog` (dedicated log DB, outside Prisma) and `AuditRecord` use their own identity/primary-key conventions.
- `createdAt` is `DateTime @default(now()) @map("created_at")`; `updatedAt` is `DateTime @updatedAt` on models that mutate.
- Core domain tables use `TIMESTAMP(3)` (without time zone), matching Prisma's default mapping in the baseline. Storage-engine tables such as `gl_account_shards`, `outbox_events`, `audit_outbox`, `backup_catalog_runs` and the two read models explicitly use `@db.Timestamptz(3)`.
- `schema_versions` uses `TIMESTAMPTZ(3)` directly in raw SQL.
- Column names are snake_case through `@map` / `@@map`; the Prisma client exposes camelCase fields.

The mixed timestamp convention is real. Any query that compares a core `TIMESTAMP(3)` column to `now()` relies on the session time zone; storage-engine tables compare absolute instants. New tables should use `TIMESTAMPTZ(3)` unless there is a documented reason not to.

### 3.7 Baseline seeders

`core-back/prisma/seed.ts` is the main baseline seeder. It is idempotent by lookup for most rows and covers:

- platform settings (`OD-1` through `OD-11` plus `join_request.four_eyes_policy`, `onboarding.required_documents`, `join_request.volume_threshold`, `kyb.refresh_policy`);
- system GL accounts via `seedSystemGlAccounts(client)`;
- the blueprint catalogue (`seedBlueprints(client)`) — gateways, versions, rails, routes, flows, steps, status/error maps and related definitions;
- platform credential sets via `seedPlatformCredentialSets(client)`;
- bilingual notification templates;
- reporting rules for the CBL large-transaction and suspicious-activity references;
- checkout support configuration and per-rail help guides via `seedCheckoutSupport` and `seedRailHelpGuides`.

`core-back/prisma/seedFakeRails.ts` is a separate bridge that points seeded gateways at the Fake Rails emulator, rewrites environment base URLs and allowed hosts, updates widget definitions to the emulator SDK, and derives inbound verification secrets from the shared seeder token. It is not a full domain seed.

`core-back/prisma/syntheticSeeder/index.ts` is the optional multi-year history seeder. It requires the Fake Rails safety gate and is described in `core.seeder`.

### 3.8 Migration workflow

The normal workflow is:

```bash
cd core-back
bun run migrate-dev       # create a new migration from the schema and apply it
bun run migrate-deploy    # apply committed migrations
bun run migrate-reset     # drop and recreate the database, then apply all migrations
bun run migrate-generate  # regenerate the Prisma client
bun run prisma:validate   # validate the datamodel
```

`core-back/prisma/migrateDev/index.ts` wraps Prisma:

1. It lists migration directories before the operation.
2. It runs `prisma migrate dev --create-only --name init`.
3. If Prisma created a migration, it patches the SQL: it removes the `DROP TABLE "schema_versions"` statement and appends the schema-version table DDL plus an upsert to `REQUIRED_SCHEMA_VERSION`.
4. It runs `prisma migrate deploy`.

The patch exists because `schema_versions` is managed outside the Prisma datamodel. It is string-based and assumes the generated Prisma SQL contains the exact `DROP TABLE "schema_versions";` statement. A Prisma output change that renames or reformats that statement would silently leave the drop in place or skip the upsert. Review the patched SQL before committing a migration.

## 4. Contracts and invariants

- PostgreSQL 18 is the only runtime database. MySQL/MariaDB must not be reintroduced.
- Money columns are `DECIMAL(18,4)` (or Prisma `Decimal` with the same precision). Application code uses `Decimal`/`decimal.js`; no floating-point arithmetic is allowed for money.
- The Prisma schema is the source of the datamodel. Migrations are the source of applied DDL. Never edit `PROJECT_DESIGN.md`, generated appendices or the generated Prisma client as if they were the schema source.
- Every migration must be forward-applicable to the committed history. There are no down migrations; recovery is restore/PITR or a new forward migration.
- The schema-version row is single-row (`id = 1`) and must equal `REQUIRED_SCHEMA_VERSION` before the application or seeder proceeds.
- `journal_lines` is append-only and partitioned by `created_at`. The primary key includes `created_at` because PostgreSQL requires the partition key in every unique key.
- `journal_lines.amount > 0`; direction carries the sign.
- `payment_links` slot accounting must satisfy the check invariant at all times.
- `approval_requests` must have `checker_user_id <> maker_user_id` when a checker is present, on insert and update.
- `gl_account_shards.shard_id` must be in `0..15`.
- FK actions are deliberate: ledger and shard references use `RESTRICT`; optional relationships use `SET NULL` or `CASCADE` where the dependent row has no independent meaning.
- UUIDv7 is the preferred identifier for new domain rows. Do not use random UUIDv4 for high-volume insert paths without a measured reason.
- Seeders must be safe to rerun. Baseline seeders use existence checks; the synthetic seeder uses a completed-run marker and `skipDuplicates`.
- The Fake Rails bridge requires `FAKE_RAILS_SEEDER_TOKEN`; it must not silently fall back to an empty secret.
- `rm_*` tables are derived data, not the source of truth. A rebuild must be possible from the outbox/ledger. `rebuildAttemptReadModels(db, { fromDay, toDay })` (`outboxWorkers.ts`) recomputes both attempt read models from `payment_attempts`; run it after bulk loads that bypass the outbox (the synthetic seeder). Since 2026-11-04 `rm_route_daily_volumes.volume_amount` is the SUCCEEDED volume (the daily route-cap semantics) and `rm_merchant_daily_stats` carries separate `success_amount` / `success_net_amount` columns next to the creation-time `gross_amount` / `net_amount`.

## 5. Data / API / config / deployment surface

### Prisma and generated surfaces

- Datamodel: `core-back/prisma/schema.prisma`.
- Generated client: `core-back/generated/prisma/**`.
- Migration lock: `core-back/prisma/migrations/migration_lock.toml` (`provider = "postgresql"`).
- Schema version constant: `core-back/prisma/schemaVersion.ts`.
- Boot guard: `core-back/prisma/client/index.ts`.
- Migration wrapper: `core-back/prisma/migrateDev/index.ts`.

### Environment

| Key | Purpose |
| :--- | :--- |
| `DATABASE_URL` | Primary PostgreSQL 18 connection used by Prisma, migrations and seeders |
| `POSTGRES_TEST_DATABASE_URL` / `STORAGE_TEST_DATABASE_URL` | Alternative test database URLs used by test helpers |
| `FAKE_RAILS_PUBLIC_BASE_URL` | Base URL used by `seedFakeRails.ts` |
| `FAKE_RAILS_SEEDER_TOKEN` | HMAC seed for Fake Rails secrets and seeder authentication |
| `FAKE_RAILS_ALLOWED_HOSTS` | Allowed hosts written into gateway environments |
| `SYNTHETIC_SEED_*` | Synthetic seeder controls (see `core.seeder`) |

### Scripts

| Script | Action |
| :--- | :--- |
| `bun run migrate` | `prisma migrate deploy` |
| `bun run migrate-dev` | Create + patch + apply a migration |
| `bun run migrate-deploy` | Apply committed migrations |
| `bun run migrate-reset` | Drop/recreate the database and apply migrations |
| `bun run migrate-generate` | Regenerate the Prisma client |
| `bun run db-seed` | Run the baseline seed |
| `bun run seed-fake-rails` | Point seeded gateways at Fake Rails |
| `bun run seed-synthetic-history` | Run the synthetic history seeder |

### Deployment surfaces

- The deploy engine provisions PostgreSQL 18 on the primary, replicas and optional PgBouncer.
- The partition cron is installed on the primary by `backupEngineProvisioner.ts`.
- The audit and log databases have their own DDL in `deploy/provisioners/auditAndLogDbProvisioner.ts`; they are not Prisma models.
- Backups capture the core database, audit database and optional Redis snapshot (see `core.backup`).

## 6. Operational usage

- Apply migrations before starting a new core build. The boot guard will reject a schema version other than 8.
- Use `bun run migrate-dev` only in development. For production, review and commit the generated migration, then run `bun run migrate-deploy`.
- After changing `schema.prisma`, run `bun run migrate-generate` before typechecking or starting the application.
- Keep the `schema_versions` patch logic in `migrateDev/index.ts` under review. It is the only place that updates the version for newly created migrations.
- Run partition maintenance by installing the deploy cron or by calling `SELECT ensure_journal_line_partitions(18)` on a schedule. The default partition is a safety net, not a substitute for monthly maintenance.
- Run `bun run db-seed` once per environment. It is idempotent for the platform settings, system accounts, blueprints, credential sets, templates, reporting rules and guides.
- Run `bun run seed-fake-rails` only in environments that intentionally point at the emulator. It rewrites gateway base URLs and allowed hosts.
- For a test server, set the synthetic seeder safety variables and run `bun run seed-synthetic-history` after the baseline seed and Fake Rails blueprints.
- To inspect the schema, read the generated `project-design/appendices/schema-catalog.md` and `migration-catalog.md`; regenerate them with `bun scripts/project-design/build.ts`.

## 7. Status and deviations

### Implemented

- 75 models and 105 enums in the Prisma datamodel.
- Schema version 8 with an equality check used by the seeders.
- Four committed migrations with the intended separation: baseline, storage indexes, CQRS read models, hardening.
- Monthly range partitioning of `journal_lines` with historical/future partitions and a default partition.
- Partial, covering, BRIN and trigram indexes for the write path, workers and search.
- Maker-checker insert check and update trigger, slot invariant, positive journal amount, shard range and reference uniqueness.
- UUIDv7 defaults and application UUIDv7 generation.
- Baseline seeders for settings, GL accounts, blueprints, credential sets, templates, reporting rules and guides.
- Fake Rails bridge seeder.
- Synthetic seeder integration with the schema-version guard.
- Schema, constraint, trigger and index test suites.

### Partial

- Timestamp semantics: core domain tables use `TIMESTAMP(3)` while storage tables use `TIMESTAMPTZ(3)`. This is consistent inside each area but mixed globally.
- Seed coverage is complete for platform fundamentals and blueprints, not for every optional model. Business history is delegated to the synthetic seeder.
- Migration guard coverage: the schema-version check runs in the seeders, not in the core HTTP start path; the migration wrapper patches new migrations, but there is no general runtime guard around every script.

### Missing / deferred

- Down migrations or automated rollback. Intentional forward-only design.
- Automatic partition creation inside the application. Deferred to the deploy cron.
- A hand-maintained schema table in the design docs. Replaced by the generated schema catalog.
- Automatic schema drift detection between `schema.prisma` and the live database. `prisma migrate` / validation tools are the current check.
- A boot-time schema assertion in core. The helper exists but core does not call it.

### Known bugs / risks

- The `migrateDev` patch is string-based and fragile against Prisma SQL formatting changes. Code risk.
- `schema_versions` is excluded from the Prisma datamodel, so `prisma migrate reset` drops it and relies on the patched migrations to recreate it. A migration that bypasses `migrateDev` can miss the version upsert.
- The baseline migration inserts version 7 and only the hardening migration moves to 8. Applying only the first three migrations leaves the database at 7; the seeders refuse to run, while core HTTP can start because it does not call the guard. This is easy to misread during partial restore.
- The partition maintenance function creates future partitions but does not enforce retention or detach old partitions. Retention is a separate operational decision.
- The default partition can silently accumulate out-of-range rows, which complicates later partition attachment.
- Core `TIMESTAMP(3)` columns have no time zone. Cross-host comparisons can be wrong if a session time zone differs from the application assumption. Code/schema risk.
- Prisma client generation is committed; a schema change without regenerating the client produces a typecheck/runtime mismatch.
- The synthetic seeder and baseline seeder both write users; the synthetic `authoritiesMap` shape differs from the auth parser expectation (see `core.seeder`).

## 8. Verification and tests

Relevant test files:

- `core-back/test/exhaustive/01-schema/models-and-columns.test.ts` — parses `schema.prisma` and checks the expected model/column surface.
- `core-back/test/exhaustive/01-schema/unique-and-fk-constraints.test.ts` — live PostgreSQL catalog checks for unique and foreign-key constraints.
- `core-back/test/exhaustive/01-schema/check-constraints-and-triggers.test.ts` — check constraints and maker-checker trigger behavior.
- `core-back/test/exhaustive/01-schema/indexes-and-query-plans.test.ts` — index existence and query-plan expectations.
- `core-back/test/phase1-mtls-and-schema.test.ts` — schema phase gate.
- `core-back/test/blueprint-seed.test.ts` — baseline blueprint seed behavior.
- `core-back/test/synthetic-seeder.test.ts` — synthetic seed safety and audit.

Commands:

```bash
cd core-back && bun test test/exhaustive/01-schema
cd core-back && bun test test/phase1-mtls-and-schema.test.ts test/blueprint-seed.test.ts
cd core-back && bun run prisma:validate
cd core-back && bun run migrate-deploy
```

The exhaustive schema suites require a reachable PostgreSQL test database (`databaseIsReachable`); without one they skip. `prisma:validate` requires no database. The migration commands require `DATABASE_URL` and should only be run against the intended database. No test or migration was run for this documentation change.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md#7-database-schema`
- `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#5-database-schema`
- `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md#4-database-schema`
- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#3-comprehensive-multi-state-distribution-across-all-66-database-models`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#4-segment-3--postgresql-18-ddl-partialcoveringgin-indexes--dedicated-auditlog-schemas`
- `design/00-process/blueprint-management.md#5-documentation-corrections-backlog`

### Code paths

- `core-back/prisma/schema.prisma`
- `core-back/prisma/schemaVersion.ts`
- `core-back/prisma/client/index.ts`
- `core-back/prisma/migrateDev/index.ts`
- `core-back/prisma/migrations/20261103000000_postgres18_init/migration.sql`
- `core-back/prisma/migrations/20261103120000_postgres18_storage_engine/migration.sql`
- `core-back/prisma/migrations/20261103130000_cqrs_read_models/migration.sql`
- `core-back/prisma/migrations/20261103180000_storage_hardening/migration.sql`
- `core-back/prisma/migrations/migration_lock.toml`
- `core-back/prisma/seed.ts`
- `core-back/prisma/seedBlueprints.ts`
- `core-back/prisma/seedGlAccounts.ts`
- `core-back/prisma/seedGuides.ts`
- `core-back/prisma/seedFakeRails.ts`
- `core-back/prisma/syntheticSeeder/**`
- `core-back/generated/prisma/**`
- `deploy/provisioners/backupEngineProvisioner.ts`
- `deploy/provisioners/auditAndLogDbProvisioner.ts`

### Generated appendices

- `project-design/appendices/schema-catalog.md` — authoritative generated model/column/index catalogue. Link target for all schema tables; do not duplicate it by hand.
- `project-design/appendices/migration-catalog.md` — authoritative generated migration list and order.
- `project-design/appendices/env-and-config-matrix.md` — database and seeder environment keys.

## 10. Change history

- 2026-11-03 — Initial canonical extraction. Records 75 models, 105 enums, schema version 8, the four-migration history, `journal_lines` partitioning, the actual constraint/trigger set, UUID/timestamp conventions, baseline seeders, Fake Rails bridge and migration wrapper behavior. See `project-design/TRACKER.md`.

## Global Search

> Status: `partial` · Last verified: 2026-11-03

## 1. Purpose and scope

Global search is the admin back-office deep-search feature that finds records across 20 domain groups and links the operator to the canonical page or drawer for the record.

It owns:

- the server-side provider registry in `core-back/lib/globalSearch.ts`;
- the query parser, token classification, match scoring and result sanitization in `core-back/lib/search/engine.ts`;
- the core internal route `POST /internal/admin/search`;
- the mTLS admin BFF proxy `POST /api/v1/admin/search` with its rate limiter;
- the admin-front command palette (`Ctrl+K` / `Cmd+K`), local page/guide search, recent queries and the client-side target registry;
- the `useOpenQuery` deep-link composable that opens a record from a query parameter.

It does not own domain authorization policy (the providers consume authority helpers but `core-back` remains the enforcement point), the underlying record APIs, or the guide content itself.

## 2. Design intent (extracted and synthesized from ./design)

The historical deep-search design defines a federated, plugin-based search:

- the server exposes a fixed set of 20 record groups, each with an explicit authority predicate;
- providers fetch candidates independently and decide whether to appear based on the actor's authorities;
- a shared parser understands free text, UUID/reference, email, phone variants and scoped tokens such as `type:merchant` and `status:ACTIVE`;
- ranking is deterministic: exact field matches rank above prefix matches, which rank above substring matches, with recency as a tie-breaker;
- sensitive fields are never returned in results; audit/AML data is filtered by confidentiality rules;
- the admin BFF rate-limits search per session;
- the frontend registry maps each server group to a route/drawer target and enforces the same route visibility on the client;
- `useOpenQuery` turns a search result into a one-shot deep link (`?open=<id>`) that the destination page opens and then clears.

The design's "20 groups" is implemented. Its stronger claims are not:

- the search is not full-text and does not use PostgreSQL ranking; it is a set of `contains` filters plus in-memory scoring over a small candidate window;
- the token-kind hook is present but unused by every built-in provider;
- the rate limiter is in memory in one admin-back process, not a shared Redis limiter;
- there is no scale, latency or concurrency benchmark for deep search.

## 3. As-built architecture

### 3.1 The 20 provider groups

`core-back/lib/search/types.ts:1-22` declares `V1_SEARCH_TYPES` with exactly 20 types. `core-back/lib/globalSearch.ts` defines one provider per type, registers all 20 in `defaultSearchRegistry` and exports `builtinSearchProviders`.

| Order | Type | Aliases | Access predicate |
| ---: | :--- | :--- | :--- |
| 10 | `merchant` | `merchants`, `mer`, `store` | `merchant:read` |
| 20 | `payment_attempt` | `attempt`, `attempts`, `tx`, `transaction`, `payment` | `attempt:read` and `merchant:read` |
| 30 | `operator_case` | `case`, `cases` | `case:read` or `operator:read` |
| 40 | `gateway_inquiry` | `inquiry`, `inquiries` | `case:read` or `operator:read` |
| 50 | `approval` | `approvals`, `maker_checker` | `approval:read` |
| 60 | `join_request` | `onboarding`, `join`, `kyb` | `kyb:read` or `compliance:read` |
| 70 | `kyb_document` | `doc`, `docs`, `document` | `kyb:read` or `compliance:read` |
| 80 | `dispute` | `disputes`, `chargeback` | `dispute:read` |
| 90 | `adjustment` | `adjustments`, `refund`, `fee_adjustment` | `finance:read` |
| 100 | `cashout` | `cashouts`, `payout`, `withdrawal` | `cashout:read` |
| 110 | `reconciliation_run` | `recon`, `reconciliation`, `statement` | `reconciliation:read` |
| 120 | `aml_case` | `aml` | `hasConfidentialAmlAccess` |
| 130 | `aml_screening` | `screening` | `hasConfidentialAmlAccess` |
| 140 | `aml_rule` | `aml_rules` | `hasConfidentialAmlAccess` |
| 150 | `aml_report` | `str`, `sar`, `regulatory_report` | `hasConfidentialAmlAccess` |
| 160 | `gateway` | `gateways`, `gw` | `gateway:read` |
| 170 | `rail` | `rails` | `gateway:read` |
| 180 | `route` | `routes`, `rail_route` | `gateway:read` |
| 190 | `user` | `users`, `staff`, `admin` | `user:read` or `security:read` |
| 200 | `audit_log` | `audit`, `logs` | `security:read` |

`hasConfidentialAmlAccess` grants access to `COMPLIANCE` and `MLRO` roles, or to an actor with `aml:read` or `aml:write` (`core-back/lib/auth/confidentialAccess.ts:34-49`). `hasMerchantSensitiveAccess` grants tax/registration fields to non-`SUPPORT` actors with `merchant:write`, `compliance:read` or `compliance:write`; the merchant provider adjusts both its WHERE clause and its ranking signals (`globalSearch.ts:143-165`).

### 3.2 Registry and execution

`SearchProviderRegistry` (`globalSearch.ts:72-127`) stores providers by type, preserves aliases/order/access/token hooks, and:

- `getAllOrdered()` sorts by `order` then type;
- `resolveAliasToTypes()` maps a scoped alias to one or more types;
- `unregister()` supports tests and future plugins;
- `registerSearchProvider()` registers against the default registry.

`executeGlobalSearch` (`globalSearch.ts:1679-1814`):

1. Validates the body with a strict Zod schema: trimmed query length 2–120, optional `types` array, limit 1–10 default 5.
2. Rejects unknown requested types with `SEARCH_TYPE_UNSUPPORTED`.
3. Parses the query and applies alias scoping.
4. Filters providers by explicit type filter, `canAccess`, and optional `supportsTokenKind`.
5. Runs all authorized providers concurrently with `Promise.allSettled`, `take = limit * 3`.
6. Ranks each provider's candidates and slices to `limit`.
7. Aggregates non-empty groups, counts returned items and sets `partial = true` when any provider rejects.
8. Logs a warning when elapsed time exceeds 750 ms (`globalSearch.ts:1796-1807`).
9. Returns `{ query, groups, total, tookMs, partial }`.

A provider rejection does not fail the request; it removes that group and marks the response partial.

### 3.3 Parser and token kinds

`parseSearchQuery` (`core-back/lib/search/engine.ts:80-137`):

- trims and caps raw input at 120 characters;
- recognizes `type:`, `is:` and `kind:` aliases for scoped types;
- recognizes `status:` and `merchant:`;
- keeps the remaining tokens as the term;
- builds Libyan phone variants for `+218`, `00218`, leading-zero national numbers and nine-digit local numbers;
- classifies the term as `SHA256_HEX`, `EMAIL`, `PHONE`, `ID_OR_REF` or `FREE_TEXT`.

The classification is reported in `ParsedSearchQuery.tokenKind`, but no built-in provider supplies `supportsTokenKind`, so classification currently does not narrow the provider set. It is used indirectly by phone-variant generation and by the audit/ID filters.

### 3.4 Ranking and sanitization

`computeMatchScore` (`engine.ts:146-197`) scores every candidate from three signal classes:

| Signal class | Exact | Prefix | Substring |
| :--- | ---: | ---: | ---: |
| `exactFields` | 1000 | 750 | 450 |
| `primaryTextFields` | 900 | 650 | 350 |
| `secondaryTextFields` | 250 | 200 | 150 |

An unmatched candidate still gets 100, so a provider can return a record whose searchable fields are related to the row (for example a nested merchant) even when the direct term does not match. `rankAndSliceCandidates` (`engine.ts:333-389`) deduplicates by result id, sorts by score descending, then timestamp descending, then id ascending, and slices to the limit. It also reports `truncated` when more than the limit survived.

`sanitizeResultItem` (`engine.ts:254-300`) keeps only `id`, `title`, `subtitle`, `reference`, `status`, `merchantId`, `operatorCaseId` and scalar `meta` values. It drops any key matching a forbidden name or fragment:

- ciphertext, secret, password, payout, bank, match list, `beforeJson`, `afterJson`, `rawPayload`, tax id, tax number, registration number, commercial registry.

This is a defensive allow-list plus deny-list; it does not redact text inside allowed fields.

### 3.5 Provider query pattern

Every provider uses Prisma `findMany` with a status scoping helper and an `OR` array of `contains` filters, `mode: "insensitive"`, plus exact UUID filters from `idSearchFilter`. Nested relations are searched through `is` filters. Each provider selects a narrow projection, orders by its domain timestamp, and takes `limit * 3` rows.

Examples:

- `merchant` searches id, legal/trade/display name, contact email/phone and (conditionally) tax/registration, plus phone variants.
- `payment_attempt` searches id, reference, provider/gateway/network reference, idempotency key and nested merchant trade/legal name.
- `operator_case` and `gateway_inquiry` search attempt references and nested merchant names.
- `join_request`, `kyb_document`, `dispute`, `adjustment` and `cashout` search the relevant references and nested merchant names.
- `reconciliation_run` searches run references and file names.
- `approval` searches subject type/id and related references.
- `gateway`, `rail` and `route` search codes/names/operator, with nested rail/gateway names for routes.
- `user` searches id, email, phone and phone variants.
- `audit_log` uses `AuditStorePort.queryAuditLogs` when a dedicated audit store is configured, otherwise the compatibility `audit_log` table.

### 3.6 Core route and BFF

Core route: `POST /internal/admin/search` (`core-back/api/internal/admin.ts:682-709`). It reads the `x-pg-min-lsn` header, runs through `readThroughReplicaOrPrimary`, passes the actor derived from the internal principal, and sets `Cache-Control: no-store`.

Admin BFF: `admin-back/api/protected/search.ts`:

- strict Zod schema mirrors core (query 2–120, `types` max 30, limit 1–10);
- `noStore` middleware;
- per-process rate limiter with a 60,000 ms window and 120 requests per key;
- key is a SHA-256 of the bearer token (or IP, or `anonymous`) truncated to 32 hex characters;
- expired buckets are swept when the map exceeds 2,000 entries;
- `429 SEARCH_RATE_LIMITED` with `Retry-After`;
- forwards to `/internal/admin/search` with the validated body.

Mounted at `/search` under the protected admin router (`admin-back/api/protected/index.ts:44`), so the public portal path is `/api/v1/admin/search`.

### 3.7 Admin palette and local commands

`admin-front/src/components/search/GlobalSearchPalette.tsx` implements:

- a `VDialog` palette opened by the app bar trigger and the global `Ctrl+K`/`Cmd+K` shortcut;
- a 250 ms debounce before the server call;
- a minimum of two characters for record search, while page and guide search can run on shorter input;
- cancellation of the previous request through `AbortController` and a sequence guard;
- a 60-second in-memory session cache for non-partial responses (`api.ts:14-18`, `api.ts:53-90`);
- an 8-entry recent-query store in `localStorage` (`recents.ts:2`, `recents.ts:34-55`);
- tabs for All, Records, Pages and Guide;
- local page search over navigation items and local guide search via `searchGuideFn`;
- partial/error banners and keyboard navigation;
- result rendering through `SearchResultRow` with safe highlighting.

`localCommands.ts` searches the navigation catalogue and guide entries. It does not query the server.

### 3.8 Client target registry and access checks

`admin-front/src/components/search/targets.ts` registers 20 target plugins, one per server type, with icon, bilingual group/kind labels, a primary route name, optional additional route names and a `resolveTarget` function. Target shapes include:

- route-param targets such as `MerchantDetail`, `OperatorCaseDetail`, `JoinRequestDetail`, `KybReviewDetail`, `GatewayWizard` and `AdminUserDetail`;
- drawer targets with `?open=<id>` for approvals, disputes, adjustments, cashouts, reconciliations, AML cases/screenings/rules/reports, rails, routes and audit logs;
- a search-prefill fallback for gateway inquiries when no operator case is linked.

`filterAndNormalizeServerGroups` (`targets.ts:387-435`) drops any group without a registered plugin, drops groups whose primary/additional route is not visible to the user, resolves each item to a target, validates the target and re-checks the target route. Route visibility checks authorities, roles and the visible route-name set (with parent lineage). This is advisory UI filtering; core remains the authority.

### 3.9 `useOpenQuery`

`admin-front/src/composables/useOpenQuery.ts`:

- watches a query parameter (default `open`);
- normalizes string or array values;
- uses loaded rows first unless `alwaysFetchDetail` is set;
- otherwise calls the page's `fetchById`;
- invokes `onOpenRecord` once per id and guards against reactive re-opens;
- calls `onNotFound` on null or failure;
- exposes `clearOpenQueryParam()` and `isResolvingOpenQuery`.

It is used by approvals, AML cases/screenings/rules/reports, disputes, adjustments, cashouts, reconciliation, rails, routes and audit logs. The one-shot guard means a page must clear or change the query parameter to re-open the same record.

## 4. Contracts and invariants

- Request body is strict: no unknown keys. Query is trimmed, 2–120 characters. Limit is 1–10 and defaults to 5. BFF `types` is capped at 30 entries.
- A response group only contains authorized providers. `partial = true` when at least one authorized provider fails.
- Unknown requested types are rejected in core before any provider runs.
- Scoped type aliases narrow the requested set only when at least one alias resolves; an unknown alias does not silently disable all search.
- Result items never include ciphertext, secrets, payout/bank details, AML match-list data, audit before/after JSON, raw payloads or tax/registration fields. The sanitizer is the last line of defence; providers should not select forbidden fields in the first place.
- `id`, `title` and all returned scalar fields are coerced to strings; empty optional fields are omitted.
- The frontend must not render a result whose target route is not visible to the user.
- `useOpenQuery` opens a record once per id per mount; destinations must fetch the record when it is not in the loaded page.
- BFF search responses are non-cacheable (`no-store`). The client cache is memory-only and only stores non-partial responses.
- The BFF limiter is advisory abuse control, not an authority boundary. Core applies its own authentication and provider predicates.
- Search reads may be served by a replica. The `x-pg-min-lsn` header provides read-after-write consistency when the admin BFF forwards it; the palette does not currently set it.

## 5. Data / API / config / deployment surface

### APIs

| Layer | Method and path | Notes |
| :--- | :--- | :--- |
| Core | `POST /internal/admin/search` | mTLS internal route, replica-aware, no-store |
| Admin BFF | `POST /api/v1/admin/search` | mTLS to core, 120 req/min per key, no-store |
| Admin front | `v1/admin/search` | via the shared API client |

Request:

```json
{ "query": "PG-12345", "types": ["payment_attempt"], "limit": 5 }
```

Response:

```json
{
  "query": "PG-12345",
  "groups": [{ "type": "payment_attempt", "items": [], "truncated": false }],
  "total": 0,
  "tookMs": 4,
  "partial": false
}
```

### Data dependencies

- Core OLTP tables: merchants, attempts, links, operator cases, gateway inquiry schedules, approvals, join requests, KYB documents, disputes, adjustments, cashouts, reconciliation runs, AML cases/screenings/rules/reports, gateways, rails, routes, users.
- Dedicated audit database: `audit_records` through `AuditStorePort` when `AUDIT_DATABASE_URL` is configured.
- Fallback audit table: `audit_log` in the core database.
- Trigram indexes from the storage and hardening migrations support the `contains` filters, but they are ordinary GIN trigram indexes, not full-text indexes.

### Configuration

| Key | Purpose |
| :--- | :--- |
| `AUDIT_DATABASE_URL` | Enables the dedicated audit provider path |
| `DATABASE_REPLICA_URLS` | Allows search reads on replicas |
| `READ_REPLICA_MAX_LAG_MS` | Replica lag ceiling for search |
| `BACKUP_DAEMON_*` | Unrelated to search; listed here only because the BFF and core share the storage configuration surface |

### Frontend routes and components

- `admin-front/src/components/search/GlobalSearchPalette.tsx`
- `admin-front/src/components/search/targets.ts`
- `admin-front/src/components/search/api.ts`
- `admin-front/src/components/search/localCommands.ts`
- `admin-front/src/components/search/recents.ts`
- `admin-front/src/components/search/SearchResultRow.tsx`
- `admin-front/src/composables/useOpenQuery.ts`
- `admin-front/src/layouts/default.tsx` (palette wiring and shortcut)

## 6. Operational usage

- Use `Ctrl+K`/`Cmd+K` in the admin portal to open the record palette. `?` opens the shortcut help.
- Type at least two characters for record search. Page and guide results can appear earlier.
- Use the filter tabs to switch between all results, records, pages and guide entries. Tabs are applied client-side over the returned groups.
- Use `type:merchant`, `status:ACTIVE` or `merchant:<uuid>` tokens inside the query to scope server-side. The type/status aliases are server-side; the UI does not expose a separate type picker.
- Results open the canonical detail page or a drawer with the record id. The destination page uses `useOpenQuery` to load the record if it is not in the current page data.
- If a group is missing from the response, check the actor's authorities and the core log for a provider failure. A `partial: true` response means another group may still be usable.
- If search returns 429, wait for `Retry-After`. The limiter is per admin-back process; a multi-node deployment can produce inconsistent limits until a shared limiter is introduced.
- Search reads can hit a replica. If a just-written record is missing, retry from a route that sends the `x-pg-min-lsn` watermark or read the canonical detail endpoint on the primary.

## 7. Status and deviations

### Implemented

- The 20-group server registry with aliases, order and authority predicates.
- Strict request validation, scoped type/status/merchant tokens and Libyan phone variants.
- Deterministic in-memory ranking with exact/prefix/substring weights and recency tie-break.
- Sensitive-field sanitization and per-provider narrow projections.
- Concurrent provider execution with partial-result semantics.
- Replica-aware core search route and `x-pg-min-lsn` support.
- Admin BFF proxy with per-process hashed-key rate limiting and no-store headers.
- Frontend palette with debounce, abort, sequence guard, session cache, recents, local pages/guides, keyboard navigation, RTL support and partial/error states.
- Client target registry for all 20 types and route/drawer deep links.
- `useOpenQuery` one-shot deep links across the wired pages.
- Unit and E2E coverage for parser/ranking/sanitization, client registry, recents, palette behavior and deep links.

### Partial

- Token-kind routing: `supportsTokenKind` exists and is invoked, but every built-in provider omits it. The feature is effectively dormant.
- Ranking: scoring happens in Node over at most `limit * 3` rows per provider, not in PostgreSQL. A broad query can truncate candidates before the best match is seen.
- Missing fields: several schema columns are not in any provider WHERE clause. Examples: merchant `supportEmail`, `supportPhone`, `businessCategory` and `country`; payment attempt link key and attempt-group fingerprint; audit `requestId` and `clientIp`; KYB `docType` (used for scoring, not filtering) and `storageKey`.
- Audit search: the dedicated audit adapter searches action, entity type, entity id and actor email through `ILIKE`; it does not search request id, client IP or before/after JSON, and it has no relevance ranking.
- Frontend types filter: the palette sends only `query` and `limit`. The All/Records/Pages/Guide tabs do not send a `types` array, so server work is not narrowed by tab.
- Rate limiting: in-memory per process, not shared across admin-back nodes; bucket sweeping is approximate and the key falls back to IP for unauthenticated requests.

### Missing / deferred

- PostgreSQL full-text search (`tsvector`, `websearch_to_tsquery`, `ts_rank`) and SQL-side ranking.
- Cursor pagination or "show all" for a group. Each group is capped at 10 and the palette displays at most that slice.
- Typo tolerance/fuzzy matching beyond trigram-backed substring filters, prefix expansion or synonyms.
- Cross-group deduplication (the same attempt can appear under multiple groups).
- A shared/distributed rate limiter.
- A deep-search scale benchmark with realistic record counts, broad queries, 20 concurrent providers and p95 latency.
- Search analytics (zero-result queries, slow providers) beyond the 750 ms warning log.
- Saved searches or per-user search history on the server.
- Server-side `types` filtering from the UI tabs.

### Known bugs / risks

- `supportsTokenKind` is dead configuration from the product's point of view. A future provider can use it, but no current provider narrows on token kind, so a SHA256 query still fans out to all authorized providers. Code gap.
- Candidate truncation: `take = limit * 3` before ranking means a provider with many substring matches can return three mediocre rows and miss the exact match. Code risk.
- `computeMatchScore` returns 100 for a row with no matching signals; if a provider's fetch filter is broader than its signals (nested relation matches), unrelated-looking rows can survive. Code risk.
- Merchant tax/registration fields are searchable only for sensitive-access actors, but the fields are also included in the provider's selected projection only for those actors. A non-sensitive actor searching a tax id gets no match rather than a redacted result. Product decision, not a bug.
- The audit fallback path does not search `requestId` or `clientIp`; dedicated audit search also omits them. Operators must use the audit list endpoint for those fields. Feature gap.
- The BFF rate limiter keys on the full authorization header hash, so token rotation creates a new bucket. It also uses `request.ip`, which is proxy-dependent. Operational risk.
- The BFF `types` schema allows up to 30 entries while the server registry has 20. Unknown types are rejected by core, so a stale client list can fail the whole request rather than ignore the unknown entry. Code risk.
- The palette client cache does not include the actor/authority set in its key. After a role change in the same tab session, a cached group can remain visible until the 60-second TTL expires; the target-route filter still applies. Code risk.
- `filterAndNormalizeServerGroups` silently drops a group if the client target registry lacks its type, so a server/client version skew hides results without an error. Code risk.
- `useOpenQuery` marks an id handled before the fetch completes. If the fetch fails transiently, the same id will not retry until the query parameter changes or the component remounts. Code risk.
- The `route` target uses `?open=<routeId>` but the routes page must implement the drawer lookup; the target registry alone does not guarantee the page supports it. Test coverage is the guard.
- No test asserts multi-node rate-limit behavior or shared-cache behavior, because neither exists.

## 8. Verification and tests

Relevant test files:

- `core-back/test/globalSearch.test.ts` — parser/token/phone variants, match scoring, sanitization, registry, authority matrix, provider behavior.
- `tests/unit/global-search.test.ts` — client target registry, local commands, recent-query storage, highlighting, access filtering.
- `tests/e2e/admin/global-search.spec.ts` — app-bar trigger vs drawer guide search, `Ctrl+K`, debounce, Enter-to-open, one-character behavior, mocked API.
- `tests/e2e/exhaustive/exhaustive-admin-surface.spec.ts` — broader admin surface coverage that includes search interactions.

Commands:

```bash
cd core-back && bun test test/globalSearch.test.ts
cd tests && bun run test:unit
cd tests && bunx playwright test -c playwright.config.ts -g "global search"
```

The core test is a unit/authority suite and does not require PostgreSQL. The Playwright suite uses mocked API responses and does not need a live core or a populated database. There is no live-stack deep-search scale test and no benchmark. No test run was performed for this documentation change.

## 9. Source references

### Old design sections

- `design/02-storage-and-performance/deep_search_plugin_architecture_plan.md#1-executive-summary--why-a-declarative-plugin-architecture-is-required`
- `design/02-storage-and-performance/deep_search_plugin_architecture_plan.md#2-product-behavior--ux-contract`
- `design/02-storage-and-performance/deep_search_plugin_architecture_plan.md#3-api-contract--shared-security-predicates`
- `design/02-storage-and-performance/deep_search_plugin_architecture_plan.md#4-server-side-plugin-architecture-core-back`
- `design/02-storage-and-performance/deep_search_plugin_architecture_plan.md#5-admin-bff-layer-admin-back`
- `design/02-storage-and-performance/deep_search_plugin_architecture_plan.md#6-frontend-plugin-registry--global-command-palette-admin-front`
- `design/02-storage-and-performance/deep_search_plugin_architecture_plan.md#7-universal-one-shot-deep-link-composable-useopenquery--page-wiring`
- `design/02-storage-and-performance/deep_search_plugin_architecture_plan.md#9-comprehensive-automated-verification--test-plan`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#3-2-outbox-driven-read-models--uncompromised-20-group-deep-search-on-replicas`

### Code paths

- `core-back/lib/search/types.ts`
- `core-back/lib/search/engine.ts`
- `core-back/lib/search/uuidSearch.ts`
- `core-back/lib/globalSearch.ts`
- `core-back/lib/auth/confidentialAccess.ts`
- `core-back/api/internal/admin.ts`
- `core-back/lib/storageEngine/index.ts`
- `core-back/lib/storageEngine/readStoreAdapter.ts`
- `admin-back/api/protected/search.ts`
- `admin-back/api/protected/index.ts`
- `admin-front/src/components/search/api.ts`
- `admin-front/src/components/search/targets.ts`
- `admin-front/src/components/search/localCommands.ts`
- `admin-front/src/components/search/recents.ts`
- `admin-front/src/components/search/GlobalSearchPalette.tsx`
- `admin-front/src/components/search/SearchResultRow.tsx`
- `admin-front/src/composables/useOpenQuery.ts`
- `admin-front/src/layouts/default.tsx`
- `core-back/prisma/migrations/20261103120000_postgres18_storage_engine/migration.sql`
- `core-back/prisma/migrations/20261103180000_storage_hardening/migration.sql`

### Generated appendices

- `project-design/appendices/api-route-matrix.md` — search routes across core, BFF and portal
- `project-design/appendices/schema-catalog.md` — indexed search columns and schema fields
- `project-design/appendices/test-inventory.md` — global-search test files and skip conditions

## 10. Change history

- 2026-11-03 — Initial canonical extraction. Records the 20 providers, registry, parser, ranking weights, authority predicates, BFF limiter, palette/targets/`useOpenQuery`, and the actual gaps: dormant `supportsTokenKind`, missing fields, no full-text search, per-process limiter and no deep-search scale benchmark. See `project-design/TRACKER.md`.

## Backup Control

> Status: `partial` · Last verified: 2026-11-04

## 1. Purpose and scope

Backup control is the administrator-facing plane for PostgreSQL point-in-time recovery, the dedicated audit database, and optional Redis snapshots. It spans three layers:

- `core-back` internal APIs and `BackupControlClient`;
- the standalone `pg-backup-daemon` in `deploy/backup-daemon`, which wraps WAL-G or Barman and owns the schedule, catalog and restore drill;
- the admin BFF and the admin portal backup page.

This part owns:

- the backup daemon contract (`/health`, `/v1/overview`, `/v1/backups/trigger`, `/v1/policy`, `/v1/runs`, `/v1/drills/run`, `/v1/drills`);
- target selection (`all`, `postgres_core`, `audit_db`, `redis`);
- full and delta backup execution;
- the in-process full/delta/drill scheduler and UTC cron parser;
- the JSON catalog of runs, drills and policy;
- the maker-checker policy update workflow;
- the scratch-restore and invariant drill;
- catalog synchronization into `backup_catalog_runs` and `backup_restore_drills`;
- the admin UI overview, trigger, drill and policy forms.

It does not own the core database schema, storage-engine read path, or the deployment certificate PKI. Those are documented in `core.data`, `core.storage` and `07-deploy`.

## 2. Design intent (extracted and synthesized from ./design)

The historical storage blueprint defines an admin-managed backup orchestrator:

- a dedicated daemon wraps WAL-G and Barman, so operators do not run ad-hoc commands;
- the daemon is reached over mTLS from core, and core is the only service allowed to call it;
- administrators can trigger full/delta backups, run restore drills and change the schedule/retention policy;
- policy changes require maker-checker approval;
- backups cover the core database, the dedicated audit database and Redis;
- the daemon writes to a primary S3/MinIO/R2 bucket and optionally mirrors to a secondary SSH/S3 vault;
- a restore drill restores the latest base backup plus WAL to a scratch PostgreSQL instance, then verifies double-entry zero drift, sharded balance parity and audit hash-chain integrity;
- the drill report is signed and stored;
- the scheduler runs weekly full, weekday delta and weekly drill jobs.

The design's false or outdated claims are corrected here:

- the scheduler does not run at Tripoli 03:00; it evaluates five-field cron expressions in UTC;
- there is no hourly Redis BGSAVE schedule; Redis is snapshotted only when a triggered or scheduled `target=all` backup includes it;
- the audit shipper does not delete rows (this is a storage-engine behavior, but it affects backup scope);
- the backup certificates are generated and distributed but are not proven ready-to-run for the `pgbackup` daemon user; ownership is not fixed;
- the daemon policy retention fields are not the values WAL-G/Barman actually apply;
- Barman mode does not mirror to the secondary target and its health still uses WAL-G commands;
- the restore drill has a role mismatch for the audit database.

## 3. As-built architecture

### 3.1 Core internal API

`core-back/api/internal/backups.ts` mounts under `/internal/admin/system/backups` and requires internal mTLS identity plus authorities:

| Route | Authorities | Behavior |
| :--- | :--- | :--- |
| `GET /overview` | `security:read` and `gateway:read` | Reads local catalog runs/drills, optionally fetches the daemon overview, syncs the daemon catalog into local tables, returns a merged payload |
| `POST /trigger` | `security:write` | Validates `{ target, kind }`, requires a configured daemon, calls the daemon, inserts a local `QUEUED` run |
| `POST /drill` | `security:write` | Requires a configured daemon, calls the daemon, inserts a local `QUEUED` drill with target time now minus 5 minutes |
| `PUT /policy` | `security:write` | Creates or executes a maker-checker approval, then updates the daemon policy |
| `GET /catalog` | `security:read` and `gateway:read` | Returns only the local `backup_catalog_runs` and `backup_restore_drills` |

The policy schema is strict: three five-field cron expressions, `fullRetentionDays`, `walRetentionDays`, `alertLagSeconds` and an optional `approvalRequestId`. Defaults exposed when the daemon is absent are:

- full: `0 2 * * 0`;
- delta: `0 2 * * 1-6`;
- drill: `0 4 * * 0`;
- full retention: 56 days;
- WAL retention: 14 days;
- alert lag: 60 seconds.

The trigger schema defaults `target` to `all` and `kind` to `full`.

### 3.2 Core policy maker-checker

`PUT /policy` without `approvalRequestId` creates an `ApprovalRequest`:

- `subjectType = "BACKUP_POLICY"`;
- `subjectId = "backup-policy"`;
- `payloadDiffJson` = the validated policy;
- `mode = "STANDARD"`;
- `makerUserId` = the current actor;
- `state = "PENDING_REVIEW"`;
- expiry 7 days.

It returns HTTP 202 with `checkerRequired: true` and the approval id.

With `approvalRequestId`, core:

1. loads the approval and requires `subjectType = "BACKUP_POLICY"`;
2. requires state `PENDING_REVIEW` or `APPROVED`;
3. rejects when `approval.makerUserId === actor.userId` with `MAKER_CHECKER_VIOLATION`;
4. requires the daemon to be configured;
5. applies `approval.payloadDiffJson` to the daemon (not the current request body);
6. marks the approval `EXECUTED`, records `checkerUserId` and increments `baseVersion`;
7. writes a `BACKUP_POLICY_UPDATED` audit row with before/after JSON and a stable-JSON checksum prefix.

There is no maker-checker on `POST /trigger` or `POST /drill`; both are direct `security:write` actions.

### 3.3 Catalog synchronization

`GET /overview` reads local runs and drills first, then checks whether the daemon is configured. If configured, it calls `GET /v1/overview`; on success it calls `syncDaemonCatalog`:

- every daemon backup run is upserted into `backup_catalog_runs` by id;
- every daemon drill is upserted into `backup_restore_drills` by id;
- `sizeBytes` is converted to `BigInt`;
- `storageTargets` and drill checks are stored as JSON;
- errors are swallowed per write with `Promise.allSettled`, so a partial sync does not fail the overview.

The response includes both the daemon view and `localCatalog: { backups, drills }`. If the daemon is unreachable, the response returns local rows and `daemonReachable: false` with `daemonError`.

`GET /catalog` never calls the daemon. The admin BFF does not proxy it, so the portal cannot use it directly.

### 3.4 Backup control client

`core-back/lib/storageEngine/backupControlClient.ts`:

- reads `BACKUP_DAEMON_URL`, `BACKUP_DAEMON_TIMEOUT_MS`, and optional CA/client cert/key paths;
- uses `http.Agent` for plain HTTP and `https.Agent` with `minVersion: "TLSv1.3"`, CA and client certificate for HTTPS;
- serializes JSON manually, sets content length, parses JSON responses and maps daemon error envelopes to `BackupDaemonError` with code/status/details;
- maps unreachable errors to 502 and timeouts to 504;
- throws `BackupDaemonNotConfiguredError` (503) when no URL is configured;
- exposes a singleton and `resetBackupControlClient()` for tests.

The client has no retries, backoff or circuit breaker. A transient daemon failure is surfaced to the operator.

### 3.5 Daemon HTTP API

`deploy/backup-daemon/src/server.ts` serves an mTLS HTTP API (plain HTTP only with `BACKUP_ALLOW_INSECURE_HTTP=true`):

| Method | Path | Behavior |
| :--- | :--- | :--- |
| `GET` | `/health` | `{ status: "ok", engineMode, version }` |
| `GET` | `/v1/overview` | Engine health, WAL health, storage targets, schedule, policy, recent runs, latest/recent drills |
| `POST` | `/v1/backups/trigger` | Validates target/kind, allocates an id, queues a background run, returns 202 |
| `PUT` | `/v1/policy` | Validates and persists cron/retention/alert policy, returns the updated policy |
| `GET` | `/v1/runs?limit=` | Recent catalog runs |
| `POST` | `/v1/drills/run` | Queues a restore drill, returns 202 |
| `GET` | `/v1/drills?limit=` | Recent drill reports |

The server:

- caps request bodies at 256 KiB;
- validates with Zod and returns structured `{ error: { code, message, details } }` envelopes;
- adds a request id and `cache-control: no-store`;
- redacts configured secret values and credential-shaped keys from responses and logs;
- tracks background tasks for graceful shutdown;
- assigns unique ids and refuses conflicts with existing catalog ids.

### 3.6 Engines: WAL-G and Barman

`deploy/backup-daemon/src/backupEngine.ts` defines `BACKUP_TARGETS = ["all", "postgres_core", "audit_db", "redis"]`, `BACKUP_KINDS = ["full", "delta"]`, and `RECOVERY_TARGETS = ["postgres_core", "audit_db"]`.

WAL-G mode:

- base backup: `wal-g backup-push <data-dir>`;
- delta: `wal-g backup-push --delta <data-dir>`;
- verify: `wal-g st ls <prefix>`;
- mirror: `rclone sync` for S3/rclone destinations, otherwise `rsync -a --delete` to the secondary target;
- list: `wal-g backup-list --json`;
- prune: `wal-g delete retain FULL <BACKUP_RETENTION_FULL_COUNT> --confirm`;
- recover: `wal-g backup-fetch <dir> LATEST` plus a generated `recovery_target_time` and `recovery_target_action = 'promote'` config;
- Redis: `redis-cli -u <url> BGSAVE`, `redis-cli --rdb <tmp>`, then `rclone copyto <tmp> <core-prefix>/redis/dump.rdb`.

Barman mode:

- `barman check <server>` for core and audit;
- `barman backup <server>` or `barman backup --incremental <server>`;
- `barman-cloud-backup` to the primary S3 target;
- `barman list-backup <server>` for listing;
- `barman recover --target-time ... <server> <backup> <dir>` for recovery;
- no daemon-side prune; the comment says Barman applies its own `retention_policy`.

`backupDataDir` refuses the audit target when `PG_AUDIT_DATA_DIR` is absent, so `target=all` fails rather than silently backing up the core data directory under the audit prefix.

### 3.7 Scheduler

`deploy/backup-daemon/src/scheduler.ts` implements an in-process scheduler:

- `SCHEDULED_JOBS = ["full", "delta", "drill"]`;
- policy changes are re-read every tick, so `PUT /v1/policy` takes effect without restart;
- the next run is computed with `nextCronRun` from `cron.ts`;
- a tick skips a due job if another backup/drill is still running and logs a warning;
- full/delta run `engine.triggerBackup("all", kind)`;
- after a successful full run, the scheduler calls `engine.prune("all", "full")`;
- drill runs `RestoreDrillRunner.run({ requestedBy: "scheduler" })` and adds the report to the catalog;
- failed jobs produce `FAILED` catalog entries; a failed drill gets a signed failed report.

Defaults: full Sunday 02:00, delta Monday–Saturday 02:00, drill Sunday 04:00, tick every 30 seconds. All cron evaluation is UTC (`cron.ts` uses `getUTC*` and `setUTC*`), with no timezone or DST configuration.

When `SCHEDULER_ENABLED=false`, the deploy provisioner writes a `/etc/cron.d/pg-backup` file with the same three jobs, invoking the trigger script or the legacy restore-drill script. The production default is the in-process scheduler with an explanatory cron file. The system-cron fallback uses the host time zone, so it is not equivalent to the UTC scheduler.

### 3.8 Catalog

`deploy/backup-daemon/src/catalogStore.ts` is a JSON catalog at `BACKUP_CATALOG_PATH`:

- `BackupCatalog = { runs, drills, policy }`;
- atomic write-through temp file plus rename;
- load-time Zod validation with a warning and fallback when the file is corrupt;
- in-memory operation continues when persistence fails, with `isPersistent()` and `getPersistenceError()`;
- default policy `fullRetentionDays: 56`, `walRetentionDays: 14`, `alertLagSeconds: 300`;
- in-memory cap of 500 runs and 100 drills, independent of the policy retention fields.

The catalog is daemon-local. Core synchronizes it into PostgreSQL only when `/overview` is fetched successfully. There is no reverse synchronization from core to the daemon.

### 3.9 Restore drill

`deploy/backup-daemon/src/restoreDrillRunner.ts`:

1. computes `targetTime = now - 5 minutes`;
2. stops and removes both scratch directories (`BACKUP_SCRATCH_DIR`, `BACKUP_SCRATCH_AUDIT_DIR`);
3. recovers the core and audit clusters through `engine.recover`;
4. if the restore did not produce a `PG_VERSION`, runs `initdb -U PG_PRIMARY_USER --auth=trust` (core and audit);
5. appends recovery settings and creates `recovery.signal`;
6. starts both scratch clusters on `127.0.0.1` at their configured ports;
7. verifies double-entry drift is zero;
8. counts journal lines;
9. verifies sharded balance parity against `gl_accounts`/`gl_account_shards`;
10. verifies the audit hash chain;
11. stops and removes the scratch directories in `finally`;
12. returns a report with checks, counts, drift, replayed LSN, error and an HMAC-SHA256 signature over stable JSON using `BACKUP_ENCRYPTION_KEY_HEX`.

The scratch clusters use `--auth=trust` and listen only on loopback. The drill does not restore Redis and does not validate Redis contents.

### 3.10 Admin BFF and UI

`admin-back/api/protected/backups.ts` proxies overview/trigger/drill/policy under `/api/v1/admin/system/backups` with the same authority split as core. It does not expose `/catalog`.

`admin-front/src/pages/system/backups/index.tsx`:

- loads the overview on mount and polls it on the page's refresh cycle;
- shows daemon reachability, engine mode, WAL health, target health, schedule, policy, recent backups and latest drill;
- displays double-entry, parity and audit-chain checks from the drill report;
- opens a trigger dialog with target and kind;
- runs a drill with a confirmation dialog;
- opens a policy dialog and submits `PUT /policy`; because the first call returns `PENDING_REVIEW`, the page surfaces the approval id rather than pretending the policy changed;
- disables actions when the daemon is not configured or unreachable.

## 4. Contracts and invariants

- Only core may call the daemon in a deployment; the listener is private and requires mTLS by default.
- The daemon must be configured before trigger/drill/policy; without `BACKUP_DAEMON_URL` the result is 503, never a silent no-op.
- `target` is one of `all`, `postgres_core`, `audit_db`, `redis`; `kind` is `full` or `delta`.
- `target=all` includes core, audit and Redis when configured. If `PG_AUDIT_DATA_DIR` is missing the whole trigger fails; the core data directory is never used for the audit prefix.
- Policy changes require a different maker and checker; the approved payload, not the current request body, is applied.
- The in-process scheduler uses five-field cron expressions evaluated in UTC. The fallback `/etc/cron.d` file is interpreted by host cron in its local time zone. A full scheduled backup prunes full backups in WAL-G mode; delta does not prune.
- Restore drills target now minus five minutes, are destructive only to scratch directories, run loopback-only and are cleaned up before the report returns.
- Drill reports are signed and stored; core copies the signature when it syncs.
- Catalog writes are atomic at the file level; a failed write is surfaced but does not stop the daemon.
- The daemon must never return or log encryption keys, S3 credentials, database passwords or private key material.

## 5. Data / API / config / deployment surface

### Core models and routes

- `BackupCatalogRun` — id, target, kind, engine, status, timestamps, duration, size, start/end LSN, storage targets JSON, error.
- `BackupRestoreDrill` — id, status, timestamps, target time, replayed LSN, double-entry drift, balance mismatches, audit broken links, journal line count, checks JSON, signature, error.
- `ApprovalRequest` — backs the policy maker-checker workflow with `subjectType = "BACKUP_POLICY"`.
- Core routes: `GET /internal/admin/system/backups/overview`, `POST /trigger`, `POST /drill`, `PUT /policy`, `GET /catalog`.
- Admin BFF routes: `GET /api/v1/admin/system/backups/overview`, `POST /trigger`, `POST /drill`, `PUT /policy`.

### Daemon environment (selected)

| Key | Purpose | Default |
| :--- | :--- | :--- |
| `BACKUP_ENGINE_MODE` / `BACKUP_COMPRESSION` / `BACKUP_ENCRYPTION_KEY_HEX` | Engine, compression, encryption/signing key | mode required, `zstd`, key required |
| `BACKUP_PRIMARY_S3_*` / `BACKUP_CORE_S3_PREFIX` / `BACKUP_AUDIT_S3_PREFIX` | Primary bucket and per-database prefixes | endpoint/bucket required, prefixes derived |
| `BACKUP_SECONDARY_SSH_TARGET` | Optional secondary vault | empty |
| `BACKUP_FULL_CRON` / `BACKUP_DELTA_CRON` / `BACKUP_DRILL_CRON` | UTC schedules | `0 2 * * 0`, `0 2 * * 1-6`, `0 4 * * 0` |
| `BACKUP_RETENTION_FULL_COUNT` / `BACKUP_RETENTION_WAL_DAYS` | WAL-G full count / Barman window and displayed policy | `8` / `14` |
| `BACKUP_ALERT_LAG_SECONDS` / `SCHEDULER_ENABLED` / `SCHEDULER_TICK_MS` | Alert threshold and scheduler | `300`, `true`, `30000` |
| `BACKUP_DAEMON_PORT` / `BIND_HOST` / `CERT_PATH` / `KEY_PATH` / `CA_CERT_PATH` / `BACKUP_ALLOW_INSECURE_HTTP` | Listener and mTLS | `4090`, `127.0.0.1`, unset, `false` |
| `PG_PRIMARY_*` / `PG_AUDIT_DB_NAME` / `PG_AUDIT_DATA_DIR` / `PG_REPLICA_NODES` | Database connections and audit target | local defaults, unset, empty |
| `PG_DATA_DIR` / `PG_BIN_DIR` / `WALG_BIN` / `BARMAN_BIN` / `BARMAN_CLOUD_BIN` | Data and binaries | PostgreSQL 18 defaults, standard names |
| `BARMAN_SERVER` / `BARMAN_AUDIT_SERVER` / `BACKUP_CATALOG_PATH` | Barman names and catalog | core DB name / audit DB name, `/var/lib/pg-backup/catalog.json` |
| `BACKUP_SCRATCH_DIR` / `SCRATCH_PORT` / `AUDIT_DIR` / `AUDIT_PORT` / `BACKUP_COMMAND_TIMEOUT_MS` | Drill scratch and command ceiling | `/var/lib/pg-backup/scratch`, 55432/55433, 30 minutes |
| `REDIS_URL` / `REDIS_CLI_BIN` | Optional Redis snapshot | unset / `redis-cli` |

### Deploy surface

`deploy/provisioners/backupEngineProvisioner.ts` writes `/etc/pg-backup/backup.env`, `/etc/pg-backup/wal-g.env`, the `pgbackup` systemd unit, `/etc/cron.d/pg-backup`, the trigger and restore-drill scripts, Barman configuration/PGPASSFILE in Barman mode, archive_command/restore_command settings and the journal partition cron.

`deploy/deploy.ts` syncs the daemon source to `/opt/pg-backup-daemon`, chowns the install directory to `pgbackup`, uploads storage certificates to `BACKUP_DAEMON_CERT_DIR`, and enables the unit. `deploy/lib/hostPlanner.ts` injects `BACKUP_DAEMON_URL` and the client cert paths into core.

## 6. Operational usage

- Set `BACKUP_DAEMON_URL` and client CA/cert/key paths in core. Use HTTPS in production; plain HTTP is local only.
- Ensure the daemon has a primary S3 bucket and an encryption key. A typo fails at boot, not during a restore.
- For a manual backup, call the admin page or `POST /trigger`; poll `/overview` or `/runs` for completion.
- For `target=all`, confirm `PG_AUDIT_DATA_DIR` is set and the audit database is reachable.
- For a policy change, submit without an approval id, then have a different `security:write` user submit with the returned id.
- Watch `archiveLagSeconds` against `BACKUP_ALERT_LAG_SECONDS`. A non-zero lag with a healthy bucket usually means archive_command, credentials or the archive process is failing.
- Inspect `backup_catalog_runs` and `backup_restore_drills` for the local copy and the daemon catalog for the in-process view. A failed drill's three checks identify double-entry, parity or audit-chain failure.
- After a real restore, verify schema version 9, the ledger invariant, shard parity and audit chain.
- Do not rely on policy `fullRetentionDays` for WAL-G pruning; WAL-G uses `BACKUP_RETENTION_FULL_COUNT` and Barman uses its server-side policy.

## 7. Status and deviations

### Implemented

- Core backup internal routes and authority checks.
- mTLS backup control client with typed errors and timeouts.
- Daemon `/health`, overview, trigger, policy, runs and drills routes.
- WAL-G base/delta backup, verify, list, mirror, prune and recover command builders.
- Barman check/backup/list/recover paths; Redis BGSAVE/RDB/upload when configured.
- In-process UTC cron scheduler with policy hot-reload and skip-on-overlap.
- JSON catalog with atomic writes, validation, in-memory fallback and caps.
- Policy maker-checker through `ApprovalRequest`, with maker ≠ checker enforcement.
- Restore drill with double-entry, parity and audit-chain checks, signed reports and scratch cleanup.
- Catalog synchronization from daemon overview into core tables.
- Admin BFF proxy and admin backup page with trigger/drill/policy flows.
- Unit tests for the daemon, core client/routes and the Playwright backup page.

### Partial

- Target-aware backups: `all` works, but Redis is coupled to `all` and has no independent schedule.
- Secondary vault: WAL-G core/audit backups mirror; Barman and Redis do not.
- Retention: the policy is stored and displayed, but effective WAL-G/Barman behavior is driven by other settings.
- Health: WAL health uses archive/replay queries and can be degraded by an empty archive; Barman mode still uses WAL-G commands.
- Drill: core and audit are tested with fake command runners; no live end-to-end restore is in the default suite.
- Policy: only policy updates are maker-checker protected; trigger and drill are single-actor actions.

### Missing / deferred

- Certificate ownership fix: files under `BACKUP_DAEMON_CERT_DIR` are uploaded as root with mode 0600 and no `chown pgbackup`, so the daemon cannot read them.
- Audit drill role mapping: the restored audit cluster is queried with `PG_PRIMARY_USER`, while the audit database uses `AUDIT_DB_USER`.
- Barman audit slot: `barmanConfig` declares `slot_name = barman_audit`, but `barmanStreamingSql()` only creates the `barman` slot.
- WAL archive lag correctness: `WAL_ARCHIVE_STATUS_QUERY` passes `COALESCE(last_archived_wal, '')` to `pg_wal_lsn_diff`, and an empty string is not a valid `pg_lsn`.
- WAL replay lag semantics: `WAL_LAG_QUERY` uses replay/receive LSN on the first replica (or primary) and is labeled `lastArchivedLsn`; it is not the archive lag.
- Retention enforcement: WAL-G prune uses the environment full count; catalog policy days are not applied. Barman uses a static server policy.
- Secondary mirroring for Barman/Redis: Barman returns only `primary-s3`; Redis writes only to the core prefix.
- Redis schedule: no `redis` cron; scheduled full/delta jobs use `target=all`, and a `delta` Redis run still performs a full BGSAVE/RDB copy.
- UTC cron: the in-process scheduler has no timezone field and evaluates UTC; the system-cron fallback uses host local time, so the historical Tripoli schedule is not honored consistently.
- Barman health: `BarmanEngine.overviewHealth` still calls WAL-G bucket/WAL commands.
- Catalog exposure and destructive-action controls: admin-back does not proxy `/catalog`; trigger/drill are not maker-checker protected.
- Restore drill target selection: the drill always uses now minus 5 minutes.

### Known bugs / risks

- The certificate ownership gap blocks the intended mTLS daemon path; code/deploy gap.
- The audit role mismatch can produce a false `FAILED` drill on a correctly restored audit database; code gap.
- The `barman_audit` slot mismatch can break audit streaming while core works; code gap.
- An empty `last_archived_wal` can make health report zero lag instead of "no archive yet"; code gap.
- The scheduler advances `next` before skip-on-overlap, so a long-running job can silently miss a slot; code risk.
- A failed prune is only logged, while the backup remains `PASSED`; operational risk.
- The daemon catalog cap diverges from the unbounded PostgreSQL history; design gap.
- The first policy submission returns `PENDING_REVIEW`; an operator who skips the checker step may believe the schedule changed; UX risk.
- Scratch port collisions fail the drill; operational risk.
- `target=all` fails when audit is not configured; select `postgres_core` explicitly for core-only backups.

## 8. Verification and tests

Relevant test files:

- `core-back/test/backup-admin/backup-control-client.test.ts` — client requests, TLS options, typed errors, timeouts and singleton reset.
- `core-back/test/backup-admin/backup-admin-routes.test.ts` — overview/trigger/drill/policy/catalog behavior against a fake daemon and live PostgreSQL.
- `deploy/backup-daemon/test/config.test.ts` — environment validation, redaction and defaults.
- `deploy/backup-daemon/test/cron.test.ts` — five-field parser, UTC evaluation and next-run calculation.
- `deploy/backup-daemon/test/backupEngine.test.ts` — command builders, WAL-G/Barman selection, Redis snapshot commands, WAL queries and pruning.
- `deploy/backup-daemon/test/catalogStore.test.ts` — atomic writes, corrupt-file fallback, caps and policy.
- `deploy/backup-daemon/test/scheduler.test.ts` — due-job selection, overlap skipping, policy reload, prune and drill.
- `deploy/backup-daemon/test/server.test.ts` — routes, validation, redaction, background tasks and mTLS-related options.
- `deploy/backup-daemon/test/restoreDrillRunner.test.ts` — scratch restore orchestration, checks, signature and failure reports.
- `tests/e2e/admin/backups.spec.ts` — admin backup page behavior with mocked APIs.

Commands:

```bash
cd core-back && bun test test/backup-admin
cd deploy/backup-daemon && bun test
cd deploy && bun test
cd tests && bunx playwright test -c playwright.config.ts -g "backup"
```

Core backup-admin route tests that touch PostgreSQL skip when the database is unreachable. The daemon tests are unit-level and use fake command runners/file systems; they do **not** run a real WAL-G/Barman backup or a real PostgreSQL restore. The Playwright backup test mocks the API and needs no live stack. No test or benchmark was run for this documentation change.

## 9. Source references

### Old design sections

- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#5-segment-4--backup-management-orchestrator--admin-control-plane-pg-backup-daemon--core-back--admin-front`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#5-1-architecture-wrapping-wal-g--barman-with-an-admin-accessible-control-plane`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#5-2-core-back--admin-front-backup-management-api-contract`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#6-segment-5--horizontal-node-scaling--multi-host-storage-orchestration-in-deploydeployenv--deploydeployts`
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md`
- `design/00-process/blueprint-management.md#5-documentation-corrections-backlog`

### Code paths

- `core-back/api/internal/backups.ts`
- `core-back/lib/storageEngine/backupControlClient.ts`
- `core-back/lib/storageEngine/auditAndLogAdapters.ts`
- `core-back/lib/audit/writeAudit.ts`
- `core-back/prisma/schema.prisma` (`BackupCatalogRun`, `BackupRestoreDrill`, `ApprovalRequest`)
- `deploy/backup-daemon/src/index.ts`
- `deploy/backup-daemon/src/config.ts`
- `deploy/backup-daemon/src/server.ts`
- `deploy/backup-daemon/src/backupEngine.ts`
- `deploy/backup-daemon/src/scheduler.ts`
- `deploy/backup-daemon/src/cron.ts`
- `deploy/backup-daemon/src/catalogStore.ts`
- `deploy/backup-daemon/src/restoreDrillRunner.ts`
- `deploy/backup-daemon/src/commandRunner.ts`
- `deploy/provisioners/backupEngineProvisioner.ts`
- `deploy/lib/hostPlanner.ts`
- `deploy/deploy.ts`
- `admin-back/api/protected/backups.ts`
- `admin-front/src/pages/system/backups/index.tsx`

### Generated appendices

- `project-design/appendices/api-route-matrix.md` — core, BFF and portal backup routes
- `project-design/appendices/env-and-config-matrix.md` — daemon and core backup environment keys
- `project-design/appendices/schema-catalog.md` — backup catalog/drill models
- `project-design/appendices/migration-catalog.md` — migration that introduced the backup models

## 10. Change history

- 2026-11-03 — Initial canonical extraction. Records the core API, daemon API, WAL-G/Barman engines, UTC scheduler, JSON catalog, policy maker-checker, restore drill, catalog sync and target-aware behavior, plus the certificate ownership, audit role, Barman slot, WAL lag, retention, secondary mirroring, Redis schedule, UTC cron and Barman health gaps. See `project-design/TRACKER.md`.

## Synthetic Seeder

> Status: `partial` · Last verified: 2026-11-04

## 1. Purpose and scope

The synthetic seeder builds a deterministic, multi-year operational history for a designated test/sandbox deployment that is wired to the Fake Payment Rails emulator. It exists so the portals, lists, filters, reconciliation, AML, operator cases, ledger checkpoints and dashboard-style views have realistic data without copying production records.

It owns:

- the five-layer safety gate;
- the scale profiles and environment parsing;
- the chronological simulation clock and Libyan market seasonality;
- the nine domain generators plus route health and checkpoints;
- the in-memory 56-collection dataset;
- the topological, chunked bulk writer;
- Fake Rails transaction/event synchronization;
- KYB document enrichment through the Vault;
- the completed-run registry in `platform_settings`;
- the in-memory and post-seed invariant audit.

It does not own the baseline seed (gateways, rails, flows, GL accounts and credential sets) or the Fake Rails emulator implementation. It depends on both. The seed is optional and must never run against a production or non-Fake-Rails environment.

## 2. Design intent (extracted and synthesized from ./design)

The historical seeder specification describes:

- a test-server-only seeder guarded by an explicit environment declaration and a live Fake Rails handshake;
- three scale profiles (COMPACT, STANDARD, STRESS) with a multi-year span;
- realistic Libyan market seasonality: weekday/weekend rhythm, Ramadan/Eid peaks, salary-day spikes and historical outages;
- coverage of the entire schema, including every attempt state, ledger templates, checkpoints, reconciliation, disputes, AML and maker-checker queues;
- a two-phase design: build an in-memory chronological graph, then bulk-write it in foreign-key order;
- Fake Rails bulk synchronization so inquiries, refunds and statement reconciliation hit the emulator coherently;
- encrypted KYB document payloads, not fake plaintext;
- a post-seed audit that proves zero ledger drift and balanced entries.

The implementation keeps the two-phase design, the safety gate and the audit. The 2026-11-04 rework (section 3.13) made the data faithful to real operation; what still differs from the specification:

- it writes 50 model collections out of 56 in-memory collections (the six baseline reference collections are read-only);
- the safety gate checks the declared test flag and Fake Rails hosts but not the database host;
- the bulk writer is not transactional;
- the generated volumes of AML cases and reconciliation items are derived bounds, not exact counts (section 3.2).

## 3. As-built architecture

### 3.1 Safety gate

`core-back/prisma/syntheticSeeder/SeederSafetyGate.ts` implements five checks before any context is created:

1. `IS_TEST_SERVER === "true"` — otherwise `SEEDER_BLOCKED_NOT_TEST_SERVER`.
2. `FAKE_RAILS_ENABLED === "true"` and `FAKE_RAILS_PUBLIC_BASE_URL` is set — otherwise `SEEDER_BLOCKED_FAKE_RAILS_DISABLED`.
3. When `NODE_ENV === "production"`, `FAKE_RAILS_ALLOW_IN_PRODUCTION === "true"` is required.
4. `FAKE_RAILS_ALLOWED_HOSTS` is non-empty and every configured `gateway_environments.baseUrls` host is in that set. Invalid URLs, empty gateway sets and external hosts fail closed.
5. A live `POST /portal-api/internal/seeder-handshake` with `x-fake-rails-seeder-token` must succeed within 10 seconds.

The gate does not inspect `DATABASE_URL`, the host name of the core database, or the presence of production data. It trusts `IS_TEST_SERVER` and the gateway host allowlist. A mis-pointed test flag against a production database is not blocked by code.

### 3.2 Configuration and profiles

`core-back/prisma/syntheticSeeder/config.ts` defines:

- `SeederProfile = "COMPACT" | "STANDARD" | "STRESS"`;
- 19 `ProfileVolumes` fields;
- `PROFILES` with the three volume sets;
- `loadSeederConfig()` reading `SYNTHETIC_SEED_PROFILE` (or `SYNTHETIC_DATA_PROFILE`), `SYNTHETIC_SEED_KEY` (or `SYNTHETIC_DATA_SEED`), `SYNTHETIC_DATA_NAMESPACE` and `SYNTHETIC_YEARS_SPAN` (or `SYNTHETIC_DATA_YEARS`).

| Profile | Merchants | Payment links | Attempts | Recon items | Operator cases | Years |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| COMPACT | 65 | 8,500 | 15,000 | 12,000 | 450 | 3.5 |
| STANDARD | 250 | 65,000 | 120,000 | 95,000 | 2,900 | 3.5 |
| STRESS | 1,200 | 280,000 | 500,000 | 400,000 | 11,500 | 4.0 |

Since 2026-11-04 every volume drives generation. `joinRequests`, `wallets`, `applications`, `beneficialOwners` and `users` are allocated across merchants with `allocateVolume` (per-merchant bounds 1-3, 1-3, 1-5, 1-6 and 1-8; `users` counts staff plus merchant users), `kybDocuments` is allocated above the per-category required-document count, `paymentLinks`/`paymentAttempts` are exact up to the attempts a link window can host, `reconciliationRuns` is split across statement sources, and `disputes`, `adjustments`, `cashouts`, `amlScreenings`, `operatorCases` and `approvalRequests` act as targets. When a volume is outside the feasible per-merchant bounds the nearest feasible count is generated and the invariant `volume.mismatch` is only enforced for feasible volumes. `amlCases` is a floor (rule-driven holds can add more) and `reconciliationItems` is an upper bound.

`yearsSpan` is used by the timeline. `SYNTHETIC_SEED_YEARS_SPAN` (written by the deploy planner), `SYNTHETIC_YEARS_SPAN` and `SYNTHETIC_DATA_YEARS` are accepted in that order; the value must be a number in (0, 10].

### 3.3 Context and ID factory

`createContext` loads existing references (`gateways`, versions, rails, routes, credentials, GL accounts, admin users, statement sources), builds a seeded PRNG from `seedKey`, builds the timeline, creates an empty dataset, and creates `nextId`.

`nextId` returns `<8 hex>-<4 hex>-7<3 hex>-8<3 hex>-<12 hex counter>` where the first 64 bits come from `sha256(namespace, seedKey)`. Two different seed keys or namespaces therefore never collide (the old factory ignored both and `skipDuplicates` silently dropped the second history), while a run stays deterministic. Rows keep unique keys that matter for re-runs (`seed_key` of GL accounts and commission profiles, e-mails, references) namespaced by seed key as well.

### 3.4 Timeline

`core-back/prisma/syntheticSeeder/timelineClock.ts`:

- `buildTimeline(now, yearsSpan)` sets `start = now - round(yearsSpan * 12) months` at 08:00 UTC and `end = now`;
- `adoptionMultiplier` grows from 1.0 to 8.0 over the span;
- `dayVolumeMultiplier` applies Friday 0.72, Saturday 1.05, salary window 1.35, Ramadan 1.8 and Eid 1.5;
- `businessHour` returns a Tripoli-style hour distribution;
- `dateAt` writes the chosen hour with `setUTCHours`.

Local hours are `Africa/Tripoli` wall-clock hours (UTC+2, no DST) and are stored as `hour - 2` UTC (`tripoliDateTime`, `tripoliHour`, `tripoliDay`); the start of the timeline is 08:00 Tripoli. `dayVolumeMultiplier` additionally models the Eid holiday trough (0.55), Ramadan (1.8), the ten days before Eid al-Adha (1.5), Friday 0.72, Saturday 1.05 and the salary window 1.35 on the Tripoli calendar day, with Ramadan/Eid tables for 2021-2028. `businessHour` takes the day: Ramadan traffic moves to the hours after iftar and Friday skips the 11:30-14:30 prayer window.

### 3.5 The nine generators

| Generator | Main outputs |
| :--- | :--- |
| `01_adminAndStaffGenerator` | 13 platform staff seats and the disabled system drafter; flat authority lists and maker/checker flags from `scripts/createAdminPlan.ts`; velocity rules with operational thresholds; AML rules whose `params` keys are the ones `AmlRuleEngine` reads. Notification templates, CBL reporting rules and the environment setting belong to the baseline seed and are no longer duplicated. |
| `02_merchantCohortGenerator` | Merchants with a consistent lifecycle (request -> submission -> review -> proposal -> decision -> activation -> suspension/closure), category-driven profiles, unique phones, IBAN-shaped payout accounts; earlier REJECTED/EXPIRED/WITHDRAWN join requests linked by `resubmission_of_id`; KYB document chains (superseded copies, expiry, 30-day notice, duplicate-hash showcase); beneficial owners summing to 100 %; wallets + GL accounts; applications; users and identities; tokens; POS terminals only for counter categories; merchant-owned credentials; negotiated commission profiles (fractional rates) and the historical platform default. National ids are queued for Vault encryption. |
| `03_gatewayLifecycleGenerator` | Later versions next to the baseline LIVE version (ROLLED_BACK -> baseline, SANDBOX_VERIFIED/DRAFT, PENDING_APPROVAL for two gateways) with environments, auth, settings and evidence; webhook channels only for baseline versions without one; statement sources; route health DERIVED from the generated attempts (last 30 days). |
| `04_linksAndAttemptsGenerator` | Heavy-tailed merchant volumes, category ticket bands, rail popularity, per-rail decline/abandon pressure; links with fee bearer, reuse and expiry; attempts built from engine-valid status paths with monotonic timestamps; pricing mirrored from the checkout (`money.ts`); step logs, inbound webhooks, attempt groups; live tail of in-flight/UNKNOWN/held attempts near `T_NOW`; late successes and SUSPENSE settlements. |
| `05_ledgerAndCheckpoints` | Confirmation, AML hold/release/void and SUSPENSE postings through the engine templates; AML hold cases; shard balances and one checkpoint instant for all accounts, computed after every posting (`generateCheckpoints`). |
| `06_reconAndStatements` | Per-source windows fed by the settled attempts (each once); MATCHED lines carry the settled amount and fee; exceptions (mismatch, missing at gateway, missing locally, duplicate) within the operator-case budget; `SETTLEMENT_SWEEP` for platform-cleared matched lines. |
| `07_disputesCashoutsAdjustments` | Executed REFUND adjustments with `FULL_REFUND`/`INTERNAL_REFUND` journals and the REFUNDED/PARTIALLY_REFUNDED step; disputes with the reserve journal, drafted CHARGEBACK adjustments and WON/LOST outcomes; cash-outs and manual debits sized so wallets never go negative; manual credits and corrections; open refund requests. |
| `08_amlAndGovernanceQueues` | Onboarding/owner/periodic screenings with matches, screening AML cases, STR reports, approvals bound to real subjects (join requests, adjustments, AML cases, gateway versions, merchants, commission profiles) with maker != checker and role flags, notifications from the baseline catalogue, audit rows derived from real events, detail change logs. |
| `09_operatorCasesGenerator` | Operator cases from reconciliation exceptions, UNKNOWN/CONFLICT attempts, held/escalated payments, late successes and SUSPENSE settlements; only an UNKNOWN attempt can carry a proposed MARK_* action (following the emulator truth); maker-checker resolutions. |

### 3.6 The 56 in-memory collections

`core-back/prisma/syntheticSeeder/dataset.ts` defines 56 arrays (the 2026-11-02 list below plus `glAccountShards` and `notificationTemplates`):

- Identity and onboarding: `users`, `userIdentities`, `merchants`, `joinRequests`, `kybDocuments`, `beneficialOwners`, `wallets`, `glAccounts`, `applications`, `accessTokens`, `accessTokenIps`, `posTerminals`, `posScreens`, `commissionProfiles`.
- Catalogue and credentials: `credentialSets`, `gatewayVersions`, `gatewayVersionEvidence`, `gatewayEnvironments`, `gatewayAuths`, `gatewaySettings`, `confirmationChannels`, `statementSources`.
- Reference collections loaded from the baseline: `rails`, `railFields`, `railRoutes`, `widgets`, `redirects`, `pollPolicies`.
- Collection flow: `paymentLinks`, `attemptGroups`, `paymentAttempts`, `attemptStepLogs`, `inboundEvents`, `journalEntries`, `journalLines`, `gatewayHealthSamples`.
- Reconciliation: `reconciliationRuns`, `reconciliationItems`, `disputes`, `adjustments`, `cashoutRequests`.
- Risk and governance: `amlScreenings`, `amlScreeningMatches`, `amlCases`, `regulatoryReports`, `operatorCases`, `approvalRequests`, `notifications`, `auditLogs`, `detailChangeLogs`, `velocityRules`, `amlRules`, `reportingRules`, `platformSettings`.

### 3.7 Bulk writer

`core-back/prisma/syntheticSeeder/sync/bulkDataWriter.ts` writes **50 models** in topological FK order (`encryptPendingSecrets` runs first and fills every Vault-encrypted column; `writeReadModels` projects `rm_*` afterwards):

- merchants before users, because users carry `merchant_id`;
- GL accounts before wallets;
- journal entries before attempts, because attempts carry `ledger_entry_id`;
- journal lines after attempts and inbound events;
- disputes and adjustments initially strip their circular references, then link them in a second pass;
- monthly GL checkpoints are applied last with per-account `update` calls.

Each model is written in 2,500-row `createMany` chunks with `skipDuplicates: true`. The writer skips any empty collection. The six in-memory collections not written are `rails`, `railFields`, `railRoutes`, `widgets`, `redirects` and `pollPolicies`; these are expected to exist from the baseline blueprint seed and are only used as read-only references.

The `WRITE_ORDER` is exported and tested (parents before children; approvals right after users; disputes before adjustments; items before cases; no strip-and-relink). The writer is not a transaction. A failure partway through leaves the previous chunks committed; re-running with the same seed key is not automatic because the completed-run marker is written only at the end. A failed run can be retried, but duplicate ids are skipped and a partial dataset may remain.

### 3.8 Fake Rails synchronization

`core-back/prisma/syntheticSeeder/sync/fakeRailsBulkSyncClient.ts` maps attempts and step logs to the Fake Rails SQLite schema and posts them in batches of 5,000:

- `POST /portal-api/internal/bulk-seed` with `x-fake-rails-seeder-token`;
- transactions first, then events;
- status mapping from core statuses to Fake Rails statuses (`SUCCEEDED`/`PARTIALLY_REFUNDED`/`DISPUTED` -> `PAID`, `REFUNDED` -> `REFUNDED`, in-flight and `UNKNOWN` -> `INITIATED`/`AWAITING_ACTION`); BLOCKED and never-dispatched attempts are not synced; an `UNKNOWN` attempt gets `inquiry_override_status` = the recorded gateway truth (`PAID` or `FAILED`), so "Inquire now" resolves it;
- provider references, OTP code selection, amounts, timestamps and gateway/rail codes.

Fake Rails stores the history so "Inquire now" on a seeded UNKNOWN attempt, refunds on seeded successes and statement reconciliation return coherent answers. The sync does not create refunds, disputes or cash-out records in Fake Rails; those remain core-side histories.

### 3.9 KYB enrichment

`core-back/prisma/syntheticSeeder/sync/enrichKybDocuments.ts` runs after the bulk write and adds data that the synchronous generators cannot produce:

- generates a tiny valid PDF preview per KYB document;
- encrypts it with `Vault.encryptSecret(..., "kyb-document")`;
- sets `originalFileName` and `uploadedById` where missing;
- creates missing required documents for ACTIVE merchants according to `readRequiredDocuments`;
- creates owner `OWNER_ID` documents for up to 24 active beneficial owners;
- sets `nextKybReviewAt` for ACTIVE merchants that lack one;
- creates up to 12 periodic revalidation requests and sets those merchants to `KYB PENDING`.

Unlike the base generators, this enrichment uses the real Vault.

### 3.10 Completed-run registry

`core-back/prisma/syntheticSeeder/seedRunRegistry.ts` stores a `PlatformSetting`:

- scope `SYNTHETIC_SEED`;
- key `synthetic.seed.completed:<seedKey>`;
- value includes seed key, namespace, profile, years span, completion time and optional attempt/journal/drift counts.

`runSyntheticSeeder` checks `findCompletedSeedRun` before the safety gate. A completed key is skipped with a message. A failed or interrupted run never writes the marker. `recordCompletedSeedRun` upserts version 1.

### 3.11 Post-seed audit

`verify/invariants.ts#checkInvariants` runs on the in-memory graph before the write (a violation aborts) and `postSeedAudit` repeats it, then compares the database with the dataset. Exact money (BigInt scaled by 10^4) is used throughout. It asserts, per rule name:

- **relations**: every foreign key (`FK_EDGES`, 78 edges incl. baseline references) points at an existing row; wallet GL account is the merchant's `MERCHANT_WALLET`; link wallet/application/merchant coherence; unique ids, e-mails, references, idempotency keys, journal `(ref_type, ref_id)`, dispute `(gateway, ref)`;
- **ledger**: every entry balanced, every line > 0 and a 4-decimal string, system drift exactly 0, lines dated like their entry, nothing in the future; checkpoint + lines after the checkpoint = plain sum for every account; shard sums = line sums;
- **settlement math**: wallet credit = `net_merchant_amount`, income credit = commission, fee accrual = gateway fee (accrual routes), MERCHANT_DIRECT never credits a wallet, the credited wallet is the link's wallet;
- **lifecycle**: each attempt's path is made of engine transitions (`lifecycle.ts`, compared with `ALLOWED_TRANSITIONS` by a test), starts at CREATED/BLOCKED, ends at its status, timestamps monotonic and <= `T_NOW`, `terminal_at` iff terminal, in-flight attempts still inside their TTL, amounts consistent with the fee-bearer breakdown, settled amount only on settled statuses, ledger entry only on settled attempts and unique;
- **links**: `confirmed_count`/`active_locked_count` equal the attempts, no slot overflow, COMPLETED exactly when full, no stale PENDING, attempt-group success counts;
- **governance**: maker != checker, maker `is_maker`, checker `is_checker`, decided approvals have a checker, pending ones none; adjustments executed iff journaled, refunds <= charge, REFUNDED iff refunds sum to the charge, dispute <-> adjustment bidirectional and consistent with the status, cash-outs linked, wallets never below `-negative_balance_ceiling` at any instant, reconciliation stats and windows;
- **time**: no `created_at` after `T_NOW`, `updated_at >= created_at` everywhere;
- **volumes**: merchants, join requests, wallets, applications, owners, users equal the profile when feasible; business-hour share, negative wallets and volume ratios are reported as metrics;
- **operator cases**: the pre-existing case audit (evidence, backlinks, maker-checker, SLA timestamps, duplicates).

After the write, `postSeedAudit` asserts that the database row counts of attempts, journal entries, journal lines, links, merchants, adjustments and disputes equal the dataset (a skipped duplicate is now a failure) and that the SQL ledger drift and unbalanced-entry count are zero.

### 3.12 Execution flow

`core-back/prisma/syntheticSeeder/index.ts`:

1. load config;
2. `ensureSchemaVersion()`;
3. skip when the seed key is already complete;
4. run the safety gate and print Fake Rails health;
5. load references and reject empty gateways/rails;
6. run the generators in order (route health, then ledger, reconciliation, refunds/disputes/cash-outs, governance, operator cases, and the checkpoints last);
7. run the in-memory audit (ledger + the full invariant suite) and fail on any violation;
8. encrypt every pending sensitive column with the Vault, then bulk-write 50 models;
9. project the `rm_*` read models and enrich KYB documents;
10. sync transactions/events to Fake Rails;
11. run the post-seed audit (invariants + database/dataset equality + SQL drift) and fail on any violation;
12. record the completed run.

The console summary reports profile, span, phase timings, rows written, KYB enrichment counts, Fake Rails sync counts and final attempts/journal lines/drift.

### 3.13 2026-11-04 realism rework

The data was re-derived from the real engine rules instead of random rows. Defects fixed:

| Area | Defect | Fix |
| :--- | :--- | :--- |
| Ledger | Hand-written account choice, float sums, per-gateway/env clearing accounts the baseline never creates; settlement-sweep and refund legs invented | `postTemplate` posts the engine's `buildPaymentConfirmationTemplate`/`buildLedgerTemplate` output, validated by `LedgerPoster.validateTemplate`, with accounts resolved like `LedgerPoster.resolveAccountId` (platform fallback); decimal.js/BigInt only |
| Checkpoints | Taken before refunds/cash-outs were posted, so lines dated before the checkpoint were missed | `generateCheckpoints` runs last; one instant for all accounts |
| Fees | Random 0.2-0.9 % gateway fee and 0.5-2.5 % commission; surcharge ignored | Commission profile hierarchy, fee-bearer breakdown, route cost model and wire rounding mirrored from the checkout (`money.ts`) |
| Lifecycle | Terminal times random 1-120 min after creation, in-flight attempts years old, `EXPIRED + LATE_SUCCESS_PENDING` and `VERIFYING + AML_HOLD` statuses the engine never produces, no refund/dispute sequencing | Engine-valid paths with one timestamp per step; late successes end SUCCEEDED (or SUSPENSE); held payments are `CREATED + AML_HOLD` with a hold entry and case; live tail only near `T_NOW`; refunds/disputes append their status step |
| Links | Counters patched after the fact; random link for each attempt | Counters follow the attempts; sequential retries respect the slot rule |
| Relations | Adjustments/disputes/AML cases not tied to approvals, journal entries or holds; approvals pointed at random subjects with invalid state; join-request approval FK order | Every adjustment/AML case/report/version/profile has the approval the real flow would create (maker != checker, role flags); writer order fixed |
| Governance | Staff `authoritiesMap` nested object (zero authorities); `SUPPORT`/`MLRO` flags wrong; maker/checker ignored role flags | Flat authority lists and flags from `createAdminPlan.ts` |
| Merchants | Single join request, uniform random statuses/dates, suspension dates unrelated to activation, owners not summing to 100 %, KYB documents unrelated to required types, duplicate phones, 0.5-3.5 commission rates (50-350 %), base64 "ciphertext" | Lifecycle-ordered timestamps, resubmission chains, required-document chains, 100 % ownership, unique phones, fractional rates, Vault encryption |
| Catalogue | 15 Arabic vs 14 English surnames (misaligned, one `undefined`), uniform categories | Aligned lists; categories with ticket bands, weights and counter flags |
| Time | Tripoli hour written as UTC, Eid treated as a peak, uniform hour for reusable links | UTC+2 conversion, Eid trough, Ramadan evening shift, Friday prayer dip |
| Config | `SYNTHETIC_SEED_YEARS_SPAN` ignored; ids ignored namespace and seed key | Both fixed |
| Volumes | Seven profile fields unused | All drive generation (section 3.2) |
| Verify | Audit checked drift, succeeded-without-ledger, slot counts and operator cases only; DB counts reported not asserted | Section 3.11 |
| Fake Rails | BLOCKED attempts synced; UNKNOWN mapped to `UNKNOWN_SIMULATED` with no truth; OTP selection from the decimal tail of a hex id | Skip never-dispatched attempts, truth in `inquiry_override_status`, hex-aware OTP |
| Read models | `rm_*` empty after a seed | `writeReadModels` projects them like `projectAttemptTransition` |

`fake-rails-back/api/portal/seederSync.ts` and `core-back/prisma/seedFakeRails.ts` were reviewed and needed no change.

## 4. Contracts and invariants

- The seeder must never run unless `IS_TEST_SERVER=true`, Fake Rails is enabled with a public URL, the production guard is satisfied when applicable, every gateway host is allowed and the live handshake succeeds.
- The seeder requires the baseline seed (gateways, rails, routes, credential sets, GL accounts, statement sources) and Fake Rails blueprints. Empty gateways or rails abort.
- The dataset must be deterministic for a given `seedKey`, profile and current time. The PRNG and the chronological clock are seeded from the key.
- The generated ledger must satisfy `SUM(DEBIT) = SUM(CREDIT)` per entry and system-wide, exactly (no tolerance).
- Every SUCCEEDED attempt must have a journal entry; attempts in flight must match each link's `active_locked_count`.
- Every non-MATCHED reconciliation item must have a candidate operator case; the operator-case generator uses the same exception budget.
- Maker-checker seeded approvals must have `makerUserId <> checkerUserId`, an `is_maker` maker and an `is_checker` checker; resolved cases must have notes and an executed approval.
- The full invariant list of section 3.11 holds before any row is written and again after the write.
- All linked evidence (attempt, reconciliation item, confirmation channel, inbound event) must exist and be consistent.
- The completed-run marker is written only after the post-seed audit passes.
- Re-running the same seed key is a no-op. Ids and unique keys are namespaced by seed key, so a different key adds a parallel history (the post-seed audit compares the database with the dataset, so a collision fails loudly).

## 5. Data / API / config / deployment surface

### Collections and models

The seeder writes 49 Prisma models through `createMany`, including merchant/user/KYB/owner, wallet/application/token, gateway/version/environment/auth/setting/channel/evidence/health, statement source, link/attempt/step/inbound, journal/line, reconciliation, dispute/adjustment/cashout, AML screening/match/case/report, approval, operator case, notification/template/audit/change-log, velocity/AML/reporting rule and platform setting.

### Environment

| Key | Purpose |
| :--- | :--- |
| `IS_TEST_SERVER` | Must be `true` |
| `FAKE_RAILS_ENABLED` | Must be `true` |
| `FAKE_RAILS_PUBLIC_BASE_URL` | Public emulator base URL |
| `FAKE_RAILS_ALLOW_IN_PRODUCTION` | Required when `NODE_ENV=production` |
| `FAKE_RAILS_ALLOWED_HOSTS` | Comma-separated allowed emulator hosts |
| `FAKE_RAILS_SEEDER_TOKEN` | Shared handshake/bulk-seed token |
| `SYNTHETIC_SEED_PROFILE` | `COMPACT`, `STANDARD`, `STRESS` (default `STANDARD` in the seeder; deploy default `COMPACT`) |
| `SYNTHETIC_SEED_KEY` | Completed-run key and PRNG seed |
| `SYNTHETIC_DATA_NAMESPACE` | Namespace used in emails/references (default `synthv1`) |
| `SYNTHETIC_YEARS_SPAN` | Timeline span in years |
| `SYNTHETIC_SEED_VERBOSE` | Prints per-model written counts |

### Deploy surface

`deploy/lib/configSchema.ts` defines `RUN_SYNTHETIC_HISTORY_SEED`, `SYNTHETIC_SEED_PROFILE`, `SYNTHETIC_SEED_KEY` and `SYNTHETIC_YEARS_SPAN`, with validation that the run requires `IS_TEST_SERVER=true`, Fake Rails enabled and (in production) the production override.

`deploy/lib/hostPlanner.ts:309-313` injects the synthetic environment into the core host. It writes **`SYNTHETIC_SEED_YEARS_SPAN`**, while `core-back/prisma/syntheticSeeder/config.ts` reads **`SYNTHETIC_YEARS_SPAN`**. The configured years span is therefore ignored by the seeder, which falls back to the profile's `yearsSpan`.

`deploy/deploy.ts:797-807` runs `bun run seed-synthetic-history` on the core host when `RUN_SYNTHETIC_HISTORY_SEED` is true, with a one-hour timeout, and logs the last lines. `deploy/deploy.env` enables the seed with the STANDARD profile and seed key `libya-pg-2023-2026_2`.

### Fake Rails endpoints

- `POST /portal-api/internal/seeder-handshake`
- `POST /portal-api/internal/bulk-seed`

Both require the seeder token and are implemented in `fake-rails-back/api/portal/seederSync.ts`.

## 6. Operational usage

- Provision a test server, install Fake Rails, run `bun run db-seed` and `bun run seed-fake-rails` first.
- Set `IS_TEST_SERVER=true`, `FAKE_RAILS_ENABLED=true`, `FAKE_RAILS_PUBLIC_BASE_URL`, `FAKE_RAILS_ALLOWED_HOSTS`, a strong `FAKE_RAILS_SEEDER_TOKEN` and the `SYNTHETIC_*` controls.
- Choose `COMPACT` for a laptop, `STANDARD` for a shared test host and `STRESS` only with enough disk, memory and time. The STANDARD profile writes roughly 280k rows and syncs 120k attempts; the deploy step allows up to one hour.
- Use a new `SYNTHETIC_SEED_KEY` for every intentionally distinct history. Reusing a key is a no-op; changing the key does not clean the previous synthetic rows.
- Run `cd core-back && bun run seed-synthetic-history`.
- Watch the phase timings and the final audit line. A nonzero drift, unbalanced entries, succeeded-without-ledger count or slot violation aborts before the completion marker.
- If Fake Rails sync fails after the database write, fix the emulator and rerun with the same key. The run marker is absent, so the seeder retries; existing ids are skipped.
- To rebuild cleanly, recreate the database and rerun the baseline seed, Fake Rails bridge and synthetic seeder. Deleting only the marker is not a clean rebuild because the old synthetic rows remain.
- Do not run the seeder against a production database or a non-Fake-Rails gateway set.

## 7. Status and deviations

### Implemented

- Five-layer safety gate with live Fake Rails handshake.
- Three profiles, a deterministic PRNG and a multi-year timeline.
- Nine generators covering merchant/onboarding, gateway lifecycle, links/attempts, ledger/checkpoints, reconciliation, disputes/cash-outs/adjustments, AML/governance, operator cases and admin/staff.
- 56 in-memory collections and a 50-model topological bulk writer with 2,500-row chunks.
- Fake Rails transaction/event synchronization in 5,000-row batches.
- Vault-backed KYB document enrichment.
- Completed-run registry in `platform_settings`.
- In-memory and post-seed invariant audits.
- Deploy integration and safety validation.

### Partial

- Collection coverage: 50 of 56 collections are written; the six reference collections come from the baseline.
- Notifications use the baseline catalogue codes `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`, `DISPUTE_OPENED`, `CASHOUT_REQUESTED` and `APPROVAL_REQUIRED` only where a template for the channel/language exists; the seeder creates no templates.
- Safety: the gate checks the declared test flag and gateway hosts, not the database host or existing data.
- Baseline versions are not backdated (attempts predate the version row's `created_at`).
- Several model families are not generated (see the `gaps` list).

### Known bugs / risks

- The bulk writer is not transactional. An interrupted run leaves partial rows; the retry skips duplicates and the post-seed audit (database/dataset equality) fails instead of passing silently. Operational risk.
- The seeder does not clear previously seeded rows. A rebuild requires a database reset.
- The DB-backed path (writer, Vault enrichment, SQL audit, read-model SQL) has not run in this environment: no PostgreSQL/Redis exist here, DB suites skip. Verification risk.
- Engine observations found while mirroring its rules (the seeder works around them; not changed because they are outside the seeder): (1) `INTERNAL_CONFIRMATION` books the requested amount only, so an INTERNAL rail with a payer surcharge cannot balance - the seeder keeps INTERNAL/MERCHANT_DIRECT rails on MERCHANT_ABSORBS; (2) `AML_HOLD_AND_RELEASE` (release) books no gateway fee accrual, so a released hold leaves the fee unaccrued; (3) `LedgerPoster` resolves the merchant wallet by `ownerId` only, i.e. the merchant's first wallet, not the link's wallet (the seeder maps the link's wallet explicitly); (4) `SYSTEM_AUTOMATION_USER_ID = "SYSTEM_AUTOMATION"` is not a UUID but is written to `users.id` (a `uuid` column); (5) the refund commission split is not rounded to 4 decimals, so the journal amounts can be re-rounded on write; (6) the guard writes BLOCKED attempts with `MERCHANT_ABSORBS` but the real bearer's amounts; (7) `postSettlementSweeps` dedupes by `batchReference`, so a batch reference shared by many items sweeps only the first.
- `SYNTHETIC_SEED_YEARS_SPAN` is now accepted; the deploy planner needs no change.

## 8. Verification and tests

Relevant test files:

- `core-back/test/synthetic-seeder-realism.test.ts` — DB-free end-to-end proof (35 tests): every generator runs against a baseline lookalike (`test/helpers/seederFixture.ts`) and the full invariant suite must report nothing for several seeds; volumes, determinism, id isolation, Tripoli time/seasonality, engine mirrors (transition table parsed from `DynamicRailEngine.ts`, pricing, ledger math), tamper tests proving the audit catches each defect class, Vault encryption, writer order, Fake Rails sync payload, read models.
- `core-back/test/synthetic-seeder.test.ts` — safety gate, config and audit behavior on sparse rows.
- `core-back/test/exhaustive/10-seeder-and-deploy/synthetic-seeder-safety-and-audit.test.ts` — exhaustive safety/audit suite.
- `fake-rails-back/test/api.test.ts` — seeder handshake and bulk-seed endpoints.
- `fake-rails-back/test/exhaustive/05-api-matrix/fake-rails-portal-and-chaos-api.test.ts` — broader Fake Rails API matrix.

Commands:

```bash
cd core-back && bun test test/synthetic-seeder-realism.test.ts test/synthetic-seeder.test.ts
cd core-back && bun test test/exhaustive/10-seeder-and-deploy
cd fake-rails-back && bun test
cd core-back && bun run seed-synthetic-history
```

The unit tests do not require a live database or Fake Rails. The actual `seed-synthetic-history` command requires PostgreSQL 18, the baseline seed, Fake Rails and all safety variables; the deploy-time run is not part of the default test gate and was NOT executed in the 2026-11-04 rework (no PostgreSQL available): the COMPACT profile was generated in memory in about 1.4 s (14.9k attempts, 8.5k links, ~60k journal lines, zero invariant violations).

## 9. Source references

### Old design sections

- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#executive-summary--architectural-vision`
- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#1-pre-flight-safety-gate--fake-rails-dependency-verification`
- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#2-chronological-simulation-engine--volume-scaling-profiles`
- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#3-comprehensive-multi-state-distribution-across-all-66-database-models`
- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#4-two-phase-seeder-execution--fake-rails-bulk-synchronization-pipeline`
- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#5-directory-structure-of-the-synthetic-seeder-module`
- `design/00-process/blueprint-management.md#5-documentation-corrections-backlog`

### Code paths

- `core-back/prisma/syntheticSeeder/index.ts`
- `core-back/prisma/syntheticSeeder/config.ts`
- `core-back/prisma/syntheticSeeder/SeederSafetyGate.ts`
- `core-back/prisma/syntheticSeeder/context.ts`
- `core-back/prisma/syntheticSeeder/dataset.ts`
- `core-back/prisma/syntheticSeeder/timelineClock.ts`
- `core-back/prisma/syntheticSeeder/prng.ts`
- `core-back/prisma/syntheticSeeder/builders.ts`
- `core-back/prisma/syntheticSeeder/libyanDataCatalog.ts`
- `core-back/prisma/syntheticSeeder/generators/01_adminAndStaffGenerator.ts`
- `core-back/prisma/syntheticSeeder/generators/02_merchantCohortGenerator.ts`
- `core-back/prisma/syntheticSeeder/generators/03_gatewayLifecycleGenerator.ts`
- `core-back/prisma/syntheticSeeder/generators/04_linksAndAttemptsGenerator.ts`
- `core-back/prisma/syntheticSeeder/generators/05_ledgerAndCheckpoints.ts`
- `core-back/prisma/syntheticSeeder/generators/06_reconAndStatements.ts`
- `core-back/prisma/syntheticSeeder/generators/07_disputesCashoutsAdjustments.ts`
- `core-back/prisma/syntheticSeeder/generators/08_amlAndGovernanceQueues.ts`
- `core-back/prisma/syntheticSeeder/generators/09_operatorCasesGenerator.ts`
- `core-back/prisma/syntheticSeeder/sync/bulkDataWriter.ts`
- `core-back/prisma/syntheticSeeder/sync/fakeRailsBulkSyncClient.ts`
- `core-back/prisma/syntheticSeeder/sync/enrichKybDocuments.ts`
- `core-back/prisma/syntheticSeeder/seedRunRegistry.ts`
- `core-back/prisma/syntheticSeeder/verify/postSeedAudit.ts`
- `core-back/prisma/seedFakeRails.ts`
- `fake-rails-back/api/portal/seederSync.ts`
- `deploy/deploy.ts`
- `deploy/lib/hostPlanner.ts`
- `deploy/lib/configSchema.ts`

### Generated appendices

- `project-design/appendices/schema-catalog.md` — models targeted by the seeder
- `project-design/appendices/env-and-config-matrix.md` — synthetic seeder and Fake Rails keys
- `project-design/appendices/test-inventory.md` — seeder test files and skip conditions

## 10. Change history

- 2026-11-03 — Initial canonical extraction. Records the safety gate, profiles, 9 generators, 55 collections, 49-model bulk writer, timeline, Fake Rails sync, KYB enrichment, run registry, post-seed audit, and the unused volumes, template coverage, base64 ciphertexts, authority shape and deploy env mismatch. See `project-design/TRACKER.md`.
- 2026-11-04 — Realism rework: engine-template ledger, lifecycle-valid attempts, profile volumes drive generation, Tripoli time, Vault-encrypted columns, approvals bound to real subjects, namespaced ids, derived route health, read models, full invariant suite and DB/dataset equality in the audit, 35 new DB-free tests. See section 3.13 and `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md` (2026-11-04 corrections).

## Tests and Benchmarks

> Status: `partial` · Last verified: 2026-11-03

## 1. Purpose and scope

This part documents the verification surface of the repository: what test suites exist, what they actually exercise, which suites require PostgreSQL/Redis/browsers/live hosts, which suites skip silently, and which benchmark claims are not backed by executable tests.

It covers:

- `core-back/test/**` — unit, integration, exhaustive, storage-engine, backup-admin, e2e and performance suites;
- `deploy/test/**` and `deploy/backup-daemon/test/**`;
- `admin-back/test/**`, `merchant-back/test/**`, `checkout-back/test/**`, `fake-rails-back/test/**`;
- `admin-front`, `merchant-front` and `checkout-front` unit checks;
- `tests/**` — Playwright E2E and Vitest unit suites;
- `scripts/run-benchmarks.sh` and `scripts/run-exhaustive-suite.sh`.

It does not define product behavior. It records whether the behavior described in the other parts has executable proof, and where that proof is weaker than the historical test plan.

## 2. Design intent (extracted and synthesized from ./design)

The historical master exhaustive test plan targets roughly 38,500 test cases/assertions across 11 suites:

1. schema, models, enums, FKs, triggers and indexes;
2. ledger templates, fee bearers, commission hierarchy and a 10,000-iteration money fuzzer;
3. transform pipeline, selectors, URL compiler and crypto lab;
4. 20 gateways × phases × 24 chaos scenarios;
5. API/RBAC/IDOR/Zod/mTLS matrix;
6. concurrency, slot locks and multi-worker clusters;
7. onboarding, KYB, AML, disputes, reconciliation and go-live gates;
8. 140 edge cases, 24 STRIDE threats and 15 safeguards;
9. PostgreSQL storage engine, replicas, audit/log DBs, backups and restore drills;
10. full-surface Playwright UI, filter, dialog, RTL/LTR and geometry matrix;
11. cross-service E2E journeys, synthetic seeder and deploy engine.

The actual repository is much smaller. It has meaningful suites for most of these areas, but:

- the literal declaration count is about 1,964 across the whole repository (the stale-claims register records 1,778 at its audit baseline), not 38,500;
- the plan's `core-back/test/exhaustive/09-storage-backup/` directory does not exist;
- many exhaustive files are matrix loops inside a small number of `test()` calls, not thousands of literal cases;
- database/Redis suites skip when the services are unavailable, and the exhaustive runner does not fail on those skips;
- the backup daemon restore drill is unit-tested with fake runners, not against a real restore;
- there is no load, TPS, deep-search or restore-throughput benchmark.

## 3. As-built architecture

### 3.1 Test inventory

A working-tree grep of `test(` / `it(` occurrences (excluding `node_modules`) finds about 1,964 literal declarations. The distribution is approximately:

| Workspace | Literal declarations | Test files | Notes |
| :--- | ---: | ---: | :--- |
| `core-back` | 1,193 | 101 | Largest suite; unit, integration, exhaustive, storage, backup-admin and performance |
| `admin-back` | 178 | 7 | mTLS, env isolation, core contract, admin surface, backups |
| `merchant-back` | 89 | 6 | mTLS, forwarding, core contract, KYB/external, env isolation |
| `checkout-back` | 82 | 6 | zero-trust matrix, contract, env isolation, error/logger |
| `deploy` (engine) | 139 | 11 | config, planner, PKI, provisioners, pipeline, rolling deploy, templates, Fake Rails |
| `deploy/backup-daemon` | 75 | 8 | config, cron, engine, catalog, scheduler, server, restore drill, commands |
| `fake-rails-back` | 58 | 4 | API, chaos, crypto, portal/chaos matrix |
| `admin-front`, `merchant-front`, `checkout-front` | 52 | 3 | UI abstraction/content completeness and frontend unit checks |
| `tests` | 97 | 24 | 20 Playwright specs plus 4 Vitest unit files |

The literal count is not an assertion count. A matrix loop can execute hundreds of assertions inside one `test()`, and a `test()` can contain one assertion. Do not use the declaration count as a coverage percentage.

Core-back test groups:

- `core-back/test/*.test.ts` — 39 root-level domain/API tests;
- `core-back/test/engine/**` — 19 engine, transform, crypto, guard, ledger and worker tests;
- `core-back/test/exhaustive/**` — 24 files across 01-schema, 02-ledger, 03-transforms-crypto, 04-rail-engine, 05-api-matrix, 06-concurrency, 07-workflows, 08-security-edge and 10-seeder-and-deploy;
- `core-back/test/storage-engine/**` — 12 files, including 2 performance files;
- `core-back/test/backup-admin/**` — 2 files;
- `core-back/test/e2e/postgres-payment.test.ts` — live payment lifecycle;
- `core-back/test/helpers/**` and `fixtures/**` — fakes and shared harnesses.

### 3.2 What runs and what skips

`core-back/test/setup.ts` sets `NODE_ENV=test`, a default `DATABASE_URL` and dummy KMS/mTLS paths. This makes the suite load without real secrets, but it does not make PostgreSQL or Redis reachable.

Database-dependent suites:

- `core-back/test/storage-engine/helpers/db.ts` probes the test database and Redis at module load (`databaseIsReachable`, `redisIsReachable`).
- `describeDatabase` is `describe` when reachable and `describe.skip` otherwise; `describeRedis` does the same for Redis.
- `core-back/test/exhaustive/_harness.ts` probes `EXHAUSTIVE_DATABASE_URL` / `POSTGRES_TEST_DATABASE_URL` and exports `databaseIsReachable`; several exhaustive files use `databaseIsReachable ? describe : describe.skip`.
- `core-back/test/e2e/postgres-payment.test.ts` uses `test.skipIf(!reachable)` for live payment tests and a few PostgreSQL-invariant tests.
- `core-back/test/storage-engine/*.test.ts` also registers a placeholder `test.skip(... requires the live database)` so the skip is visible.

Redis-dependent suites:

- `core-back/test/storage-engine/cache-velocity.test.ts` skips the live `RedisCacheAdapter` suite without Redis; the memory adapter tests still run.
- `core-back/test/storage-engine/performance/storage-performance.test.ts` skips the live Redis velocity benchmark without Redis.

Without PostgreSQL 18, the schema, ledger, storage-engine integration, backup-admin route and exhaustive DB suites do not prove anything; they skip. Without Redis, the live Lua/velocity path is unproven. The default `bun test` exit code can still be zero because skipped tests are not failures.

Playwright:

- `tests/playwright.config.ts` starts the admin, merchant and checkout preview servers and runs `tests/e2e/{admin,merchant,checkout}` with mocked APIs.
- `tests/playwright.exhaustive.config.ts` starts four preview servers (admin, merchant, checkout, fake-rails) and runs the exhaustive UI specs. It does not start core, the BFFs or Fake Rails; the specs rely on route mocking for API data.
- `tests/playwright.live.config.ts` targets the deployed single-node box over LAN with self-signed TLS and runs `tests/e2e-live/live.spec.ts`.
- `tests/e2e/exhaustive/full-platform-lifecycle-journeys.spec.ts` is skipped unless `E2E_LIVE=1`. The exhaustive runner prints a skip message when the variable is absent.

Deploy and daemon tests are unit-level. The backup daemon suite uses fake command runners and fake file systems; it does not require PostgreSQL, WAL-G, Barman, S3 or a real backup. The deploy suite tests planners/provisioners/config and does not deploy a real multi-host cluster.

### 3.3 Exhaustive runner

`scripts/run-exhaustive-suite.sh` is the master runner:

- forces `--parallel=1` for database suites;
- runs core exhaustive groups 01 through 08, then edge BFF tests, then deploy tests;
- runs `core-back/test/storage-engine` and `test/backup-admin` plus `deploy/backup-daemon` as `T-EX-09`;
- runs the frontend-facing Vitest unit tests in `tests/` and the exhaustive Playwright config as `T-EX-09b`;
- runs `test/exhaustive/10-seeder-and-deploy`;
- runs the cross-service journey only when `E2E_LIVE=1`;
- runs the full core regression last;
- optionally runs `scripts/deploy-localhost.sh` with `--deploy`.

The runner does not preflight PostgreSQL, Redis, browsers or the live stack. It inherits the skip behavior above. A green run therefore means "nothing that ran failed"; it does not mean every suite executed.

### 3.4 Performance suites

`scripts/run-benchmarks.sh`:

- requires `DATABASE_URL`, `POSTGRES_TEST_DATABASE_URL` or `STORAGE_TEST_DATABASE_URL`, exiting with code 2 otherwise;
- runs `bun test test/storage-engine/performance` (or a `BENCHMARK_FILTER`);
- runs the full `test/storage-engine` regression;
- runs `test/backup-admin`;
- prints p50/p95 values; it does not store results or compare against a baseline.

`core-back/test/storage-engine/performance/storage-performance.test.ts` contains:

| Test | Assertion |
| :--- | :--- |
| `compareLsn` 1,000,000 ops | median < 1,000 ms |
| `uuidv7` 100,000 ids | median < 2,000 ms |
| `stableJson` 10,000 rows | median < 2,000 ms |
| memory velocity 10,000 evaluations | median < 2,000 ms |
| read-store routing 100,000 selections | median < 1,000 ms |
| 500 sequential UoWs with outbox + audit | < 10,000 ms |
| 50 concurrent UoWs | p95 < 500 ms |
| 1,000-event outbox drain | < 5,000 ms |
| 16 shard rows load | < 50 ms and no sequential scan |
| 1,000-row audit hash chain append + verify | < 5,000 ms |
| 1,000 live Redis velocity evaluations | < 3,000 ms (skips without Redis) |

`core-back/test/storage-engine/performance/write-path-benchmark.test.ts` adds:

| Test | Assertion |
| :--- | :--- |
| 300 `writeAudit` calls (`audit_log` + `audit_outbox`) | < 10,000 ms |
| shard balance reads for a 16-shard account | p95 < 25 ms |

These are regression ceilings, not capacity benchmarks. They are generous enough for developer hardware and do not model 50M-500M records, 1,000+ sustained TPS, mixed read/write workloads, multi-node contention or p99 latency.

### 3.5 Missing benchmark classes

The design's target scale is 50M-500M financial records, 1,000+ TPS sustained writes and sub-5 ms reads. The repository has no executable proof of any of these:

- no sustained TPS benchmark, load generator or latency percentile beyond p95 in two tests;
- no test database at production scale; the performance tests use a small migrated test database;
- no deep-search benchmark (20 providers, broad query, realistic candidate set, p95, partial rate);
- no restore-drill benchmark (backup fetch + WAL replay + three checks under time);
- no replication lag/read-after-write benchmark with real replicas;
- no multi-node core/worker contention benchmark;
- no audit/log DB throughput benchmark under buffering pressure;
- no Redis outage/failover benchmark.

## 4. Contracts and invariants

- A test that requires PostgreSQL 18 or Redis must skip explicitly when the service is absent. It must not silently pass a mock that claims to prove live behavior.
- The exhaustive runner's success means only that executed tests passed. Reports of coverage must state which suites skipped.
- A live suite must be opt-in (`E2E_LIVE=1`) and must not be counted as part of the default gate.
- Performance tests must assert a finite upper bound and print the measured value so regressions are visible. They must not assert a lower bound that is machine-dependent.
- Benchmark scripts must fail when no database URL is configured rather than quietly running only pure tests.
- Backup/restore tests that use fake runners must be labelled as unit tests, not restore proofs.
- UI tests that mock APIs prove rendering/navigation behavior, not backend integration.
- The canonical verification gate is `bun scripts/project-design/build.ts --check`, plus the workspace typecheck/test/build commands in `AGENTS.md`. A green exhaustive runner is not a substitute for the full gate.
- Skipped database/live suites must be reported explicitly when claiming completion.

## 5. Data / API / config / deployment surface

### Commands

```bash
# Core unit/integration (database suites skip without PostgreSQL)
cd core-back && bun test

# Storage and backup regression
cd core-back && bun test test/storage-engine
cd core-back && bun test test/backup-admin

# Exhaustive runner
./scripts/run-exhaustive-suite.sh
./scripts/run-exhaustive-suite.sh --deploy
E2E_LIVE=1 ./scripts/run-exhaustive-suite.sh

# Storage benchmarks (requires a database URL)
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test \
  ./scripts/run-benchmarks.sh
BENCHMARK_FILTER=write-path ./scripts/run-benchmarks.sh

# Backup daemon
cd deploy/backup-daemon && bun test

# Deploy engine
cd deploy && bun test

# Edge BFFs
cd admin-back && bun test
cd merchant-back && bun test
cd checkout-back && bun test
cd fake-rails-back && bun test

# Frontend unit
cd admin-front && bun run test:unit
cd merchant-front && bun run test:unit
cd checkout-front && bun run build

# UI Playwright (mocked APIs; preview servers)
cd tests && bun run test:unit
cd tests && bunx playwright test -c playwright.config.ts
cd tests && bunx playwright test -c playwright.exhaustive.config.ts

# Live stack
cd tests && bunx playwright test -c playwright.live.config.ts
```

### Environment

| Key | Purpose |
| :--- | :--- |
| `DATABASE_URL` | Default core/test database; benchmark runner requires one of the database URLs |
| `POSTGRES_TEST_DATABASE_URL` | Alternative exhaustive/test database |
| `STORAGE_TEST_DATABASE_URL` | Alternative storage-engine test database |
| `EXHAUSTIVE_DATABASE_URL` | Exhaustive harness database override |
| `STORAGE_TEST_REDIS_URL` | Live Redis suite URL |
| `BENCHMARK_FILTER` | Filters the performance directory |
| `E2E_LIVE` | Enables live cross-service journeys and is checked by the exhaustive runner |
| `PLAYWRIGHT_CHROME_PATH` | Optional Chromium executable |
| `FAKE_RAILS_*` | Required by Fake Rails and synthetic-seeder tests when run live |

### Test assets

- `core-back/test/helpers/**` — fake Prisma, repositories, guards, governance, retention and background-job fakes.
- `core-back/test/exhaustive/_harness.ts` — deterministic xoshiro128** PRNG, schema parser, catalog readers, invariant verifier.
- `core-back/test/storage-engine/helpers/db.ts` — real PostgreSQL/Redis probes, sandbox schemas, cleanup.
- `tests/e2e/fixtures.ts` — Playwright API mocking and shared page fixtures.
- `tests/playwright*.config.ts` — mocked, exhaustive and live configurations.

## 6. Operational usage

- Run the smallest relevant suite first, then the full gate from `AGENTS.md`.
- For a core change, run the focused test file, then `cd core-back && bun test`. If the change touches storage, also run `test/storage-engine`; if it touches backups, run `test/backup-admin`.
- Always state whether PostgreSQL and Redis were available. A skipped suite is not a passing suite.
- Before claiming exhaustive coverage, run `./scripts/run-exhaustive-suite.sh` with a real database and Redis, and report any skipped groups.
- For benchmarks, use a dedicated test database and stable hardware. Compare the printed p50/p95 values with the previous run; do not treat the ceilings as service-level objectives.
- For UI changes, run the relevant Playwright project. The default/exhaustive configs use mocked APIs; only `E2E_LIVE=1` proves cross-service behavior.
- For backup daemon changes, run its unit tests and, separately, a real restore drill on a test host if the change touches recovery, WAL, Barman or scratch handling.
- Do not add a benchmark that asserts a minimum throughput on shared CI hardware without a recorded baseline and a tolerance policy.

## 7. Status and deviations

### Implemented

- Broad core-back unit/integration coverage across engine, ledger, governance, workers, search, storage, backups and API routes.
- Exhaustive schema, ledger, transform, rail, API, concurrency, workflow, security and seeder suites.
- Storage-engine and write-path performance suites with explicit thresholds.
- Backup control client and internal route tests.
- Backup daemon unit tests for config, cron, engine, catalog, scheduler, server and restore drill.
- Deploy engine tests for planning, PKI, provisioners, pipeline, rolling deploy, templates and Fake Rails.
- Edge BFF mTLS/contract/isolation tests.
- Frontend content/abstraction checks and Playwright UI suites.
- A master exhaustive runner and a storage benchmark runner.
- Opt-in live cross-service journeys.

### Partial

- The exhaustive suite has no `09-storage-backup` directory; the runner substitutes existing storage/backup suites.
- Database/Redis suites skip when services are absent, and the runner does not fail on skips.
- Exhaustive file names are stale in places (for example `all-15-templates-matrix.test.ts` while the ledger has 17 `LedgerScenario` values, and `all-20-gateways-24-scenarios.test.ts` while Fake Rails has 13 seeded core gateways). The filenames do not guarantee the current matrix size.
- The Playwright exhaustive matrix runs preview frontends with mocked APIs; it does not exercise the BFF/core/Fake Rails chain.
- The backup daemon restore drill test is a unit test with fake commands, not a live restore proof.
- The performance tests are regression guards, not scale benchmarks.

### Missing / deferred

- The 38,500+ assertion target. The working tree has about 1,964 literal declarations; the stale-claims baseline is 1,778.
- `core-back/test/exhaustive/09-storage-backup/` and its planned ~900 tests.
- A 1,000+ TPS sustained write benchmark.
- A 50M-500M record-scale query benchmark with realistic indexes and data distribution.
- A deep-search benchmark across 20 providers with p95/p99 and partial-rate measurement.
- A live backup/restore benchmark with WAL-G/Barman, real S3, WAL replay and drill verification.
- A multi-node concurrency benchmark for core workers, outbox relay, audit shipper and replica reads.
- An automated check that a database-backed suite actually ran (rather than skipped) in CI.
- Coverage reporting, mutation testing or a test-to-design traceability gate.
- A benchmark result archive for comparing runs over time.

### Known bugs / risks

- Silent skips can make a green run misleading. `describeDatabase`/`describeRedis` and `test.skipIf` are explicit in code, but no runner-level summary fails when a required service is absent. Process gap.
- The exhaustive runner's `T-EX-09` name suggests a dedicated suite that does not exist. Documentation/process drift.
- `test.skip("... requires the live database")` placeholders inflate the skip count and can be mistaken for executed tests. Test hygiene risk.
- Performance thresholds are generous and machine-dependent. A slow CI host can pass a regression that a fast host would have caught, and a fast host can fail a noisy run. Process risk.
- The benchmark script's full storage regression includes live tests that skip without Redis; it does not fail when only the live Redis path was skipped. Process gap.
- Playwright preview servers reuse an existing server (`reuseExistingServer: true`), so a stale local preview can serve old assets. Test hygiene risk.
- Live journeys are opt-in; a default exhaustive run never proves the deployed stack. Process gap.
- Fake Rails/backup daemon tests use fakes for external systems, so protocol/credential mismatches can survive until a live deployment. Test gap.
- Test counts in historical docs (`38,500+`) are not reproducible from the repository and must not be cited as current coverage.

## 8. Verification and tests

The verification surface is the suites listed in section 3. The canonical gate is:

```bash
bun scripts/project-design/build.ts --check
git diff --check
cd core-back && bun run typecheck && bun test
cd deploy && bun run typecheck && bun test
cd deploy/backup-daemon && bun run typecheck && bun test
cd admin-back && bun run typecheck && bun test
cd merchant-back && bun run typecheck && bun test
cd checkout-back && bun run typecheck && bun test
cd admin-front && bun run build
cd merchant-front && bun run build
cd checkout-front && bun run build
```

Database-backed suites require PostgreSQL 18; Redis-backed suites require Redis. The exhaustive runner and benchmark runner do not provision either. The live Playwright suite requires a deployed stack and `E2E_LIVE=1` for the cross-service journey. No build, test or benchmark was run for this documentation change; this part is a code/test inventory, not a verification log.

## 9. Source references

### Old design sections

- `design/05-testing/master_exhaustive_test_plan_for_opencode.md#executive-summary--testing-philosophy`
- `design/05-testing/master_exhaustive_test_plan_for_opencode.md#1-master-test-volume--coverage-matrix-38500-assertions`
- `design/05-testing/master_exhaustive_test_plan_for_opencode.md#10-suite-09-postgresql-18-storage-engine-replicas-auditlog-databases-backups--restore-drills-900-tests`
- `design/05-testing/master_exhaustive_test_plan_for_opencode.md#11-suite-10-full-surface-playwright-ui-filter-dialog-rtlltr--geometry-matrix-across-all-4-portals-2300-tests`
- `design/05-testing/master_exhaustive_test_plan_for_opencode.md#12-suite-11-full-cross-service-end-to-end-journeys-synthetic-seeder--deploy-engine-verification-1200-tests`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#7-step-by-step-opencode-execution-plan`
- `design/00-process/blueprint-management.md#5-documentation-corrections-backlog`

### Code paths

- `core-back/test/setup.ts`
- `core-back/test/helpers/**`
- `core-back/test/exhaustive/_harness.ts`
- `core-back/test/exhaustive/**`
- `core-back/test/storage-engine/**`
- `core-back/test/storage-engine/performance/storage-performance.test.ts`
- `core-back/test/storage-engine/performance/write-path-benchmark.test.ts`
- `core-back/test/backup-admin/**`
- `core-back/test/e2e/postgres-payment.test.ts`
- `deploy/test/**`
- `deploy/backup-daemon/test/**`
- `admin-back/test/**`
- `merchant-back/test/**`
- `checkout-back/test/**`
- `fake-rails-back/test/**`
- `tests/unit/**`
- `tests/e2e/**`
- `tests/e2e-live/live.spec.ts`
- `tests/playwright.config.ts`
- `tests/playwright.exhaustive.config.ts`
- `tests/playwright.live.config.ts`
- `scripts/run-benchmarks.sh`
- `scripts/run-exhaustive-suite.sh`

### Generated appendices

- `project-design/appendices/test-inventory.md` — authoritative generated test file inventory and skip conditions
- `project-design/appendices/env-and-config-matrix.md` — test/benchmark environment keys
- `project-design/appendices/api-route-matrix.md` — API surfaces exercised by the route matrices

## 10. Change history

- 2026-11-03 — Initial canonical extraction. Records the actual test inventory, database/Redis/browser/live skip behavior, the missing exhaustive storage suite, the benchmark scripts and thresholds, and the absent 1,000+ TPS, scale, deep-search and restore benchmarks. See `project-design/TRACKER.md`.

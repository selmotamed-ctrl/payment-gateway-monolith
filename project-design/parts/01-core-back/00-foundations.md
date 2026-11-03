---
id: core.foundations
title: Core Foundations
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - core-back/index.ts
  - core-back/api/index.ts
  - core-back/api/internal/index.ts
  - core-back/lib/error/index.ts
  - core-back/lib/rawBody/index.ts
  - core-back/lib/requestLogger/index.ts
  - core-back/lib/db/connectionConfig.ts
  - core-back/prisma/client/index.ts
  - core-back/prisma/schemaVersion.ts
  - core-back/lib/storageEngine/index.ts
  - core-back/api/middleware/mtlsGuard.ts
  - core-back/api/middleware/authDoubleCheck.ts
design_sources:
  - design/payment_gateway_final_design-v5.md#21-service-roles-boundaries-and-security-constraints
  - design/payment_gateway_final_design-v5.md#22-mutual-tls-mtls-inter-service-transport-architecture
  - design/opencode_technical_delivery_design.md#41-core-back-mtls-server--channel-bound-cn-guard
  - design/opencode_technical_delivery_design.md#28-delivery-run-4--postgresql-18-storage-engine-backups-and-horizontal-scaling
  - design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md#21-core-port-interfaces-core-backlibstorageengineportsts
tests:
  - core-back/test/phase1-mtls-and-schema.test.ts
  - core-back/test/internal-routes.test.ts
  - core-back/test/runtime/raw-body.test.ts
  - core-back/test/runtime/production-adapters.test.ts
  - core-back/test/db-connection-config.test.ts
  - core-back/test/runtime/rotating-refresh-token.test.ts
  - core-back/test/exhaustive/05-api-matrix/mtls-channel-isolation.test.ts
gaps:
  - ensureSchemaVersion is not called at API boot.
  - The public /api router has no routes.
  - The error envelope maps a malformed JSON SyntaxError to HTTP 400 but still uses the generic SERVER_ERROR code.
  - Console request ids and x-request-id are different values.
  - Core startup does not stop workers if the TLS listen fails.
---

# Core Foundations

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
9. **Schema version 8 is required.** The seeders enforce it; the API currently does not at boot.
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
4. Seed (this also checks schema version 8).
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

- `design/payment_gateway_final_design-v5.md` §2.1 service roles, §2.2 mTLS transport, §15? request/response envelope context.
- `design/opencode_technical_delivery_design.md` §4.1 server/CN guard, §28 storage runtime.
- `design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md` §2.1 ports and §2.2 unit of work.
- `design/Dynamic-Payment-Gateway-Management-Design-v2.md` §15 stable error envelope.

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

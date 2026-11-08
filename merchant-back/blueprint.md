<!-- GENERATED FILE. Edit project-design/parts/** instead. Do not hand-edit this file. -->

# merchant-back blueprint

Generated from: `edge.shared`, `edge.merchant`.

## Shared Core Upstream Client

> Status: `implemented` · Last verified: 2026-11-05

## 1. Purpose and scope

This part documents the edge-to-core transport used by `admin-back`, `merchant-back` and `checkout-back`. It owns the mTLS agent, the `CORE_BACK_URLS` node pool, node selection, passive failure detection, retries, request identity headers, the `x-pg-min-lsn` consistency hint, path/channel confinement, core error mapping and the SSE stream proxy.

It does not own authorization or business validation. `core-back` remains authoritative for token verification, authorities, maker-checker, amount resolution, idempotency and channel-bound client-certificate checks. The client only guarantees that a request reaches an allowed core channel over an authenticated TLS 1.3 connection.

The implementation exists as three near-identical copies:

- `admin-back/lib/coreInternalClient.ts`
- `merchant-back/lib/coreInternalClient.ts`
- `checkout-back/lib/coreInternalClient.ts`

Each copy is 761 lines and differs only in `CORE_SERVICE_NAME` and `CORE_CHANNEL_PREFIX`. There is no workspace package, no generated shared module and no single build artifact for the pool.

## 2. Design intent (extracted and synthesized from ./design)

The historical design requires every edge request to cross a private LAN boundary over mutual TLS 1.3. The edge authenticates with a dedicated client certificate whose CN names the service, and `core-back` binds each internal namespace to that CN. Edge services never receive `DATABASE_URL`, `KMS_MASTER_KEY` or another host's client key.

When `core-back` scales horizontally, each edge receives `CORE_BACK_URLS`. The intended behavior is:

- persistent keep-alive connections to every core node;
- least-in-flight selection with round-robin tie-breaking;
- passive removal of a failed node, a cooldown, and a half-open probe after the cooldown;
- retry of idempotent requests on a different node;
- propagation of `x-pg-min-lsn` so LSN-aware reads can wait for a replica that has replayed the caller's write;
- no loss of the edge's identity headers (`x-request-id`, `x-real-client-ip`, `x-client-user-agent`, `x-edge-service`).

The design describes this as enabling rolling core restarts without dropping edge traffic. The implementation provides that only for requests that can be retried and only while at least one other eligible node exists; it does not make an individual single-node core restart seamless.

## 3. As-built architecture

### 3.1 Agent and TLS material

`createCoreAgent()` in each copy builds one `https.Agent` per configured node:

- client certificate from `MTLS_CLIENT_CERT_PATH`;
- client private key from `MTLS_CLIENT_KEY_PATH`;
- CA from `MTLS_CA_CERT_PATH`;
- `minVersion` and `maxVersion` fixed to `TLSv1.3`;
- `rejectUnauthorized: true`;
- keep-alive enabled with 30-second keep-alive delay and `maxSockets: 64`;
- the agent-level timeout is `CORE_REQUEST_TIMEOUT_MS`.

Material is loaded synchronously with `fs.readFileSync` when the agent is created. A missing file becomes `MTLS_MATERIAL_UNAVAILABLE` (HTTP 500) rather than a process crash. Because the agent is cached, replacing certificate files on disk does not affect a running process until the pool is rebuilt. The pool is rebuilt when the configured URL signature changes or when `resetCoreAgent()`/`resetCorePool()` is called by tests.

### 3.2 Pool lifecycle and selection

`ensureNodes()` parses `CORE_BACK_URLS` or falls back to `CORE_BACK_URL`. `parseCoreBackUrls()`:

- splits on commas;
- rejects empty entries;
- requires absolute `https:` URLs;
- de-duplicates by normalized `URL.toString()`;
- preserves the original trimmed strings for requests.

Each node state tracks `url`, `agent`, `healthy`, `inFlight`, `failures`, `lastFailureAt` and `cooldownUntil`.

`eligiblePool(excluded)` implements the cooldown/half-open state:

1. If any excluded node is unhealthy, has zero in-flight requests and its cooldown has elapsed, return only those half-open nodes. This lets one request probe recovery before the node rejoins the general pool.
2. Otherwise return every healthy, non-excluded node.
3. If neither set is non-empty the request fails with `503 CORE_UNAVAILABLE`.

`selectNode()` picks the minimum in-flight count and uses a monotonic round-robin cursor to break ties. The cursor advances on every selection and is reduced modulo the tied set size. A node selected for an attempt is added to the request-local `attempted` set, so a retry never targets the same URL within one logical call.

### 3.3 Failure marking and retries

`markNodeFailure()` increments `failures`, records `lastFailureAt` and sets `cooldownUntil = now + CORE_FAILURE_COOLDOWN_MS` (5 seconds); it only sets `healthy=false` once `failures` reaches `CORE_FAILURE_THRESHOLD` (3 consecutive failures, GAP-021). `markNodeHealthy()` clears all failure state.

Retry eligibility is controlled by `retryAttemptsFor()`:

- idempotent methods default to retrying: `GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`;
- `POST` and `PATCH` do not retry by default;
- `retryIdempotent: true` forces retries; `retryIfUnavailable: true` allows a non-idempotent call to retry;
- `maxAttempts` defaults to 2 and is floored to at least 1; there is no upper cap.

`request()` marks a node failed and retries when the node returns HTTP `502` or `503`, or when the request throws a connection/TLS error. Any other status, including other `5xx` responses, marks the node healthy and is returned to the caller. If every attempt ends in a `502`/`503`, the last response body is returned rather than converted to a local error. If every node has already been attempted and no eligible node remains, the call fails with `CORE_UNAVAILABLE`.

`mapCoreTransportError()` maps transport failures to stable edge errors:

| Transport condition | Edge error |
| :--- | :--- |
| `ETIMEDOUT`, `ESOCKETTIMEDOUT` | `504 CORE_TIMEOUT` |
| `ECONNREFUSED`, `ECONNRESET`, `EPIPE`, `EHOSTUNREACH` | `502 CORE_UNREACHABLE` |
| `ENOTFOUND`, `EAI_AGAIN` | `502 CORE_DNS_FAILURE` |
| TLS error codes | `502 CORE_TLS_ERROR` |
| other failures | `502 CORE_CONNECTION_ERROR` |

### 3.4 Headers and consistency

`buildCoreHeaders()` emits:

- `x-request-id`: the resolved edge request id;
- `x-real-client-ip`: the client IP resolved from the trusted proxy;
- `x-client-user-agent`: the caller's user agent, possibly empty;
- `x-edge-service`: `admin-back`, `merchant-back` or `checkout-back`;
- `accept: application/json`;
- `content-type: application/json` when a JSON body exists, or the supplied raw content type;
- `authorization` when present;
- every caller-supplied header, lowercased;
- `x-pg-min-lsn` when `minLsn` or `consistencyLsn` is non-empty.

`consistencyHeader(lsn)` is a helper that returns the same header or an empty object. The client does not generate an LSN. Callers must obtain one from a write response or another trusted source. `x-pg-min-lsn` is passed through to `core-back`, where `lib/storageEngine` converts it into an `atLeastLsn` read constraint with a 250 ms wait.

### 3.5 Path and channel confinement

`assertCorePath()` rejects:

- empty paths and non-rooted paths;
- protocol-relative paths (`//...`), embedded `://` and backslashes;
- invalid percent escaping;
- decoded `.` or `..` segments;
- any path outside the service's channel prefix.

The prefixes are:

| Service | Prefix |
| :--- | :--- |
| `admin-back` | `/internal/admin` |
| `merchant-back` | `/internal/merchant` |
| `checkout-back` | `/internal/checkout` |

`resolveCoreUrlAgainst()` pins the result to the configured base origin and appends the path to the base pathname. `resolveCoreUrl()` exposes the same behavior for callers and tests. This is a client-side guard only; `core-back` independently enforces the certificate CN with `requireEdgeIdentity()` in `core-back/api/middleware/mtlsGuard.ts`.

### 3.6 SSE streams and fallback behavior

`openCoreStream()` is the streaming counterpart of `request()`:

- sets `accept: text/event-stream` and `cache-control: no-cache`;
- uses the same node selection, retry count, cooldown and attempted-node set;
- increments `inFlight` until the stream ends, closes or errors;
- if a node answers `502`/`503` and another attempt is possible, drains that response into a buffer, records it as `lastStream`, and tries the next node;
- if retries are exhausted, returns `lastStream` or maps the transport error.

`proxyCoreStream()` converts a non-2xx upstream into the normal core HTTP error, then copies the stream to the express response with `cache-control: no-cache, no-transform`, `connection: keep-alive` and `x-accel-buffering: no`. On client disconnect it aborts the upstream request.

There is no true fallback to polling at the edge. Checkout and POS SSE are implemented by the core endpoint polling PostgreSQL on a timer; an established edge stream that breaks is ended, not resumed. The buffered `lastStream` fallback only preserves a failed handshake response body for retry purposes.

## 4. Contracts and invariants

- Every core URL must be an absolute `https:` URL. Plain HTTP is not accepted by the edge configuration schema.
- TLS 1.3 is the only accepted protocol version.
- The client cert CN must match the channel; the client path guard prevents accidental cross-channel calls, and `core-back` prevents forged ones.
- A call never retries against the same URL twice.
- A default retry only applies to idempotent methods.
- A `502`/`503` from any node is interpreted as node unavailability even if generated by application code.
- Request identity headers and `authorization` are forwarded verbatim; the edge does not mint or re-sign tokens.
- The pool does not load-balance SSE streams after establishment; selection happens once per stream open.
- LSN hints are propagated, not validated. A malformed value is passed to core, where the storage layer decides how to handle it.
- The client never receives or uses `DATABASE_URL`, `KMS_MASTER_KEY`, or another service's certificate.

## 5. Data / API / config / deployment surface

### Environment

| Key | Required | Used by | Meaning |
| :--- | :--- | :--- | :--- |
| `CORE_BACK_URL` | yes | all BFFs | First core URL and fallback when `CORE_BACK_URLS` is unset. |
| `CORE_BACK_URLS` | no | all BFFs | Comma-separated core pool. |
| `MTLS_CLIENT_CERT_PATH` | yes | all BFFs | Client certificate. |
| `MTLS_CLIENT_KEY_PATH` | yes | all BFFs | Client private key. |
| `MTLS_CA_CERT_PATH` | yes | all BFFs | Internal CA certificate. |
| `CORE_REQUEST_TIMEOUT_MS` | no | all BFFs | Per-request and agent timeout. Defaults: admin 60000, merchant/checkout 30000. |
| `TRUSTED_PROXY_CIDRS` | no | all BFFs | Peers whose forwarded IP headers are trusted. Default loopback only (`127.0.0.0/8,::1/128`). |
| `POS_STREAM_TIMEOUT_MS` | no | merchant | Stream timeout passed by the POS SSE route (default 900000). |

### Deployment surface

`deploy/lib/hostPlanner.ts` derives `CORE_BACK_URLS` as `https://<core-private-ip>:<service-port>,...` by default. An explicit `CORE_BACK_URLS` in `deploy.env` wins. `deploy/deploy.ts` writes the URL list and `CORE_BACK_URL` (first URL) into every edge `.env`.

The deploy engine installs only the CA and the edge's own client certificate on an edge host. Certificate paths in the generated `.env` are relative (`shared/certs/...`) and are expanded to the release directory by `absoluteEnv()`.

## 6. Operational usage

- When adding a core node, add it to `CORE_NODES` or set `CORE_BACK_URLS`; re-deploy the edge tiers so their process environment changes. The pool itself would notice a changed environment only if the process configuration changes, which requires a restart in a deployed environment.
- When rotating certificates, restart or redeploy the edge processes. Replacing files in place is not sufficient for a running pool.
- Check `/health` on the edge only for process liveness; it does not probe core. Use `deploy/lib/healthVerifier.ts` or a manual mTLS request to check the upstream.
- Use `x-request-id` to correlate an edge failure with core logs. The edge maps core envelopes and preserves `code`, `message`, `details` and `reference`.
- To debug node selection, inspect `CORE_BACK_URLS` in the generated `.env`, the edge logs and the core health endpoint. There are no exported pool metrics or a status endpoint.

## 7. Status and deviations

### Implemented

- Per-node keep-alive TLS 1.3 agents with client certificates and CA verification.
- Least-in-flight selection with round-robin tie-breaking.
- Passive failure marking with a 5-second cooldown.
- Half-open selection: one zero-in-flight request probes an unhealthy node after cooldown.
- Idempotent retries and explicit non-idempotent retry opt-in.
- `x-pg-min-lsn` propagation and header helper.
- Channel path confinement and URL origin pinning.
- Core envelope and transport error mapping.
- SSE stream proxying with pre-establishment retry and buffering of failed handshake responses.

### Partial

- The "shared" client is a copy-paste implementation. Behavior is consistent today, but a change must be applied three times.
- Certificate rotation requires a restart; there is no file watcher or hot reload.
- The SSE fallback preserves a failed response but does not resume an interrupted stream.

### Missing / deferred

- No circuit-breaker metrics, pool introspection, or administrative pool status endpoint.
- No request hedging or per-attempt deadline separate from the overall timeout.
- No automatic retry for `POST`/`PATCH` unless a caller opts in.
- No jitter on cooldown or randomized selection.

### Known bugs / risks

- Treating every upstream `502`/`503` as a node failure can evict a healthy core node that legitimately returned a gateway-style `502`/`503`.
- A half-open node is preferred over healthy nodes while any half-open candidate exists. With several recovering nodes this can concentrate probe traffic rather than spread it.
- `maxAttempts` can exceed the number of nodes; the attempted set then stops the loop early.
- A pool with an empty URL list throws `CORE_UNAVAILABLE`; there is no startup-time rejection of an empty `CORE_BACK_URLS` beyond the fallback to `CORE_BACK_URL`.
- The stream path does not retry after response headers are delivered; a mid-stream core restart is visible to the browser.

### Code gap versus documentation

The historical design describes zero-downtime rolling core restarts. The client enables retry-based continuity for idempotent one-shot calls and for stream establishment, but it does not guarantee zero downtime for non-idempotent calls, established SSE streams, or a single core node. This document records the as-built behavior.

## 8. Verification and tests

```bash
cd admin-back && bun test test/core-internal-client.test.ts test/mtls-client.test.ts test/env-isolation.test.ts
cd merchant-back && bun test test/core-internal-client.test.ts test/mtls-client.test.ts test/env-isolation.test.ts
cd checkout-back && bun test test/core-internal-client.test.ts test/mtls-client.test.ts test/env-isolation.test.ts
```

The suites cover URL parsing, least-in-flight and round-robin selection, cooldown/half-open behavior, retry eligibility, header construction, `x-pg-min-lsn`, path confinement, transport error mapping and env isolation. They do not exercise a real TLS handshake or a live core node; those require a deployed stack.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` section 2.2, mutual TLS and forwarded context.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 6.2, edge-to-core upstream pool.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` section 6.2, the same pool specification.

### Code paths

- `admin-back/lib/coreInternalClient.ts`, `merchant-back/lib/coreInternalClient.ts`, `checkout-back/lib/coreInternalClient.ts`: agent, pool, retries, headers, streams.
- `admin-back/lib/env/index.ts`, `merchant-back/lib/env/index.ts`, `checkout-back/lib/env/index.ts`: URL parsing and required mTLS paths.
- `admin-back/api/forward.ts`, `merchant-back/api/forward.ts`, `checkout-back/api/public/inbound.ts`: call sites and header context.
- `core-back/api/middleware/mtlsGuard.ts`, `core-back/api/index.ts`: CN-to-channel assertion.

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/api-route-matrix.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

## Security hardening (2026-11-05)

Applies to all three copies of the client:
- Only transport/TLS errors and 502/503/504 mark a node unhealthy.
- Header names and values are validated as printable ASCII (`400 CORE_HEADER_INVALID`); edge-owned headers are applied last, and `x-real-client-ip` is always overwritten with the resolved IP.
- PUT/DELETE are HTTP-idempotent and are replayed after send like GET/HEAD/OPTIONS; POST/PATCH still need an `Idempotency-Key`/opt-in, and a connect-phase failure is always retryable.
- SSE streams use their own agent pool (128 sockets) with `MAX_STREAMS_PER_IP` (default 5) and abort upstream on early client disconnect.
- Buffered responses are capped (`CORE_MAX_RESPONSE_BYTES` default 64 MiB, `CORE_TOTAL_DEADLINE_MS` default 300000).
- Admin `x-pg-min-lsn` is validated against `^hex/hex$` (400 otherwise).
- `resolveClientIp` honours forwarded headers only from trusted peers and requires a single valid IP (`x-real-ip` preferred, `x-real-client-ip` fallback).
- A node leaves rotation only after `CORE_FAILURE_THRESHOLD = 3` consecutive failures (GAP-021, RESOLVED 2026-11-05; identical in the admin, merchant and checkout copies). A success resets the count.

## Merchant Edge BFF

> Status: `partial` · Last verified: 2026-11-06

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
- emits no CORS headers unless `CORS_ALLOWED_ORIGINS` is set (no credentials), plus hand-written security headers;
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
- `POST /verify-identity` is retired: core always answers `410 IDENTITY_VERIFICATION_RETIRED`.
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
- List queries accept any positive `page` (no arbitrary upper bound) and cap `pageSize` at 200, so deep pages on large merchant datasets are forwarded rather than rejected with `400 VALIDATION_FAILED`; deep offset pages remain an offset-pagination cost (GAP-006).

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
| `TRUSTED_PROXY_CIDRS` | loopback only (`127.0.0.0/8,::1/128`) | Trusted forwarded-IP peers. |
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
- (Superseded) `resolveClientIp` now honours forwarded headers only from trusted peers, requires a single valid IP and prefers `x-real-ip` over `x-real-client-ip`; the edge always overwrites `x-real-client-ip` towards core. Historical note: `x-real-client-ip` was preferred over `x-real-ip` in `merchant-back/lib/net/index.ts`. When the backend is loopback-bound this is safe; if it is ever exposed and a direct peer is inside `TRUSTED_PROXY_CIDRS`, the peer can spoof its client IP.
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
- 2026-11-06: removed the arbitrary `page <= 10000` cap from `zListQuery` and the five list query schemas that duplicated it (`payments`, `links`, `cashouts`, `disputes`, wallet statements); `pageSize` stays capped at 200. Regression tests forward page 23397 on all six merchant list routes.

## 11. Cross-node POS updates (2026-11-03)

The core POS SSE stream now subscribes to the Redis-backed `realtime:attempt` and `realtime:pos` topics. A cashier request processed by a merchant-back/core pair on one host reaches a paired screen whose stream is held by a merchant-back node on the other host. The existing 3-second database poll remains as a fallback.

## Security hardening (2026-11-05)

- **Token creation.** Malformed CIDRs and ranges broader than /8 (IPv4) or /32 (IPv6) are rejected. Scopes are lowercase `resource:action`, unique, at most `TOKEN_MAX_SCOPES` (20); core restricts them further to `link:write`, `link:read`, `payment:read`. `expiresAt` must be a future ISO date within `TOKEN_MAX_TTL_DAYS` (365); default `TOKEN_DEFAULT_TTL_DAYS` (90). `pg_live_` tokens must be `pg_live_` plus 43 base64url characters.
- **External limiter** keys on token hash plus IP.
- **Uploads** require a bearer token and Content-Length (`411`) and are size-checked (`413`) before buffering; `UPLOAD_RATE_LIMIT_MAX` applies. Website fields accept http(s) only.
- **Cash-out create** keeps and forwards `idempotencyKey` (body or `Idempotency-Key` header) to core.
- **Auth** POSTs have a per-account limiter in addition to the per-IP limiter. `/verify-identity` is retired (410).
- Redaction and `redactUrl` cover PII keys and path tokens.

## Gap resolutions (2026-11-05)

- **Logout and session cookie (GAP-019, RESOLVED).** `POST /api/v1/merchant/auth/logout` forwards to core `POST /internal/merchant/auth/logout` (session `jti` revocation) and clears the cookie. `SESSION_COOKIE_MODE` (default `false`) and `SESSION_COOKIE_SECURE` (default `true`) are validated in `merchant-back/lib/env`; in cookie mode the token is set as the `pg_merchant_session` HttpOnly, `SameSite=Strict` cookie (path `/api/v1/merchant`, 12 h), the body carries `sessionCookie: true`, and cookie-authenticated writes require `x-pg-csrf: 1`. The cookie is ignored when the mode is off; login/MFA are exempt from the CSRF conversion so a stale cookie cannot block sign-in. The mode is off by default.
- **Audience and breaker (GAP-020, GAP-021).** Merchant sessions carry `aud=payment-gateway-merchant`; a session minted for another channel is refused by core (`401 SESSION_AUDIENCE_INVALID`). The upstream client uses `CORE_FAILURE_THRESHOLD = 3`.

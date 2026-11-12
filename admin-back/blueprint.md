<!-- GENERATED FILE. Edit project-design/parts/** instead. Do not hand-edit this file. -->

# admin-back blueprint

Generated from: `edge.shared`, `edge.admin`.

## Shared Core Upstream Client

> Status: `implemented` · Last verified: 2026-11-08

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

- idempotent methods default to retrying: `GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`. A retry after the request reached the wire is a separate question (below): `PUT` and `DELETE` are only retried when the connection failed before anything was sent;
- `POST` and `PATCH` do not retry by default;
- `retryIdempotent: true` forces retries; `retryIfUnavailable: true` allows a non-idempotent call to retry;
- `maxAttempts` defaults to 2 and is floored to at least 1; there is no upper cap.

`request()` marks a node failed only when the request throws a connection/TLS/timeout error (`isNodeFailure`). Every complete HTTP response, whatever its status, marks the node healthy. A `502`/`503`/`504` response is retried on another node only when the request may be replayed after it was sent: `GET`, `HEAD` and `OPTIONS`, a request carrying an `Idempotency-Key`, or an explicit `retryIdempotent`/`retryIfUnavailable` opt-in. `PUT` and `DELETE` are deliberately NOT replay-safe after send, because core's `PUT` routes create a new version per call (`PUT /settings` writes a new `platform_settings` version and an audit row on every call), so a replay could double-apply; they are still retried on a connect-phase failure, when nothing was sent. If every attempt ends in a `502`/`503`/`504`, the last response body is returned rather than converted to a local error. If every node has already been attempted and no eligible node remains, the call fails with `CORE_UNAVAILABLE`.

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
- if a node answers `502`/`503`/`504` and another attempt is possible, drains that response into a buffer, records it as `lastStream`, and tries the next node (the answer does not count against the node's health);
- if retries are exhausted, returns `lastStream` or maps the transport error.

`proxyCoreStream()` converts a non-2xx upstream into the normal core HTTP error, then copies the stream to the express response with `cache-control: no-cache, no-transform`, `connection: keep-alive` and `x-accel-buffering: no`. On client disconnect it aborts the upstream request.

There is no true fallback to polling at the edge. Checkout and POS SSE are implemented by the core endpoint polling PostgreSQL on a timer; an established edge stream that breaks is ended, not resumed. The buffered `lastStream` fallback only preserves a failed handshake response body for retry purposes.

## 4. Contracts and invariants

- Every core URL must be an absolute `https:` URL. Plain HTTP is not accepted by the edge configuration schema.
- TLS 1.3 is the only accepted protocol version.
- The client cert CN must match the channel; the client path guard prevents accidental cross-channel calls, and `core-back` prevents forged ones.
- A call never retries against the same URL twice.
- A default retry only applies to idempotent methods.
- A `502`/`503`/`504` answer can trigger a failover for a replay-safe request, but it is never interpreted as node failure, even when a proxy generated it; only transport errors are.
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

- A proxy in front of core that answers `502` for a dead backend is no longer detected as a node failure (only transport errors are); with a single core behind such a proxy every request still reaches it. Distinguishing a proxy-generated 5xx from core's own envelope (a JSON body with `code`) would restore that detection if it is ever needed.
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
- Only transport/TLS errors mark a node unhealthy (HTTP 502/503/504 answers do not, since 2026-11-08).
- Framing and hop-by-hop headers are never taken from a caller (`content-length`, `transfer-encoding`, `content-encoding`, `connection`, `keep-alive`, `upgrade`, `te`, `trailer`, `host`, `expect`; since 2026-11-08): `buildCoreHeaders` and `request()` strip them and `request()` sets `content-length` from the body it actually writes. A forwarded length that described a different (for example decompressed) body would otherwise desync the pooled keep-alive connection to core (request smuggling; confirmed for the checkout inbound route, latent in the other two edges).
- Header names and values are validated as printable ASCII (`400 CORE_HEADER_INVALID`); edge-owned headers are applied last, and `x-real-client-ip` is always overwritten with the resolved IP.
- Only GET/HEAD/OPTIONS (and requests with an `Idempotency-Key` or an explicit opt-in) are replayed after send. PUT/DELETE are retried only on a connect-phase failure (nothing was sent); POST/PATCH likewise need an `Idempotency-Key`/opt-in. This reverses the 2026-11-05 rule that replayed PUT/DELETE.
- SSE streams use their own agent pool (128 sockets) with `MAX_STREAMS_PER_IP` (default 5) and abort upstream on early client disconnect.
- Buffered responses are capped (`CORE_MAX_RESPONSE_BYTES` default 64 MiB, `CORE_TOTAL_DEADLINE_MS` default 300000).
- Admin `x-pg-min-lsn` is validated against `^hex/hex$` (400 otherwise).
- `resolveClientIp` honours forwarded headers only from trusted peers and requires a single valid IP (`x-real-ip` preferred, `x-real-client-ip` fallback).
- A node leaves rotation only after `CORE_FAILURE_THRESHOLD = 3` consecutive failures (GAP-021, RESOLVED 2026-11-05; identical in the admin, merchant and checkout copies). A success resets the count.

## Admin Edge BFF

> Status: `partial` · Last verified: 2026-11-10

## 1. Purpose and scope

`admin-back` is the private-LAN API edge for the back office. It terminates browser requests from `admin-front`, enforces the LAN boundary and coarse-grained authority hints, validates and translates the public admin vocabulary into the canonical `core-back` contract, and forwards every operation over mTLS to `/internal/admin/*`.

It owns no database connection, no Prisma client, no `DATABASE_URL`, no `KMS_MASTER_KEY` and no business authority. The service is a stateless Express 5 application built for Bun.

Scope boundaries:

- Owns the admin LAN ingress, LAN CIDR check, rate limiting, request logging, upload buffering, schema validation and body mapping.
- Does not own JWT signature verification, session revocation, MFA state, IP allowlists for individual users, maker-checker enforcement or money movement.
- Does not own the backup daemon; it proxies backup control routes to `core-back`, which talks to `pg-backup-daemon` over mTLS.

## 2. Design intent (extracted and synthesized from ./design)

The historical design places the admin portal on a private LAN, behind a non-forwarded reverse proxy on port 8443. The admin backend binds to loopback. Every request is forwarded to `core-back` over TLS 1.3 using a client certificate with `CN=admin-back`; the core rejects that certificate on the merchant or checkout channels.

The design describes the edge as validating input with shared Zod schemas, enforcing LAN rate limits and admin session/MFA headers, and leaving session verification, revocation, MFA and authority checks to `core-back`. It also requires maker-checker for sensitive actions, with the checker different from the maker, enforced by the core.

The admin surface is intentionally broad: users, join requests and KYB, merchants, approvals, AML, gateway catalog and wizard, rails/routes, operations, reconciliation, finance, settings, audit logs and backup controls.

## 3. As-built architecture

### 3.1 Process and listener

`admin-back/index.ts` creates an Express app with:

- `x-powered-by` disabled;
- `trust proxy` disabled at the Express layer (`app.set("trust proxy", false)`);
- CORS: no headers unless `CORS_ALLOWED_ORIGINS` is set (credentials disabled), plus hand-written security headers (nosniff, no-referrer, X-Frame-Options, `frame-ancestors 'none'`, CORP, default no-store);
- request logging middleware;
- an unauthenticated `GET /health` returning `{ status: "ok", service: "admin-back", uptime }`;
- JSON and URL-encoded body parsers limited by `MAX_JSON_BODY_BYTES`;
- the admin router mounted at `/api/v1/admin`, wrapped by `enforceLanAccess`;
- a JSON 404 handler and the shared error handler.

The listener binds to `ADMIN_BIND_HOST` (default `127.0.0.1`). The deploy engine writes `ADMIN_BIND_HOST=127.0.0.1`, so only the co-located Nginx vhost reaches the process. The admin Nginx vhost is exposed on `ADMIN_NGINX_LAN_PORT` (default 8443) and restricted to `LAN_ALLOWED_CIDRS`.

### 3.2 Middleware and guards

| Layer | Behavior |
| :--- | :--- |
| `enforceLanAccess` | Resolves the client IP from `x-real-ip`/`x-real-client-ip` only when the immediate peer is loopback or in `TRUSTED_PROXY_CIDRS`, then requires the result to be inside `ADMIN_LAN_CIDRS`. Failure is `403 ADMIN_LAN_ONLY`. Applied to the entire `/api/v1/admin` router, including `/auth`. |
| `adminLimiter` | 600 requests per 60 seconds by default (`ADMIN_RATE_LIMIT_MAX`), applied to the protected router. Returns `429 RATE_LIMITED`. |
| `authLimiter` | 10 requests per fixed 15 minutes by default (`AUTH_RATE_LIMIT_MAX`), applied to `/auth`. The `AUTH_RATE_LIMIT_WINDOW_MS` setting is defined but not used here. |
| `requireSession` | Rejects a missing `Authorization` header with `401 AUTH_REQUIRED`. It does not parse or verify the header. |
| `requireAuthorities` | Reads `role`, `roles`, `authorities` and `authorities_map` from the base64url JWT payload, then checks that at least one requested authority or role is present. `COMPLIANCE` and `MLRO` are aliases for `aml:read`/`aml:write`. |
| Search limiter | `POST /search` has its own 120-requests-per-minute limiter keyed by a SHA-256 hash of the bearer token or IP. |
| Upload middleware | Multer memory storage with `MAX_UPLOAD_BYTES`; the reconciliation route validates the detected MIME type and magic bytes through `assertAllowedUpload`, while the join-request KYB route forwards the raw file without that check. |

`extractAuthorityHints()` does not verify the token signature and does not check `exp` or `nbf`. It rejects a token only when a present `typ` is not `session`, a present `iss` is not `payment-gateway-core`, or a present `aud` does not include `payment-gateway-admin` (the admin channel audience; the former `payment-gateway-edge` is no longer accepted, GAP-020). A caller can therefore craft a token that satisfies the edge's AML or backup gate; `core-back` will still reject it. This is documented as advisory gating, not authentication.

`ADMIN_AUTHORITY_HINTS` is an optional RESTRICTION list (default empty = no restriction). When set, a guard whose required authorities do not intersect the list denies the request; it can only narrow access, never widen it. A stale old-style value copied from an earlier README can therefore deny routes, so upgrade configs should leave it unset unless intentionally restricting.

### 3.3 Forwarding behavior

`admin-back/api/forward.ts` implements `coreForward()`:

1. Reads the `Authorization` header and validates route params and query with Zod where configured.
2. Skips the body for `GET`/`HEAD`; otherwise validates the public body with the route schema.
3. Applies `bodyFrom()` to translate the public body into the canonical core body.
4. Calls `callCoreResponse()` over the shared mTLS pool with:
   - the route method and path;
   - the translated body;
   - scalar query parameters only;
   - optional fixed headers;
   - the edge request id, resolved client IP, user agent and bearer token.
5. Sends the core response body with the declared status, or the core status when `relayStatus: true`.

Routes that can become asynchronous or return a non-200 outcome use `relayStatus: true` (merchant suspension/reinstatement/close, approvals, join-request decisions, gateway submit-approval, AML proposals, backup trigger/drill/policy, reconciliation and operator actions). Creation routes generally declare 201 explicitly. `splitBodyFrom` exists in the forwarder but is not used by the current admin routers.

`forwardUpload()` streams a multipart file to the core as raw bytes with `x-upload-filename`, `x-upload-content-type`, `x-upload-sha256`, `x-upload-size` and base64url `x-upload-metadata`. The reconciliation route uses this path with a longer `RECONCILIATION_TIMEOUT_MS`.

### 3.4 Route map

All routes are prefixed with `/api/v1/admin`. The auth routes are inside the LAN guard but outside `requireSession`.

| Area | Routes |
| :--- | :--- |
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/mfa` |
| Search | `POST /search` |
| Academy | `GET, PUT /academy/progress`, `GET /academy/exams/:examId/eligibility`, `POST /academy/exams/:examId/start`, `POST /academy/exams/:examId/submit`, `GET /academy/team` (`SECURITY_ADMIN`); 60 requests/minute per user |
| Users | `GET, POST, PATCH /users`, `GET /users/:id`, `PATCH /users/:id`, `GET /users/export`, `GET /users/summary`, `GET /users/summary/export` |
| Join requests | `GET /join-requests`, `GET /join-requests/:id`, `POST /join-requests/admin-assisted`, `PATCH /join-requests/:id/profile`, `POST /join-requests/:id/beneficial-owners`, `PATCH, DELETE /join-requests/:id/beneficial-owners/:ownerId`, `POST, DELETE /join-requests/:id/kyb-documents[/:docId]`, `POST /join-requests/:id/submit`, `POST /join-requests/:id/withdraw`, `PATCH /join-requests/:id/checklist`, `POST /join-requests/:id/screening/retry`, `POST /join-requests/:id/assign`, `POST /join-requests/:id/request-info`, `POST /join-requests/:id/decide` |
| KYB documents | `GET /kyb-documents`, `GET /kyb-documents/:id`, `GET /kyb-documents/:id/content`, `POST /kyb-documents/:id/review`, `POST /kyb-documents/:id/request-replacement`, `POST /kyb-documents/:id/request-revalidation`, plus export/summary variants |
| Merchants | `GET /merchants`, `GET /merchants/:id`, `GET /merchants/:id/stats`, `PATCH /merchants/:id/descriptive`, `POST /merchants/:id/suspend`, `POST /merchants/:id/reinstate`, `POST /merchants/:id/close`, `GET /merchants/:id/pending-changes`, `POST /merchants/:id/pending-changes/:approvalId/withdraw`, `POST /merchants/:id/propose-edit`, `GET /merchants/:id/detail-changes`, plus export/summary variants |
| Approvals | `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve`, `POST /approvals/:id/reject`, `POST /approvals/bulk-reject`, plus export/summary variants |
| AML (confidential) | `GET /aml/screenings`, `GET /aml/screenings/:id`, `POST /aml/matches/:id/disposition`, `GET /aml/cases`, `GET /aml/cases/:id`, `POST /aml/cases/:id/propose`, `GET, POST /aml/rules`, `GET, POST /aml/reporting-rules`, `GET, POST /aml/reports`, `GET /aml/reports/:id/payload`, `PATCH /aml/reports/:id/payload`, `POST /aml/reports/:id/generate-output`, `GET /aml/reports/:id/outputs/:format/download`, `POST /aml/reports/:id/request-approval`, `POST /aml/reports/:id/submit`, `POST /aml/reports/:id/acknowledge`, `GET, POST /aml/report-schemas`, `GET, PUT /aml/report-schemas/:id`, `GET /aml/report-schemas/:id/definition`, `GET /aml/report-context-catalog`, `POST /aml/report-schemas/:id/compile`, `POST /aml/report-schemas/:id/validate`, `POST /aml/report-schemas/:id/simulate`, `POST /aml/report-schemas/:id/clone`, `POST /aml/report-schemas/:id/sample-context`, `POST /aml/report-schemas/:id/code-lists/preview`, `GET, PUT /aml/report-schemas/:id/template`, `POST /aml/report-schemas/:id/workbook/preview`, `POST /aml/report-schemas/:id/promote`, `GET, PUT /aml/report-schema-defaults`, `GET, PUT /aml/reporting-rules/:id/schema-bindings`, `GET /aml/reports/:id/requirements`, plus export/summary variants |
| Gateways | `GET /gateways/ai-transcript`, `POST /gateways/spec-verify`, `POST /gateways/spec-import`, `GET, POST /gateways`, `GET, PATCH /gateways/:id`, `POST /gateways/:id/rollback`, `GET, POST /gateways/:id/versions`, plus export/summary variants |
| Gateway versions | `POST /gateway-versions/:vid/clone`, `GET /gateway-versions/:vid`, `PUT /gateway-versions/:vid/environments`, `/auth`, `/settings`, `/crypto-profiles`, `/flows`, `/channels`, `/status-rules`, `/error-maps`, `POST /gateway-versions/:vid/dry-run`, `/run-suite`, `/submit-approval` |
| Credential sets | `GET, POST /credential-sets`, `GET, PUT /credential-sets/:id`, `POST /credential-sets/:id/verify`, `POST /credential-sets/:id/revoke` |
| Rails and routes | `GET, POST /rails`, `GET, PATCH /rails/:id`, `PUT /rails/:id/fields`, `GET, POST /routes`, `GET, PATCH /routes/:id`, `POST /routes/:id/state`, plus export/summary variants |
| Assets | `GET, POST /assets`, `GET /assets/:id` |
| Operations | `GET /gateway-inquiries`, `GET /gateway-inquiries/:id`, `POST /gateway-inquiries/:id/cancel`, `/run-now`, `/retry`, `GET /operator-cases`, `GET, PATCH /operator-cases/:id`, `POST /operator-cases/:id/resolve`, `POST /operator-cases/bulk-inquire`, `/bulk-assign`, `/bulk-state`, `POST /attempts/:id/inquire`, `GET /attempts/:id`, plus export/summary variants |
| Reconciliation | `GET, POST /reconciliation/sources`, `PATCH /reconciliation/sources/:id`, `POST /reconciliation/upload`, `GET /reconciliation/runs`, `GET /reconciliation/runs/:id`, `GET /reconciliation/runs/:id/export`, `GET /reconciliation/runs/summary`, `GET /reconciliation/runs/summary/export` |
| Finance | `GET, POST /disputes`, `GET /disputes/:id`, `POST /disputes/:id/evidence`, `GET, POST /adjustments`, `GET /adjustments/:id`, `GET /cashouts`, `GET /cashouts/:id`, `POST /cashouts/:id/process`, `GET, POST /commission-profiles`, `POST /commission-profiles/:id/expire`, `GET /commission-profiles/:id/history`, `GET, POST /velocity-rules`, `POST /velocity-rules/:id/deactivate`, `GET /velocity-rules/:id/history`, `GET /finance/profitability`, `GET /finance/liquidity`, `GET /finance/invariant-check`, plus export/summary variants |
| Settings | `GET, PUT /settings`, `POST /settings/restore-preview`, `POST /settings/restore-apply`, `GET /settings/export`, `GET /settings/summary`, `GET /settings/summary/export`, `GET, PUT /settings/checkout-support`, `GET /settings/checkout-support/history`, `GET /settings/checkout-support/summary`, `GET /settings/checkout-support/summary/export` |
| Options | `GET /options/:kind` |
| Stats | `GET /stats/overview`, `GET /stats/recent-activity`, `GET /stats/export`, `POST /stats/export-audit`, plus export variants |
| Audit logs | `GET /audit-logs`, `GET /audit-logs/:id`, `GET /audit-logs/export`, `GET /audit-logs/summary`, `GET /audit-logs/summary/export` |
| System backups | `GET /system/backups/overview`, `GET /system/backups/catalog`, `POST /system/backups/trigger`, `POST /system/backups/drill`, `PUT /system/backups/policy` |

The AML router applies `requireAuthorities("COMPLIANCE", "MLRO", "aml:read", "aml:write")` to every AML route. The backup router applies `security:read`/`gateway:read` to the overview and catalog and `security:write` to trigger, drill and policy. The remaining routes rely on `requireSession` plus core-side authority enforcement.

## 4. Contracts and invariants

- The admin API is reachable only from `ADMIN_LAN_CIDRS`; the deploy engine aligns the UFW admin rule with `LAN_ALLOWED_CIDRS`.
- Every forwarded path must stay under `/internal/admin`; the shared client enforces this and core re-checks the client CN.
- The edge never accepts a core path from the request; route modules construct the path.
- The edge never performs money arithmetic; amount and currency fields are validated and forwarded for core to re-check.
- Sensitive mutations are not approved at the edge. Maker-checker, base-version checks, state transitions and audit writes happen in `core-back`.
- The backup policy route creates a maker-checker approval when `approvalRequestId` is absent; a checker must be a different user from the maker.
- The admin edge never receives database credentials, the KMS key or another host's certificate.
- Error envelopes from core (`code`, `message`, `details`, `reference`) are preserved by `mapCoreHttpError()`.

## 5. Data / API / config / deployment surface

### Environment

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | Runtime mode. |
| `PORT` | `4101` | Backend listener port. |
| `ADMIN_BIND_HOST` | `127.0.0.1` | Backend bind address. |
| `CORE_BACK_URL` | required | First core node, absolute HTTPS. |
| `CORE_BACK_URLS` | optional | Core pool. |
| `MTLS_CLIENT_CERT_PATH`, `MTLS_CLIENT_KEY_PATH`, `MTLS_CA_CERT_PATH` | required | Edge mTLS material. |
| `CORE_REQUEST_TIMEOUT_MS` | `60000` | Core request timeout. |
| `TRUSTED_PROXY_CIDRS` | loopback only (`127.0.0.0/8,::1/128`; deploy sets `127.0.0.1/32,::1/128`) | Peers whose forwarded IP headers are trusted. |
| `ADMIN_LAN_CIDRS` | loopback plus RFC1918 ranges | Allowed admin clients. |
| `ADMIN_AUTHORITY_HINTS` | empty (no restriction) | Optional restriction list; when set, a guard must match one of its entries. |
| `MAX_JSON_BODY_BYTES` | `4194304` | JSON limit. |
| `MAX_UPLOAD_BYTES` | `20971520` | Multipart limit. |
| `UPLOAD_ALLOWED_MIME` | `text/csv,application/vnd.ms-excel,application/json` | Reconciliation upload MIME list. |
| `ADMIN_RATE_LIMIT_MAX`, `ADMIN_RATE_LIMIT_WINDOW_MS` | `600`, `60000` | Protected router limiter. |
| `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS` | `10`, `900000` | Login/MFA limiter; the window key is not read by the limiter. |
| `RECONCILIATION_TIMEOUT_MS` | `120000` | Reconciliation upload forwarding timeout. |

### Generated deployment environment

`deploy/lib/hostPlanner.ts` writes `PORT`, `ADMIN_BIND_HOST=127.0.0.1`, `ADMIN_LAN_CIDRS`, the core URL list and mTLS paths. It never writes `DATABASE_URL` or `KMS_MASTER_KEY`.

## 6. Operational usage

```bash
cd admin-back
bun install
bun run start
bun run dev
bun test
bun run typecheck
```

- Open the portal through the LAN vhost (`https://admin.internal:8443` or the configured LAN port), not directly against `:4101`.
- `GET /health` is unauthenticated and does not check core; use the deployment verifier for an upstream mTLS check.
- To diagnose a `403 ADMIN_LAN_ONLY`, inspect `ADMIN_LAN_CIDRS` and the reverse proxy's `X-Real-IP` behavior. The admin resolver prefers `x-real-ip`, then `x-real-client-ip`, and only when the immediate peer is trusted.
- To diagnose `EDGE_AUTHORITY_DENIED`, the edge did not find a configured role/authority in the token payload. This is intentional fail-closed behavior for AML and backup routes; core may still accept the token.
- Backup policy changes normally return `202 PENDING_REVIEW`; a second user supplies the `approvalRequestId` to execute.

## 7. Status and deviations

### Implemented

- LAN-only ingress with CIDR guard and UFW alignment.
- Full admin forwarding surface with public-to-core body mappers.
- mTLS pool, channel confinement, retries and LSN header propagation through the shared client.
- AML and backup edge-level authority hints.
- Multipart upload forwarding with hashes and metadata.
- Rate limiting for auth, protected routes and deep search.
- Relay of asynchronous core statuses for approvals, merchant lifecycle, AML proposals and backup controls.

### Partial

- Edge authority gating is advisory and based on unsigned claims; it cannot be treated as authentication.
- Only AML and backup routes have edge-level authority checks. Every other protected route depends on core.
- The login limiter ignores `AUTH_RATE_LIMIT_WINDOW_MS`.

### Missing / deferred

- No edge-side JWT verification, revocation cache, MFA-state check or per-user IP allowlist.
- No OpenAPI/route manifest generated from the routers.
- No dedicated pool status or metrics endpoint.
- No admin-initiated session refresh endpoint at the edge.

### Known bugs / risks

- A forged token with acceptable `typ`/`iss`/`aud` can pass edge AML or backup gating. Core rejects it, but the edge response differs from an outright authentication failure and may leak route existence.
- Core verifies the session signature, expiry, user status and authorities, but it does not enforce per-call MFA state, session revocation or a per-user admin IP allowlist. The edge does not add those checks.
- CORS is off unless `CORS_ALLOWED_ORIGINS` is set (cross-origin dev frontends need it). The LAN guard remains a control; do not expose `:8443` outside the LAN.
- `app.set("trust proxy", false)` means Express's `req.ip` is the socket peer. The LAN guard implements its own trusted-proxy logic; the two can disagree if a new proxy is introduced.
- The join-request KYB upload forwards the client-declared MIME type without magic-byte validation. Core must treat the file as untrusted.
- Protected admin routes accept any non-empty bearer string; core is the only authentication authority.

## 8. Verification and tests

```bash
cd admin-back && bun run typecheck && bun test
```

Key suites:

- `admin-back/test/admin-surface.test.ts`: route surface and forwarding behavior.
- `admin-back/test/core-contract.test.ts`: public-to-core mappers and strict core schemas.
- `admin-back/test/core-internal-client.test.ts`: pool, retry, headers and LSN.
- `admin-back/test/mtls-client.test.ts`: channel confinement and error mapping.
- `admin-back/test/backups.test.ts`: backup proxy schema and authority behavior.
- `admin-back/test/academy-progress.test.ts`: academy proxy validation, per-user rate limit and team-view role gate.
- `admin-back/test/env-isolation.test.ts`: edge environment has no database/KMS secrets.

The tests use a local HTTPS/HTTP stub and do not require PostgreSQL or Redis. A live mTLS check is part of `deploy/lib/healthVerifier.ts`.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` section 2.1, service boundaries.
- `design/01-platform-architecture/payment_gateway_final_design-v5.md` section 16.3, admin API surface.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 5, firewall policy.

### Code paths

- `admin-back/index.ts`: app composition and LAN mount.
- `admin-back/api/middleware/lanGuard.ts`: LAN CIDR enforcement.
- `admin-back/api/middleware/authorityGuard.ts`: claim decoding and authority hints.
- `admin-back/api/forward.ts`: forwarding contract.
- `admin-back/api/protected/**`: route surface and mappers.
- `admin-back/api/upload.ts`: multipart forwarding.
- `admin-back/lib/coreInternalClient.ts`: shared pool.
- `admin-back/lib/env/index.ts`: environment contract.

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.
- 2026-11-06: removed the arbitrary `page <= 10000` cap from `zListQuery`; the admin journal-entries last-page jump (page 23397 on the stress dataset) was rejected with `400 VALIDATION_FAILED` before reaching core. `pageSize` stays capped at 200. Regression test added to `admin-back/test/admin-ui-completion.test.ts`.

## Security hardening (2026-11-05)

- **authorityGuard.** Rejects `alg: none` and non-HS256 tokens and bad signature segment shape; requires `typ`, `iss`, `aud` and `exp` and enforces `exp`/`nbf`. `ADMIN_AUTHORITY_HINTS` (default empty) can only restrict, never skip a guard. Matching is case-sensitive. `requireSession` returns `401 AUTH_INVALID` for tokens that are not live core-shaped sessions. `*` is honoured at the edge; core re-verifies (the edge cannot verify signatures because the key lives in core).
- **Deny-by-default any-of authority lists** on: users, join-requests, kyb-documents, merchants suspend/close, approvals, gateways, gateway-versions, rails, routes, assets, credential-sets, reconciliation, settings (restore-preview is a read, restore-apply a write), audit-logs, operator-cases, gateway-inquiries, attempts, disputes, adjustments, cashouts, commission-profiles, velocity-rules, finance and system/backups. Search, academy, options and stats are left to core.
- **Backups.** Policy cron is validated (5 fields; minimum gaps full 60, delta 5, drill 60 minutes) and `alertLagSeconds` must be >= 1. Retention is NOT floored at the edge: every policy change is a maker-checker proposal, and the maker must be able to propose a low-retention policy for the checker to review. Trigger/drill are rate-limited by `BACKUP_JOB_RATE_LIMIT_MAX` (6 per 10 minutes); an `Idempotency-Key` is relayed when supplied, but core has no replay store yet, so it is not an idempotency guarantee.
- **KYB uploads.** Upload runs `assertAllowedUpload` (png/jpeg/pdf) plus zod validation; the content route forces `Content-Disposition: attachment`, a CSP sandbox and a Content-Type allow-list. `logoUrl` must be http(s).
- **Limiters** key on the resolved client IP plus a per-account limiter on login/MFA. Admin `x-pg-min-lsn` is validated (400).
- **Logout and session cookie (GAP-019, RESOLVED 2026-11-05).** `POST /api/v1/admin/auth/logout` (public router, `logoutHandler`) forwards to core `POST /internal/admin/auth/logout`, which revokes the session `jti`, and clears the session cookie. With `SESSION_COOKIE_MODE=true` (default `false`) login and MFA responses move the token into the `pg_admin_session` HttpOnly, `SameSite=Strict` cookie (path `/api/v1/admin`, 12 h, `Secure` unless `SESSION_COOKIE_SECURE=false`, default `true`) and return `sessionCookie: true` instead of `token` (`captureSessionToken`); the `cookieSession` middleware, mounted first on the admin router, converts the cookie into the `Authorization: Bearer` header only when the mode is on and the caller sent none, and requires `x-pg-csrf: 1` on unsafe methods (`403 CSRF_HEADER_REQUIRED`). Login/MFA are exempt from the cookie conversion so a stale cookie cannot block a new sign-in; logout is outside the auth limiter. Both settings are validated by `admin-back/lib/env`.
- **Session audience and breaker (GAP-020, GAP-021).** The advisory authority guard now requires `aud=payment-gateway-admin`. The core upstream client removes a node from rotation only after `CORE_FAILURE_THRESHOLD = 3` consecutive failures. Sessions minted before the audience change are rejected and administrators must sign in again.

## Admin UI completion forwards (2026-11-06)

New `coreForward` routes (new files `wallets.ts`, `applications.ts` (applications + `paymentLinksRouter` + `posTerminalsRouter`), `transactions.ts` (transactions + `inboundEventsRouter`), `system.ts`, plus additions to `merchants.ts`, `gateways.ts`, `settings.ts`, `finance.ts`, `aml.ts`) registered in `protected/index.ts` with the same any-of authorities core enforces:

| Mount | Read | Write |
| :--- | :--- | :--- |
| `/wallets` (+ `/:id/statement`, `/:id/audit-events`), `/applications`, `/payment-links`, `/pos-terminals` | `merchant:read` | `merchant:write` |
| `/transactions` | `attempt:read`, `merchant:read`, `finance:read` | n/a |
| `/inbound-events` | `attempt:read`, `case:read` | n/a |
| `/system/*` (jobs-outbox, jobs, outbox, audit-outbox, notifications), mounted after `/system/backups` | `security:read` | `security:write` |
| `/finance/journal-entries`, `/finance/gl-accounts/:id` (+ `/lines`) | `finance:read` | checkpoint, `/shards/scale`, `/shards/:shardId/repair` and `/repair/request` `finance:write` (`/repair-plan` `finance:read`) |
| `/gateways/:id/health` | `gateway:read` | n/a |
| `/settings/notification-templates` | `settings:read` | `settings:write` |
| `/merchants/:id/beneficial-owners`, `/merchants/:id/revalidations` | `merchant:read` or `kyb:read` | `kyb:write` or `merchant:write` (the rest of `/merchants` stays `merchant:write`; `kyb:write` does not unlock suspend) |
| `/aml/reporting-rules/:id/promote`, `/finance/route-caps` | already in core; now forwarded | |

Contracts enforced at the edge: bodies are `.strict()` zod; `reason` is `z.string().trim().min(10).max(500)` (shared `mutationSchemas.ts`; also required on job requeue, notification retry and GL checkpoint); mutation enums are the safe subsets (wallet `FROZEN|ACTIVE`, application `SUSPENDED|ACTIVE`, POS `INACTIVE|BLOCKED|ACTIVE`, link `CANCELLED`); path ids must be UUIDs; list queries pass through every scalar filter. `zListQuery` requires `page >= 1` and caps `pageSize` at 200 but has no upper page bound, so a "last page" jump on a multi-million-row ledger is forwarded instead of failing validation; deep offset pages remain an offset-pagination cost (GAP-006). `relayStatus` passes core's 200/201/202 to the client unchanged (202 = submitted for approval). There is no outbox retry route (core has none).

## Remediation round 2 (2026-11-08): limiters, uploads, invitation routes

`api/public/auth.ts` wires `createAccountLimiters` (per `identifier|ip` and an identifier ceiling, failures only) and the public `POST /auth/accept-invitation` route; `api/upload.ts` exports `uploadGuards` (limiter, `Content-Length` pre-check, session-shape check before multer) and is used by the reconciliation and join-request uploads; `api/protected/users.ts` and `api/contract.ts` carry the invitation-based create and re-invite contracts (no password or phone in the create body).

## Report engine forwards (2026-11-10)

`/api/v1/admin/report-engine/*` forwards the core report-engine routes. The catalog forwards `audience`, `page`, `pageSize`, `search`, `sortKey` and `sortDirection`; the chrome registry forwards `type`, `includeArchived`, `page`, `pageSize`, `search`, `sortKey` and `sortDirection`; and `POST /chrome/:id/archive` is proxied. The edge authority guard accepts `report:review`, `report:approve`, `report_engine:author`, `report_engine:run`, `gateway:write`, `security:read`, `security:write` and `reports.draft` for reads, and `report:approve`, `report_engine:author`, `report:review`, `security:write` and `reports.draft` for writes.

## Reporting Studio, incidents and filing adapters (2026-11-10)

`admin-back/api/protected/aml.ts` forwards the new reporting surface to core; every route remains behind `requireAuthorities("COMPLIANCE", "MLRO", "aml:read", "aml:write")` and core re-checks the authority:

- template/studio: `POST /report-schemas/:id/template/analyze`, `POST /report-schemas/:id/template/upload`, `DELETE /report-schemas/:id/template`, `GET|PUT /report-schemas/:id/template`, `POST /report-schemas/:id/workbook/preview`; the XML/XLSX/DOCX schema enums accept `DOCX`.
- rule bindings: `PUT /reporting-rules/:id/schema-bindings` relays the core 202 (approval request), not 200.
- incidents: list/create/detail/update and transition, timeline, responders and responder acknowledgement/release, actions, links, communications and `POST /incidents/:id/report`.
- filing: `GET|POST|PATCH|DELETE /filing-adapters`, `GET /reports/:id/submissions` and `POST /reports/:id/file`; file relays core's 202/502 status and never exposes the adapter secret.

The edge validates identifiers, enums and body shapes, but keeps the core as the authority for maker-checker, schema lifecycle, output readiness and adapter authority matching.

## Final AML forwarding sweep (2026-11-10)

- `GET /aml/incidents` now has an explicit query schema and forwards `search`, `page`, `pageSize`, `status`, `severity` and `category`; without it `coreForward` dropped every filter.
- Incident writes, filing-adapter create/update/disable and `POST /reports/:id/file` relay core's 202 instead of returning a false 200.
- The new AML routes remain behind the shared `amlConfidential` guard; the edge only validates shapes while core remains the authority for maker-checker, submission readiness and adapter matching.

## Object & asset storage proxy

`admin-back/api/protected/objectStorage.ts` forwards the console API:
`GET /object-storage/summary`, `GET /object-storage/objects`,
`GET /object-storage/objects/:id`, `GET /object-storage/access-logs`,
`POST|DELETE /object-storage/objects/:id/legal-hold` and
`POST /object-storage/maintenance/:job`. It is mounted with
`system:storage:read`/`system:storage:admin`/`system:storage:legal-hold`
read/write guards. `assetsRouter` additionally exposes binary
`POST /assets/upload` (multipart `file` + `name`) and
`GET /assets/:id/content`, forwarding raw bytes to core.

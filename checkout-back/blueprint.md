<!-- GENERATED FILE. Edit project-design/parts/** instead. Do not hand-edit this file. -->

# checkout-back blueprint

Generated from: `edge.shared`, `edge.checkout`.

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

## Checkout Edge BFF

> Status: `partial` · Last verified: 2026-11-13

## 1. Purpose and scope

`checkout-back` is the public checkout and inbound-webhook edge. It serves anonymous payers and external payment gateways:

- payer link resolution and attempt lifecycle under `/api/v1/pay/*`;
- the checkout status SSE stream;
- browser return handling under `/api/v1/return/*`;
- raw inbound gateway webhooks under `/api/v1/inbound/:gateway/:env/:pathToken`.

It owns edge schema validation, the zero-monetary-field assertion, raw webhook capture, header allowlisting, environment translation, client IP propagation, rate limiting, redirect construction and mTLS forwarding to `/internal/checkout/*`. It owns no database, no session, no money resolution and no gateway signature verification.

## 2. Design intent (extracted and synthesized from ./design)

The checkout edge is deliberately read/execute-only. A payer can select a rail and submit form data, but can never create a link, change a link or supply an amount or currency. `core-back` resolves money from `payment_links` by `linkKey`.

Inbound webhooks are treated as untrusted. The design calls for capturing the raw bytes and headers, forwarding them unchanged to the core inbox, and returning the gateway's configured ack quickly. The core verifies the signature, IP allowlist and replay window. The design's blueprint says the inbox returns the ack in under 10 ms; the as-built core performs verification inline before acking.

The return URL is an untrusted browser hint. Core inspects the attempt, triggers an inquiry where appropriate, and the edge redirects the browser to the checkout status page.

## 3. As-built architecture

### 3.1 Process and mount order

`checkout-back/index.ts`:

- disables `x-powered-by`;
- sets `trust proxy` to false;
- emits no CORS headers unless `CORS_ALLOWED_ORIGINS` is set (same-origin by default; credentials disabled), plus hand-written security headers;
- installs request logging;
- serves unauthenticated `GET /health`;
- mounts `/api/v1/inbound` with `inboundRouter` **before** the JSON body parser, so the inbound router can install its own raw parser;
- then installs JSON and URL-encoded parsers (`MAX_JSON_BODY_BYTES`);
- mounts `/api/v1` with the pay and return routers;
- adds the shared 404 and error handlers.

The listener binds to `BIND_HOST` (default `0.0.0.0`). The deploy engine writes `127.0.0.1`; Nginx is the public listener.

### 3.2 Middleware and guards

| Layer | Behavior |
| :--- | :--- |
| `payLimiter` | 60-second window, `PAY_RATE_LIMIT_MAX` (default 120), on the pay router. |
| `returnLimiter` | 60-second window, `PAY_RATE_LIMIT_MAX`, on the return router. |
| `inboundLimiter` | 60-second window, `INBOUND_RATE_LIMIT_MAX` (default 600), on the inbound router. |
| Raw parser | `express.raw({ type: () => true, limit: MAX_INBOUND_BODY_BYTES })`, applied after the inbound limiter; only GET/HEAD/POST are accepted; parser errors return 413/400. |
| `assertNoMonetaryFields` | Recursively rejects forbidden monetary keys (amount, currency, total, fee, commission, price, net/gross/debit/credit amounts, and close variants) with `400 AMOUNT_NOT_ACCEPTED`. Applied to initiate, confirm, resend, cancel and client-event. |
| Schema validation | Zod schemas for link keys, attempt ids, rail codes, sub-modes, form data, OTPs, evidence, idempotency keys and client events. |
| Header allowlist | Inbound forwards only `content-type`, `user-agent`, `x-signature`, `x-gateway-signature`, `x-hub-signature-256`, `x-moomalat-signature`, `x-timestamp` and `x-nonce`. `content-length` is deliberately NOT forwarded (2026-11-08): `express.raw` inflates gzip/deflate/br/zstd bodies, so the inbound length no longer describes the bytes the edge writes to core; forwarding it let the surplus be parsed as the next request on the pooled keep-alive connection (request smuggling). The shared client now also drops caller-supplied framing/hop-by-hop headers and computes `content-length` from the real body. |
| Environment translation | `sandbox`, `test`, `uat` map to core `SANDBOX`; `live`, `production` map to `LIVE`; anything else is rejected. |

There is no edge authentication. Anonymous payers and external gateways are the intended callers. The link key, attempt id/token, OTP and idempotency key are the edge-visible capabilities; core validates each against database state.

### 3.3 Forwarding behavior

Payer routes call `callCore()` directly with a method, path, body and context. They do not use a generic forwarder. The context includes the request id, resolved client IP, user agent and no bearer token.

`GET /pay/:linkKey` resolves public link data. `POST /initiate` validates the rail code, optional sub-mode, form data and idempotency key, then forwards. `GET /logs/:attemptId` returns public attempt state. `POST /confirm`, `/resend`, `/cancel` and `/client-event` validate their schemas and forward.

`GET /pay/:linkKey/logs/:attemptId/status` calls `proxyCoreStream()` with a 10-minute timeout. The core endpoint itself polls PostgreSQL every 2 seconds, emits an SSE `status` event when the status changes, and ends on a terminal status or after the deadline. The edge retries a failed stream handshake on another core node but cannot resume an established stream.

Inbound `ANY /inbound/:gateway/:env/:pathToken`:

1. Validates the gateway identifier, environment and path token shape.
2. Reads the raw `Buffer` and the original `content-type`.
3. Translates the environment.
4. Calls `callCoreRaw()` with method, raw bytes, content type, allowlisted headers, request id, client IP and a 10-second timeout.
5. Relays the core status code, content type and body.

The edge does not parse the webhook body, compute a signature, or decide whether the event is genuine. Core stores the event, resolves the channel and attempt, performs synchronous verification, updates the event and then returns the channel ack status/body. If core returns an error, the edge relays it; no local ack is fabricated.

Browser return `GET|POST /return/:attemptToken`:

- validates the attempt token;
- calls core with the query for GET or `{ hint: "browser_return" }` for POST;
- builds `CHECKOUT_FRONT_BASE_URL` + `CHECKOUT_FRONT_STATUS_PATH` with `attempt_token` and an optional `reference`;
- redirects with 302.

### 3.4 Route map

| Method | Edge path | Core path |
| :--- | :--- | :--- |
| GET | `/api/v1/pay/:linkKey` | `GET /internal/checkout/pay/:linkKey` |
| POST | `/api/v1/pay/:linkKey/initiate` | `POST /internal/checkout/pay/:linkKey/initiate` |
| GET | `/api/v1/pay/:linkKey/logs/:attemptId` | `GET /internal/checkout/pay/:linkKey/logs/:attemptId` |
| GET | `/api/v1/pay/:linkKey/logs/:attemptId/status` | SSE proxy of `GET /internal/checkout/pay/:linkKey/logs/:attemptId/status` |
| POST | `/api/v1/pay/:linkKey/logs/:attemptId/confirm` | `POST /internal/checkout/pay/:linkKey/logs/:attemptId/confirm` |
| POST | `/api/v1/pay/:linkKey/logs/:attemptId/resend` | `POST /internal/checkout/pay/:linkKey/logs/:attemptId/resend` |
| POST | `/api/v1/pay/:linkKey/logs/:attemptId/cancel` | `POST /internal/checkout/pay/:linkKey/logs/:attemptId/cancel` |
| POST | `/api/v1/pay/:linkKey/logs/:attemptId/client-event` | `POST /internal/checkout/pay/:linkKey/logs/:attemptId/client-event` |
| ANY | `/api/v1/inbound/:gateway/:env/:pathToken` | `ANY /internal/checkout/inbound/:gateway/:env/:pathToken` (raw bytes) |
| GET, POST | `/api/v1/return/:attemptToken` | `GET, POST /internal/checkout/return/:attemptToken` |

## 4. Contracts and invariants

- No payer schema accepts `amount`, `currency` or any normalized monetary field. The recursive assertion rejects nested occurrences before forwarding.
- The payer can submit only the link key, rail code, sub-mode, form data, idempotency key, OTP and untrusted client event hints.
- The edge never resolves money, fees or currency; core reads the authoritative link.
- Inbound bodies are forwarded byte for byte. The edge must not normalize JSON or re-encode forms.
- Only the allowlisted inbound headers cross the boundary. `authorization`, `cookie` and arbitrary `x-*` headers are dropped.
- Core is the only place where gateway signatures, replay windows, IP allowlists and channel/environment bindings are verified.
- Client event aliases (`COMPLETE_CALLBACK`, `ERROR_CALLBACK`, widget aliases) are normalized to `completeCallback`, `errorCallback`, `widgetEvent` and `returnHint`.
- The return redirect destination comes only from configured `CHECKOUT_FRONT_BASE_URL` and `CHECKOUT_FRONT_STATUS_PATH`, not from client input.
- SSE responses must disable buffering; Nginx sets `proxy_buffering off` for the status route.

## 5. Data / API / config / deployment surface

### Environment

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | Runtime mode. |
| `PORT` | `4103` | Backend listener port. |
| `BIND_HOST` | `0.0.0.0` | Bind address; deploy overrides to `127.0.0.1`. |
| `CORE_BACK_URL` | required | First core node, absolute HTTPS. |
| `CORE_BACK_URLS` | optional | Core pool. |
| `MTLS_CLIENT_CERT_PATH`, `MTLS_CLIENT_KEY_PATH`, `MTLS_CA_CERT_PATH` | required | Edge mTLS material. |
| `CORE_REQUEST_TIMEOUT_MS` | `30000` | Default core timeout (inbound explicitly uses 10 seconds). |
| `TRUSTED_PROXY_CIDRS` | loopback only (`127.0.0.0/8,::1/128`) | Trusted forwarded-IP peers. |
| `MAX_JSON_BODY_BYTES` | `1048576` | JSON limit. |
| `MAX_INBOUND_BODY_BYTES` | `1048576` | Raw webhook limit (was 3 MiB). |
| `CHECKOUT_FRONT_BASE_URL` | `http://localhost:5103` | Redirect base. |
| `CHECKOUT_FRONT_STATUS_PATH` | `/pay/status` | Redirect path. |
| `PAY_RATE_LIMIT_MAX`, `PAY_RATE_LIMIT_WINDOW_MS` | `120`, `60000` | Pay and return limiters. |
| `INBOUND_RATE_LIMIT_MAX`, `INBOUND_RATE_LIMIT_WINDOW_MS` | `600`, `60000` | Inbound limiter. |

### Deployment surface

`deploy/lib/hostPlanner.ts` writes `BIND_HOST=127.0.0.1`, `CHECKOUT_FRONT_BASE_URL=https://<CHECKOUT_DOMAIN>` and `CHECKOUT_FRONT_STATUS_PATH=/pay/status`. The checkout Nginx vhost proxies `/api/` to `127.0.0.1:4103`, disables buffering for the SSE route, and applies `client_max_body_size` sized for the inbound raw limit. The edge `.env` contains no database or KMS secret.

## 6. Operational usage

```bash
cd checkout-back
bun install
bun run start
bun run dev
bun test
bun run typecheck
```

- Public reachability is through `https://pay.<domain>/api`; port 4103 stays loopback-only.
- To test a webhook locally, send the exact gateway bytes and signature headers to the inbound route. The edge preserves bytes and the allowlisted headers; the core verification result determines the processing outcome.
- A gateway retry is expected after a non-2xx edge/core response. Dedupe is by `channel.id + SHA-256(rawBody)` in core; the edge does not dedupe.
- For SSE problems, check Nginx buffering, the core 10-minute deadline and the 2-second poll interval. The edge does not send keepalive comments of its own.
- For a redirect loop, verify `CHECKOUT_FRONT_BASE_URL` and `CHECKOUT_FRONT_STATUS_PATH`.

## 7. Status and deviations

### Implemented

- Public pay, return, SSE and inbound route surface.
- Zero-monetary-field assertion with nested scanning.
- Raw inbound capture with byte preservation and strict header allowlist.
- Environment and client-event vocabulary translation.
- Core pool, retries, LSN propagation and channel confinement.
- Rate limits per route family.
- Browser redirect to the configured checkout status page.

### Partial

- Inbound webhooks are processed synchronously. The design describes a queue-and-fast-ack inbox; the code stores the event, runs verification inline, updates the event and only then ack's.
- SSE is a core-side database poller, not a transition-bus subscription.
- The edge's stream retry covers handshake failure only.

### Missing / deferred

- Asynchronous webhook verification with a fast ack.
- Stream resume/replay, `Last-Event-ID` support or a polling fallback.
- Edge-side operational or diagnostic routes.
- Signature pre-validation at the edge (intentionally left to core).

### Known bugs / risks

- The 10-second inbound timeout can return `504 CORE_TIMEOUT` while core continues writing the event and processing it. The gateway may retry; core dedupe should suppress duplicate effects, but the observable response is ambiguous.
- Synchronous verification puts crypto, IP lookup and replay checks on the webhook request path, so a slow verification consumes the gateway's timeout budget and an inbound worker.
- If the core ack status or body is misconfigured, the edge faithfully relays it; there is no fallback ack.
- The return handler issues a 302 after core responds. A core error is surfaced as an error response, not a redirect with an error state.
- `CHECKOUT_FRONT_BASE_URL` accepts HTTP or HTTPS in the edge schema. In production it should be HTTPS.
- The default `BIND_HOST` is `0.0.0.0`; only the deploy engine's override to loopback prevents direct exposure.

## 8. Verification and tests

```bash
cd checkout-back && bun run typecheck && bun test
```

Key suites:

- `checkout-back/test/checkout-zero-trust.test.ts`: no amount/currency acceptance, field rejection and translation.
- `checkout-back/test/core-internal-client.test.ts`: pool, retry, headers and LSN.
- `checkout-back/test/mtls-client.test.ts`: channel confinement and error mapping.
- `checkout-back/test/error-and-logger.test.ts`: error envelopes and request logging.
- `checkout-back/test/env-isolation.test.ts`: no database/KMS material at the edge.
- `checkout-back/test/exhaustive/05-api-matrix/checkout-zero-trust-matrix.test.ts`: route matrix.

The suites are local and do not require PostgreSQL/Redis. A live gateway webhook requires the core, a configured channel and the gateway signature fixture.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` section 2.1, checkout boundary.
- `design/01-platform-architecture/payment_gateway_final_design-v5.md` section 16.1, checkout API surface.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` section 6.2, pool behavior.

### Code paths

- `checkout-back/index.ts`: mount order and raw inbound handling.
- `checkout-back/api/public/pay.ts`: payer routes and stream proxy.
- `checkout-back/api/public/inbound.ts`: raw capture, header allowlist and environment translation.
- `checkout-back/api/public/return.ts`: browser return redirect.
- `checkout-back/lib/zReady/index.ts`: monetary-field assertion and event vocabulary.
- `checkout-back/lib/coreInternalClient.ts`: shared mTLS pool.
- `checkout-back/lib/env/index.ts`: environment contract.
- `core-back/api/internal/checkout.ts`: link, attempt, SSE and inbound implementation.

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

## 11. Cross-node SSE bridge (2026-11-03)

- `core-back` republishes every `attempt:transition` event on the Redis-backed `realtime:attempt` topic.
- The checkout status stream subscribes to that topic and emits `event: status` immediately; the existing 2-second database poll remains as a fallback.
- The merchant POS stream subscribes to `realtime:attempt` and `realtime:pos`, filtering by merchant id, so a screen on one host receives an update processed by a core node on the other host.

## Security hardening (2026-11-05)

- **Inbound.** The limiter runs before the raw body parser; buckets are per resolved IP plus channel and a coarse per-IP bucket (5x). Only GET/HEAD/POST; body limit `MAX_INBOUND_BODY_BYTES` default 1 MiB (was 3 MiB); body-parser errors return 413/400. Core errors map to public codes `INBOUND_REJECTED`, `INBOUND_NOT_FOUND`, `INBOUND_CONFLICT`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `INBOUND_UNAVAILABLE`; 401/403/404/410 collapse to 404.
- **Pay routes.** Confirm accepts only `otp` (evidence ignored); BLOCK/HOLD responses carry no internal reasons.
- **Window envs** `PAY_RATE_LIMIT_WINDOW_MS` and `INBOUND_RATE_LIMIT_WINDOW_MS` are wired. Redaction masks link keys, attempt tokens, `/logs/` ids and inbound path tokens in logs.

## Gap resolutions (2026-11-05)

- The checkout upstream client uses the same `CORE_FAILURE_THRESHOLD = 3` consecutive-failure threshold before a core node leaves rotation (GAP-021). Checkout sessions use the `payment-gateway-checkout` audience (GAP-020).

## v38 sandbox checkout (2026-11-13)

`sbx_*` link keys and `SANDBOX` inbound environments select `SANDBOX_CORE_BACK_URLS`; `pl_*` and LIVE inbound stay on the Live pool. The inspector routes list accounts, patch an account balance/status and reveal/simulate an attempt; all refuse a non-`sbx_` key with `403`. An unconfigured sandbox node is `503 SANDBOX_NODE_UNAVAILABLE`, never a silent Live fallback.

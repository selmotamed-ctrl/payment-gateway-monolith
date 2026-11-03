---
id: edge.shared
title: Shared Core Upstream Client
status: implemented
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - admin-back/lib/coreInternalClient.ts
  - merchant-back/lib/coreInternalClient.ts
  - checkout-back/lib/coreInternalClient.ts
  - admin-back/lib/env/index.ts
  - merchant-back/lib/env/index.ts
  - checkout-back/lib/env/index.ts
  - admin-back/api/forward.ts
  - merchant-back/api/forward.ts
  - checkout-back/api/public/inbound.ts
design_sources:
  - design/payment_gateway_final_design-v5.md#22-mutual-tls-mtls-inter-service-transport-architecture
  - design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md#62-edge-to-core-mtls-upstream-load-balancer--health-failover-admin-back-merchant-back-checkout-back
tests:
  - admin-back/test/core-internal-client.test.ts
  - admin-back/test/mtls-client.test.ts
  - admin-back/test/env-isolation.test.ts
  - merchant-back/test/core-internal-client.test.ts
  - merchant-back/test/mtls-client.test.ts
  - merchant-back/test/env-isolation.test.ts
  - checkout-back/test/core-internal-client.test.ts
  - checkout-back/test/mtls-client.test.ts
  - checkout-back/test/env-isolation.test.ts
gaps:
  - The client is copied into all three BFFs instead of living in a shared workspace package.
  - Client certificates are read when the per-node HTTPS agent is created; replacing files on disk does not reload them until the pool is reset or the process restarts.
  - An upstream HTTP 502/503 is always treated as a node failure, even when it is a legitimate application response.
  - Stream retries can only re-open a stream before it is established; there is no resume or polling fallback at the edge.
---

# Shared Core Upstream Client

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

`markNodeFailure()` sets `healthy=false`, increments `failures`, records `lastFailureAt` and sets `cooldownUntil = now + CORE_FAILURE_COOLDOWN_MS` (5 seconds). `markNodeHealthy()` clears all failure state.

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
| `TRUSTED_PROXY_CIDRS` | no | all BFFs | Peers whose forwarded IP headers are trusted. |
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

- `design/payment_gateway_final_design-v5.md` section 2.2, mutual TLS and forwarded context.
- `design/payment_gateway_deployment_and_guides_architecture.md` section 6.2, edge-to-core upstream pool.
- `design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md` section 6.2, the same pool specification.

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

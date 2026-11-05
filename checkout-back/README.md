# checkout-back

`checkout-back` is the public checkout and inbound-webhook edge/BFF. It serves anonymous payers and external payment gateways:

- payer link resolution and attempt lifecycle under `/api/v1/pay/*`;
- the checkout status SSE stream;
- browser return handling under `/api/v1/return/*`;
- raw inbound gateway webhooks under `/api/v1/inbound/:gateway/:env/:pathToken`.

It validates edge payloads, enforces the zero-monetary-field rule, captures raw webhook bytes, allowlists headers, translates environment and event vocabulary, and forwards over mutual TLS (mTLS) to `core-back` under `/internal/checkout/*`.

- Runtime: Bun + Express 5 + Zod 4.
- Status: `partial` (see the canonical design part for the authoritative status).
- Generated blueprint: [`blueprint.md`](./blueprint.md)
- Canonical parts: [`Checkout Edge BFF`](../project-design/parts/02-edge-services/03-checkout-back.md), [`Shared Core Upstream Client`](../project-design/parts/02-edge-services/00-shared-core-upstream-client.md)
- Generated references: [`API route matrix`](../project-design/appendices/api-route-matrix.md), [`environment matrix`](../project-design/appendices/env-and-config-matrix.md)

## 1. Purpose and boundaries

`checkout-back` owns:

- anonymous payer route validation and forwarding;
- the recursive zero-monetary-field assertion;
- raw inbound capture with byte preservation;
- inbound header allowlisting and environment translation;
- client-event alias normalization;
- rate limits and client IP propagation;
- browser redirect construction;
- the mTLS pool and request context sent to core.

`checkout-back` does not own:

- database access, Prisma, migrations or `DATABASE_URL`;
- `KMS_MASTER_KEY` or another host's certificate/key;
- payer sessions or authentication;
- amount, currency, fee or link state resolution;
- gateway signature verification, replay windows or inbound IP allowlists;
- ledger writes or idempotency decisions.

Trust model: the edge is untrusted from core's point of view. The edge authenticates to core with a client certificate whose common name is exactly `checkout-back`. Core verifies the internal CA, binds the certificate to `/internal/checkout`, and independently resolves the payment link, validates the attempt, re-checks every capability and verifies inbound webhooks. The link key, attempt id/token, OTP and idempotency key are edge-visible capabilities; they are not a substitute for core validation.

The backend binds to `BIND_HOST` (default `0.0.0.0` in the service schema). Deployment writes `127.0.0.1`, so the public checkout Nginx vhost is the only intended listener.

## 2. Architecture and request flow

`index.ts` creates a stateless Express app:

1. Disables `x-powered-by`.
2. Sets Express `trust proxy` to `false`.
3. Emits permissive CORS without credentials unless `CORS_ALLOWED_ORIGINS` is set, plus hand-written security headers.
4. Installs request logging with request-id resolution and secret redaction.
5. Serves unauthenticated `GET /health`.
6. Mounts `/api/v1/inbound` **before** the JSON body parser so the inbound router can install its own raw parser.
7. Installs JSON and URL-encoded parsers with `MAX_JSON_BODY_BYTES`.
8. Mounts `/api/v1` with the pay and return routers.
9. Adds the shared JSON 404 and error handlers.

Middleware:

| Layer | Behavior |
| :--- | :--- |
| `payLimiter` | Fixed 60-second window, `PAY_RATE_LIMIT_MAX` (default 120), on the pay router. |
| `returnLimiter` | Fixed 60-second window, `PAY_RATE_LIMIT_MAX`, on the return router. |
| `inboundLimiter` | Fixed 60-second window, `INBOUND_RATE_LIMIT_MAX` (default 600), on the inbound router. |
| Raw parser | `express.raw({ type: () => true, limit: MAX_INBOUND_BODY_BYTES })` for every inbound request. |
| `assertNoMonetaryFields` | Recursively rejects amount, currency, total, fee, commission, price, net/gross/debit/credit amount and close variants with `400 AMOUNT_NOT_ACCEPTED`. Applied to initiate, confirm, resend, cancel and client-event. |
| Schema validation | Zod schemas for link keys, attempt ids, rail codes, sub-modes, form data, OTPs, evidence, idempotency keys and client events. |
| Header allowlist | Inbound forwards only `content-type`, `user-agent`, `content-length`, `x-signature`, `x-gateway-signature`, `x-hub-signature-256`, `x-moomalat-signature`, `x-timestamp` and `x-nonce`. |
| Environment translation | `sandbox`, `test`, `uat` become core `SANDBOX`; `live`, `production` become `LIVE`; anything else is rejected. |

Payer routes call `callCore()` directly rather than using a generic forwarder. The call context includes the request id, resolved client IP and user agent; no bearer token is sent. The return route calls core and then redirects to the configured checkout front status page. The inbound route uses `callCoreRaw()` with a 10-second timeout.

## 3. Routes

All routes are under `/api/v1` unless noted. `GET /health` is at the process root.

| Method | Edge path | Core path | Notes |
| :--- | :--- | :--- | :--- |
| GET | `/pay/:linkKey` | `GET /internal/checkout/pay/:linkKey` | Resolves public link data. |
| POST | `/pay/:linkKey/initiate` | `POST /internal/checkout/pay/:linkKey/initiate` | Rail, optional sub-mode, form data, idempotency key; returns `201`. |
| GET | `/pay/:linkKey/logs/:attemptId` | `GET /internal/checkout/pay/:linkKey/logs/:attemptId` | Public attempt state. |
| GET | `/pay/:linkKey/logs/:attemptId/status` | SSE proxy of `GET /internal/checkout/pay/:linkKey/logs/:attemptId/status` | 10-minute stream timeout. |
| POST | `/pay/:linkKey/logs/:attemptId/confirm` | `POST /internal/checkout/pay/:linkKey/logs/:attemptId/confirm` | OTP, optional evidence, idempotency key. |
| POST | `/pay/:linkKey/logs/:attemptId/resend` | `POST /internal/checkout/pay/:linkKey/logs/:attemptId/resend` | Optional idempotency key. |
| POST | `/pay/:linkKey/logs/:attemptId/cancel` | `POST /internal/checkout/pay/:linkKey/logs/:attemptId/cancel` | Optional idempotency key and reason. |
| POST | `/pay/:linkKey/logs/:attemptId/client-event` | `POST /internal/checkout/pay/:linkKey/logs/:attemptId/client-event` | Client event alias normalization. |
| ALL | `/inbound/:gateway/:env/:pathToken` | `POST /internal/checkout/inbound/:gateway/:env/:pathToken` | Raw bytes; environment translated to `SANDBOX`/`LIVE`; 10-second timeout. |
| GET, POST | `/return/:attemptToken` | `GET, POST /internal/checkout/return/:attemptToken` | Calls core, then redirects `302` to the configured status page. |
| GET | `/health` (process root) | none | Process liveness only; does not probe core. |

Route notes:

- The edge inbound route accepts all methods and relays the core response. Core currently registers `POST` for the inbound path.
- Payer routes never accept an amount or currency. `formData` is a flat record of primitives and is forwarded as submitted.
- Client event aliases such as `COMPLETE_CALLBACK`, `ERROR_CALLBACK`, `CANCEL_CALLBACK`, `WIDGET_READY`, `WIDGET_CLOSED` and `RETURN_HINT` normalize to `completeCallback`, `errorCallback`, `widgetEvent` or `returnHint`.
- The return redirect destination is built only from `CHECKOUT_FRONT_BASE_URL` and `CHECKOUT_FRONT_STATUS_PATH`, with `attempt_token` and an optional `reference` returned by core. A core error is surfaced as an error response, not as a redirect with an error state.

## 4. `CORE_BACK_URLS` pool and failover

The shared client is implemented in `lib/coreInternalClient.ts`. This service uses `CORE_SERVICE_NAME=checkout-back` and `CORE_CHANNEL_PREFIX=/internal/checkout`.

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
8. `x-pg-min-lsn` is propagated when the caller supplies an LSN. The client does not generate one. Checkout payer routes do not currently set one.

Transport mapping:

| Transport condition | Edge error |
| :--- | :--- |
| `ETIMEDOUT`, `ESOCKETTIMEDOUT` | `504 CORE_TIMEOUT` |
| `ECONNREFUSED`, `ECONNRESET`, `EPIPE`, `EHOSTUNREACH` | `502 CORE_UNREACHABLE` |
| `ENOTFOUND`, `EAI_AGAIN` | `502 CORE_DNS_FAILURE` |
| TLS error codes | `502 CORE_TLS_ERROR` |
| Other failures | `502 CORE_CONNECTION_ERROR` |

SSE note: the status stream retries a failed handshake on another core node, but an established stream is not load-balanced or resumed. Core polls PostgreSQL on a timer, emits a `status` event on change and ends on a terminal status or after its deadline. The edge has no pool metrics or status endpoint.

## 5. Authentication, authorities and trust

`checkout-back` has no edge authentication or authority layer. Anonymous payers and external gateways are the intended callers.

| Control | `checkout-back` behavior | `core-back` behavior |
| :--- | :--- | :--- |
| Payer identity | None. | The link key, attempt id/token, OTP and idempotency key are validated against database state. |
| Payer amount/currency | Recursively rejects monetary fields. | Resolves the authoritative amount and currency from `payment_links` by `linkKey`. |
| Inbound webhook authenticity | Does not parse, sign, verify or dedupe the body. | Resolves the channel, verifies source IP/timestamp/correlation/signature in constant time, applies the replay window and dedupes by channel id plus SHA-256 of the raw body. |
| Inbound processing | Synchronous forward with a 10-second timeout. | Stores the event, verifies it inline, updates the event and returns the channel ack; there is no fast queue-and-ack inbox. |
| Request shape | Zod validation and idempotency key format. | Re-validates with its own schemas and business invariants. |
| Edge authority | None. | All checkout internal routes are intentionally unauthenticated: the capabilities are the credentials. |

Important consequences:

- A checkout request can never create a link, change a link, choose an amount or choose a currency.
- The edge does not verify gateway signatures. Only core decides whether an inbound event is genuine.
- Because inbound verification is synchronous, a slow core verification consumes the gateway's timeout budget. If the edge returns `504 CORE_TIMEOUT`, core may still finish storing and processing the event. The gateway may retry; core dedupe should suppress duplicate effects, but the observable response is ambiguous.
- The edge relays core's ack status and body. It does not fabricate a local ack and has no fallback ack.

## 6. Environment

| Key | Required | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | no | `development` | Runtime mode (`development`, `test`, `production`). |
| `PORT` | no | `4103` | Backend listener port. |
| `BIND_HOST` | no | `0.0.0.0` | Backend bind address. Deployment sets `127.0.0.1`. |
| `CORE_BACK_URL` | yes | none | First core node; absolute `https:` URL. |
| `CORE_BACK_URLS` | no | none | Comma-separated core pool; absolute `https:` URLs. |
| `MTLS_CLIENT_CERT_PATH` | yes | none | Client certificate for core. |
| `MTLS_CLIENT_KEY_PATH` | yes | none | Client private key. |
| `MTLS_CA_CERT_PATH` | yes | none | Internal CA certificate. |
| `CORE_REQUEST_TIMEOUT_MS` | no | `30000` | Default core timeout. Inbound explicitly uses 10 seconds; the status stream uses 10 minutes. |
| `TRUSTED_PROXY_CIDRS` | no | loopback only (`127.0.0.0/8,::1/128`) | Peers whose forwarded IP headers are trusted. |
| `MAX_JSON_BODY_BYTES` | no | `1048576` | JSON and URL-encoded body limit. |
| `MAX_INBOUND_BODY_BYTES` | no | `1048576` | Raw inbound webhook body limit at the edge. |
| `CHECKOUT_FRONT_BASE_URL` | no | `http://localhost:5103` | Redirect base for browser returns. Accepts HTTP or HTTPS; use HTTPS in production. |
| `CHECKOUT_FRONT_STATUS_PATH` | no | `/pay/status` | Redirect path for browser returns. |
| `PAY_RATE_LIMIT_MAX` | no | `120` | Pay and return requests per fixed 60-second window. |
| `PAY_RATE_LIMIT_WINDOW_MS` | no | `60000` | Defined but not read by the current limiters; the window is fixed at 60 seconds. |
| `INBOUND_RATE_LIMIT_MAX` | no | `600` | Inbound requests per fixed 60-second window. |
| `INBOUND_RATE_LIMIT_WINDOW_MS` | no | `60000` | Defined but not read by the current limiter; the window is fixed at 60 seconds. |

The service never reads `DATABASE_URL`, `KMS_MASTER_KEY` or another service's certificate. Deploy writes `BIND_HOST=127.0.0.1`, `CHECKOUT_FRONT_BASE_URL=https://<CHECKOUT_DOMAIN>`, `CHECKOUT_FRONT_STATUS_PATH=/pay/status`, the core URL list and the edge mTLS paths into the generated `.env`. The checkout Nginx vhost disables buffering for the SSE route and sizes `client_max_body_size` for the inbound limit.

## 7. Commands

```bash
cd checkout-back
bun install
bun run start      # bun run index.ts
bun run dev        # bun --watch index.ts
bun test
bun run typecheck  # bunx tsc --noEmit
```

Public reachability is through the checkout Nginx vhost; the backend port must stay loopback-only.

## 8. Testing and troubleshooting

```bash
cd checkout-back && bun run typecheck && bun test
```

Key suites:

- `test/checkout-zero-trust.test.ts`: no amount/currency acceptance, field rejection and vocabulary translation.
- `test/core-internal-client.test.ts`: pool, retry, headers and LSN behavior.
- `test/mtls-client.test.ts`: channel confinement and transport error mapping.
- `test/error-and-logger.test.ts`: error envelopes and request logging.
- `test/env-isolation.test.ts`: no database/KMS secrets in the edge environment.
- `test/exhaustive/05-api-matrix/checkout-zero-trust-matrix.test.ts`: route matrix.

These suites use local stubs and do not require PostgreSQL or Redis. A live gateway webhook requires core, a configured channel and the gateway signature fixture.

Common failures:

| Symptom | Likely cause / check |
| :--- | :--- |
| `400 AMOUNT_NOT_ACCEPTED` | A payer payload contains amount, currency or another monetary field, including nested fields. |
| `400 INBOUND_ENVIRONMENT_INVALID` | Inbound `env` is not one of `sandbox`, `test`, `uat`, `live`, `production`. |
| `400 VALIDATION_FAILED` | Link key, attempt id/token, rail code, OTP, form data or idempotency key failed the edge schema. |
| `404 NOT_FOUND` | Path or method is not part of the checkout surface; the inbound edge accepts all methods but core registers `POST`. |
| `429 RATE_LIMITED` | Pay/return or inbound rate limit exceeded. |
| `502 CORE_TLS_ERROR` | Certificate/CA mismatch, expired certificate, or wrong client certificate. Restart after rotation. |
| `502 CORE_UNREACHABLE` / `504 CORE_TIMEOUT` | Core node is down or slower than the timeout. Inbound times out after 10 seconds. |
| `503 CORE_UNAVAILABLE` | No eligible core node remains or `CORE_BACK_URLS` is empty. |
| SSE stream closes | Check Nginx buffering, the core 10-minute deadline, the 2-second poll interval and whether core restarted mid-stream. |
| Redirect loop | Check `CHECKOUT_FRONT_BASE_URL` and `CHECKOUT_FRONT_STATUS_PATH`. |

## 9. Security notes

- No database, KMS or migration material is present at the edge. Environment-isolation tests assert this boundary.
- The client certificate CN must be exactly `checkout-back`; core's mTLS guard rejects a valid certificate on another namespace.
- TLS 1.3 is fixed in both directions; core verifies the internal CA and the edge verifies the core server certificate.
- There is no edge session, cookie or authority check. Payer authorization is capability-based and fully validated by core.
- The zero-monetary-field assertion scans nested objects and arrays up to a bounded depth and node budget. It is a UX guard; core must still resolve and validate money from the link.
- Raw body handling: inbound webhook bytes are forwarded unchanged with the original `content-type`. Only the allowlisted headers cross the boundary. `authorization`, `cookie` and arbitrary `x-*` headers are dropped.
- Inbound bodies are limited to `MAX_INBOUND_BODY_BYTES` (default 1 MiB, previously 3 MiB) at the edge, after a per-IP/channel limiter; only GET/HEAD/POST are accepted and core errors map to public codes (`INBOUND_REJECTED`, `INBOUND_NOT_FOUND`, `INBOUND_CONFLICT`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `INBOUND_UNAVAILABLE`). Core's raw-body limit is larger, so core must enforce its own limit.
- The edge does not pre-validate signatures, compute HMACs or dedupe. Core must do all of that.
- CORS is permissive without credentials unless `CORS_ALLOWED_ORIGINS` is set. The public reverse proxy and CSP are the browser-facing controls.
- `CHECKOUT_FRONT_BASE_URL` accepts HTTP or HTTPS in the schema. Production deployment writes HTTPS; do not use HTTP.
- `BIND_HOST` defaults to `0.0.0.0`; only the deploy override to loopback prevents direct exposure.
- Logs redact sensitive keys and truncate long strings, but gateway signatures, body contents and payer data must never be logged by application code.
- A `504 CORE_TIMEOUT` on inbound does not prove core did not process the event. Rely on core dedupe and inquiry rather than assuming failure.

## 10. References

- [`blueprint.md`](./blueprint.md) (generated from the canonical parts)
- [`project-design/parts/02-edge-services/03-checkout-back.md`](../project-design/parts/02-edge-services/03-checkout-back.md)
- [`project-design/parts/02-edge-services/00-shared-core-upstream-client.md`](../project-design/parts/02-edge-services/00-shared-core-upstream-client.md)
- [`project-design/parts/00-platform/02-security-and-mtls.md`](../project-design/parts/00-platform/02-security-and-mtls.md)
- [`project-design/appendices/api-route-matrix.md`](../project-design/appendices/api-route-matrix.md)
- [`project-design/appendices/env-and-config-matrix.md`](../project-design/appendices/env-and-config-matrix.md)

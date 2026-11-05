---
id: edge.checkout
title: Checkout Edge BFF
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: 5a24f6f+working-tree
code:
  - core-back/lib/realtimeBus.ts
  - checkout-back/index.ts
  - checkout-back/api/**
  - checkout-back/lib/env/index.ts
  - checkout-back/lib/coreInternalClient.ts
  - checkout-back/lib/net/index.ts
  - checkout-back/lib/zReady/index.ts
  - checkout-back/lib/error/index.ts
  - checkout-back/lib/requestLogger/index.ts
design_sources:
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#21-service-roles-boundaries-and-security-constraints
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#161-checkout-back-public-api-apiv1pay--apiv1inbound---forwards-to-core-back-internalcheckout
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#62-edge-to-core-mtls-upstream-load-balancer--health-failover-admin-back-merchant-back-checkout-back
tests:
  - core-back/test/storage-engine/telemetry-and-realtime.test.ts
  - checkout-back/test/checkout-zero-trust.test.ts
  - checkout-back/test/core-internal-client.test.ts
  - checkout-back/test/mtls-client.test.ts
  - checkout-back/test/error-and-logger.test.ts
  - checkout-back/test/env-isolation.test.ts
  - checkout-back/test/exhaustive/05-api-matrix/checkout-zero-trust-matrix.test.ts
  - checkout-back/test/security-regressions.test.ts
gaps:
  - An established SSE stream still has no replay/resume; the realtime bridge reduces cross-node latency but does not make a broken stream resumable.
  - Inbound webhooks are verified synchronously inside the request before the gateway ack; the design's fast queue-and-ack path is not implemented.
  - The edge applies a 10-second inbound forwarding timeout; a slower core verification returns an edge timeout even though core may finish storing/processing.
  - An established SSE stream has no resume or polling fallback; a core restart ends the browser stream.
  - The return handler trusts core's redirected reference only for display and does not independently verify the attempt.
  - The edge exposes no authenticated operational route; all pay/return/inbound routes are anonymous by design.
---

# Checkout Edge BFF

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
- emits permissive CORS without credentials unless `CORS_ALLOWED_ORIGINS` is set, plus hand-written security headers;
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
| Header allowlist | Inbound forwards only `content-type`, `user-agent`, `content-length`, `x-signature`, `x-gateway-signature`, `x-hub-signature-256`, `x-moomalat-signature`, `x-timestamp` and `x-nonce`. |
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

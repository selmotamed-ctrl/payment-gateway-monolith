# checkout-edge (Rust)

Rust port of `checkout-back`: the payer-facing edge for payment links, inbound webhook
callbacks, the browser return redirect, public Academy certificate verification and the checkout
status stream.

The edge terminates no TLS itself (Nginx does, exactly like the TypeScript service). It serves
plain HTTP and talks to core over mutual TLS 1.3 with `MTLS_CLIENT_*`.

```bash
cargo run -p checkout-edge -- config validate   # validates env + loads the TLS material
cargo run -p checkout-edge -- serve             # PORT/BIND_HOST, default 0.0.0.0:4103
cargo test -p checkout-edge
cargo clippy -p checkout-edge --all-targets -- -D warnings
```

## Parity

Every route in `backend-rs/tests/golden-vectors/route-inventory/edge-routes.json` for
`checkout-back` is implemented. **No checkout route answers 501**; an unknown method/path pair is
the TypeScript `notFoundHandler`:

```json
{"code":"NOT_FOUND","message":"No route matches <METHOD> <path>"}
```

| # | TS route (`edge-routes.json`) | Rust dispatch | Behaviour |
| :-: | :--- | :--- | :--- |
| 1 | `ALL /api/v1/inbound/:gateway/:env/:pathToken` | `Route::Inbound` | GET/HEAD/POST only; raw body; allowlist; two limiters; `SANDBOX`/`LIVE`; public error vocabulary |
| 2 | `GET /api/v1/pay/:linkKey` | `Route::PayLink` | core `GET /internal/checkout/pay/:linkKey` |
| 3 | `POST /api/v1/pay/:linkKey/initiate` | `Route::Initiate` | monetary guard → zod → core → **201** |
| 4 | `GET /api/v1/pay/:linkKey/logs/:attemptId` | `Route::AttemptLogs` | core logs |
| 5 | `GET /api/v1/pay/:linkKey/logs/:attemptId/status` | `Route::AttemptStatus` | SSE passthrough, 10 min deadline, per-IP slots |
| 6 | `POST /api/v1/pay/:linkKey/logs/:attemptId/confirm` | `Route::Confirm` | monetary guard → zod → core |
| 7 | `POST /api/v1/pay/:linkKey/logs/:attemptId/resend` | `Route::Resend` | optional body (`req.body ?? {}`) |
| 8 | `POST /api/v1/pay/:linkKey/logs/:attemptId/cancel` | `Route::Cancel` | optional body |
| 9 | `POST /api/v1/pay/:linkKey/logs/:attemptId/client-event` | `Route::ClientEvent` | legacy event aliases → canonical |
| 10 | `GET /api/v1/pay/:linkKey/logs/:attemptId/sandbox-inspector` | `Route::SandboxInspector` | `sbx_` only, Sandbox pool |
| 11 | `POST /api/v1/pay/:linkKey/logs/:attemptId/sandbox-simulate` | `Route::SandboxSimulate` | `sbx_` only, Sandbox pool |
| 12 | `GET /api/v1/pay/:linkKey/sandbox-accounts` | `Route::SandboxAccountsList` | `sbx_` only; `railCode` query |
| 13 | `POST /api/v1/pay/:linkKey/sandbox-accounts` | `Route::SandboxAccountsCreate` | `sbx_` only; **201** |
| 14 | `PATCH /api/v1/pay/:linkKey/sandbox-accounts/:accountId` | `Route::SandboxAccountPatch` | `sbx_` only |
| 15 | `GET /api/v1/pay/:linkKey/sandbox-accounts/:accountId/movements` | `Route::SandboxAccountMovements` | `sbx_` only |
| 16 | `GET /api/v1/return/:attemptToken` | `Route::Return` | core `GET /internal/checkout/return/:token`, 302 to the front |
| 17 | `POST /api/v1/return/:attemptToken` | `Route::Return` | `{hint:"browser_return"}` then 302 |
| 18 | `GET /api/v1/verify/certificate/:publicId` | `Route::Certificate` | core `GET /internal/checkout/academy/certificates/:id`, `cache-control: no-store` |
| 19 | `GET /health` | `Route::Health` | `{status,service,release,commit,uptime,implementation}` |

### Pipeline order (identical to `checkout-back/index.ts`)

1. security headers → CORS allow-list → request id → request log;
2. `GET /health`;
3. inbound router: method guard (405 + `Allow`) → per-client limiter → per-channel limiter →
   `express.raw`-equivalent inflated body (1 MiB default; gzip/deflate/zstd/brotli) → parameters →
   core;
4. pay limiter (`120/60 s` default) **before the body is parsed**, for every path under
   `/api/v1/pay`;
5. global JSON (1 MiB) and urlencoded parsers;
6. `/api/v1` router → 404 `NOT_FOUND`.

## Request validation (zod parity)

`src/validation.rs` ports the zod schemas from `lib/zReady` and the five public route files:
link key (6–64 token chars), attempt id (6–64), attempt token (8–256), rail code (1–64), OTP
(`^\d{4,8}$`), idempotency key (8–128 of `[A-Za-z0-9_.:-]`), form data (string ≤512 | number |
boolean | null, keys ≤128), evidence (keys ≤64, any value), sandbox create/patch/simulate and the
inbound environment enum. `.strict()` objects reject unknown keys with `unrecognized_keys`.

Failures are `400 VALIDATION_FAILED` with zod issue objects `{code, path, message}` (and `keys`
for `unrecognized_keys`). Message text is best effort; the code and the dotted path are the
contract. `assertNoMonetaryFields` runs before validation on initiate/confirm/resend/cancel/
client-event and returns `400 AMOUNT_NOT_ACCEPTED` with `details.field`.

## Core client (mTLS, `CORE_BACK_URLS`)

* Live nodes: `CORE_BACK_URLS` (comma, trimmed, de-duplicated, absolute `https:`) with
  `CORE_BACK_URL` as the fallback. Sandbox nodes: `SANDBOX_CORE_BACK_URLS` with
  `SANDBOX_CORE_BACK_URL` as the fallback.
* Two independent pools (`pg_upstream::UpstreamPool`). A Sandbox request never falls back to Live;
  an absent Sandbox pool is `503 SANDBOX_NODE_UNAVAILABLE`.
* Selection: least in-flight, monotonic round-robin tie-break; passive health (3 consecutive
  transport failures → 5 s ejection; half-open single probe); `Exclusions` prevent the same URL
  twice per logical call.
* Retries: connect-phase `GET/HEAD/PUT/DELETE/OPTIONS`; after-send replay only for
  `GET/HEAD/OPTIONS`, an `idempotency-key` or the explicit opt-in. Core's own 502/503/504 answers
  never eject a node.
* Every Sandbox call sets `x-execution-plane: SANDBOX` and `x-sandbox-proxy: checkout-back`.
* TLS 1.3 only, `MTLS_CLIENT_CERT_PATH` / `MTLS_CLIENT_KEY_PATH` / `MTLS_CA_CERT_PATH`, internal
  CA as the only root, SNI for hostnames, redirects disabled.
* Headers: `x-request-id`, `x-real-client-ip` (trusted-proxy resolved), `x-client-user-agent`
  (printable ASCII, 512), `x-edge-service: checkout-back`, `accept`,
  `content-type`, `idempotency-key`, `x-pg-min-lsn`; framing/hop-by-hop headers are stripped and
  `content-length` is recomputed from the bytes actually written.
* Errors keep the TypeScript table: `504 CORE_TIMEOUT`, `502 CORE_UNREACHABLE`,
  `CORE_DNS_FAILURE`, `CORE_TLS_ERROR`, `CORE_CONNECTION_ERROR`, `502 CORE_RESPONSE_TOO_LARGE`,
  `503 CORE_UNAVAILABLE`, and core envelopes (`code`, `message`, `reference`, `details`) pass
  through unchanged on non-inbound routes.

## Environment

| Key | Default | Notes |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `4103` | |
| `BIND_HOST` | `0.0.0.0` | |
| `CORE_BACK_URL` | required | absolute `https:` |
| `CORE_BACK_URLS` | falls back to `CORE_BACK_URL` | comma list, de-duplicated |
| `SANDBOX_CORE_BACK_URL` / `SANDBOX_CORE_BACK_URLS` | unset = Sandbox not configured | never falls back to Live |
| `MTLS_CLIENT_CERT_PATH` / `MTLS_CLIENT_KEY_PATH` / `MTLS_CA_CERT_PATH` | required | read and validated at startup/`config validate` |
| `CORE_REQUEST_TIMEOUT_MS` | `30000` | per-chunk idle timeout (1 s–300 s) |
| `CORE_TOTAL_DEADLINE_MS` | `300000` | per-request deadline (1 s–30 min) |
| `CORE_MAX_RESPONSE_BYTES` | `67108864` | buffered response cap, and inbound SSE error bodies |
| `TRUSTED_PROXY_CIDRS` | `127.0.0.0/8,::1/128` | forwarded headers honoured only from these peers |
| `CORS_ALLOWED_ORIGINS` | empty | empty = no CORS headers; never credentials |
| `MAX_STREAMS_PER_IP` | `5` | concurrent SSE streams per address |
| `MAX_JSON_BODY_BYTES` | `1048576` | checkout JSON limit (1 MiB) |
| `MAX_INBOUND_BODY_BYTES` | `1048576` | inflated inbound limit |
| `CHECKOUT_FRONT_BASE_URL` | `http://localhost:5103` | return redirect base |
| `CHECKOUT_FRONT_STATUS_PATH` | `/pay/status` | return redirect path |
| `PAY_RATE_LIMIT_MAX` / `PAY_RATE_LIMIT_WINDOW_MS` | `120` / `60000` | pay routes |
| `INBOUND_RATE_LIMIT_MAX` / `INBOUND_RATE_LIMIT_WINDOW_MS` | `600` / `60000` | per channel; the per-IP ceiling is ×5 |
| `APP_RELEASE` / `APP_COMMIT` / `GIT_COMMIT` | `dev` / `unknown` | health |
| `DOTENV_PATH` | `.env` when present | never overrides the process environment |

`config validate` prints `config OK (...)` and exits non-zero with a key name (never a value) on a
bad configuration.

## Security notes

* Security headers: `x-content-type-options: nosniff`, `referrer-policy: no-referrer`,
  `x-frame-options: DENY`, `content-security-policy: frame-ancestors 'none'`,
  `cross-origin-resource-policy: cross-origin` (the checkout TS value), `cache-control: no-store`
  unless the handler set one, and no `x-powered-by`.
* `x-request-id` is accepted only when it matches `^[A-Za-z0-9._:-]{1,128}$`; otherwise a UUIDv4
  is generated. It is forwarded to core and used in the log line, but **not echoed on the
  response** (TS parity; see deviation 16).
* The log line redacts capability path segments (`/pay/<key>`, `/logs/<attempt>`,
  `/return/<token>`, `/inbound/<gw>/<env>/<token>`, `/verify/certificate/<id>`) and sensitive
  query values. Bodies, callbacks, authorization headers and payer secrets are never logged.
* Inbound forwards only `content-type`, `user-agent`, `x-signature`, `x-gateway-signature`,
  `x-hub-signature-256`, `x-moomalat-signature`, `x-timestamp`, `x-nonce`; `content-length` and
  `content-encoding` are stripped and the length is recomputed after inflation.
* The public inbound error vocabulary replaces core's codes/messages/details/references.

## Tests

`cargo test -p checkout-edge` runs 179 tests (63 unit + 116 integration) with no live core,
PostgreSQL or TLS server. The fake core implements `CoreTransport` and records every node, path,
query, header and body. Ported suites:

| Rust test file | TypeScript source |
| :--- | :--- |
| `tests/checkout_zero_trust.rs` | `test/checkout-zero-trust.test.ts` |
| `tests/core_internal_client.rs` | `test/core-internal-client.test.ts`, `test/mtls-client.test.ts` |
| `tests/sandbox_checkout_forward.rs` | `test/sandbox-checkout-forward.test.ts`, `test/sandbox-routing.test.ts` |
| `tests/security_regressions.rs` | `test/security-regressions.test.ts` |
| `tests/error_and_logger.rs` | `test/error-and-logger.test.ts` |
| `tests/env_isolation.rs` | `test/env-isolation.test.ts` |
| `tests/exhaustive_matrix.rs` | `test/exhaustive/05-api-matrix/checkout-zero-trust-matrix.test.ts` |
| `tests/certificate_and_return.rs`, `tests/routes_served.rs`, `tests/transport_edge_cases.rs` | added coverage for every route, gzip/deflate/zstd/brotli inflation, HEAD and SSE limits |

## Known deviations (for `DEVIATIONS.md`)

1. **Sandbox account list `railCode` is a real query parameter.** The TS code appends
   `?railCode=…` to `path` before `resolveCoreUrlAgainst`, whose `URL.pathname` setter
   percent-encodes the `?` and core never sees the filter. The Rust edge forwards
   `/sandbox-accounts?railCode=…` as intended.

2. **TLS material is loaded at boot** (`serve` and `config validate`). TS creates the agent lazily
   and returns `500 MTLS_MATERIAL_UNAVAILABLE` on the first core call. Failing startup is safer and
   is invisible to clients when the files are present.

3. **Idle timeout approximation.** Node's `https` timeout is socket inactivity; `reqwest` exposes
   one total deadline. The executor sets the total deadline and applies
   `CORE_REQUEST_TIMEOUT_MS` as a per-chunk idle timeout while reading the body. A slow header
   phase is bounded by the total deadline rather than the idle timeout.

4. **Request log format.** The TS renderer uses ANSI columns and a `#<6char>` id; the Rust edge
   logs the same fields (`request_id`, method, redacted path/query, status, duration) through
   `tracing` with no colour. Redaction is identical.

5. **Validation issue text** is best effort. `code`, `path`, `unrecognized_keys.keys` and the
   status are the contract; zod's human messages are not byte-identical.

6. **Health `uptime` is integer seconds** and the payload adds `implementation: "rust"`
   (chapter 2 §20 additive marker). The TS value is a float.

7. **Response `x-pg-served-by` / `x-pg-min-lsn` relay is not performed** because the TS checkout
   routes do not relay them either (`res.json(payload)`), despite the shared chapter 2 §10 prose.

8. **Rate limit headers** are `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and
   `Retry-After`; the exact `express-rate-limit` v8 draft header variant may differ.

9. **`GET /health` is inside the catch-all dispatcher** rather than a separate ntex resource;
    the observable response and the pre-parser ordering are unchanged.

10. **`cross-origin-resource-policy: cross-origin`** follows `checkout-back/lib/security` while
    chapter 2 §2 says `same-origin`; TS wins in Track P.

11. **Non-UTF-8 JSON charsets are refused `415`.** `body-parser` decodes any `iconv` charset; the
    Rust reader accepts UTF-8 (and `us-ascii` is valid UTF-8) and refuses a different declared
    charset rather than decoding it wrongly.

12. **One reqwest pool, not two socket agents.** TS keeps a 64-socket request agent and a separate
    128-socket SSE agent; Rust uses one hyper/reqwest pool with `pool_max_idle_per_host(64)`.
    SSE keeps the 10-minute deadline, `MAX_STREAMS_PER_IP` slots and true streaming, but there is
    no separate cap on concurrent active sockets.

13. **Connect timeout is client-wide.** `CORE_REQUEST_TIMEOUT_MS` sets the reqwest connect timeout
    and the per-chunk idle timeout; a per-route `timeoutMs` (inbound 10 s, SSE 10 min) overrides
    the idle and total deadlines but not the connect timeout.

14. **Unknown-key validation details are best effort when a body also has invalid known fields.**
    Status and code are always `400 VALIDATION_FAILED`; the issue list reports the unknown keys
    first, as the Rust reader stops at the `.strict()` object check.

15. **Sandbox plane markers are added.** The TS checkout edge selects the Sandbox core pool but
    does not add `x-execution-plane`/`x-sandbox-proxy` (only the admin/merchant sandbox proxies do).
    The Rust port sets both on every Sandbox call, as the P2-T03 contract requires; core that keys
    on the headers therefore sees a plane marker it would not see from the TS checkout edge.

16. **`x-request-id` is not echoed on the response.** Chapter 2 §2 says to echo it, but neither
    `checkout-back/index.ts` nor its logger sets the response header; the edge resolves it, forwards
    it to core and logs it. TS wins in Track P. The Rust edge resolves it once and reuses that value
    for the forward and the log line; TS calls `resolveRequestId` separately in the handler and the
    logger, so an invalid incoming id can produce two different generated ids there.
17. **Brotli compressed input is capped at `MAX_INBOUND_BODY_BYTES` + 64 KiB.** The output is
    streamed through a capped `Read` adapter and an oversized result is `413 PAYLOAD_TOO_LARGE`;
    a deliberately padded brotli stream whose inflated output is under the limit is therefore
    refused `413` rather than buffered without bound.

## Files

| File | Contents |
| :--- | :--- |
| `src/main.rs` | CLI, `config validate`, `serve` |
| `src/config.rs` | `CheckoutConfig::load`, defaults, ranges, limiter keys |
| `src/error.rs` | envelope, core status mapping, public inbound errors |
| `src/validation.rs` | zod-equivalent schemas and client-event aliases |
| `src/monetary.rs` | zero-trust monetary scanner |
| `src/inbound.rs` | header allow-list, environment translation, channel keys |
| `src/logging.rs` | request-id rules, URL/secret/header redaction |
| `src/routes.rs` | the complete checkout route table |
| `src/body.rs` | JSON/urlencoded/raw readers, gzip/deflate/zstd, limits |
| `src/core.rs` | `CoreTransport`, reqwest mTLS executor, pools, retries, streams |
| `src/service.rs` | pipeline, handlers, SSE slots, limiters |
| `src/server.rs` | ntex adapter, middleware, CORS, HEAD suppression |

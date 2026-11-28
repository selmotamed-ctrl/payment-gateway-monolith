# merchant-edge (Rust/ntex)

Rust port of `merchant-back` — phase **P2-T04** of the Rust/ntex port. The binary serves the whole
merchant edge: the 105 merchant API routes of
`backend-rs/tests/golden-vectors/route-inventory/edge-routes.json` (`service: "merchant-back"`),
`GET /health`, and the `/api/v1/merchant/sandbox/{*rest}` wildcard of the Sandbox Studio proxy.

- Library: `merchant_edge` (`src/lib.rs`) — route table, dispatcher, contract translation, core
  transport. Integration tests drive the same dispatcher the service uses.
- Binary: `merchant-edge` (`src/main.rs`) — `serve`, `config validate`, `routes`.
- The TS edge terminates no TLS (nginx does), so the Rust service also listens on plain HTTP.

```bash
cd backend-rs
cargo run -p merchant-edge -- serve               # PORT 4102, BIND_HOST 0.0.0.0
cargo run -p merchant-edge -- config validate     # env + mTLS material
cargo run -p merchant-edge -- routes              # print the registered table
cargo test -p merchant-edge
cargo clippy -p merchant-edge --all-targets -- -D warnings
```

## Routes

Registration order is Express order. Static paths are declared before dynamic patterns that could
shadow them (report-engine chrome/migration routes), and `/sandbox/{*rest}` is the last merchant
route so every explicit Sandbox Studio upload keeps priority.

| Group | Count | Middleware |
| :--- | ---: | :--- |
| public | 1 | security headers, CORS, request log, 404, `/health` |
| auth | 16 | `cookieSession`, `requireMerchantAudience`, logout before the login limiter, auth 20/15 min, per-account failure limiters, optional session-cookie capture |
| onboarding | 9 | API 300/60 s, mandatory bearer, upload 10/min + session shape + declared length before multipart |
| protected | 76 | API 300/60 s, `cookieSession`, audience, forwarded with the canonical contract |
| external | 4 | client 600/60 s (5 × external), `pg_live_`/`pg_test_` token shape, token+IP 120/60 s |
| sandbox wildcard | 1 | protected middleware, then `/sandbox/*` → Sandbox core only |

`merchant-edge routes` prints every line; the full list is:

```
GET    /health
POST   /api/v1/merchant/auth/logout
POST   /api/v1/merchant/auth/register
POST   /api/v1/merchant/auth/verify-identity
POST   /api/v1/merchant/auth/accept-invitation
POST   /api/v1/merchant/auth/login
POST   /api/v1/merchant/auth/google/start
POST   /api/v1/merchant/auth/google
GET    /api/v1/merchant/auth/google/callback
POST   /api/v1/merchant/auth/google/exchange
POST   /api/v1/merchant/auth/email/verify
POST   /api/v1/merchant/auth/email/resend
POST   /api/v1/merchant/auth/password/forgot
POST   /api/v1/merchant/auth/password/reset
GET    /api/v1/merchant/auth/me
POST   /api/v1/merchant/auth/mfa/verify
POST   /api/v1/merchant/auth/mfa/resend
GET    /api/v1/merchant/onboarding/join-request
PUT    /api/v1/merchant/onboarding/join-request
POST   /api/v1/merchant/onboarding/join-request/withdraw
GET    /api/v1/merchant/onboarding/kyb-revalidations
POST   /api/v1/merchant/onboarding/kyb-documents
GET    /api/v1/merchant/onboarding/beneficial-owners
POST   /api/v1/merchant/onboarding/beneficial-owners
DELETE /api/v1/merchant/onboarding/beneficial-owners/:id
POST   /api/v1/merchant/onboarding/submit
GET    /api/v1/merchant/wallets
POST   /api/v1/merchant/wallets
GET    /api/v1/merchant/wallets/:id/balance
GET    /api/v1/merchant/wallets/:id/statements
GET    /api/v1/merchant/wallets/:id/statements/:month/export
GET    /api/v1/merchant/wallets/:id
GET    /api/v1/merchant/applications
POST   /api/v1/merchant/applications
PATCH  /api/v1/merchant/applications/:id
GET    /api/v1/merchant/applications/:id
GET    /api/v1/merchant/links
POST   /api/v1/merchant/links
GET    /api/v1/merchant/links/:id
POST   /api/v1/merchant/links/:id/cancel
GET    /api/v1/merchant/links/:id/attempts
GET    /api/v1/merchant/pos/terminals
POST   /api/v1/merchant/pos/terminals
PATCH  /api/v1/merchant/pos/terminals/:id
POST   /api/v1/merchant/pos/terminals/:id/screens
GET    /api/v1/merchant/pos/screens/:screenCode/stream
GET    /api/v1/merchant/pos/terminals/:id
GET    /api/v1/merchant/payments
GET    /api/v1/merchant/disputes
POST   /api/v1/merchant/disputes/:id/evidence
GET    /api/v1/merchant/disputes/:id/attachments
POST   /api/v1/merchant/disputes/:id/attachments
GET    /api/v1/merchant/disputes/:id/attachments/:attachmentId/content
DELETE /api/v1/merchant/disputes/:id/attachments/:attachmentId
GET    /api/v1/merchant/disputes/:id
GET    /api/v1/merchant/cashouts
POST   /api/v1/merchant/cashouts
GET    /api/v1/merchant/tokens
POST   /api/v1/merchant/tokens
PUT    /api/v1/merchant/tokens/:id/ips
DELETE /api/v1/merchant/tokens/:id
GET    /api/v1/merchant/credential-sets
POST   /api/v1/merchant/credential-sets
PUT    /api/v1/merchant/credential-sets/:id
GET    /api/v1/merchant/credential-sets/:id
GET    /api/v1/merchant/users
POST   /api/v1/merchant/users
PATCH  /api/v1/merchant/users
PATCH  /api/v1/merchant/users/:id
GET    /api/v1/merchant/stats/overview
GET    /api/v1/merchant/webhooks/event-types
GET    /api/v1/merchant/webhooks/endpoints
POST   /api/v1/merchant/webhooks/endpoints
PATCH  /api/v1/merchant/webhooks/endpoints/:id
POST   /api/v1/merchant/webhooks/endpoints/:id/rotate-secret
POST   /api/v1/merchant/webhooks/endpoints/:id/test
GET    /api/v1/merchant/webhooks/deliveries
POST   /api/v1/merchant/webhooks/deliveries/:id/redeliver
GET    /api/v1/merchant/report-engine/catalog
GET    /api/v1/merchant/report-engine/autocomplete/:sourceKey
POST   /api/v1/merchant/report-engine/catalog/:code/execute
GET    /api/v1/merchant/report-engine/studio/transcript
POST   /api/v1/merchant/report-engine/studio/verify
POST   /api/v1/merchant/report-engine/studio/preview
POST   /api/v1/merchant/report-engine/studio/specs
GET    /api/v1/merchant/report-engine/studio/specs
GET    /api/v1/merchant/report-engine/studio/specs/:id
POST   /api/v1/merchant/report-engine/studio/specs/:id/publish
POST   /api/v1/merchant/report-engine/studio/specs/:id/archive
GET    /api/v1/merchant/report-engine/studio/usage
POST   /api/v1/merchant/report-engine/studio/templates/:code/clone
GET    /api/v1/merchant/report-engine/studio/chrome
GET    /api/v1/merchant/report-engine/studio/chrome/transcript
GET    /api/v1/merchant/report-engine/studio/chrome/needs-migration
GET    /api/v1/merchant/report-engine/studio/chrome/:id
POST   /api/v1/merchant/report-engine/studio/chrome
POST   /api/v1/merchant/report-engine/studio/chrome/:id/archive
POST   /api/v1/merchant/report-engine/studio/chrome/:id/set-default
GET    /api/v1/merchant/report-engine/studio/chrome/:id/migration-prompt
GET    /api/v1/merchant/report-engine/studio/needs-migration
GET    /api/v1/merchant/report-engine/studio/specs/:id/migration-prompt
POST   /api/v1/merchant/sandbox/mirror/disputes/:id/attachments
*      /api/v1/merchant/sandbox/{*rest}
POST   /api/v1/external/links
GET    /api/v1/external/links/:key
POST   /api/v1/external/links/:key/cancel
GET    /api/v1/external/payments/:reference
```

The 76 `protected` routes include the report-engine, webhook and Sandbox upload routes of the TS
`api/protected/index.ts` mount table; the wildcard row is the `/sandbox` catch-all it cannot
express.

## Environment

The zod schema of `merchant-back/lib/env/index.ts` is reproduced key by key. Missing required
values or out-of-range values fail startup with
`Invalid environment configuration: [{"path":…,"code":…,"message":…}]`.

| Key | Default | Rule |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `4102` | 1–65535 |
| `BIND_HOST` | `0.0.0.0` | non-empty |
| `CORE_BACK_URL` | — (required) | absolute `https:` URL |
| `CORE_BACK_URLS` | — | comma list, de-duplicated, https only |
| `SANDBOX_CORE_BACK_URL` | — | optional absolute https URL |
| `SANDBOX_CORE_BACK_URLS` | — | optional comma list; unset → Sandbox 503 |
| `MTLS_CLIENT_CERT_PATH` / `MTLS_CLIENT_KEY_PATH` / `MTLS_CA_CERT_PATH` | — (required) | PEM files, checked at boot |
| `CORE_REQUEST_TIMEOUT_MS` | `30000` | 1 000–300 000 |
| `CORE_TOTAL_DEADLINE_MS` | `300000` | 1 000–1 800 000 |
| `CORE_MAX_RESPONSE_BYTES` | `67108864` | 1 024–536 870 912 |
| `TRUSTED_PROXY_CIDRS` | `127.0.0.0/8,::1/128` | only these peers may set `x-real-ip` / `x-real-client-ip` |
| `CORS_ALLOWED_ORIGINS` | `""` | exact origins; empty emits no CORS headers |
| `MAX_STREAMS_PER_IP` | `5` | 1–1 000 |
| `MAX_JSON_BODY_BYTES` | `2097152` | 1 024–10 485 760 |
| `MAX_UPLOAD_BYTES` | `10485760` | 1 024–26 214 400 |
| `UPLOAD_ALLOWED_MIME` | `image/png,image/jpeg,application/pdf` | lowercase allow-list |
| `UPLOAD_RATE_LIMIT_MAX` | `10` | uploads per client IP per minute |
| `AUTH_RATE_LIMIT_MAX` | `20` | auth per client IP per window |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `900000` | ≥ 1 000 |
| `API_RATE_LIMIT_MAX` | `300` | merchant portal per client IP per window |
| `API_RATE_LIMIT_WINDOW_MS` | `60000` | ≥ 1 000 |
| `EXTERNAL_RATE_LIMIT_MAX` | `120` | per token+IP; the IP ceiling is 5× |
| `EXTERNAL_RATE_LIMIT_WINDOW_MS` | `60000` | ≥ 1 000 |
| `TOKEN_DEFAULT_TTL_DAYS` | `90` | 1–3 650 |
| `TOKEN_MAX_TTL_DAYS` | `365` | 1–3 650 |
| `TOKEN_MAX_SCOPES` | `20` | 1–50 |
| `PG_LIVE_TOKEN_PREFIX` | `pg_live_` | 4–32 chars |
| `SESSION_COOKIE_MODE` | `false` | `true`/`false` |
| `SESSION_COOKIE_SECURE` | `true` | `true`/`false` |
| `POS_STREAM_TIMEOUT_MS` | `900000` | 1 000–3 600 000 |
| `APP_RELEASE` / `APP_COMMIT` / `GIT_COMMIT` | `dev` / `unknown` | health identity |

Read outside the schema (like TS): none. `DOTENV_PATH`/`.env` are read by `pg-config` before the
process environment.

## Behaviour contract

- **Middleware order**: security headers → CORS → request id/log → `/health` → JSON (2 MiB, or
  24 MiB on `/api/v1/merchant/sandbox/mirror/report-engine*`) / urlencoded (2 MiB) → router
  (`cookieSession` → `requireMerchantAudience` → group limiters → route) → 404 → error envelope.
- **Errors**: `{"code","message","reference"?,"details"?}`; validation is
  `400 VALIDATION_FAILED` with the zod issue list; core errors keep the core status, code,
  message, details and reference; a bare core 4xx/5xx uses the TS fallback table.
- **404**: `{"code":"NOT_FOUND","message":"No route matches <METHOD> <path>"}`.
- **Limiters**: one shared fixed-window map per process (not per ntex worker). Auth failures are
  counted per account+IP and per account ceiling (5×), successful requests are released
  (`skipSuccessfulRequests`). 429 bodies are the TS messages; uploads/API/external also carry
  `RateLimit-Limit`/`RateLimit-Remaining` (+`Retry-After` when refused).
- **Sessions**: `pg_merchant_session`, `Path=/api/v1/merchant`, `HttpOnly; SameSite=Strict`,
  `Secure` unless disabled, `Max-Age=43200`. Cookie-authenticated unsafe methods need
  `x-pg-csrf: 1`; login/MFA/register/verify-identity/google are exempt; an explicit
  `Authorization` wins. Login/MFA/exchange move `token` into the cookie and answer
  `sessionCookie: true`.
- **Uploads**: the per-IP budget (10/min), a plausible merchant session (HS256, `typ=session`,
  merchant audience, unexpired, `nbf` within 60 s) and the declared `Content-Length` are checked
  before a byte is buffered; multipart is parsed in memory with `files: 1`, `fields: 32` and
  `MAX_UPLOAD_BYTES`. Magic bytes must be PNG/JPEG/PDF and match the declared type; forward to
  core uses `x-upload-filename` (URI-encoded), `x-upload-content-type` (detected),
  `x-upload-sha256`, `x-upload-size` and base64url `x-upload-metadata`.
- **External API**: `pg_live_`/`pg_test_` + 43 base64url chars; Live tokens target the Live pool,
  `pg_test_` tokens the Sandbox pool. `/external/*` forwards the bearer unchanged.
- **Upstream**: mTLS TLS 1.3 (`reqwest` + rustls identity), `CORE_BACK_URLS` least-in-flight pool,
  passive health (3 failures → 5 s cooldown, half-open probe), retries before send for
  GET/HEAD/PUT/DELETE/OPTIONS, after send only GET/HEAD/OPTIONS or `Idempotency-Key`, 64 MiB
  response cap, `x-request-id`/`x-real-client-ip`/`x-client-user-agent`/`x-edge-service` set by the
  edge, hop-by-hop/framing headers stripped, `content-length` recomputed. Paths are confined to
  `/internal/merchant` and `/internal/sandbox`; `//`, `..`, `\` and bad escapes are refused.
- **Sandbox**: every `/api/v1/merchant/sandbox/*` call goes to `SANDBOX_CORE_BACK_URLS` with
  `x-execution-plane: SANDBOX` and `x-sandbox-proxy: merchant-back`. `/studio/*`, `/overview`,
  `/seed-*`, `/reset`, `/webhooks/test-ping`, wallet/payment details, dispute resolve and
  `/reconciliation/*` map to `/internal/sandbox/merchant*`; `/fake-rails/*` maps to
  `/internal/sandbox/fake-rails/*`; list/create routes keep `/internal/merchant*` **on the
  sandbox pool**. `/mirror/*` always uses `/internal/merchant*` on the sandbox pool and relays
  the raw body with `content-type`/`content-disposition`. An unset sandbox pool is
  `503 SANDBOX_NODE_UNAVAILABLE`; there is no fallback to Live.
- **SSE/streams**: POS screen streams and dispute attachment downloads stream through with
  `content-type` (from core), `cache-control: no-cache, no-transform`, `connection: keep-alive`,
  `x-accel-buffering: no`; `MAX_STREAMS_PER_IP` limits concurrent streams; the upstream is
  aborted when the client disconnects and the slot is released on drop.

## Tests

The TS suites are ported with a fake core (`upstream::test_support::FakeCore`) that records the
exact path/method/query/headers/body the edge would send:

| Rust tests | TS source |
| :--- | :--- |
| `tests/core_forwarding.rs` | `test/core-forwarding.test.ts`, `test/webhooks-forwarding.test.ts`, `test/merchant-kyb-and-external.test.ts` (KYB uploads), `test/report-engine-route-order.test.ts` (route table unit tests) |
| `tests/security_and_sandbox.rs` | `test/security-regressions.test.ts`, `test/sandbox-proxy.test.ts`, `test/sandbox-routing.test.ts`, `test/session-cookie-and-logout.test.ts`, `test/auth-account-limiters.test.ts` (via the app-level limiter tests), `test/merchant-kyb-and-external.test.ts` (external + POS SSE) |
| `tests/http_server.rs` | ntex shell: security headers, 404, JSON limit, upload preflight ordering, CORS preflight |
| `tests/client_build.rs` | reqwest/rustls provider trap: the mTLS client must build after `install_crypto_provider` |
| `tests/mtls_handshake.rs` | live rustls server with the internal CA, client certificate required, TLS 1.3: a good client answers 200 and a foreign identity fails closed |
| `tests/inventory.rs` | exact coverage of the 106 merchant entries of `edge-routes.json` (105 API + `/health`) and no invented route except the documented `/sandbox/{*rest}` wildcard |
| inline `#[cfg(test)]` | `api/contract.ts` (mappers), `lib/zReady` (validation/transforms), `lib/authLimiters.ts` (failure-only budgets), `lib/coreInternalClient.ts` (pool selection, header safety, JSON parsing), `api/sandboxProxy.ts` (`proxyPath`), `api/upload.ts` (magic/size/type) |

`cargo test -p merchant-edge` runs 153 tests (103 library, 1 binary, 49 integration).

## Deviations from the TypeScript edge

Track P keeps TS behaviour; the list below is every intentional difference (planned entries belong
in `backend-rs/DEVIATIONS.md`; this file is the P2-T04 report).

1. **Request id is not echoed on the response.** `resolveRequestId` in all three TS edges only
   forwards `x-request-id` to core; chapter 2 §2 says "echo on the response". Rust matches the
   code (no response header) to keep parity tests header-identical. It is validated
   (`^[A-Za-z0-9._:-]{1,128}$`) or replaced with a UUIDv4 and forwarded to core.
2. **Logging is structured `tracing`** (`request_id`, method, path, status, duration) instead of
   the ANSI request logger text. Edges have no access-log database sink; 5xx log at `warn`.
3. **mTLS material is validated at boot.** TS creates the `https.Agent` lazily on the first call;
   the Rust client is built in `AppState::production`, so a missing/unreadable PEM is a startup
   error instead of a first-request `500 MTLS_MATERIAL_UNAVAILABLE`.
4. **`/health` uptime is integer seconds** and the payload carries the additive
   `implementation: "rust"` marker (shared `pg-http::EdgeHealth` contract).
5. **Zod issue text is best-effort.** Codes and paths match (`invalid_type`, `too_small`,
   `too_big`, `invalid_format`, `invalid_value`, `unrecognized_keys`, `invalid_union`, `custom`);
   `message` wording is close but not byte-identical (allowed by chapter 2 §4).
6. **Google callback redirect has an empty body**; Express also writes a short "Found" HTML body.
7. **Non-preflight `OPTIONS`** answers the 404 envelope. Express's router would answer `Allow` for
   a known path; no merchant client or test uses it.
8. **`HEAD` is served by the `GET` handler** with the body stripped (Express parity).
9. **Zod `union` errors** carry a simplified `errors` array (issue groups) rather than zod's exact
   nested shape; the top-level code/path match.
10. **Uploads are buffered after the preflight guards** (multer also buffers). The byte cap,
    `files: 1`, `fields: 32`, `LIMIT_*` mapping and magic/declared-type checks are reproduced;
    the parser additionally enforces the cap while scanning and rejects a second file in one
    field (`maxCount: 1`).
11. **Sandbox availability is read from the configuration**, not from the transport object, so a
    fake/embedded transport can never accidentally enable a fallback. Production resolves the same
    value (`SANDBOX_CORE_BACK_URLS` set and non-empty).
12. **`merchant-back/api/protected/options.ts` is dead code in TS** (never mounted in
    `protected/index.ts`); it is not implemented (it is also absent from the route inventory).
13. **The Sandbox wildcard is not in the route inventory.** The AST inventory cannot express a
    `router.use("/sandbox", …)` catch-all; the Rust table registers it explicitly, last.
14. **Upstream transport is `reqwest` + rustls**, not `node:https`; retry, health, header,
    path-confinement and timeout rules come from `pg-upstream` and match chapter 2 §10.
    TLS is pinned to 1.3 in both directions.
15. **`CORE_RESPONSE_TOO_LARGE` message** is the exact TS text
    ("Core response exceeded the edge size limit") instead of the pool's size-annotated variant.
16. **`ipKeyGenerator` IPv6 grouping** is /56 as in express-rate-limit v8; IPv4 keys are plain.

## Missing dependencies

None. The crate only uses `[workspace.dependencies]`; `ipnet` (address families) and the dev-only
`rcgen` (client-build test certificates) were added to this crate's manifest from the workspace.
No other directory or the root `Cargo.toml` was modified.

## Follow-ups for the coordinator

- ntex's router tail syntax is `{tail}*`, not `{tail:.*}` (the latter matches a single segment).
  The merchant edge uses the correct form; every other ntex service should be checked for the same
  one-character trap when its catch-all is wired.
- `tests/mtls_handshake.rs` runs a real rustls server on loopback; a full core still needs the
  P2-T06 staging soak (route behavior against the real core, not a fake).

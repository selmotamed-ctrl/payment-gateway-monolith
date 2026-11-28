# admin-edge (Rust port of `admin-back`)

`admin-edge` is the Rust/ntex implementation of the admin back-office edge. It serves the same
public contract as `admin-back`: authentication, MFA, the LAN guard, advisory authority hints, the
core mTLS proxy, contract translation, multipart uploads, the sandbox proxy, academy/search rate
limits and the report-engine 24 MB JSON paths.

The TS `admin-back` remains the reference. This crate intentionally keeps the TS vocabulary,
error codes, limits and middleware order (see "Deviations" for the few deliberate differences).

## Coverage

The route inventory (`backend-rs/tests/golden-vectors/route-inventory/edge-routes.json`) lists 419
admin rows: `/health`, 10 auth rows and 408 protected rows. Two auth rows are the `/auth/login` and
`/auth/mfa` limiter registrations for the same handlers, so there are **416 distinct
method + path API routes + `/health`**.

| # | Area | Inventory rows | Served | Notes |
| ---: | :--- | ---: | :--- | :--- |
| 1 | `/health` | 1 | yes | `{status, service, release, commit, uptime, impl:"rust"}` |
| 2 | `/auth/*` | 10 | yes | 8 handlers; 2 rows are the login/MFA limiter registrations |
| 3 | `access-tokens` | 2 | yes | list + summary |
| 4 | `academy` | 9 | yes | progress, exams, certificate, team (SECURITY_ADMIN), export |
| 5 | `aml` | 83 | yes | screenings, matches, cases, rules, reporting rules, reports, report schemas, incidents, filing adapters |
| 6 | `applications` | 5 | yes | list/summary/detail/patch/token revoke |
| 7 | `approvals` | 9 | yes | list/export/summary/bulk-reject/detail/approve/reject/extend-emergency |
| 8 | `assets` | 6 | yes | 5 JSON/raw + multipart upload |
| 9 | `audit-logs` | 5 | yes | list/export/summary/export/detail |
| 10 | `credential-sets` | 6 | yes | list/detail/create/update/verify/revoke |
| 11 | `disputes` | 11 | yes | 10 JSON/raw + multipart attachment upload |
| 12 | `adjustments` | 6 | yes | list/export/summary/detail/create |
| 13 | `cashouts` | 6 | yes | list/export/summary/detail/process |
| 14 | `commission-profiles` | 5 | yes | list/summary/create/history/expire |
| 15 | `velocity-rules` | 5 | yes | list/summary/create/history/deactivate |
| 16 | `finance` | 18 | yes | profitability, liquidity, invariant, route caps, journal entries, GL accounts, shard repair/scale, checkpoint |
| 17 | `gateways` | 14 | yes | list/create/summary/export/detail/patch/rollback/health/versions/AI spec |
| 18 | `gateway-versions` | 13 | yes | clone/detail/environments/auth/settings/crypto/flows/channels/status rules/error maps/dry-run/suite/approval |
| 19 | `join-requests` | 19 | yes | 18 JSON + multipart KYB upload |
| 20 | `kyb-documents` | 9 | yes | list/summary/detail/review/replacement/revalidation/content |
| 21 | `merchants` | 28 | yes | list/detail/resources/stats/mutations/beneficial owners/revalidations |
| 22 | `object-storage` | 7 | yes | summary/access logs/objects/legal hold/maintenance |
| 23 | `gateway-inquiries` | 7 | yes | list/summary/detail/cancel/run-now/retry |
| 24 | `operator-cases` | 12 | yes | list/summary/export/bulk/patch/resolve/acknowledge/catalog |
| 25 | `attempts` | 2 | yes | detail/inquire |
| 26 | `options` | 1 | yes | merchants/rails/gateways/users/applications/wallets/credential-sets/gl-accounts |
| 27 | `payment-links` | 2 | yes | list/state |
| 28 | `pos-terminals` | 2 | yes | list/status |
| 29 | `rails` | 8 | yes | list/create/summary/export/detail/patch/fields |
| 30 | `routes` | 12 | yes | list/create/patch/summary/export/detail/state/health/probe/override/clear |
| 31 | `reconciliation` | 10 | yes | sources, multipart statement upload, runs, summary, statement, export |
| 32 | `report-engine` | 31 | yes | transcript, specs, catalog, execute, chrome, merchant reports, AML bypass, migrations |
| 33 | `search` | 1 | yes | 120/min per session |
| 34 | `settings` | 17 | yes | platform settings, restore, communication, checkout support, notification templates |
| 35 | `stats` | 5 | yes | overview/export/export-audit/recent activity |
| 36 | `system` | 12 | yes | backups (5) + jobs/outbox/audit-outbox/notifications (7) |
| 37 | `transactions` | 3 | yes | list/summary/summary export |
| 38 | `inbound-events` | 2 | yes | list/detail |
| 39 | `users` | 9 | yes | list/export/summary/create/invite/bulk patch/patch/detail |
| 40 | `wallets` | 6 | yes | list/summary/detail/statement/audit-events/status |
| 41 | `/api/v1/admin/sandbox/**` | catch-all | yes | `sandboxProxy` (not represented in the inventory because it is an Express `use`) |

### Routes answering `501 NOT_IMPLEMENTED_ROUTE`

**None.** Every route in the inventory is implemented. The multipart routes are implemented in
`src/upload.rs` + `src/dispatch.rs`; the sandbox catch-all in `src/sandbox.rs` + `src/dispatch.rs`.

The table itself (`src/routes.rs`) has 411 rows: 8 auth + 403 JSON/raw/local handlers. The other 5
protected routes are multipart. Unknown paths answer `404 NOT_FOUND` with
`{"code":"NOT_FOUND","message":"No route matches <METHOD> <path>"}`; nothing is guessed or routed
to a similar path.

## Layout

| File | Port of |
| :--- | :--- |
| `src/main.rs` | `admin-back/index.ts`, CLI (`serve`, `config validate`) |
| `src/config.rs` | `admin-back/lib/env/index.ts` |
| `src/auth.rs` | `api/middleware/authorityGuard.ts`, `lib/authLimiters.ts` |
| `src/schema.rs` + `src/schemas.rs` | the zod schemas of every router (`zReady`, `parseOrThrow`) |
| `src/contract.rs` | `api/contract.ts` (the full 1,691-line translation table) |
| `src/client.rs` | `lib/coreInternalClient.ts`, `lib/corePools.ts`, `lib/mtlsClient` |
| `src/dispatch.rs` | `index.ts`, `api/index.ts`, `api/forward.ts`, `api/upload.ts`, `api/sandboxProxy.ts`, `lib/security/*`, `lib/requestLogger` (request id) |
| `src/routes.rs` | every `api/protected/*.ts` and `api/public/auth.ts` route registration + guards |
| `src/upload.rs` | `api/upload.ts`, `lib/zReady` (`detectUploadMime`, `assertAllowedUpload`), asset sniffing |
| `src/sandbox.rs` | `api/sandboxProxy.ts` (`targetPath`) |
| `src/limits.rs` | `express-rate-limit` instances + search/academy buckets |

## Behaviour

- **Middleware order**: security headers → CORS → request id → `/health` → LAN guard →
  cookie session → admin/auth limiters → session shape → method authority guard → body/params/query
  validation → contract translation → core call → response relay.
- **LAN guard**: `ADMIN_LAN_CIDRS` (default loopback + RFC1918). The client IP is resolved through
  `TRUSTED_PROXY_CIDRS` (default loopback) with `x-real-ip` first and `x-real-client-ip` second.
  A non-LAN peer gets `403 ADMIN_LAN_ONLY` with `details.clientIp`.
- **Request id**: an incoming `x-request-id` matching `^[A-Za-z0-9._:-]{1,128}$` is used,
  otherwise a UUIDv4 is generated; the value is forwarded to core, whose error envelopes use it
  as their `reference`. It is **not** echoed on the response: the TS request logger does not set
  that header, and TS wins in Track P (chapter 2 §2 says echo; recorded below).
- **Sessions**: the edge never verifies the signature (core owns the key). It refuses every
  credential that is not shaped like a live core session (HS256 header, `typ:"session"`,
  issuer, admin audience, `exp`, optional `nbf`) with `401 AUTH_INVALID`, and applies the
  mount-level any-of authority lists in `src/routes.rs` (`403 EDGE_AUTHORITY_DENIED`).
  `ADMIN_AUTHORITY_HINTS` can only narrow a guard.
- **Cookie mode** (`SESSION_COOKIE_MODE=true`): login/MFA move `token` into the
  `pg_admin_session` HttpOnly/SameSite=Strict cookie (`Path=/api/v1/admin`, `Max-Age=43200`,
  `Secure` unless `SESSION_COOKIE_SECURE=false`); unsafe cookie-authenticated requests need
  `x-pg-csrf: 1`; logout always clears the cookie.
- **Limits**: admin 600/60 s, auth 10/15 min, API search 120/min per (ip, subject), academy
  60/min per user, uploads 20/window, backup jobs 6/10 min. Account limiters count failed logins
  only, per (account, address) with a 5× account-wide ceiling.
- **Body limits**: 4 MiB (`MAX_JSON_BODY_BYTES`) everywhere except
  `^/api/v1/admin/(sandbox/mirror/)?report-engine(/|$)` which gets 24 MB. Multipart uploads are
  bounded by `MAX_UPLOAD_BYTES` + 256 KiB of framing; the file limit is enforced while parsing.
- **Core proxy**: `CORE_BACK_URLS` (deduped, absolute `https:`) least-in-flight with monotonic
  round-robin tie-break, passive health (3 failures → 5 s ejection, half-open single probe),
  two attempts, replay only for read-only/idempotency-key/opt-in requests, TLS 1.3 only with the
  internal CA and client certificate, 60 s idle / 300 s total deadline / 64 MiB response cap.
  The Sandbox pool (`SANDBOX_CORE_BACK_URLS`) is separate, carries
  `x-execution-plane: SANDBOX` + `x-sandbox-proxy: admin-back`, and never falls back to Live
  (`503 SANDBOX_NODE_UNAVAILABLE`).
- **Uploads**: raw bytes with `x-upload-filename` (URI-encoded), `x-upload-content-type`
  (magic-byte detected), `x-upload-sha256`, `x-upload-size`, `x-upload-metadata` (base64url JSON),
  and `x-statement-source-id` for reconciliation.
- **Raw downloads** relay `content-type`, `content-disposition`, `x-content-sha256`,
  `x-pg-served-by`, `x-pg-min-lsn`; KYB documents and brand assets are forced to a download/inline
  disposition with a sandbox CSP and a fixed content-type allowlist.

## Environment

| Key | Default | Notes |
| :--- | :--- | :--- |
| `PORT` | `4101` | |
| `ADMIN_BIND_HOST` | `127.0.0.1` | LAN-facing bind address |
| `CORE_BACK_URLS` | — | comma-separated absolute `https:` URLs |
| `CORE_BACK_URL` | — | fallback when `CORE_BACK_URLS` is absent; the first list entry is used if only the list exists |
| `SANDBOX_CORE_BACK_URLS` / `SANDBOX_CORE_BACK_URL` | unset | unset = Sandbox not configured |
| `MTLS_CLIENT_CERT_PATH`, `MTLS_CLIENT_KEY_PATH`, `MTLS_CA_CERT_PATH` | required | PEM files |
| `CORE_REQUEST_TIMEOUT_MS` | `60000` | 1000..300000 |
| `CORE_TOTAL_DEADLINE_MS` | `300000` | 1000..1800000 |
| `CORE_MAX_RESPONSE_BYTES` | `67108864` | 1024..536870912 |
| `TRUSTED_PROXY_CIDRS` | `127.0.0.0/8,::1/128` | forwarded IP headers are trusted only from these peers |
| `CORS_ALLOWED_ORIGINS` | empty | empty = no CORS headers |
| `ADMIN_LAN_CIDRS` | `127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | |
| `ADMIN_AUTHORITY_HINTS` | empty | restriction list for edge authority guards |
| `MAX_JSON_BODY_BYTES` | `4194304` | |
| `MAX_UPLOAD_BYTES` | `20971520` | |
| `UPLOAD_ALLOWED_MIME` | `text/csv,application/vnd.ms-excel,application/json` | statement uploads |
| `ADMIN_RATE_LIMIT_MAX` / `ADMIN_RATE_LIMIT_WINDOW_MS` | `600` / `60000` | |
| `UPLOAD_RATE_LIMIT_MAX` | `20` | per admin window |
| `BACKUP_JOB_RATE_LIMIT_MAX` | `6` | per 10 minutes |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS` | `10` / `900000` | |
| `SESSION_COOKIE_MODE` | `false` | `true` moves the session into the HttpOnly cookie |
| `SESSION_COOKIE_SECURE` | `true` | |
| `RECONCILIATION_TIMEOUT_MS` | `120000` | statement upload core timeout |
| `APP_RELEASE`, `APP_COMMIT` / `GIT_COMMIT` | `dev`, `unknown` | `/health` |
| `DOTENV_PATH` | `.env` | `pg-config` behaviour |

## Tests

```bash
cd backend-rs
cargo test -p admin-edge
cargo clippy -p admin-edge --all-targets -- -D warnings
cargo fmt -p admin-edge --check
```

102 tests currently cover:

- the complete translation table (`contract_tests.rs`: each mapper only emits core keys and always
  emits required ones; unsupported decisions and missing canonical fields; legacy aliases),
- an exact set comparison against the committed 419-row route inventory (`routes::tests`), so a
  missing or extra method + path fails the build,
- the backup cron rules (valid ranges, rejected names/macros, minimum gaps),
- the zod subset (`strict`/strip/passthrough, defaults, coercion, refinements, money/UUID/email
  patterns, passwords),
- the LAN guard, session/authority hints (expired, wildcard, restriction list), forwarded headers
  and client IP resolution,
- 4 MiB vs 24 MB report-engine limits (including a declared length above 24 MB),
- 404 body, malformed JSON, unknown-key rejection before core,
- admin/auth/backup/search limiters and failure-only account limits,
- cookie mode, CSRF, logout and `Set-Cookie`,
- sandbox path rewrite, Sandbox-only pool/headers, mirror relay, fail-closed without a node,
- multipart uploads (`x-upload-*`, raw bytes, signature mismatch, upload limiter),
- `relayStatus` (202) vs declared 201,
- bulk approval reject and bulk user patch fan-out,
- HEAD served from GET, security headers, CORS, `x-pg-min-lsn` validation,
- the mTLS client builds with the ring provider (`reqwest` uses `rustls-no-provider`).

The fake core is an in-process `NodeSender`; no PostgreSQL, Redis or real core is required.

## Deviations from the TS edge (recorded)

1. **`x-request-id` response header**: chapter 2 §2 says echo the id on the response; the TS edges
   only resolve/forward it and never set it, so this port follows TS and does not echo it.
2. **Access logging**: the request text log, redaction details and the `http_access_logs` sink of
   `lib/requestLogger` are not ported. The edge resolves/generates `x-request-id`, forwards it to
   core and emits tracing spans; it does not echo it (see 1) and the log DB sink belongs to the
   core logging pipeline.
3. **Response relay**: `coreForward` responses are relayed byte-for-byte with the core
   `content-type`; TS parses and re-serialises JSON. Error envelopes are still parsed and mapped
   exactly (`CORE_*` fallbacks, reference/details preserved).
4. **Query parser**: flat keys and repeated keys (array) only; qs bracket expansion is not
   reproduced. A repeated key becomes an array and is then dropped by `scalarQuery`, like TS.
5. **Rate-limit plumbing**: fixed windows are process-wide like TS; IPv6 addresses are not grouped
   by `/56`; `RateLimit*` headers are not emitted (a `Retry-After` header is). Search/academy use a
   true sliding window.
6. **Middleware order**: LAN guard, cookie handling and the limiters run before JSON body parsing;
   TS parses JSON first. Limits and error bodies are identical, but an unauthenticated oversized
   body gets `401/403` here and `413` in TS.
7. **HEAD/OPTIONS**: HEAD is served from the GET route (Express behaviour). Automatic Express
   OPTIONS responses are only provided for CORS preflight.
8. **Multipart parser**: a hand-written parser replaces multer (one file, 32 fields, same limits
   and `UPLOAD_*` errors). Multer's `latin1` filename decoding is not reproduced.
9. **Core client**: one shared reqwest connection pool (TLS 1.3, 64 idle sockets per host) instead
   of a per-node `https.Agent`; node health/ejection/retry decisions are the shared `pg-upstream`
   implementation used by the other Rust edges.
10. **`CORE_BACK_URL`**: optional when `CORE_BACK_URLS` is set (the TS env schema requires it even
   then).
11. **Sandbox `/reset` and seed query**: the resolved `merchantId` is emitted before the original
    query; a duplicate `merchantId` in the incoming query would appear twice.
12. **Cookie capture** re-serialises the login/MFA JSON body, which can change object key order.
13. **Health** adds `"impl":"rust"` (chapter 2 §20 additive marker).
14. **`result_large_err`** is allowed crate-wide because `ApiError` carries an optional JSON
    `details` envelope (same choice as `bins/core-rs`).
15. **No SSE routes** exist on the admin edge in TS and none are implemented.
16. The command surface is `serve` / `config validate`; `config validate` refuses a route whose core
    path escapes `/internal/admin/` and prints the route and multipart counts.
17. Route matching is case-sensitive (Express routing is case-insensitive by default). Real
    clients use the documented paths; the router does not lowercase segments.

## Remaining work

None of the 419 inventory rows is deferred. The operational follow-ups are the deviations above,
chiefly the access-log sink (needs the core log pipeline) and the qs-compatible query parser if a
portal starts sending bracket syntax.

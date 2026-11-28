# core-rs — Rust core shell (P3)

The Rust port of `core-back`. This crate is the **P3 skeleton**: connection pools, the
authentication double check, the HTTP pipeline (request id, body limits, error envelope, request
log), the route policy registry and health. Domain routes arrive in P4 (reads), P5 (money path) and
P7 (writes); workers in P6.

- Plan and contracts: `design/14-rust-port/{02_contracts_reference,03_target_architecture,09_task_catalog}.md`
- Work log: `backend-rs/IMPLEMENTATION_TRACKER.md` (P3-T01…T10)
- Intentional differences: `backend-rs/DEVIATIONS.md` and §6 below

## 1. Implemented routes

| Method | Path | Policy | Auth | Notes |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/health` | `internal`, no auth, no body | valid client certificate, **no CN check** | `{msg,status,service,release,commit,leader,queue,workers,implementation}`; always 200 |
| GET | `/internal/admin/health` | `admin` | mTLS CN `admin-back` | `{status:"ok",channel:"admin",release,commit}` |
| GET | `/internal/merchant/health` | `merchant` | mTLS CN `merchant-back` | same shape, `channel:"merchant"` |
| GET | `/internal/checkout/health` | `checkout` | mTLS CN `checkout-back` | same shape, `channel:"checkout"` |
| GET | `/internal/admin/auth/me` | `admin`, session | admin session + staff principal | P3 probe, see §6 |

Everything else:

- a `/internal/*` or `/api/*` path that TS serves but Rust has not ported →
  `501 {"code":"NOT_IMPLEMENTED_ROUTE","message":"This route is not ported yet","path":…}` so the
  parity harness can classify it;
- any other unknown path → Express's 404 HTML page (`Cannot GET /path`), because the TS core has no
  explicit 404 handler (chapter 2 §3).

`GET /health` needs a valid client certificate under rustls (`WebPkiClientVerifier` with the
internal CA), but no CN check — exactly the TS split between the TLS layer and `mtlsGuard`.

## 2. Authentication

`GET /internal/admin/auth/me` is the mounted probe for `authDoubleCheck.ts`:

1. `Authorization: Bearer <token>` (case-insensitive scheme) else `401 AUTH_REQUIRED`;
2. `pg_live_` / `pg_test_` prefix → API token; otherwise a session JWT;
3. **API token**: plane prefix vs `EXECUTION_PLANE` → row by hex SHA-256 (`access_tokens.token_hash`)
   → `env` column → revoked → scopes → IP allow-list on `x-real-client-ip` → expiry → merchant
   `ACTIVE` → `lastUsedAt` touch. Errors: `ACCESS_TOKEN_INVALID`, `ACCESS_TOKEN_REVOKED`,
   `ACCESS_TOKEN_EXPIRED`, `ACCESS_TOKEN_IP_NOT_ALLOWED`, `MERCHANT_NOT_ACTIVE`,
   `LIVE_TOKEN_ON_SANDBOX_PLANE`, `SANDBOX_TOKEN_ON_LIVE_PLANE`;
4. **Session**: HS256 signature/issuer/audience/expiry → `jti` revocation (Redis `PTTL` fast path,
   `session_revocations` durable copy, re-warm on a table hit) → user row → `ACTIVE` →
   `sessions_invalid_before` → authorities from `users.authorities_map` (non-empty). Errors:
   `SESSION_INVALID`, `SESSION_REVOKED`, `SESSION_USER_MISSING`, `SESSION_USER_INACTIVE`,
   `SESSION_AUDIENCE_INVALID`, `SESSION_AUTHORITIES_EMPTY`, `STAFF_PRINCIPAL_REQUIRED`;
5. authorities are OR-ed (`require_authorities`), `*` only for staff.

The session signing key is `HKDF-SHA256(KMS_MASTER_KEY raw UTF-8, "payment-gateway-core",
"session-signing", 32)`, so a token minted by TS verifies in Rust and vice versa (the shared
`pg-domain-auth` golden vectors pin the derivation).

## 3. HTTP pipeline (order)

`src/app.rs::dispatch` reproduces `createApp`:

1. `x-request-id` accepted when it matches `^[A-Za-z0-9._:-]{1,128}$`, else UUIDv4; echoed on the
   response and used as the error `reference`;
2. body limits enforced before routing (Express parses before the router):
   raw-body routes from `pg_http::limits::raw_body_limit_for` (100 MB reconciliation upload, 5 MB
   assets, 25 MB KYB/inbound/dispute attachments, 50 MB AML evidence), JSON 1 MB or 24 MB under
   `/internal/{admin,merchant}/report-engine`, urlencoded 1 MB. An oversized plain body answers
   `500 SERVER_ERROR` (the TS error handler does not map `PayloadTooLargeError`); only the
   report-engine prefix is wrapped and answers `413 PAYLOAD_TOO_LARGE` with `details.limit`;
3. route lookup, then the mTLS CN guard for `/internal/*`, then the policy;
4. the handler; `ApiError` becomes `{code,message,reference?,details?}`;
5. the request line `<ISO> #<6> <METHOD padded 6><path> <status> <ms> [<len>b] [← ip]` on
   stdout/stderr (ANSI only on a TTY), and an `http_access_logs` row into the log database when
   `LOG_DATABASE_URL` is set (bounded buffer, `STORAGE_LOG_BUFFER_MAX`, 250 ms flush).

## 4. Environment

| Key | Default | Used for |
| :--- | :--- | :--- |
| `PORT` / `HOST` | `4000` / `127.0.0.1` | listener |
| `MTLS_CA_CERT_PATH`, `MTLS_SERVER_CERT_PATH`, `MTLS_SERVER_KEY_PATH` | — | TLS 1.3 server, client certificates |
| `MTLS_REQUIRED` | `true` | **Rust-only dev knob**: `false` serves plain HTTP and skips the CN gate (tests) |
| `KMS_MASTER_KEY` | — (required) | session signing key (≥ 16 chars) |
| `EXECUTION_PLANE` | `LIVE` | plane fence for API tokens |
| `DATABASE_URL` | — (required) | main pool (`pg-core-back`) |
| `DATABASE_REPLICA_URLS` | — | replica pools (URL list; router in P3-T02) |
| `AUDIT_DATABASE_URL`, `LOG_DATABASE_URL` | — | audit store / access-log sink (5 connections each) |
| `LEADER_ELECTION_DATABASE_URL` | primary | singleton-worker locks; **must be session-safe** |
| `PGBOUNCER_ENABLED` | `false` | refuses a transaction-pooled leader URL at boot |
| `PG_POOL_CONNECT_TIMEOUT_MS` | `5000` | wait for a pooled connection |
| `PG_STATEMENT_CACHE` | `256` | sqlx statement cache (`0` for PgBouncer without prepared statements) |
| `REDIS_URL` / `REDIS_NODES` | — | session revocation fast path (falls back to the table) |
| `WORKER_ENABLED` | `true` | boot gate + `/health.queue.enabled` |
| `WORKER_BACKGROUND_JOBS_ENABLED` | `true` | same |
| `WORKER_BACKGROUND_JOBS_DRAINED_EXTERNALLY` | `false` | allows a process with workers off |
| `WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS` | `300000` | queue degradation threshold |
| `STORAGE_LOG_BUFFER_MAX`, `STORAGE_LOG_FLUSH_INTERVAL_MS` | `5000`, `250` | access-log buffer |
| `APP_RELEASE`, `APP_COMMIT`/`GIT_COMMIT`, `NODE_ID` | — | health/version labels |

URLs written by the deploy engine carry `?sslmode=no-verify`; `pg-db` maps that to sqlx
`PgSslMode::Require` (TLS without certificate verification), keeps `connection_limit`/`pool_max`,
and pins `TIME ZONE 'UTC'` in `after_connect` because PgBouncer may drop startup options.

## 5. CLI

```
core-rs serve                      # the server (default command)
core-rs config validate            # env + TLS file checks
core-rs schema version             # 46
core-rs schema sql-state           # SQLSTATE → Prisma code table
core-rs routes export --out F      # write the route policy document
core-rs routes check [--file F]    # CI gate: unknown/missing/duplicate routes fail (exit 3)
```

`routes check` with no `--file` validates the committed `bins/core-rs/routes-policy.json` embedded
in the binary; the unit test `routes::tests::committed_policy_document_is_current` fails when the
document is stale (`cargo run -p core-rs -- routes export --out bins/core-rs/routes-policy.json`).

Every mounted route must be declared in `src/routes/mod.rs::mounted_routes`; the dispatcher only
serves what that table lists, so a handler cannot exist without a `pg_http::policy::Policy`.

## 6. Deviations and what is not mounted

Deviations from the TS contract (also recorded for `DEVIATIONS.md`):

- **DEV-1 — admin `auth/me` is authenticated here.** TS registers `GET /internal/admin/auth/me`
  *before* `requireAuthentication` and returns static metadata. The Rust route requires an admin
  session so the double check has a mounted probe, and adds the caller's `principal`. P7-T02 ports
  the admin auth module and restores the public, static route.
- **DEV-2 — `MTLS_REQUIRED`.** A Rust-only knob (`true` by default) so development and tests can
  run without certificates. With `true` the behaviour is the TS one: TLS 1.3, client certificate
  required, CN table per channel.
- **DEV-3 — admin `auth/me` `communication` is `null`.** The public communication status reads
  Platform Settings; that engine lands with P8. `null` is exactly what TS returns when its status
  query fails, so the shape is unchanged.
- **DEV-4 — the request log does not colour the path.** The TS `.white` slot is effectively the
  terminal default colour; Rust prints the path uncoloured (byte-identical on a non-TTY).
- **DEV-5 — the queue probe always reads `background_jobs`.** TS reads it through Prisma; the SQL
  is `count(*)` + `min(created_at) WHERE state = 'QUEUED'` with a 2 s timeout and
  `error:"QUEUE_HEALTH_UNAVAILABLE"` when the database does not answer.

Not mounted / not started in P3 (left for later waves, with the phase that owns them):

- all domain routes: merchant/checkout/admin reads (P4), money path (P5), writes/governance (P7),
  report engine, compliance, sandbox and academy (P8) — they answer `501 NOT_IMPLEMENTED_ROUTE`;
- workers and the worker health registry entries (P6). `core_rs::workers::WorkerRegistry` is ready
  for P6 to register `pg_workers` snapshots; `/health.workers` is empty today;
- the Sandbox user mirror (`authDoubleCheck.ts:232-290`): a session whose user is absent from the
  Sandbox database answers `SESSION_USER_MISSING` until P8-T05;
- the plane-fence boot check, communication bootstrap, Redis invalidation transport and
  `reconcileReportChromeDefaults` startup step (P5/P6/P8);
- the replica router/LSN monitor (P3-T02), Redis bus/caches (P5) and Google OAuth JWKS (P3-T08
  remainder).

## 7. Layout for wave 3 (domain routes)

```
src/
  app.rs        request pipeline + dispatch (done)
  auth.rs       double check, revocation store, CN guard (done)
  http.rs       error envelope, body limits, request meta (done)
  logging.rs    request line + access-log sink (done)
  health.rs     /health payload + channel payload (done)
  config.rs     env schema subset (done)
  state.rs      pools, leader, auth, shutdown (done)
  workers.rs    worker health registry (P6 fills it)
  routes/
    mod.rs      mounted route table + policies + `routes check` (done)
    health.rs   /health + channel health (done)
    auth.rs     admin auth/me probe (done)
    merchant/   P4/P5/P7 — one module per TS router, each registering its policies in mod.rs
    checkout/   P5
    admin/      P4/P7/P8
    common/     shared validators (zod-shaped issues) and pagination helpers (P4-T01)
integration_tests/
  list_query_pg   pg-db::tests/live_pg.rs        (pools, leader probe, listQuery, UoW, audit)
  shell           bins/core-rs/tests/shell.rs    (auth matrix, limits, health, 404, policy gate)
```

## 8. Verification

```
cd backend-rs
cargo clippy -p pg-db -p core-rs --all-targets -- -D warnings
cargo fmt -p pg-db -p core-rs -- --check
cargo test -p pg-db -p core-rs
```

The tests use `PG_TEST_DATABASE_URL` (or `DATABASE_URL`, or
`postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`) and
`PG_TEST_REDIS_URL` (or `STORAGE_TEST_REDIS_URL`, or `redis://127.0.0.1:56379`). When PostgreSQL
is unreachable each test prints `SKIP: PostgreSQL is unreachable …` and returns; the Redis test
skips the same way.

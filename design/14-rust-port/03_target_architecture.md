# Chapter 3 — Target Architecture

> Part of the Rust/ntex port plan (`porting_to_ntex_rust.md`). Describes how the Rust code is organised and the
> engineering rules it follows. Contracts it must honour are in chapter 2.

---

## 1. Principles

1. **Hexagonal core.** Domain crates (`pg-domain-*`) contain pure business logic with traits for storage, clock,
   randomness, outbound HTTP and notifications. HTTP, SQL and Redis live in adapter crates. This makes golden-vector
   and property testing cheap and keeps ntex out of business logic.
2. **One request context, passed explicitly.** `RequestCtx` carries request id, principal, plane, client IP, read
   consistency, telemetry sink and (from E-DB-04) the tenant id used for RLS. No task-locals for business data, no
   globals.
3. **Deny by default.** Every route declares a policy (§6); every worker declares its lock model; every outbound
   host is allowlisted.
4. **Bounded everything.** Every cache, queue, buffer, map and stream has a configured maximum.
5. **Same SQL, same behaviour.** Port raw SQL verbatim; translate ORM calls to explicit SQL; prove with parity.

---

## 2. Process and runtime model

- All servers use **ntex 4.11 on Tokio** (`ntex` features `tokio`, `rustls`, `compress`, `cookie`).
- ntex starts N HTTP worker threads, each with a single-threaded runtime; handler futures need not be `Send`. Shared
  state is `Arc<AppState>` built once in `main` and cloned into each worker's app factory.
- `HTTP_WORKERS` default = physical cores (from `/sys/devices/system/cpu/*/topology/core_id` de-duplicated; fallback
  `available_parallelism()`).
- **Background runtime**: a separate `tokio::runtime::Builder::new_multi_thread()` with `WORKER_RUNTIME_THREADS`
  (default 2) started before the HTTP server; it runs all workers, the replica monitor, the access-log flusher,
  cache-invalidation subscribers and Redis pub/sub. Both runtimes share the same `Arc` pools.
- Blocking work (bcrypt, zip/xlsx/docx generation, XSD validation, JSON > 1 MB, file I/O in daemons) goes to
  `tokio::task::spawn_blocking` with a bounded semaphore (`BLOCKING_MAX`, default 2 × cores).
- Graceful shutdown on SIGTERM/SIGINT: stop accepting, drain in-flight requests up to `SHUTDOWN_GRACE_MS` (10 s),
  signal workers to finish their current tick, release leader locks, flush log buffers, close pools; notify systemd
  (`sd-notify` `STOPPING=1`). Readiness `READY=1` after listen succeeds (used by pgctl zero-downtime restarts).

---

## 3. Workspace and crates

```
backend-rs/
  Cargo.toml  rust-toolchain.toml  deny.toml  .cargo/config.toml
  DEVIATIONS.md  PARITY.md  BENCHMARKS.md  README.md
  crates/
    pg-config         typed env/credentials loading reproducing TS schemas; config registry client (E-F01)
    pg-http           ntex glue: error envelope, request id, logger, health, body limits, security headers,
                      catch-panic, zod-compatible validation, rate limiter, route policy registry
    pg-mtls           rustls server/client configs, CN/SAN extraction, cert reload
    pg-crypto         vault (v1 + v2), HKDF keys, JWT, bcrypt, API tokens, MFA, Standard Webhooks, CryptoEngine,
                      audit hash, FNV-1a, pgos1, PGBKv2, JS-compatible helpers (sort, ISO dates)
    pg-types          Money4/DecimalJs/JsDate serde types, JS key order, cursor codec, generated enums/models
    pg-db             pools, URL normalisation, replica router + LSN, unit of work, SQLSTATE map, leader election,
                      migrator (P10), schema version gate (S-DB-01)
    pg-redis          invalidation bus, realtime bus, cache L1/L2, velocity Lua, throttles, revocation
    pg-objstore       object storage SDK (core) + blob store (daemon) + sniffing
    pg-domain-auth    principals, sessions, API tokens, MFA, OAuth, authorities
    pg-domain-flow    flow engine, step executor, transforms DSL, selectors, slots, guards, spec importer runtime
    pg-domain-ledger  poster, checkpoint, invariant, shard repair/scaler, partition maintenance
    pg-domain-gov     approvals, maker-checker, AML, KYB, disputes, adjustments, cash-out, operator cases
    pg-domain-comms   communication engine, templates (EN/AR), tipping-off guard, SMTP/SMS/webhook transports
    pg-domain-recon   statement ingestion, matching, sweeps, follow-ups
    pg-domain-academy catalog, exam engine, certificates
    pg-egress         API consumer (10 auth methods, token cache, per-credential mTLS), SSRF guard, webhook egress
    pg-workers        BaseWorker runtime, the 28 workers, monitor checks, worker control (E-F02)
    pg-report-engine  report spec, compilers, verifier, read-only executor, transcripts, chrome, assets
    pg-compliance     XSD compiler/generator/validator, regulatory reports, CBL baseline schemas, filing adapters
    pg-office         XLSX write/read, DOCX, zip helpers
    pg-search         global search providers and ranking
    pg-upstream       edge→core least-in-flight pool, route table, shadow diff
    pg-edge           edge-shared: contract translation helpers, multipart streaming, cookie session, limiters
    pg-deploy-*       pgctl libraries (chapter 7 §4)
  bins/
    core-rs  admin-edge  merchant-edge  checkout-edge  fake-rails-rs
    backup-daemon-rs  wal-fetch  object-storage-daemon-rs  pgctl
  tools/  golden/ codegen/ parity/ route-inventory/
  tests/  golden-vectors/ parity-fixtures/ integration/
```

Dependency rules (checked by `cargo deny` bans and a CI script): domain crates never depend on `ntex`, `sqlx`,
`redis`; edge binaries never depend on domain crates; `pg-crypto` has no I/O.

---

## 4. Data access layer

- **sqlx 0.9** with `query!` / `query_as!` macros, offline metadata committed (`cargo sqlx prepare --workspace`).
  CI runs `cargo sqlx prepare --check` against a migrated PostgreSQL 18 service container.
- Repositories per aggregate in adapter modules (`pg-db::repo::<aggregate>`), returning domain structs. A
  repository function documents its TS origin: `/// Port of core-back/engine/db/repositories.ts:findAttemptForUpdate`.
- `Executor` abstraction: functions take `&mut PgConnection` (inside a unit of work) or `&PgPool` (autocommit).
- **Unit of work** (`pg-db::uow`): `uow.run(timeout, |tx| async { … })` sets `SET LOCAL statement_timeout`, collects
  buffered outbox/audit rows and flushes them before commit, returns `commit_lsn`. Retry wrapper for transient
  SQLSTATEs is explicit per call site (TS has no generic retry; do not add one silently).
- **Typed arrays** for unnest batching (`Vec<Uuid>`, `Vec<Decimal>`, `Vec<i16>`, `Vec<i64>`) bound as PostgreSQL
  arrays with explicit casts copied from TS SQL.
- **Read routing** via `ReadConsistency::{Primary, Replica, AtLeastLsn{lsn, max_wait}}` on `RequestCtx`.
- **Prisma behaviours** (chapter 2 §18) are applied by generated per-table metadata: `updated_at` set on insert and
  update, id generation (v7/v4/cuid), Json null semantics.
- Statement cache size `PG_STATEMENT_CACHE` (default 256, `0` disables) for PgBouncer compatibility.

---

## 5. Code generation

`backend-rs/tools/codegen/gen.ts` (Bun, used until P10):

- Loads Prisma DMMF (`@prisma/internals getDMMF`) from `core-back/prisma/schema.prisma`.
- Emits `pg-types/src/generated/{enums.rs, models.rs, meta.rs}`:
  - enums: `#[derive(sqlx::Type, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]`,
    `#[sqlx(type_name = "<DbName>")]`, variants with `#[sqlx(rename)]` / `#[serde(rename)]`;
  - models: row structs with DB names (`@map`) and Prisma field names for serde; type mapping `String`→`String`,
    `Int`→`i32`, `BigInt`→`i64`, `Decimal`→`Decimal`, `Boolean`→`bool`, `DateTime @db.Timestamptz`→`DateTime<Utc>`,
    other `DateTime`→`NaiveDateTime` (UTC), `Json`→`serde_json::Value`, `Bytes`→`Vec<u8>`, `@db.Uuid`→`Uuid`, lists →
    `Vec<T>`, optional → `Option<T>`; relation fields skipped;
  - meta: per table `{updated_at_column, id_kind, json_nullable_columns, default_now_columns}`;
  - `REQUIRED_SCHEMA_VERSION` from `schemaVersion.ts`;
  - `report-schema-catalog.json` for Report Studio (replaces runtime parsing of `schema.prisma`).
- After P10 the generator switches to **database introspection** (`core-rs schema codegen` reads
  `information_schema`/`pg_catalog` of a freshly migrated DB) so Prisma is no longer needed.
- CI: regeneration must produce no diff.

---

## 6. Route policy registry (deny by default)

Every route in every Rust server is registered through one macro that requires a policy. A route without a policy
does not compile. This fixes the class of defects "guard forgotten" (e.g. unused `requireMerchantScope`, admin
`auth/me` before authentication).

```rust
// Illustrative; adapt to the final ntex 4 handler signatures.
pub struct Policy {
    pub channel: Channel,                 // Admin | Merchant | Checkout | Sandbox | Internal | Public
    pub authn: Authn,                     // None | Session | ApiToken | SessionOrApiToken
    pub authorities: &'static [&'static str], // OR semantics (TS parity)
    pub merchant_scope: ScopeRule,        // NotApplicable | Required | FromPath("merchantId")
    pub mfa: MfaRule,                     // NotRequired | RequiredSinceLogin (S-SEC-04)
    pub maker_checker: Option<SubjectType>,
    pub rate_class: RateClass,
    pub body: BodyRule,                   // Json(limit) | Raw(limit) | Urlencoded | None
    pub audit: AuditRule,                 // None | Read | Write
    pub ts_origin: &'static str,          // "core-back/api/internal/merchant.ts:2974"
}

route!(POST "/internal/merchant/cashouts", Policy {
    channel: Channel::Merchant,
    authn: Authn::Session,
    authorities: &["cashout:write"],
    merchant_scope: ScopeRule::Required,
    mfa: MfaRule::NotRequired,
    maker_checker: None,
    rate_class: RateClass::Default,
    body: BodyRule::Json(1 << 20),
    audit: AuditRule::Write,
    ts_origin: "core-back/api/internal/merchant.ts:2974",
}, handlers::merchant::create_cashout);
```

- During Track P, each policy reproduces the TS guards exactly (including permissive ones); the registry exports
  `routes-policy.json` which is diffed against `routes.json` from the TS inventory so no route is missing.
- Track S items tighten individual policies (S-SEC-02 merchant scope, S-SEC-04 MFA) in both implementations.
- The registry also drives: the rate limiter class, body parser selection, the OpenAPI document (E-F11), and the
  admin edge's authority hints (removing the manual `ADMIN_AUTHORITY_HINTS` drift).

---

## 7. Validation and errors

- `pg-http::validate`: builder-style validators that emit zod-shaped issues (`code`, `path`, `message`, plus zod's
  extra fields such as `minimum`, `inclusive`, `expected`, `received` where TS clients read them).
- Request structs use `#[serde(deny_unknown_fields)]` mirroring `.strict()`, but unknown-key errors are converted to
  the zod `unrecognized_keys` issue, not serde's message.
- One error type at the HTTP boundary:

  ```rust
  pub struct ApiError { pub status: u16, pub code: Cow<'static, str>, pub message: String,
                        pub details: Option<serde_json::Value> }
  ```

  Domain crates return `thiserror` enums; `impl From<DomainError> for ApiError` lives in the adapter crate with a
  table that maps each variant to the exact TS status/code/message.
- Panics are caught per request (AD-10) and mapped to `500 SERVER_ERROR` with the request id; the panic is logged
  with backtrace.

---

## 8. Configuration

- `pg-config` loads `.env` (dotenvy semantics), then process env, then **systemd credentials**: for each secret key
  `K`, if `$CREDENTIALS_DIRECTORY/K` exists its content wins (AD-13). Secret values are wrapped in
  `secrecy::SecretString` and zeroized on drop.
- Each service has a typed config struct reproducing the TS zod schema (names, defaults, constraints, cross-field
  rules, error message format). Tested against `env-schemas.json`.
- Runtime-tunable values (E-F01/E-F02) come from the configuration registry, not env; env provides only bootstrap
  values and secrets.
- Unknown env keys are ignored (TS behaviour for process env); unknown keys in TOML files are rejected.

---

## 9. Observability

- **Logs**: default text format identical to TS (chapter 2 §20); `LOG_FORMAT=json` emits structured JSON with
  `ts, level, request_id, route, status, duration_ms, db_queries, db_ms, actor_id, client_ip, msg` (also fixes the
  zero-valued fields of the access log once S-OPS-01 lands). Secrets redacted by a `Redact` wrapper type and a
  header allowlist.
- **Metrics** (S-OPS-02): Prometheus text on `METRICS_BIND` (loopback by default, disabled unless set). Histograms
  per route pattern and status class; pool usage (size, idle, waiters); worker tick duration, lag, last success;
  outbox backlog and age; replica lag; Redis latency; ledger postings/s; RSS and FD count.
- **Traces** (E-OPS-01): OpenTelemetry OTLP exporter (`opentelemetry-otlp` 0.33) with spans for HTTP, SQL, Redis and
  egress; propagated edge→core with `traceparent`. Off by default.
- **Health**: chapter 2 §20 bodies + `impl:"rust"`; readiness via `sd-notify`.

---

## 10. CLIs (single binary per area, subcommands via `clap` 4.6)

| Binary | Subcommands |
| :--- | :--- |
| `core-rs` | `serve`; `migrate {deploy, status, new, reset, rehearse}`; `schema {check-sql-objects, codegen, version}`; `seed {base, fake-rails, synthetic}`; `admin {create, dev-users}`; `ledger {repair-default-partition, verify, checkpoint}`; `comms {bootstrap, test-send}`; `cases backfill`; `audit {legacy-evidence, currency-mismatch, verify-chain}`; `config {validate, print-schema}` |
| `admin-edge`, `merchant-edge`, `checkout-edge` | `serve`, `config validate` |
| `fake-rails-rs` | `serve`, `db {migrate, reset}` |
| `backup-daemon-rs` | `serve`, `trigger`, `drill`, `catalog verify` |
| `wal-fetch` | `<target> <file> <dest>` (restore_command compatible) |
| `object-storage-daemon-rs` | `serve`, `fsck` |
| `pgctl` | chapter 7 §3 |

Every CLI: `--json` output mode, exit codes 0 success / 1 failure / 2 usage / 3 precondition failed, `--dry-run`
where it mutates state, and secrets read from credentials or env, never from argv.

---

## 11. Performance engineering

### 11.1 Build

```toml
[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
panic = "unwind"
debug = "line-tables-only"
strip = "none"
incremental = false
```

- `RUST_TARGET_CPU` deploy setting (`x86-64-v3` if every host has AVX2 per pgctl preflight, else `x86-64-v2`).
- PGO with `cargo-pgo` 0.3 trained on BL-1/BL-3/BL-5 (P10-T07); keep only if ≥ 5% gain.
- Builds with `cargo zigbuild` 0.24 pinned to the oldest supported glibc.

### 11.2 Memory

- mimalloc global allocator (AD-07; P0-T09 benchmark decides).
- Response serialisation directly into `BytesMut` with capacity hints; zero-copy `Bytes` proxying in edges when the
  body is not translated (raw uploads, inbound callbacks, most GETs).
- Streaming for uploads, object storage, backups, exports; 64 KiB buffers.
- Bounded caches (`moka` max capacity), bounded channels, bounded log buffers, SSE ≤ 16 KiB per stream with one Redis
  subscription per process fanned out through `tokio::sync::broadcast`.
- `compact_str`/`Arc<str>` for frequently cloned short strings; `smallvec` for ledger lines (≤ 8 inline).

### 11.3 CPU

- No per-request regex compilation (`LazyLock<Regex>`), no repeated key derivation (derive at startup), no JSON round
  trips between layers, bcrypt on the blocking pool, AES/HMAC/SHA via `aws-lc-rs`.
- Ledger poster target: validate + fold + build arrays ≤ 50 µs for a 4-line posting (criterion).

### 11.4 Database

- `unnest` batching as TS; prepared statements; no string-built SQL on hot paths.
- Fix N+1 patterns from Prisma `include` trees with `= ANY($1)` batch loads (each change recorded in DEVIATIONS with a
  parity test).
- Validation and computation before `BEGIN`; keep transactions short.
- Hot path round trips: posting = 3 statements; checkout initiate and confirm budgets documented per route in
  `BENCHMARKS.md` (TS measured 15–18 round trips for a confirmation, GAP-063).

### 11.5 Concurrency

- Never block an ntex worker; no lock held across `.await`; `parking_lot` only for short sections; shared rate-limit
  state in sharded maps.

---

## 12. Crate table (pinned 2026-11-28)

| Concern | Crate (version) |
| :--- | :--- |
| HTTP server | `ntex` 4.11.1, `ntex-tls` 4.9.0, `ntex-rt` 4.10.1 (MSRV 1.97) |
| TLS / X.509 | `rustls` 0.23.46 (aws-lc-rs provider), `rustls-pki-types` 1.16, `x509-parser` 0.18.1, `webpki-roots` 1.0.12, `rcgen` 0.14.10 (pgctl PKI) |
| Async | `tokio` 1.54.1, `tokio-util` 0.7.20, `async-trait` 0.1.92 |
| PostgreSQL | `sqlx` 0.9.1, `sqlx-cli` 0.9.1 |
| Decimal / bigint | `rust_decimal` 1.43, `bigdecimal` 0.4.11, `num-bigint` 0.5.1 |
| JSON / serde | `serde` 1.0.229, `serde_json` 1.0.154 (`preserve_order`), `ryu-js` 1.0.4, `toml` 1.2, `jsonschema` 0.63.2 (config schemas), `schemars` 1.2.3 |
| Redis | `redis` 1.8.3 |
| HTTP client | `reqwest` 0.13.5 (rustls), `hyper` 1.13 (edge upstream pool) |
| Crypto | `aws-lc-rs` 1.19, `hkdf` 0.13, `hmac` 0.13, `sha2` 0.11, `bcrypt` 0.19.3, `jsonwebtoken` 12.0 (HS256 + EdDSA for E-SEC-01), `ed25519-dalek` 3.0, `base64` 0.23.1, `hex` 0.4.3, `uuid` 1.29.3, `secrecy` 0.10.3, `zeroize` 1.9.2, `age` 0.12.1 (pgctl secrets store), `cryptoki` 0.12.1 (optional PKCS#11 HSM, E-SEC-05) |
| Email | `lettre` 0.11.24 |
| Office / archives | `rust_xlsxwriter` 0.104, `calamine` 0.38, `zip` 9.9, `zstd` 0.14.5 |
| SQLite | `rusqlite` 0.43 (bundled) |
| Caching / maps | `moka` 0.12.16, `dashmap` 6.2.1, `lru` 0.19.2, `parking_lot` 0.13 |
| Time | `chrono` 0.4.45, `chrono-tz` 0.10.4, `croner` 5.0.1 |
| Net | `ipnet` 2.12, `socket2` 0.6.5, `hickory-resolver` 0.26.4 (egress DNS pinning) |
| Observability | `tracing` 0.1.44, `tracing-subscriber` 0.3.23, `tracing-appender` 0.2.5, `opentelemetry` / `opentelemetry_sdk` / `opentelemetry-otlp` 0.33.1, `tracing-opentelemetry` 0.34, `prometheus-client` 0.26 |
| systemd | `sd-notify` 0.5.0, `listenfd` 1.0.2 (socket activation for zero-downtime) |
| CLI | `clap` 4.6.10, `indicatif` 0.18.6 |
| Deploy engine | `russh` 0.65.4, `ssh-key` 0.6.7, `minijinja` 3.1.0, `aws-sdk-s3` 1.162 + `aws-config` 1.13, `nix` 0.32, `sysinfo` 0.40, `tempfile` 3.27, `walkdir` 2.5, `globset` 0.4 |
| Optional sandboxed plugins | `wasmtime` 51.0 (E-F07 only) |
| Errors | `thiserror` 2.0.21, `anyhow` 1.0.105 (binaries only) |
| Allocator | `mimalloc` 0.1.52 (`tikv-jemallocator` 0.7 for comparison) |
| Testing | `insta` 1.49, `proptest` 1.12, `criterion` 0.8.2, `similar` 3.2.1, `testcontainers` 0.28, `cargo-nextest` 0.9.152 |
| Supply chain | `cargo-deny` 0.22.2, `cargo-audit` 0.23, `cargo-cyclonedx` 0.5.10, `minisign` 0.10 |

Adding any other crate requires a `DEVIATIONS.md` entry with the reason and an owner sign-off.

---

## 13. Coding standards

- `#![forbid(unsafe_code)]` in every crate (document any dependency-driven exception).
- Public items carry `/// Port of <ts path>:<symbol>` during Track P.
- No `anyhow` in libraries; no global mutable state; inject `Clock` and `Rng` traits in domain code.
- Never log secrets, ciphertext, tokens, AML-confidential data or keys; use `Redact<T>`.
- Money: `Decimal` only, strings in JSON; the money-module float ban (master rule 3) is enforced by CI.
- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo nextest run`, `cargo deny check`,
  `cargo sqlx prepare --check`, golden-vector suite and parity suites must pass on every pull request.

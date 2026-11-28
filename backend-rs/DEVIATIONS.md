# Deviations from the TypeScript specification

Every intentional difference from the TS code or from `design/14-rust-port/**` is recorded here.
Format from chapter 9 §2. Track P changes never alter observable behaviour; entries below are
build-environment or internal-representation choices.

## DEV-001 RustCrypto instead of aws-lc-rs
- Date / task: 2026-11-28 / P0-T01
- TS source: `core-back/engine/crypto/{Vault,CryptoEngine}.ts`
- What TS does: uses Node's OpenSSL bindings.
- What the plan said: `aws-lc-rs` 1.19 for SHA/HMAC/HKDF/AES-GCM.
- What Rust does: `sha2` 0.11, `hmac` 0.13, `hkdf` 0.13, `aes-gcm` 0.11, `subtle`, `rand`.
- Item / approval: build environment has no cmake, NASM or clang, so `aws-lc-sys` cannot build.
  Algorithms, key sizes, AAD and wire formats are unchanged and covered by golden tests.

## DEV-002 reqwest with `rustls-no-provider` + ring
- Date / task: 2026-11-28 / P1-T02
- TS source: `deploy/object-storage-daemon/src/shared/blobStore.ts` (node:https)
- What the plan said: `reqwest` 0.13 with rustls.
- What Rust does: `rustls-no-provider`; `pg-mtls::install_crypto_provider` installs the ring
  provider once per process before any TLS config or client is built. TLS 1.3 only.
- Item / approval: same build constraint as DEV-001. `rustls` is pinned with
  `default-features = false, features = ["std", "ring"]`.

## DEV-003 Daemon CN authorization happens in the HTTP handler, not on a raw TLS front
- Date / task: 2026-11-28 / P1-T03
- TS source: `deploy/object-storage-daemon/src/server.ts:274-305`
- What TS does: the `node:tls` front checks CN and writes a raw `HTTP/1.1 403` before bridging to
  the inner HTTP server.
- What Rust does: rustls requires and verifies the client certificate during the handshake
  (`WebPkiClientVerifier`), then the single catch-all handler reads `PeerCertDer`, extracts
  CN/SANs and returns HTTP 403 with the same daemon body
  `{"error":{"code":"forbidden","message":"client certificate is not authorized"}}`.
- Item / approval: n/a — observable status and body are the same; the request is never routed.
  Revisit if a future test requires the raw pre-HTTP response.

## DEV-004 Scaffold binaries use one catch-all route with manual dispatch
- Date / task: 2026-11-28 / P0/P1
- TS source: `core-back/api/**`, edges, fake rails, backup daemon.
- What the plan said: each route registered through the policy macro.
- What Rust does in the current scaffold: `bins/*` register `/{tail:.*}` and dispatch manually, so
  unported routes answer `501 NOT_IMPLEMENTED_ROUTE` instead of a misleading 404. Real routes are
  added with `pg_http::policy::Policy` entries as they are ported (P2+).
- Item / approval: n/a — scaffolding only; the policy registry and CI diff (P3-T10) are the gate
  before any domain route is enabled.

## DEV-005 `SslMode` wrapper in `pg-db`
- Date / task: 2026-11-28 / P3-T01
- TS source: `deploy/lib/configSchema.ts:883-928`
- What Rust does: parses `sslmode=no-verify` into its own `SslMode::Require` enum because sqlx's
  `PgSslMode` implements neither `PartialEq` nor `Eq`. `connect_options()` maps it to sqlx.
- Item / approval: n/a — representation only; the URL semantics are unchanged and tested.

## DEV-006 `pg-workers` is a runtime skeleton, not the 28 workers
- Date / task: 2026-11-28 / P6-T01
- What Rust does: the runtime supports interval, jitter, singleton lock verification per tick,
  panic isolation, `WORKER_DISABLED`, and the health snapshot. Individual workers arrive in P6.
- Item / approval: n/a — phase scope.

## DEV-007 Ledger scenarios are 18, not 17
- Date / task: 2026-11-28 / P5-T04
- TS source: `core-back/engine/ledger/LedgerPoster.ts:204-222`
- What the design text says: 17 scenarios in `03-ledger.md` §3.3.
- What Rust does: copies the 18 names from the TS code (the design's 17 plus `SUSPENSE_REFUND`).
- Item / approval: n/a — the TS code is the Track P specification (master rule 1).

## DEV-008 Shard repair preview hash is FNV-1a, not SHA-256
- Date / task: 2026-11-28 / P6-T06
- TS source: `core-back/engine/ledger/ShardRepair.ts`
- What Rust does: `pg-domain-ledger::plan_shard_repair` returns `plan_hash` as
  `fnv1a32:<8 hex>` over the canonical plan string. It is the preview↔apply change detector and
  never crosses the API as a security digest. The SQL/API layer (P6-T06) must use the SHA-256 plan
  hash from `cjw`/`sha2` when it binds an approval; this pure crate has no hashing dependency.
- Item / approval: n/a — internal representation; the approval binding stays SHA-256 in the DB layer.

## DEV-009 Ledger pure planner receives a reduced repair input
- Date / task: 2026-11-28 / P6-T06
- TS source: `core-back/engine/ledger/ShardRepair.ts`
- What Rust does: `plan_shard_repair(journal_sum, journal_max_seq, shard_balance, shard_line_seq,
  baseline_seq)` decides RECOMPUTE vs REBASELINE from those facts. The TS planner also sees the
  checkpoint state, an unproven checkpoint and the full sequence list (to detect a duplicated
  middle number); the SQL adapter must compare those itself before applying a plan.
- Item / approval: n/a — the adapter is P6-T06; this is documented in `pg-domain-ledger`.

## DEV-010 Idempotency-Key POSTs get a second attempt in `AttemptLoop`
- Date / task: 2026-11-28 / P2-T01
- TS source: `{admin,merchant,checkout}-back/lib/coreInternalClient.ts` (`retryAttemptsFor`)
- What TS does: `retryAttemptsFor` returns 1 attempt for POST even with an `Idempotency-Key`, so
  `mayReplayAfterSend` is unreachable for mutations in that helper.
- What Rust does: `RetryPolicy::attempts_for` keeps the literal TS rule; `attempts_for_request`
  (used by `AttemptLoop`) gives a keyed POST 2 attempts unless `retry_idempotent: Some(false)`.
  The plan's chapter 2 §10 explicitly allows replay for `Idempotency-Key` requests.
- Item / approval: needs owner confirmation; until then the executor may call `attempts_for` for
  strict parity.

## DEV-011 Transport failure classification inspects the reqwest source chain
- Date / task: 2026-11-28 / P2-T01
- TS source: the edges' `classifyCoreError`
- What Rust does: `reqwest` collapses DNS/refused/reset/TLS into `is_connect()`, so
  `TransportFailure::from_reqwest` inspects the source-chain text and maps an unidentifiable
  connect failure to `CORE_UNREACHABLE`.
- Item / approval: n/a — the external code/status stays the TS one; only internal classification.

## DEV-012 `CORE_CONFIG_INVALID` for an unparseable core base URL
- Date / task: 2026-11-28 / P2-T01
- TS source: `resolveCoreUrl`
- What Rust does: an unparseable base URL is a boot/config error (`500 CORE_CONFIG_INVALID`);
  TS would produce `502 CORE_CONNECTION_ERROR` per request. Core URLs are validated at startup in
  Rust, so this can only happen after a bad runtime mutation.
- Item / approval: n/a — recorded so the parity harness normaliser covers it if a test injects it.

## DEV-013 Token-cache margin and deterministic jitter
- Date / task: 2026-11-28 / P5-T02
- TS source: `ApiConsumer.ts` token cache
- What Rust does: default refresh margin 60 s (task instruction; `TokenCache::TS_MARGIN_MS` keeps
  the TS 30 s), and jitter is deterministic FNV-1a over the cache key instead of `Math.random`.
  A restart therefore does not move the refresh point.
- Item / approval: n/a for jitter; the 60 s margin is a hardening choice to confirm against TS
  during P5-T02 parity (the TS value wins if a golden vector pins it).

## DEV-014 `pg-edge` cookie decision returns the caller Authorization verbatim
- Date / task: 2026-11-28 / P2-T02
- TS source: `{admin,merchant}-back/lib/security/sessionCookie.ts`
- What TS does: when an Authorization header is present it calls `next()` and cookie mode is not
  applied; the header is used verbatim by the auth layer.
- What Rust does: `CookieDecision::Bearer(value)` carries that verbatim value (it may not start
  with "Bearer "), so callers must treat it as "forward the caller header unchanged".
- Item / approval: n/a — same behaviour, explicit naming.

## DEV-015 API-token and MFA randomness comes from UUID v4
- Date / task: 2026-11-28 / P3-T08
- TS source: `core-back/lib/auth/{index,mfaChallenges}.ts`
- What Rust does: `pg-domain-auth` derives 32 token bytes and the 4 MFA bytes from `uuid::Uuid::new_v4()`
  (two UUIDs / one UUID slice) because `rand` is not a dependency of that crate. Prefixes, base64url
  shape, length, modulo and hashes are unchanged.
- Item / approval: n/a — the OS CSPRNG is still the source; revisit if a golden vector pins the decoder.

## DEV-016 Session `exp` is enforced against the caller's clock
- Date / task: 2026-11-28 / P3-T08
- What Rust does: `verify_session` sets `validate_exp=false` and checks `exp` against the supplied
  `now`, so verification, revocation and tests use one clock. `exp`/`iss`/`aud` presence is still
  required and the audience/channel check is unchanged.
- Item / approval: n/a — one clock avoids flakiness; the wire contract is unchanged.

## DEV-017 Flow transition error code and governance edges
- Date / task: 2026-11-28 / P5-T05
- TS source: `core-back/engine/flow/DynamicRailEngine.ts` `transition()`
- What TS does: an illegal transition throws `INVALID_ATTEMPT_TRANSITION`; only the callback/finalize
  guards use `ATTEMPT_TERMINAL`.
- What Rust does: `effective_status_transition` returns `ATTEMPT_TERMINAL` for a terminal refusal and
  also accepts the two governance edges (`CREATED -> SUCCEEDED|FAILED`). The adapter must map the
  code back to the TS one for the direct transition route.
- Item / approval: n/a — recorded so the route adapter preserves the code.

## DEV-018 `ATTEMPT_GROUP_ALREADY_SUCCEEDED` is pre-checked in Rust
- Date / task: 2026-11-28 / P5-T05
- TS source: `attempt_groups_single_success` DB CHECK / `slotStore.ts`
- What Rust does: `SlotDecision::commit_group` pre-checks the group and returns
  `409 ATTEMPT_GROUP_ALREADY_SUCCEEDED` before the write; TS lets the DB constraint fail.
- Item / approval: n/a — same observable status, better error code; keep the DB constraint.

## DEV-019 Visible-rails ordering uses weight + route id only
- Date / task: 2026-11-28 / P5-T05
- TS source: `core-back/engine/flow/VisibleRailsResolver.ts`
- What Rust does: status/health/canary filtering is exact; ordering by `EFFECTIVE_COST` or
  `STRICT_PRIORITY` needs the cost model (P5-T03) and is not implemented yet. `min_healthy` is a
  Rust-only opt-in knob; `None` is exact TS parity.
- Item / approval: n/a — phase scope; P5-T03 must implement the cost strategies.

## DEV-020 `jsonwebtoken` uses the RustCrypto provider in pg-domain-auth
- Date / task: 2026-11-28 / P3-T08
- What Rust does: `jsonwebtoken` 12 needs an explicit crypto provider; `pg-domain-auth` enables
  `rust_crypto` on its own dependency (the workspace entry keeps default features). Any other crate
  that issues JWTs must enable it too.
- Item / approval: n/a — same DEV-001 build constraint.

## DEV-021 Report search has 21 providers, not 20
- Date / task: 2026-11-28 / P4-T06
- TS source: `core-back/lib/globalSearch.ts`
- What the design says: 20 providers.
- What Rust does: ports all 21 registered providers (the design text is stale; TS wins).
- Item / approval: n/a.

## DEV-022 Compliance periods use a fixed UTC+2 offset
- Date / task: 2026-11-28 / P8-T03
- TS source: `Africa/Tripoli` through Intl/chrono-tz.
- What Rust does: `pg-compliance::periods` uses a fixed UTC+2 offset because `chrono-tz` is not a
  dependency of that crate. Libya currently has no DST; revisit if that changes or if historical
  periods must be exact.
- Item / approval: n/a — current-date periods are identical; recorded for the verification plan.

## DEV-023 XSD subset validator is whitelist-based
- Date / task: 2026-11-28 / P8-T03
- TS source: `core-back/engine/compliance/reporting/xsdCompiler.ts`
- What Rust does: allows element/sequence/choice/attribute/simpleType and rejects
  DTD/ENTITY/include/import; `xs:pattern` is not enforced (no regex dependency) and inside
  `xs:choice` per-child `minOccurs` is not enforced (the exactly-one rule is). No arbitrary XSD
  execution is possible.
- Item / approval: n/a — a stricter, smaller language; FIU XSD confirmation remains the gate.

## DEV-024 `spec_hash` is a local SHA-256 implementation
- Date / task: 2026-11-28 / P8-T01
- TS source: `core-back/lib/reportEngineSdk/specHash.ts`
- What Rust does: `pg-report-engine` carries a small SHA-256 + canonical JSON to avoid a dependency;
  the TS golden spec hash (`7942fcd2…`) matches. Number text can differ only at extreme exponents.
- Item / approval: n/a — replace with `sha2` + `pg_types::js_object_order` when the crate next
  touches the hash (recorded follow-up).

## DEV-025 Verified deploy port table differs from the task prompt
- Date / task: 2026-11-28 / D0-T03
- TS source: `deploy/lib/configSchema.ts`, `deploy/deploy.env.example`, `hostPlanner.ts`
- What Rust does: uses the real ports: core 4000 (sandbox 4005), admin 4101, merchant 4102,
  checkout 4103, fake rails 4104/8444, object storage 4095, backup 4090, PostgreSQL 5432,
  PgBouncer 6432, Redis 6379, backup scratch 55432/55433. The prompt's 4010/4015/4020/4021/4022
  do not exist in the TS planner (4010/4015 is the D2 Rust-coexistence listener).
- Item / approval: n/a — TS wins.

## DEV-026 `pgctl config import` maps 86 of the 282 keys in this first pass
- Date / task: 2026-11-28 / D0-T02
- TS source: `deploy/deploy.env.example`
- What Rust does: imports 86 keys, keeps 115 unmapped keys in `[extra]` with `UNMAPPED` warnings,
  extracts 23 secret names as `secret:<name>` references and never returns secret values. The full
  282-key map and `secrets.age` writing remain D0-T02 work.
- Item / approval: n/a — lossless: nothing is dropped silently.

## DEV-027 pgctl config models each edge separately
- Date / task: 2026-11-28 / D0-T01
- What Rust does: `services.edges.{admin,merchant,checkout}` each carry their own ports instead of
  a flat `edges.port`, because the TS planner configures three independent edge services.
- Item / approval: n/a — schema shape; the importer accepts the flat env keys.

## DEV-028 External-database role keys are reported as ignored
- Date / task: 2026-11-28 / D0-T02
- What Rust does: `PG_DB_NAME`/`PG_DB_USER`/`PG_APP_USER`/`PG_REPLICATION_USER` on an external DB
  are consumed but reported as `IGNORED_ENV_KEY`; `DB_*` wins. TS silently ignores them.
- Item / approval: n/a — visible warning, same effective configuration.

## DEV-029 Parity route status is generated, not hand-maintained
- Date / task: 2026-11-28 / P0-T10
- What Rust does: `tools/parity/parity-md.ts` maps every route in the TS inventory to
  `live-rs|scaffold|todo` from `tools/parity/status.json` and fails if a status is missing or the
  markdown is stale. The hand-written `PARITY.md` remains the narrative; the generated table is
  published into it once the edges/core routes go live.
- Item / approval: n/a — tooling.

## DEV-030 Release archives use system tar/zstd
- Date / task: 2026-11-28 / D1-T01
- What Rust does: `pgctl release build` invokes `tar --sort=name --mtime=@epoch --owner=0 --group=0
  --numeric-owner` and `zstd -19` instead of in-process crates, because no tar/zstd crate is a
  workspace dependency. A missing tool is a precondition error (exit 3); the resulting archive is
  byte-deterministic for a fixed epoch.
- Item / approval: n/a — build tooling; revisit when the crate table adds tar/zstd.

## DEV-031 SSH runner is unit-tested through a scripted transport
- Date / task: 2026-11-28 / D1-T03
- What Rust does: the `Transport` trait has a `LocalTransport` and a real `RusshTransport`
  (public-key auth, hard timeout, exit status); tests use a scripted transport. No sshd fixture or
  real host was used. Host keys are pinned by SHA-256 fingerprint.
- Item / approval: n/a — the live host test remains a lab action.

## DEV-032 Service install references credentials that D4 provisions
- Date / task: 2026-11-28 / D1-T02
- What Rust does: systemd units carry `LoadCredential=` paths and the install plan creates
  `/etc/pg/credentials/<service>`; the files are not written by D1. `--execute` fails closed until
  the PKI/secrets distribution (D4) lands.
- Item / approval: n/a — dependency ordering.

## DEV-033 TS/Rust coexistence applies to the core only
- Date / task: 2026-11-28 / D2-T01
- What Rust does: `impl = "both"` plans TS core 4000/4005 and Rust core 4010/4015 with both pools in
  the edge plan. Edges keep one listener per port; coexistence is expressed through the route
  table/pools, not duplicate edge processes.
- Item / approval: n/a — chapter 7 only defines core coexistence ports.

## DEV-034 Zero-downtime socket handoff is not implemented
- Date / task: 2026-11-28 / D3-T03
- What Rust does: units document `SO_REUSEPORT` and a 15 s drain, but the listener option and the
  `@next` dual-instance handoff are a service-code change, not yet implemented. Rollback/watch and
  release history exist.
- Item / approval: n/a — D3-T02 remains open.

## DEV-035 Generated enum `sqlx(type_name)` values are quoted
- Date / task: 2026-11-28 / P3/P6
- TS source: `core-back/prisma/schema.prisma` enum names.
- What Rust does: the codegen emits `#[sqlx(type_name = "\"MerchantStatus\"")]` (quoted identifier).
  sqlx 0.9 resolves custom types through `to_regtype` and lower-cases unquoted names, so the
  previous `"MerchantStatus"` failed bindings for every CamelCase enum.
- Item / approval: n/a — required for sqlx to find the PostgreSQL type; generated files regenerated.

## DEV-036 Workers use an adaptive next-delay hook
- Date / task: 2026-11-28 / P6
- What Rust does: `Worker::next_delay` (additive) lets the outbox relay shorten its next tick after a
  non-empty drain; default remains the configured interval.
- Item / approval: n/a.

## DEV-037 `attempt.transitioned` read-model projector is an acknowledging consumer
- Date / task: 2026-11-28 / P6
- What Rust does: `OutboxRelayWorker` folds and acknowledges `attempt.transitioned` but the `rm_*`
  read-model SQL is not ported yet (E-DB-13). Expiry/poll write the event themselves with the
  `attemptRepository` payload.
- Item / approval: n/a — read models are a later phase.

## DEV-038 Automatic shard repair uses a CAS update
- Date / task: 2026-11-28 / P6
- What Rust does: auto-repair applies `UPDATE … WHERE balance = … AND line_seq = …` instead of the
  TS `FOR UPDATE` + tail read; the pure planner is shared with `pg-domain-ledger`. Only persistent
  PARITY, intact sequence and a correction under the cap are eligible.
- Item / approval: n/a — same invariant, shorter lock hold; verify in the P6 parity run.

## DEV-039 Platform-monitor probes are injected traits
- Date / task: 2026-11-28 / P6
- What Rust does: certificate, Redis, backup, communication and object-storage probes are traits;
  `cert_expiry` needs a reader to be wired by the runtime. Communication readiness opens a case but
  does not fan out `COMMUNICATION_ALERT` notices yet (P6-T04).
- Item / approval: n/a.

## DEV-040 Core `admin/auth/me` is authenticated
- Date / task: 2026-11-28 / P3-T08
- TS source: `core-back/api/internal/admin.ts` registers `auth/me` before `requireAuthentication`
  (static metadata).
- What Rust does: the P3 probe route requires a session and returns the principal, exercising the
  double check. P7 restores the TS pre-auth response.
- Item / approval: n/a — temporary P3 probe, recorded in `bins/core-rs/README.md`.

## DEV-041 `MTLS_REQUIRED` is a Rust-only development knob
- Date / task: 2026-11-28 / P3-T07
- What Rust does: when false, the CN guard is skipped for local tests; production/default is true.
  TS has no equivalent (Express sits behind the TLS server).
- Item / approval: n/a — test/development only; deploy never sets it.

## DEV-042 mimalloc is the selected allocator
- Date / task: 2026-11-28 / P0-T09
- Measurement: system vs mimalloc, JSON parse +15%, value round-trip +31%, serialize +21%, mixed
  +22%, peak RSS −17% (20k retained events). jemalloc could not build because `make` is absent.
- What Rust does: decision recorded in `BENCHMARKS.md`; the global allocator is enabled in the
  binaries in a later pass (edge/daemon agents may still be editing main.rs).
- Item / approval: owner decision; re-open if a target host lacks mimalloc support.

## DEV-043 BL-1 needs a twin cluster at 128 posters
- Date / task: 2026-11-28 / P0-T08
- The provided test cluster has `max_connections=100`, so 128 posters (141 connections) cannot run.
  A schema-only twin with `max_connections=300` was created, measured and dropped. A schema-only DB
  also needs the platform-wide `PROVIDER_FEE_EXPENSE` account seeded first.
- Item / approval: n/a — benchmark setup prerequisite, documented in `BENCHMARKS.md`.

## DEV-044 One posting exceeded Prisma's 5 s transaction budget at 128 posters
- Date / task: 2026-11-28 / P0-T08
- Observed 2 errors in ~133,500 postings (`P2028` at 5.3/5.6 s); no commit, D1-D5 still pass.
  Recorded as a baseline defect (GAP-065 context), not silently retried.
- Item / approval: n/a — baseline evidence.

## DEV-045 Fake Rails defaults to port 4104
- Date / task: 2026-11-28 / P9-T01
- TS source: `fake-rails-back/lib/env/index.ts:31`
- The first Rust pass defaulted to 4100 from the task prompt; corrected to the TS default 4104. Deploys
  set `PORT` explicitly, but local runs now match TS.

## DEV-046 Fake Rails transport limitations
- Date / task: 2026-11-28 / P9-T01
- What Rust does: webhook delivery is plain HTTP only (an HTTPS target fails with a clear error);
  `RSA_SHA256` signing returns 501 (unused by seeded profiles); `SOCKET_RESET` closes the connection
  with 499/`Connection: close` instead of a true TCP RST; business dates are fixed UTC+2 Tripoli;
  the login limiter uses the transport peer and does not trust `X-Forwarded-For`.
- Item / approval: n/a — documented in `bins/fake-rails-rs/README.md`; HTTPS/RSA are later hardening.

## DEV-047 Fake Rails statement XLSX cells are inline strings
- Date / task: 2026-11-28 / P9-T01
- What Rust does: the XLSX writer emits inline strings rather than numeric cells; CSV/JSON are exact.
- Item / approval: n/a — spreadsheet formatting only; revisit with the shared office pipeline.

## DEV-048 Backup daemon compresses through the zstd CLI
- Date / task: 2026-11-28 / P9-T02
- What Rust does: `zstd` is in the plan's crate table but was not in the workspace dependency
  list at implementation time; the daemon invokes the system `zstd` CLI (level 6, `-T0`) exactly
  as the TS daemon does. The PGBKv2 wire format is unchanged. Add the crate and switch in-process
  when the root manifest next changes.
- Item / approval: n/a — build/tooling.

## DEV-049 Backup S3/MinIO and SSH vault destinations fail closed
- Date / task: 2026-11-28 / P9-T02
- What Rust does: an `s3://` tier returns `S3_NOT_CONFIGURED` (no AWS SDK in the allowed
  dependency set); SSH/rclone returns `SSH_VAULT_NOT_PORTED`. Local filesystem tiers are complete.
  `wal-g`/`barman` are explicit configuration errors, never silently emulated.
- Item / approval: n/a — fail closed, recorded.

## DEV-050 Backup daemon has no continuous pg_receivewal supervisor
- Date / task: 2026-11-28 / P9-T02
- What Rust does: archive push + `wal-fetch` + restore of streamed partial segments are ported; the
  supervised continuous `pg_receivewal` process and object-storage blob copy/KEK escrow/decryption
  sample are gaps. Active-manifest parity is implemented.
- Item / approval: n/a — P9-T02 remaining.

## DEV-051 Checkout SSE/body and response-header deviations
- Date / task: 2026-11-28 / P2-T03
- What Rust does: one reqwest pool (64 idle/host) rather than separate 64-request and 128-SSE
  agents (per-IP stream cap and 10-minute deadline retained); sandbox calls add
  `x-execution-plane`/`x-sandbox-proxy`; sandbox `railCode` is a real query parameter (TS appends it
  into the path); checkout responses do not relay `x-pg-served-by`/`x-pg-min-lsn` (TS does not);
  `cross-origin-resource-policy: cross-origin` follows checkout TS, not the chapter 2 prose;
  ETags are not emitted; responses keep `cache-control: no-store` unless a handler overrides;
  malformed percent escapes map to `400 BAD_REQUEST`; the request log uses tracing fields.
- Item / approval: n/a — TS parity; brotli now supported.

## DEV-052 Edge responses do not echo x-request-id
- Date / task: 2026-11-28 / P2-T03..05
- TS source: `*/lib/requestLogger/index.ts` resolves and forwards the id but never sets a response
  header (chapter 2 §2 says edges echo it).
- What Rust does: forwards and logs the resolved id; does not add the response header (TS wins).
  The core still echoes `x-request-id`.
- Item / approval: n/a — chapter 2 stale; fix the chapter or add an S-item to both implementations.

## DEV-053 Admin edge relays bytes and parses bodies after LAN/auth
- Date / task: 2026-11-28 / P2-T05
- What Rust does: response bodies are relayed byte-for-byte instead of JSON re-serialisation;
  multipart is hand-parsed after the LAN/auth limiters (so an unauthenticated upload is refused
  before buffering); query parsing is flat (no qs bracket syntax); no access-log sink or coloured
  request line; one shared reqwest pool instead of per-node agents; HEAD/OPTIONS differences;
  no IPv6 /56 grouping or `RateLimit-*` headers; `x-request-id` forwarded but not echoed (TS).
- Item / approval: n/a — all routes are served; access-log sink arrives with S-OPS-01.

## DEV-074 Gateway egress error codes are an `API_*` family
- Date / task: 2026-11-28 / P5-T02
- TS source: `core-back/engine/apiConsumer/ApiConsumer.ts:134-159`
- `ApiConsumerError` carries `status`, `rawText`, `data`, `retryable` and `moneyUncertain` but no
  `code`. Rust therefore keeps the `compileUrl`/SSRF codes for a refused destination
  (`PRIVATE_HOST`, `HOST_NOT_ALLOWED`, `INSECURE_URL`, `DNS_FAILURE`, `HEADER_INJECTION_BLOCKED`, …)
  and adds a stable `API_*` family for what TS has no code for (`API_TIMEOUT`,
  `API_NETWORK_ERROR`, `API_RESPONSE_TOO_LARGE`, `API_REDIRECT_FORBIDDEN`,
  `API_JSON_DEPTH_EXCEEDED`, `API_XML_DTD_FORBIDDEN`, `API_INVALID_JSON`, `API_HTTP_ERROR`,
  `API_REQUEST_INVALID`) plus the credential/config codes (`API_KEY_CREDENTIAL_MISSING`,
  `API_TOKEN_ENDPOINT_REQUIRED`, `API_MUTUAL_TLS_MATERIAL_MISSING`, …). A caller that needs the TS
  `STEP_REQUEST_INVALID` refusal maps the auth/config codes itself.
- Item / approval: n/a — additive identifiers, no behaviour change.

## DEV-054 `API_KEY` with `apply: BODY` edits a structured body
- Date / task: 2026-11-28 / P5-T02
- TS source: `ApiConsumer.ts:611-668`
- TS serialises the body first and then requires an object for body placement, so every body shape
  either throws (`API_KEY body authentication requires an object body`) or silently ignores the
  assignment (`URLSearchParams` gets a JS property, not a form field). Rust injects the field into
  the structured JSON object or form body **before** serialization and refuses a multipart, XML,
  text or binary body with `API_BODY_PLACEMENT_UNSUPPORTED`. A gateway configured for body placement
  therefore now receives the key; the signature (when used) also covers it.
- Item / approval: n/a — the TS behaviour is a defect; recorded as a behaviour change.

## DEV-055 Mutual TLS trusts a per-credential CA by augmentation
- Date / task: 2026-11-28 / P5-T02
- TS source: `ApiConsumer.ts:543-556`, `:950-966`
- Bun's `fetch(..., { tls: { cert, key, ca } })` replaces the trust store with `ca`. Rust builds the
  client with reqwest (`Identity::from_pem`, `add_root_certificate`), which *adds* the credential CA
  to the platform roots; the client certificate and key come from the `certificate`/`privateKey`
  credentials, or from `pg_mtls::ClientTlsPaths` files in a deployment. TLS 1.2 and 1.3 are allowed
  (third-party gateways still speak 1.2; `pg_mtls::client_config` pins 1.3 for internal mTLS). One
  client is cached per `(host, pinned address, SHA-256 of the material)` in a bounded LRU.
- Item / approval: n/a — documented trust-store semantics.

## DEV-056 Rotating refresh tokens are kept in memory and a forced refresh keeps them
- Date / task: 2026-11-28 / P5-T02
- TS source: `ApiConsumer.ts:729-762`, `:811-818`
- TS persists a `new_refresh_token` through `rotatingRefreshTokenPersistence` and otherwise keeps
  using the stored credential until the process restarts. Rust hands every rotation to an optional
  `RefreshTokenSink` and also caches the newest refresh token, so the next grant uses it even
  without a sink. A 401-triggered forced refresh deliberately keeps the cached refresh token (TS
  would reuse the stale credential). `refresh_period_ms` is stored on the cached token so the TS
  `expires_in * 1000 - 30_000` cadence (and an explicit period) is reproduced; jitter is
  deterministic (FNV-1a) instead of `Math.random`.
- Item / approval: n/a — equivalent or safer token rotation.

## DEV-057 Multipart boundaries, XML/text content types and the flat query list
- Date / task: 2026-11-28 / P5-T02
- TS source: `ApiConsumer.ts:611-637`, `compileUrl.ts:179-219`
- Multipart: TS lets `fetch` serialise `FormData`; Rust generates `----pgw<uuidv7>` and writes the
  parts itself (same wire format), rejecting CR/LF/quotes in a field name or filename. XML and text
  bodies set `application/xml` / `text/plain; charset=utf-8`; TS sends a raw string with no default
  content type. A caller-supplied `content-type` always wins in both.
- Query: the executor takes flat `(name, value)` pairs and percent-encodes them like
  `encodeURIComponent` (space → `%20`); the nested `QueryValue`/`arrayFormat` compiler of
  `compileUrl` is not ported, so a caller flattens arrays itself. Path templates
  (`{{param}}` substitution) are not ported either.
- Item / approval: n/a — documented subset.

## DEV-058 The token endpoint follows the egress policy, and 5xx answers use the retry policy
- Date / task: 2026-11-28 / P5-T02
- TS source: `ApiConsumer.ts:453-481`, `:764-779`
- TS always requires HTTPS for a token endpoint, even for a development Fake Rails host; Rust
  validates it with the same policy as the call, so `allow_insecure_http` also permits a local token
  endpoint. TS retries an `ApiConsumerError` thrown by `responseError` (any 5xx) under the retry
  policy; Rust reproduces that, including a 5xx on the resend after a 401. A token-endpoint 5xx is
  therefore retried once for a safe call, where TS marks the token error non-retryable.
- Item / approval: n/a — consistent retry semantics; no money path changes.

## DEV-063 Ledger persistence is the raw-SQL path with an always-scoped currency
- Date / task: 2026-11-28 / P5-T04
- TS source: `engine/ledger/LedgerPoster.ts`, `lib/storageEngine/ledgerShardWriter.ts`,
  `engine/ledger/ShardRepair.ts`
- What Rust does: `pg-ledger` implements only the raw-SQL posting path; `LEDGER_RAW_SQL=false` is
  refused (`LEDGER_RAW_SQL_REQUIRES_RAW_PATH`) instead of running the Prisma fallback. The template
  always carries a currency, so account resolution is always currency-scoped (TS filters only when
  the posting context supplies one). Ids are generated in Rust (`Uuid::now_v7()`); repair apply is
  a compare-and-set on `(current_balance, line_seq)` instead of `FOR UPDATE` plus the frozen
  part/tail read; amounts are rounded to 4 dp in Rust before binding; shard widths are read per
  posting (no 3 s process cache); `verify_shard` is read-only and checkpoint advance stays in
  `pg-workers`. Repair writes `gl_shard_repairs` but not the audit row or operator-case note
  (those belong to the audit/case libraries).
- Item / approval: n/a — same money semantics, stricter currency context, shorter repair lock.

## DEV-064 PKI uses ECDSA P-256 and bundles leaves with the intermediate
- Date / task: 2026-11-28 / D4-T01
- TS source: `deploy/lib/pkiManager.ts` (`generate-mtls-certs`, RSA leaves, root-only trust anchor).
- What Rust does: root, intermediate and leaves are ECDSA P-256 (optional RSA leaves are not
  implemented). Leaf `.crt` files contain leaf + intermediate so a root-only trust store verifies
  them; `internal-ca.crt` stays root-only. Production leaves default to 90 days, `pki dev` leaves to
  825 days with the TS `core-back` CN. `pki verify` treats a leaf inside the renewal window as a
  failure, matching `--check-certs`; `pki renew` refuses when the CA itself is inside the window.
  The CRL is signed by the intermediate with a 30-day `nextUpdate` and rotation re-signs it.
- Item / approval: n/a — same chain and CN/SAN table; smaller keys and a portable bundle.

## DEV-065 D5 storage settings live in a `[storage]` overlay
- Date / task: 2026-11-28 / D5-T01..T05
- TS source: `deploy/lib/configSchema.ts` (`PG_RAM_GB`, `PG_IO_METHOD`, `PGBOUNCER_*`,
  `REDIS_*`, `KYB_*`) and chapter 7 §7 (`[postgres]`, `[pgbouncer]`, `[redis]`).
- What Rust does: `pg-deploy-plan::storage` owns the D5 knobs and reads a `[storage.<component>]`
  table; top-level `[postgres]`, `[pgbouncer]`, `[clamav]`, `[audit]` and `[log]` are accepted as
  aliases. They are removed before `PgctlConfig` deserialises (it denies unknown keys). `[redis]`
  stays in `pg-deploy-config`; only the new keys (`engine`, `acl`, `maxmemory`, `ha`, ...) are in
  `[storage.redis]`.
- Item / approval: n/a — temporary boundary. When `pg-deploy-config` models the D5 settings, move
  them into the document model and keep this loader as the compatibility alias.

## DEV-066 Storage TLS uses the internal CA, never a self-signed certificate
- Date / task: 2026-11-28 / D5-T01..T03
- TS source: `postgres18Provisioner.ts` (`pgTlsCommands`) and `pgbouncerTlsCommand` run
  `openssl req -x509`; the deploy gate then uses `sslmode=no-verify`.
- What Rust does: the plan requires `server.crt`, `server.key`, `ca.crt` and `crl.pem` under the
  component TLS directory and converges ownership/mode. The leaves are issued by `pgctl pki`
  (D4-T02). Links default to `verify-full`; `require` and `verify-ca` are explicit coexistence
  settings and produce a warning. `pg_hba.conf` defaults to `clientcert=verify-ca` (not
  `verify-full`) because one PgBouncer certificate cannot match both pooled roles; `verify-full`
  remains an option for direct-only deployments and warns when a pooler is enabled. Replication
  rules stay SCRAM-only: `pg_basebackup` has no client certificate, and the design scopes client
  certificates to application roles.
- Item / approval: D5 plans are target architecture; D4-T02 must issue storage leaves and per-role
  client certificates before `clientcert=verify-full` can be applied (the TS clients do not present
  one yet).

## DEV-067 PgBouncer auth file contains SCRAM verifiers, not plaintext passwords
- Date / task: 2026-11-28 / D5-T02
- TS source: `pgbouncerUserlist` writes `"user" "password"` in clear.
- What Rust does: the userlist contains `"user" "{{scram:<secret>}}"`; the executor derives the
  SCRAM-SHA-256 verifier from the secret store at apply time. `auth_type = scram-sha-256` is
  unchanged.
- Item / approval: n/a — no plaintext credential is written to disk or captured in a log.

## DEV-068 One pgctl-owned Redis configuration path
- Date / task: 2026-11-28 / D5-T03
- TS source: `redisProvisioner.ts` writes `/etc/redis/redis.conf.d/zz-pg-switch.conf`,
  `/etc/redis/redis.conf` and `/etc/valkey/valkey.conf` plus drop-ins for both flavours.
- What Rust does: `/etc/pg-redis/redis.conf` (and `users.acl`) is the single source, and a drop-in
  resets `ExecStart=` to `<redis-server|valkey-server> /etc/pg-redis/redis.conf`. This converges
  identically on Debian and Arch and avoids three drifting copies. Unit detection, restart-only-on
  -change and the firewall allowlist are the TS rules.
- Item / approval: n/a — representation choice; both engines are covered by tests.

## DEV-069 PGDG is the default source and `io_method = auto` resolves to `worker`
- Date / task: 2026-11-28 / D5-T01
- TS source: installs the distro package; no `io_method` setting.
- What Rust does: `storage.postgres.source = "pgdg"` (default) writes the pinned PGDG apt
  repository before installing `postgresql-18` (chapter 7 §9; fixes hosts without a distro
  package). `io_method = auto` renders `worker` in the static plan, probes kernel/liburing support
  and re-renders as `io_uring` at apply time.
- Item / approval: explicit `source = "distro"` keeps the TS behaviour; the probe result is a
  fact, not plan input, so the plan stays deterministic.

## DEV-070 Synchronous standbys are opt-in
- Date / task: 2026-11-28 / D5-T01
- TS source: `synchronous_standby_names` is never set (asynchronous replication).
- What Rust does: `storage.postgres.sync_standbys` defaults to `false`. When enabled it renders
  `ANY 1 (<slots>)` and the replica's `primary_conninfo` sets a matching `application_name`.
- Item / approval: design S-DB-12 says "benchmark first"; rendering it on a fresh primary would
  block every commit until the standby connects. Enable it after the replica is streaming.

## DEV-071 Audit/log DDL is inline until the P10-T02 migrations move it
- Date / task: 2026-11-28 / D5-T05
- TS source: `auditAndLogDbProvisioner.ts` embeds `AUDIT_DB_BASE`/`LOG_DB_BASE`.
- What Rust does: the same DDL is rendered into private 0600 SQL steps. Chapter 7 §9 moves it to
  `db/audit/*.sql` and `db/log/*.sql` migrations run by `core-rs migrate` at P10-T02. The audit and
  log tiers normally share `pgw_owner`, so they must use one owner password reference; the planner
  rejects two different references when both tiers are present.
- Item / approval: n/a — phase scope, tracked in the README.

## DEV-072 Provisioner execution is refused
- Date / task: 2026-11-28 / D5-T01..T05
- What Rust does: `pgctl provision plan` prints the JSON plan; `pgctl provision plan --execute` and
  `pgctl provision apply` print it too and exit 3 with "refused until the D1 service/SSH
  integration". No package is installed and no remote file is written by this build.
- Item / approval: the D5 planner is complete; execution waits for the D1 runner to consume
  `ProvisionStep` (fact probes, secret resolution, file hashes, reload/restart policy).

## DEV-073 PgBouncer runs from a pgctl-owned unit
- Date / task: 2026-11-28 / D5-T02
- TS source: keeps the packaged unit and adds only a `KillSignal=SIGINT` drop-in.
- What Rust does: writes `/etc/systemd/system/pgbouncer.service` (packaged unit override) with
  `KillSignal=SIGINT`, `TimeoutStopSec=15s`, `Type=notify`, `User=postgres`, `NoNewPrivileges`,
  `ProtectSystem=strict` and `ReadWritePaths`. `ExecStart=/usr/bin/env pgbouncer ...` keeps the
  binary path portable.
- Item / approval: n/a — same stop semantics as the TS drop-in, stronger sandbox.

## DEV-075 Flow engine persists per step and keeps the response that produced output
- Date / task: 2026-11-28 / P5-T03
- TS source: `engine/flow/DynamicRailEngine.ts`, `engine/flow/StepExecutor.ts`
- What Rust does: step/phase results are persisted per step (the TS persists per phase) so
  `advance_step` can resume; `previousResponse` must be encrypted at rest by the DB adapter. The
  phase response keeps the last response that actually produced one, where TS overwrites it with
  `undefined` (which would make the seeded HTTP-then-ASSERT card flow untrusted). HTTP 3xx maps to a
  failed step result `GATEWAY_REDIRECT_BLOCKED` instead of a thrown phase error, and every HTTP
  status is returned to the status rules. `matches` uses the in-crate JS-subset matcher (no
  lookaround/backrefs; no regex crate is pinned). `to_number` is allowed only for non-money;
  `to_int` keeps the negative sign (TS drops it). `LOCAL_SETTLEMENT_RECONCILE` uses the loaded
  attempt snapshot. The multipart boundary is owned by the egress adapter, and `initiate` returns
  `SUCCEEDED` while persisting `AWAITING_CUSTOMER` as TS does.
- Item / approval: n/a — same observable lifecycle, more durable resume data.

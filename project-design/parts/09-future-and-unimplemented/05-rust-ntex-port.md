---
id: future.rust-ntex-port
title: Backend Port to Rust on ntex (Future)
status: partial
confidence: high
last_verified: 2026-11-28
verified_against: c48a1c9+working-tree
code:
  - backend-rs/Cargo.toml
  - backend-rs/crates/pg-config
  - backend-rs/crates/pg-types
  - backend-rs/crates/pg-crypto
  - backend-rs/crates/pg-http
  - backend-rs/crates/pg-mtls
  - backend-rs/crates/pg-db
  - backend-rs/crates/pg-objstore
  - backend-rs/crates/pg-workers
  - backend-rs/crates/pg-domain-auth
  - backend-rs/crates/pg-domain-flow
  - backend-rs/crates/pg-domain-ledger
  - backend-rs/crates/pg-domain-gov
  - backend-rs/crates/pg-domain-comms
  - backend-rs/crates/pg-domain-recon
  - backend-rs/crates/pg-domain-academy
  - backend-rs/crates/pg-upstream
  - backend-rs/crates/pg-egress
  - backend-rs/crates/pg-redis
  - backend-rs/crates/pg-edge
  - backend-rs/crates/pg-report-engine
  - backend-rs/crates/pg-compliance
  - backend-rs/crates/pg-office
  - backend-rs/crates/pg-search
  - backend-rs/crates/pg-deploy-config
  - backend-rs/crates/pg-deploy-plan
  - backend-rs/tools/codegen
  - backend-rs/tools/golden
  - backend-rs/tools/route-inventory
  - backend-rs/bins/object-storage-daemon-rs
  - backend-rs/bins/core-rs
  - backend-rs/bins/admin-edge
  - backend-rs/bins/merchant-edge
  - backend-rs/bins/checkout-edge
  - backend-rs/bins/fake-rails-rs
  - backend-rs/bins/backup-daemon-rs
  - backend-rs/bins/pgctl
  - backend-rs/bins/wal-fetch
design_sources:
  - design/14-rust-port/porting_to_ntex_rust.md
  - design/14-rust-port/01_current_system_inventory.md
  - design/14-rust-port/02_contracts_reference.md
  - design/14-rust-port/03_target_architecture.md
  - design/14-rust-port/04_database_v2.md
  - design/14-rust-port/05_security_v2.md
  - design/14-rust-port/06_features_and_dynamic_configuration.md
  - design/14-rust-port/07_deploy_engine_v2.md
  - design/14-rust-port/08_verification_benchmarks_and_cutover.md
  - design/14-rust-port/09_task_catalog.md
tests:
  - backend-rs/crates/**/src/** (in-file unit tests)
  - backend-rs/tests/golden-vectors/fnv-shares.json
  - backend-rs/tests/golden-vectors/vault.json
  - backend-rs/tests/golden-vectors/webhooks.json
  - backend-rs/tests/golden-vectors/canonical.json
  - backend-rs/tests/golden-vectors/money-decimal.json
  - backend-rs/tests/golden-vectors/js-key-order.json
  - backend-rs/tests/golden-vectors/js-dates.json
  - backend-rs/tests/golden-vectors/pgos1.json
  - backend-rs/tests/golden-vectors/route-inventory
  - backend-rs/crates/pg-crypto/tests/golden_fnv.rs
  - backend-rs/crates/pg-crypto/tests/golden_vault.rs
  - backend-rs/crates/pg-crypto/tests/golden_webhooks.rs
  - backend-rs/crates/pg-crypto/tests/golden_canonical.rs
  - backend-rs/crates/pg-types/tests/golden_money.rs
  - backend-rs/crates/pg-types/tests/golden_json_order.rs
  - backend-rs/crates/pg-types/tests/golden_dates.rs
  - backend-rs/crates/pg-objstore/tests/golden_pgos1.rs
gaps:
  - Track P is at P0/P1: the object-storage daemon is complete; core and the edges are health/config scaffolds, and every unported route answers 501. No domain route, worker, migration, seed or business CLI is live.
  - Domain/edge/report/deploy crates are pure logic with 1,070 passing unit/golden tests; they are not wired into request handlers or SQL repositories yet.
  - TS baselines BL-1..BL-9 have not been recorded, the parity harness (P0-T10) and the two-machine/object-storage labs have not run, and `cargo deny`/`cargo sqlx prepare` are not yet part of CI.
  - The TS core still has no uniform per-worker disable switch (`WORKER_DISABLED`, P0-T03); Rust supports it.
  - Urgent compatible fixes identified by the plan are open, notably S-DB-02 (app role can delete audit_log rows by setting `pgw.audit_retention`) and S-SEC-02 (`requireMerchantScope` unused and fail-open).
---

# Backend Port to Rust on ntex (Future)

## 1. Status

**Partial (started 2026-11-28).** The plan is the document set in `design/14-rust-port/`; start with
`porting_to_ntex_rust.md`. `backend-rs/IMPLEMENTATION_TRACKER.md` is the live work log; `PARITY.md` and
`DEVIATIONS.md` record what is byte-compatible and what deliberately differs.

Implemented so far:

- Rust 1.100.1 workspace (`backend-rs/`) with the chapter 3 crate/binary layout, pinned dependencies, `deny.toml`,
  release profile, root `rs:check|test|build` scripts and a CI `rust` job.
- `pg-config` (dotenv, systemd credentials, object-storage daemon config), `pg-types` (Money4, decimal.js
  serialisation, JsDate, JS key order, ids, cursor), `pg-crypto` (vault AES-256-GCM/HKDF, CryptoEngine
  canonicalisation with UTF-16 sort, Standard Webhooks, FNV-1a UTF-16, redaction), `pg-http` (error envelope,
  request id, security headers, body limits, health, zod-shaped issues, deny-by-default route policies, fixed-window
  limiter catalogue), `pg-mtls` (rustls 1.3 server/client configs, CN/SAN extraction, channel table), `pg-db`
  (`sslmode=no-verify` normalisation, pool knobs, SQLSTATE map, advisory-lock leader election and session probe,
  Prisma metadata), `pg-objstore` (atomic FS store, remote mTLS client, `pgos1` envelope, MIME/executable sniffing,
  namespace policies, storage keys, GC/retention) and `pg-workers` (interval/jitter/singleton/panic isolation/health).
- The **P1 object-storage daemon** is complete: all six `/v1/*` routes, `fsck`, ntex/rustls mTLS with peer CN/SAN
  authorization, bounded bodies and the TS error bodies. This is the pilot for the ntex 4.11 mTLS model (P0-T07).
- Health/config scaffolds for `core-rs`, the three edges, fake rails and the backup daemon; unported routes answer
  `501 NOT_IMPLEMENTED_ROUTE` so the parity harness can classify them.
- Domain and adapter crates implemented as pure, tested libraries: `pg-domain-{auth,flow,ledger,gov,comms,recon,academy}`
  (sessions/JWT/MFA/throttle, statuses/transitions/guards/visible rails/slots, ledger templates/shards/fold/repair/commission,
  approvals/maker-checker/AML states, communication templates/tipping-off/SMS, CSV/date/statement parsing, exam/certificate/lab
  scoring), `pg-upstream` (least-in-flight pool/retry/path/headers), `pg-egress` (SSRF/allowlist/pinned resolution, auth
  methods, token cache, webhook retry), `pg-redis` (invalidation/realtime envelopes, Lua velocity, bounded auth state,
  caches/revocation), `pg-edge` (trusted proxies, cookie/CSRF, multipart/SSE/upload guards), `pg-report-engine`
  (spec/normalise/limits/hash/decimal/compatibility/verifier), `pg-compliance` (filing gate, safe XSD subset, periods,
  incidents), `pg-office`, `pg-search`, and `pg-deploy-{config,plan}` with the `pgctl` and `wal-fetch` binaries.
- P0 tooling is complete: Prisma codegen (123 models / 131 enums / metadata / report catalog), route/error/env inventory
  (611 core + 544 edge routes, 605 error groups, 8 env schemas) and 148 TypeScript-generated golden cases across FNV,
  vault, webhooks, CryptoEngine canonicalisation, decimal.js/Money4, JS key order/dates and `pgos1`. All eight Rust
  golden suites pass, including decrypting TS vault payloads and `pgos1` streams.
- Verification on this tree: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace` (1,070 passed), the three tool `--check` gates and the root scripts.

## 2. Program

Four tracks:

- **P — port at parity**: every server (`core-back` Live/Sandbox, the three edges, fake rails, backup and
  object-storage daemons) and every backend tool (migrations, seeds, synthetic seeder, admin bootstrap, ledger and
  audit utilities, WAL fetch) reimplemented in Rust on ntex 4 / Tokio with byte-identical contracts against the
  unchanged database, migrated route by route (edge route tables with shadow diffing) and worker by worker (shared
  advisory-lock leader election).
- **D — deploy engine v2 (`pgctl`)**: Rust replacement of `deploy/` with declarative TOML config (importer for the
  282-key `deploy.env`), pinned SSH host keys, rcgen PKI with ECDSA and rotation, encrypted secrets store delivered as
  systemd credentials, nftables, systemd units with zero-downtime SO_REUSEPORT restarts, versioned releases and
  automatic rollback, PGDG PostgreSQL 18, verified TLS for PostgreSQL/PgBouncer/Redis, optional Patroni HA and
  observability stack, plus ports of the test-matrix lab, deploy stress and local/Codespaces launchers.
- **S — compatible hardening** applied to TS and Rust together during coexistence (schema-version boot gate, audit
  delete bypass fix, least-privilege roles, MFA re-check, fail-closed merchant scope, PAN guard, storage TLS, index
  and constraint work, migration linter, metrics).
- **E — evolution** after parity: timestamptz, PII blind indexes and vault v2, RLS and per-service roles, partitioned
  queues and archives, DB-level ledger integrity, configuration registry, runtime worker control, feature flags,
  policy-as-data, regionalisation, approvals v2, rails v2, event platform, async inbound callbacks, SSE resume,
  asymmetric sessions, API tokens v2.

## 3. Targets

≥ 4,500 postings/s and ≤ 1 ms CPU per posting (TS: ~900/s at 6–7 ms, GAP-065), ≥ 2,000 checkout initiate TPS at
p95 < 35 ms, edge overhead ≤ 0.3 ms p50, RSS ≤ 35% of TS, 72 h soak and chaos with zero ledger drift, 100% route
parity.

## 4. Out of scope

Frontends, the documentation tooling, the frontend content pipeline (only its output path changes), the voucher
system and server-side PDF rendering.

When implementation starts, update this part per phase; move it out of `09-future-and-unimplemented/` at P10-T10.

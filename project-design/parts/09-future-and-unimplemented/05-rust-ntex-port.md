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
  - backend-rs/crates/pg-ledger
  - backend-rs/crates/pg-flow-engine
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
  - backend-rs/bins/core-rs/tests/
  - backend-rs/crates/pg-ledger/tests/live_pg.rs
  - backend-rs/crates/pg-flow-engine/tests/**
  - backend-rs/crates/pg-workers/tests/**
gaps:
  - Track P is partial: 315 of the 323 unique core routes are mounted (all reads except nine GETs); the write surface (223 POST/28 PATCH/24 PUT/12 DELETE), the money HTTP routes and the remaining workers are not ported, so unported routes still answer 501.
  - The P5 libraries exist but `productionRuntime`/`app.rs` are not wired to the flow adapters, so confirm/cancel/refund do not serve traffic yet; the money path is library-complete, route-incomplete.
  - Nine GETs remain (access-token/application/wallet summaries, wallet statement/audit, gateway AI transcript, report-engine transcript, merchant Google callback, POS SSE stream); the two transcripts need the P8 authoring builders and the other two are P5/P7 streams.
  - P6 has twelve of the TS workers; Deadline, KYB scan/expiry, regulatory reports, audit anchor, commission netting, notification/webhook fan-out, shard scaler/invariant and the object-storage maintenance worker remain.
  - P9 seeds/migrations/business CLIs and P10 cutover are not started; parity replay/shadow diffing and the two-machine/object-storage labs have not run; `cargo deny`/`cargo sqlx prepare` are not CI gates.
  - D5 provisioner execution is refused until D1 converges; D5-T06 HA, D5-T07 observability, D6 and the deploy stress/lab runs remain.
  - Urgent compatible fixes identified by the plan are open, notably S-DB-02 (app role can delete audit_log rows by setting `pgw.audit_retention`) and S-SEC-02 (`requireMerchantScope` unused and fail-open).
---

# Backend Port to Rust on ntex (Future)

## 1. Status

**Partial (started 2026-11-28, working tree on branch `rust`).** The plan is the document set in
`design/14-rust-port/`; start with `porting_to_ntex_rust.md`. `backend-rs/IMPLEMENTATION_TRACKER.md`
is the live work log; `PARITY.md` and `DEVIATIONS.md` record what is byte-compatible and what
deliberately differs.

Current Rust tree (verified 2026-11-28): **2,731 tests in 130 test binaries pass**, `cargo clippy
--workspace --all-targets -- -D warnings` is clean, all nine release binaries build, and the three
`backend-rs/tools` `--check` gates pass.

- **P0 complete.** Workspace/CI/scripts; route inventory (611 core + 544 edge routes, 605 error
  groups, 8 env schemas) and its `--check`; Prisma codegen (123 models / 131 enums / metadata /
  report catalog); 148 TypeScript-generated golden vectors across FNV, vault, webhooks,
  CryptoEngine canonicalisation, decimal.js/Money4, JS key order/dates and `pgos1`; baselines
  BL-1/BL-2; mimalloc; `WORKER_DISABLED` in the TS core; real mTLS proven with the internal CA.
- **P1 object-storage daemon complete.** All six `/v1/*` routes, `fsck`, ntex/rustls mTLS with peer
  CN/SAN authorization, bounded bodies and TS error bodies.
- **P2 edges complete.** `checkout-edge` 19/19 routes (179 tests), `merchant-edge` 107/107 (153
  tests), `admin-edge` 419/419 + sandbox catch-all (102 tests): mTLS pools, contract translation,
  uploads/limits, sandbox mirror, SSE and raw inbound compression.
- **P4 read surface complete except nine GETs.** `core-rs` mounts **315 routes**: all merchant,
  checkout, admin commerce/merchant-360/ledger/operations/AML/system/gateways/academy/report-engine/
  search and the 37 sandbox GETs, with `routes-policy.json` generated from the table and
  `bin/core-rs/tests/inventory_parity.rs` proving every mounted route exists in the TypeScript
  inventory with the right TS file. **Nine GETs remain**: `access-tokens/summary`,
  `applications/summary`, `wallets/summary`, `wallets/:id/statement`, `wallets/:id/audit-events`,
  `gateways/ai-transcript`, `report-engine/transcript` (two generated transcripts), the merchant
  Google OAuth callback (P7) and the POS SSE stream (P5).
- **P5 money-path libraries complete.** `pg-ledger` (posting, account cache, shard sequences,
  cash-out locks, reads, repair; 36 unit + 15 live tests), `pg-flow-engine` (transform library, six
  step kinds, rail loop, materialisation, DB/egress/ledger adapters; 157 tests), `pg-egress` (SSRF/
  pinned DNS, 10 auth methods, token cache, multipart, mTLS; 102 tests). The HTTP money routes
  (confirm/cancel/refund) and worker wiring are still P7.
- **P6 partially complete.** Runtime plus twelve workers: OutboxRelay, InboundInbox, ExpirySweeper,
  Poll, LedgerCheckpoint, PlatformMonitor, JournalPartition, JoinRequestExpiry,
  ExpiryHousekeeping, StatementSchedule, ConsistencyAudit and Retention (132 worker tests).
- **P9 daemons complete.** Fake Rails (20 rails, SQLite/WAL, portal/SSE/control; 86 tests) and the
  backup daemon (mTLS control/WAL, queue/idempotency/catalog/PGBKv2, pg-native full/delta/WAL,
  restore drills; 197 tests + live PostgreSQL 18 PITR). Seeds and business CLIs remain.
- **D0-D5 complete as libraries.** `pgctl` config/plan/release/SSH/install/route table/workers push/
  rollback/watch, PKI (113 tests incl. 42 PKI), storage provisioners as deterministic plans (87
  tests). Provisioner execution, D5-T06/T07 and the deploy labs remain.

Verification on this tree: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D
warnings`, `cargo test --workspace`, `cargo build --release --workspace`, the three tool `--check`
gates and `git diff --check`.

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

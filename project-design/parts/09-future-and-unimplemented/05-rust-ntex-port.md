---
id: future.rust-ntex-port
title: Backend Port to Rust on ntex (Future)
status: missing
confidence: high
last_verified: 2026-11-28
verified_against: c48a1c9+working-tree
code:
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
gaps:
  - No Rust code exists yet; every backend process and the deploy engine still run on TypeScript/Bun.
  - The ntex 4.11 mTLS model (peer certificate CN per request) is unproven until spike P0-T07 passes.
  - TS baselines BL-1..BL-9 have not been recorded.
  - The TS core has no uniform per-worker disable switch yet (`WORKER_DISABLED`, task P0-T03).
  - Urgent compatible fixes identified by the plan are open, notably S-DB-02 (app role can delete audit_log rows by setting `pgw.audit_retention`) and S-SEC-02 (`requireMerchantScope` unused and fail-open).
---

# Backend Port to Rust on ntex (Future)

## 1. Status

Planned (revision 2, 2026-11-28), not started. The plan is the document set in `design/14-rust-port/`; start with
`porting_to_ntex_rust.md`. This part is the canonical tracking entry and describes no current behaviour.

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

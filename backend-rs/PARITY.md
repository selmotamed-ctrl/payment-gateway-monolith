# Parity tracker

Status legend: `live-rs` (route/worker served by Rust), `partial` (port compiled and tested, not all
of the TS surface mounted or wired), `scaffold` (binary or crate exists, route returns 501), `todo`.
Track P requires `live-rs` before cutover; a route may only leave `scaffold` with golden vectors or
replay parity (chapter 8).

## Servers

| Component | Rust binary | Status | Notes |
| :--- | :--- | :--- | :--- |
| core | `core-rs` | partial | mTLS shell, DB pools/UoW/audit/leader, policy registry, health; all P4 GET read modules mounted (merchant, checkout, admin commerce/ledger/operations/AML/system/gateways/academy/report-engine/search/sandbox + merchant 360). Write routes and the P5 money-path wiring remain. `routes-policy.json` is the mounted contract. |
| admin edge | `admin-edge` | **live-rs** | 419/419 inventory routes + sandbox catch-all, contract translation, limiters/uploads/LAN guard; 102 tests |
| merchant edge | `merchant-edge` | **live-rs** | 107/107 routes, contract translation, sandbox mirror, uploads/limits; 153 tests |
| checkout edge | `checkout-edge` | **live-rs** | 19/19 routes, mTLS pool, raw inbound gzip/deflate/zstd/br, SSE, sandbox inspector; 179 tests |
| fake rails | `fake-rails-rs` | **live-rs** | SQLite + WAL, 20 rails, chaos, portal/JWT/SSE, accounts/clearing/statements, SDK/hosted, seeder, control, CIDR/webhook allowlists; 86 tests |
| object storage daemon | `object-storage-daemon-rs` | **live-rs** | all six `/v1/*` routes, `fsck`; P1-T03; real internal-CA mTLS verified (allowed CN, wrong CN 403, no-cert handshake refusal) |
| backup daemon | `backup-daemon-rs` | **live-rs** | mTLS control/WAL planes, queue/idempotency/scheduler/catalog/PGBKv2, pg-native full/delta/WAL, restore drills; 197 tests + live PG18 PITR |
| deploy engine | `pgctl` | partial | D0-D5: config/plan/release/SSH/install/route table/workers push/rollback/watch, PKI (113 tests), storage provisioners (87 tests); execution of provisioners and D5-T06/T07 remain |

## Libraries

| TS source | Rust crate | Status |
| :--- | :--- | :--- |
| `lib/env/index.ts`, daemon configs | `pg-config` | live |
| Prisma Decimal / JSON dates / ids | `pg-types` | live |
| `engine/crypto/Vault.ts`, `CryptoEngine.ts`, webhooks | `pg-crypto` | live |
| `lib/error`, request id, security headers, limits, policies, limiter | `pg-http` | live |
| `core-back/index.ts` mTLS, `mtlsGuard.ts` | `pg-mtls` | live |
| `lib/storageEngine` URL/leader/SQLSTATE | `pg-db` | live (DB calls P3.2+) |
| `lib/storageEngine/blobStore`, object-storage SDK | `pg-objstore` | live (FS + remote + pgos1) |
| `engine/workers/*` runtime + six workers | `pg-workers` | partial (runtime + OutboxRelay/InboundInbox/ExpirySweeper/Poll/LedgerCheckpoint/PlatformMonitor; remaining automations in progress) |
| `engine/ledger/LedgerPoster.ts`, shard writer, repair | `pg-ledger` | live (posting/locks/sequences/reads/repair; 36 unit + 15 live tests) |
| `engine/flow/**`, transforms, runtime | `pg-flow-engine` | partial (pure engine 63 tests; DB/egress/ledger adapters in progress) |
| `engine/apiConsumer/**`, webhook egress | `pg-egress` | live (102 tests, pinned DNS/mTLS/token cache/multipart) |
| auth / flow / ledger / gov / comms / recon / academy domain rules | `pg-domain-*` | live |
| report engine / compliance / office / search | `pg-report-engine`, `pg-compliance`, `pg-office`, `pg-search` | live libraries |
| deploy config / plan | `pg-deploy-config`, `pg-deploy-plan` | live libraries (provisioners plan-only; `--execute` refused until D1) |

## Byte-level vectors

| Area | Vector file | Status |
| :--- | :--- | :--- |
| FNV-1a UTF-16 / shards | `tests/golden-vectors/fnv-shares.json` | 20 cases pass (`crates/pg-crypto/tests/golden_fnv.rs`) |
| Vault seal/open/sign | `tests/golden-vectors/vault.json` | 15 cases pass, TS payloads opened by Rust (`golden_vault.rs`) |
| Standard Webhooks | `tests/golden-vectors/webhooks.json` | 6 cases pass (`golden_webhooks.rs`) |
| CryptoEngine canonicalisation | `tests/golden-vectors/canonical.json` | 17 cases pass incl. JS integer-key order (`golden_canonical.rs`) |
| decimal.js / Money4 / rounding | `tests/golden-vectors/money-decimal.json` | 62 cases pass (`crates/pg-types/tests/golden_money.rs`) |
| JS object key order | `tests/golden-vectors/js-key-order.json` | 10 cases pass (`golden_json_order.rs`) |
| `toISOString()` dates | `tests/golden-vectors/js-dates.json` | 13 cases (JS max date is outside chrono) (`golden_dates.rs`) |
| pgos1 | `tests/golden-vectors/pgos1.json` | 5 TS streams decrypted by Rust, framing verified (`crates/pg-objstore/tests/golden_pgos1.rs`) |
| Route / error / env inventory | `tests/golden-vectors/route-inventory/*.json` | 611 core + 544 edge routes, 605 error groups, 8 env schemas; `--check` gate; `bins/core-rs/tests/inventory_parity.rs` proves no mounted route is invented |

Cross-implementation golden vectors (chapter 8 §2) require the Bun generators (`tools/golden/`)
and are not written yet.

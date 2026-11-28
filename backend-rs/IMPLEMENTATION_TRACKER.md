# backend-rs implementation tracker

> Live work log for the Rust/ntex port. Any agent can resume from here.
> Plan: `design/14-rust-port/porting_to_ntex_rust.md` and chapters 1-9.
> Canonical tracking part: `project-design/parts/09-future-and-unimplemented/05-rust-ntex-port.md`.
> Last updated: 2026-11-28 (session 2, waves 3/4 integration).

## 1. How to resume

1. Read this file, then `backend-rs/DEVIATIONS.md` and the design chapter for the task you pick.
2. Check §4 for what is done and §5 for what is next. Pick the first `TODO` item in plan-ID order
   unless the user says otherwise.
3. Do not run `cargo build`/`cargo test` until the "verification window" in §6 is opened by the
   coordinating agent; write code and in-file unit tests first (user instruction: tests/builds at
   the end).
4. Update this file in the same change (status, files, notes). Do not let two agents edit the same
   file: §7 lists ownership.
5. Keep `DEVIATIONS.md` current for every intentional difference from the TS specification.

## 2. Non-negotiable rules (from the plan)

- Track P = parity. TS code wins over documents; record disagreements as `DEV-xxx`.
- Money is `rust_decimal::Decimal`; no `f32`/`f64` in money/ledger/commission/pricing/settlement.
- No `unwrap`/`expect`/`panic!`/`todo!`/`unimplemented!` in request, worker or CLI paths.
- Same transaction boundaries, lock order and idempotency as the TS code.
- Every route has a policy in `pg_http::policy::RouteRegistry`; deny by default.
- Secrets are never logged; `EnvironmentKeyResolver`/`SecretValue` exist for this.
- Only the pinned workspace dependencies. Add a `DEVIATIONS.md` entry for anything else.

## 3. Environment facts

- Rust 1.100.1 installed via rustup (`~/.cargo/bin`). Workspace pins `rust-version = "1.97"`.
- No cmake, NASM or clang on this host, so `aws-lc-rs` cannot build. **DEV-001**: RustCrypto
  (`sha2`, `hmac`, `hkdf`, `aes-gcm`, `subtle`, `rand`) replaces `aws-lc-rs` for hashes/HMAC/AES.
  Wire formats and algorithms are unchanged.
- Workspace lives at `backend-rs/` (not yet wired into root CI/scripts).
- Crate versions are the plan's pinned versions (`ntex` 4.11.1, `sqlx` 0.9.1, `rust_decimal` 1.43,
  `rustls` 0.23.46, ...). `sqlx` is a dependency but no live database is required for the current
  foundation code.

## 4. Status

Legend: `DONE` code complete + in-file tests; `PARTIAL` usable subset; `STUB` compiles, contract
documented, behaviour deferred; `TODO` not started.

### P0 Foundations
| ID | Status | Notes |
| :--- | :--- | :--- |
| P0-T01 workspace | DONE | `backend-rs/Cargo.toml`, 34 members, rust-toolchain, deny.toml, cargo config; `cargo clippy --workspace` and `cargo test --workspace` green |
| P0-T02 CI | DONE | root `rs:check|test|build` scripts + `rust` job in `.github/workflows/ci.yml` |
| P0-T03 TS WORKER_DISABLED | DONE | env keys, runtime filter + `/health`, external-drain boot guard, tests |
| P0-T04 route inventory tools | DONE | 611 core + 544 edge routes, 605 error groups, 8 env schemas; `--check` green |
| P0-T05 codegen | DONE | 123 models / 131 enums / metadata + report catalog; `--check` green |
| P0-T06 golden vectors | DONE | 148 TS-generated cases; all 8 Rust golden suites pass (pgos1 framing fixed) |
| P0-T07 ntex mTLS spike | DONE | real-cert test: health/PUT/GET with allowed CN, wrong CN 403 exact daemon body, no cert rejected by TLS 1.3 handshake; catch-all pattern fixed from `{tail:.*}` to `{tail}*` |
| P0-T08 baselines | DONE | BL-1 363/1030/632/581 posts/s at 1/8/32/128 posters, D1-D5 pass; BL-2 27/27 + perf bounds; BL-3..9 unavailable (documented) |
| P0-T09 allocator benchmark | DONE | mimalloc chosen: +15-31% JSON ops, -17% RSS; jemalloc unbuildable (no make) |
| P0-T10 parity harness | DONE | normalizer, TS/Rust edge launcher, fake core replay, DB differ, parity generator; 10/10 TS-vs-TS pass |
| P0-T11 fixture | PARTIAL | dump/verify/restore helper + manifest; COMPACT dump not committed as a CI artefact |
| P0-T12 dependency advisories | PARTIAL | nodemailer 10.6.1 + @types 8 removes the production SMTP highs; remaining highs are Prisma transitive `effect`/`deepmerge-ts`/`mysql2` and dev-only maildev nodemailer (GAP-081) |

### P1 Object storage (pilot)
| ID | Status | Notes |
| :--- | :--- | :--- |
| P1-T01 pg-config/pg-http/pg-mtls | DONE | env + credentials, error envelope, policies, rate limiter, rustls configs; `cargo check` green |
| P1-T02 blob store | DONE | `pg-objstore::{blob_store,remote,pgos1,sniff}`; atomic FS store, reqwest mTLS client, pgos1 seal/open |
| P1-T03 daemon routes | DONE | `bins/object-storage-daemon-rs` all six `/v1/*` routes + `fsck`; ntex `PeerCertDer` CN/SAN gate; route tests green |
| P1-T04 ship via pgctl | PARTIAL | release/service-install path exists; object daemon not yet live-shipped through pgctl |

### Foundation crates
| Crate | Status | Notes |
| :--- | :--- | :--- |
| pg-config | DONE | dotenv, credentials dir, object-storage config rules |
| pg-types | DONE | Money4, DecimalJs, JsDate, JS key order, JsNumber, ids, cursor + generated 123 models / 131 enums / meta |
| pg-crypto | DONE | vault, CryptoEngine canonicalisation, Standard Webhooks, FNV-1a UTF-16, redaction |
| pg-http | DONE | error envelope, request id, security headers, limits, health, validation, policy registry, limiter |
| pg-mtls | DONE | rustls 1.3 mTLS configs, CN/SAN, channel table |
| pg-db | DONE | pools/UoW/audit/leader session probe/listQuery/repositories/SQLSTATE; 40 unit + 8 live tests |
| pg-objstore | DONE | FS store, remote mTLS client, pgos1, sniffing, namespace policies/storage keys/GC; `cargo check` green |
| pg-redis | DONE | invalidation/realtime envelopes, velocity Lua, bounded auth store, caches/revocation; 60 tests green |
| pg-upstream | DONE | ≤in-flight pool, passive health, retry/path/header/consistency; 44 tests green |
| pg-edge | DONE | trusted proxies, cookie/CSRF order, header/multipart/SSE/upload guards; 64 tests green |
| pg-domain-auth | DONE | sessions/JWT, API tokens, authorities, throttle, cookies, MFA; 83 tests green (DEV-015..017) |
| pg-domain-flow | DONE | statuses/transitions/guards/visible rails/slots; 49 tests green (DEV-018..020) |
| pg-domain-ledger | DONE | template validation, 18 scenarios, FNV routing, fold/sequences, repair planner, commission rounding; 59 tests green (DEV-007/008/009) |
| pg-domain-gov | DONE | 29 approval subjects, maker-checker/checker roles, AML/dispute/cashout states; 26 tests |
| pg-domain-comms | DONE | EN/AR templates, tipping-off guard, SMS payload/signature, TS AUTH_ONLY ordering; 20 tests |
| pg-domain-recon | DONE | CSV/date/amount/context; 25 tests |
| pg-domain-academy | DONE | exam/certificate/lab scoring; 35 tests |
| pg-egress | DONE | public-IP/allowlist/SFn, auth methods, token cache, webhook retry; 102 tests green (DEV-010..013, 053-058) |
| pg-workers | PARTIAL | runtime + OutboxRelay/InboundInbox/ExpirySweeper/Poll/LedgerCheckpoint/PlatformMonitor (84 unit + 7 DB); six remaining automations in wave 5 |
| pg-report-engine | DONE | spec/normalize/limits/hash/decimal/compatibility/authority/verifier; 65 tests |
| pg-ledger | DONE (P5-T04) | posting, account cache, shard sequences, locks, reads, repair; 36 unit + 15 live tests |
| pg-flow-engine | PARTIAL (P5-T03) | 122 engine/transform/step/rail tests; DB/egress/ledger adapters in wave 5 |
| pg-egress executor | DONE (P5-T02) | 102 tests incl. real TLS/mTLS, pinned DNS, token cache, multipart |
| pg-compliance | DONE | filing gate, safe XSD subset, periods/calendar, incidents, canonical context; 43 tests |
| pg-office | DONE | RFC 6266 disposition, output names, DOCX/XLSX specs; 21 tests |
| pg-search | DONE | 21 providers, query parse/validation, ranking/slicing; 26 tests |
| pg-deploy-config | DONE | pgctl.toml model, 40+ validation codes, env importer, JSON Schema; 63 tests |
| pg-deploy-plan | DONE | host/service planner, diff, systemd units, verification checks; 31 tests |
| bins/core-rs | SCAFFOLD | mTLS, `/health`, channel health, config validate, schema version, policy export; `cargo check` green |
| bins/checkout-edge | DONE | 19/19 TS routes, mTLS pool, raw inbound gzip/deflate/zstd/br, SSE, sandbox inspector; 179 tests |
| bins/merchant-edge | DONE | 107/107 TS routes, contract translation, sandbox mirror, uploads/limits; 153 tests |
| bins/admin-edge | DONE | 419/419 inventory rows + sandbox catch-all, contract translation, limiters/uploads/LAN guard; 102 tests |
| bins/fake-rails-rs | DONE | SQLite + WAL, 20 rails, chaos, portal/JWT/SSE, accounts/clearing/statements, SDK/hosted, seeder, control, CIDR/webhook allowlists; 86 tests |
| bins/backup-daemon-rs | DONE | mTLS control/WAL planes, queue/idempotency/scheduler/catalog/PGBKv2, pg-native full/delta/WAL, restore drills; 197 tests + live PG18 PITR |
| bins/wal-fetch | DONE | restore_command-compatible local fetch, S3 exit 3; 10 tests |
| bins/object-storage-daemon-rs | DONE | P1 pilot complete |
| bins/pgctl | DONE (D0-D5) | config/plan/release/SSH/install/route table/workers push/rollback/watch, PKI (42 tests), provision plans; 113 tests |

## 4b. Golden-vector interop milestone

All eight TS-generated vector files are wired into Rust integration tests and pass:
`fnv-shares`, `vault`, `webhooks`, `canonical`, `money-decimal`, `js-key-order`, `js-dates`,
`pgos1`. The vectors found and we fixed: pgos1 frame length (plaintext length, not sealed length),
`JSON_CANONICAL` integer-key enumeration, `Money4` HALF_UP + negative-zero normalisation,
`RoundingMode` aliases/fallback, lowercase-only vault signatures and the JS max-date decision.
Route inventory is committed with a `--check` gate (P0-T04).

## 5. Current work (this agent)

Done: foundation crates, object storage daemon, worker runtime, all service scaffolds, CI/scripts,
README/PARITY/DEVIATIONS/BENCHMARKS; three edges, fake rails and backup daemon; D0-D3.

Integration in progress (2026-11-28 session 2):
1. Wave 3 P4 read routes and wave 4 P5/D4/D5 agents are finishing their own test gates. Do not
   edit their modules (ownership in §7).
2. Coordinator landed `:param` dispatch in `routes/mod.rs` (static path wins over a template, table
   cached once per process) and `bins/core-rs/tests/inventory_parity.rs` (every mounted route must
   exist in the committed TypeScript inventory, with a matching TS file).
3. Wave 5 (launched): sandbox GETs, admin merchant 360 aggregates, remaining admin exports/content/
   backups, report-engine transcript/migration/autocomplete, merchant deferred reads, `pg-flow-engine`
   DB/egress/ledger adapters, six remaining `pg-workers` automations.
4. Then: fix remaining `cargo test -p core-rs` failures, regenerate `routes-policy.json` with
   `cargo run -p core-rs -- routes export --out bins/core-rs/routes-policy.json`, and close the
   verification window (§6).

## 6. Verification window

OPEN for foundation crates (green so far: pg-config, pg-types, pg-crypto, pg-http, pg-mtls, pg-db,
pg-objstore, pg-workers, object-storage-daemon-rs, core-rs, three edges, fake-rails-rs,
backup-daemon-rs). Full-workspace verification waits for the parallel agents.

Commands:
```
cd backend-rs
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo deny check        # if cargo-deny installed
```
Plus existing repo gates: `bun scripts/project-design/build.ts --check`, `git diff --check`.

## 6b. Phase roadmap (plan order)

| Phase | Status | Notes |
| :--- | :--- | :--- |
| P0 foundations + tooling | DONE except P0-T03/T07-live/T08/T09/T10/T11/T12 | codegen, inventory, golden vectors wired; mTLS proven in ntex daemon; baselines/parity harness pending |
| P1 object storage pilot | DONE (P1-T04 blocked on pgctl shipping) | daemon live, golden pgos1 interop |
| P2 edges | IN PROGRESS (wave 2) | checkout/merchant/admin full proxies + translations |
| P3 core skeleton | PARTIAL | pools/UoW/audit/leader/listQuery/auth/route shell/health done (91 tests); `pg-db::replica` router added (not wired), Redis invalidation, domain routes remain |
| P4 read routes | TODO | needs P3 |
| P5 money path | TODO | needs P3 |
| P6 workers | PARTIAL | Outbox/Inbox/Expiry/Poll/Checkpoint/PlatformMonitor done (91 tests); 22 workers remain |
| P7 write routes | TODO | |
| P8 report/compliance/sandbox/academy | PARTIAL (libraries only) | runtime routes need P3/P4 |
| P9 fake rails/backup/seeds/CLIs | PARTIAL | Fake Rails (86) and backup daemon (197 + live PITR) done; seeds/CLIs remain (P9-T05..T08) |
| P10 cutover | TODO | |
| D deploy engine | PARTIAL (D0, D1, D2, D3-T03; D4/D5 in progress) | release tar/sign/verify, SSH runner/host pinning/sudo/stdin/lock, service install dry-run+execute, mixed TS/Rust plans, route table/workers push, rollback/watch; D3-T02/D4/D5/D6 remain |
| S compatible hardening | TODO | needs numbered TS+Rust items |
| E evolution | TODO | after P10 |

## 6c. Waves

- **Wave 2 (done):** checkout/merchant/admin edge proxies, core P3 shell + DB/auth/listQuery, P6
  concrete workers, fake-rails daemon, backup daemon, pgctl D1/D2, parity harness, TS baselines.
- **Wave 3 (launched 2026-11-28):** nine P4 read-route agents over the pre-created `routes/*`
  modules (merchant, checkout, admin commerce/ledger/operations/AML/system/gateways,
  report-engine/academy/search). Each owns one module file so `routes/mod.rs` is not edited.
- **Wave 4 (launched):** P5 money path core (`pg-ledger` DB poster, `pg-flow-engine` transforms/
  step executor/rail loop, `pg-egress` HTTP executor), plus D4 PKI and D5 storage provisioners.
- **Server restart (2026-11-28 ~04:20):** the harness restarted while waves 3/4 were compiling.
  All work is on disk; running `cargo` processes were resumed. Integration is waiting for the
  remaining route-module agents to stop writing before fixing the final compile errors and
  regenerating `routes-policy.json`. Do not edit a `routes/*` file owned by an active agent.

## 7. File ownership (parallel agents)

| Agent | Owns (write) | May read |
| :--- | :--- | :--- |
| coordinator (this agent) | `backend-rs/Cargo.toml`, `crates/pg-config`, `pg-types`, `pg-crypto`, `pg-http`, `pg-mtls`, `pg-db`, `pg-objstore`, `bins/object-storage-daemon-rs`, `bins/core-rs`, `bins/*-edge`, `bins/fake-rails-rs`, `bins/backup-daemon-rs`, tracker/docs/CI | everything |
| domain-ledger | `crates/pg-domain-ledger` | pg-types, TS ledger sources |
| domain-auth-flow | `crates/pg-domain-auth`, `crates/pg-domain-flow` | pg-crypto, pg-types, TS auth/flow |
| domain-gov-comms | `crates/pg-domain-gov`, `pg-domain-comms`, `pg-domain-recon`, `pg-domain-academy` | pg-types, pg-crypto |
| edge-upstream | `crates/pg-upstream`, `crates/pg-egress` | pg-crypto, pg-http, TS edges |
| redis-edge | `crates/pg-redis`, `crates/pg-edge` | pg-http, TS storage/edges |
| report-compliance | `crates/pg-report-engine`, `pg-compliance`, `pg-office`, `pg-search` | pg-types |
| deploy | `crates/pg-deploy-config`, `pg-deploy-plan`, `bins/pgctl`, `bins/wal-fetch` | design chapter 7 |
| route-inventory | `tools/route-inventory/**`, `tests/golden-vectors/route-inventory/**` | core/edge routes |
| golden | `tools/golden/**`, `tests/golden-vectors/*.json` (not route-inventory) | Rust crypto/types |
| checkout-edge | `bins/checkout-edge/**` | checkout-back TS, pg-edge/pg-upstream |
| merchant-read | `bins/core-rs/src/routes/merchant.rs` (+ submodules) | merchant TS GETs |
| checkout-read | `bins/core-rs/src/routes/checkout.rs` | checkout TS GETs |
| admin-commerce | `routes/admin_commerce.rs` | adminCommerce/admin GETs |
| admin-ledger | `routes/admin_ledger.rs` | adminLedger/finance/audit GETs |
| admin-operations | `routes/admin_operations.rs` | operator/dispute/recon/KYB/join/incident GETs |
| admin-aml | `routes/admin_aml.rs` | AML GETs |
| admin-system | `routes/admin_system.rs` | settings/system/stats/users/object-storage GETs |
| admin-gateways | `routes/admin_gateways.rs` | gateway/rail/route/credential GETs |
| report-academy-search | `routes/admin_report_engine.rs`, `admin_academy.rs`, `search.rs` | report/academy/search |
| ledger-poster | `crates/pg-ledger/**` | LedgerPoster TS |
| flow-engine | `crates/pg-flow-engine/**` | flow engine TS |
| egress-executor | `crates/pg-egress/src/**` | ApiConsumer/egress TS |
| pki-d4 | `bins/pgctl/src/pki/**` | deploy pkiManager TS |
| storage-d5 | `crates/pg-deploy-plan/src/storage/**`, `bins/pgctl` provision commands | deploy provisioners TS |
| merchant-edge | `bins/merchant-edge/**` | merchant-back TS |
| admin-edge | `bins/admin-edge/**` | admin-back TS |
| core-shell | `bins/core-rs/**`, `crates/pg-db/**` | generated types, pg-domain-auth, TS core |
| workers-p6 | `crates/pg-workers/**` | pg-db, generated types, TS workers |
| fake-rails | `bins/fake-rails-rs/**` | fake-rails-back TS |
| backup-daemon | `bins/backup-daemon-rs/**` | deploy/backup-daemon TS |
| deploy-d1d2 | `crates/pg-deploy-*/**`, `bins/pgctl/**`, `bins/wal-fetch/**` | design chapter 7 |

No agent may edit `backend-rs/Cargo.toml`; if a new dependency is required, report it to the
coordinator. Use `[dependencies] name = { workspace = true }` only for crates already in
`[workspace.dependencies]`; the coordinator can add missing ones.

## 8. Session log

- 2026-11-28: workspace, foundation crates (config/types/crypto/http/mtls/db/objstore), tracker
  created; seven parallel agents launched for domain/edge/redis/report/deploy crates.
- 2026-11-28: pg-objstore remote + sniff, object-storage daemon complete (ntex mTLS CN/SAN gate,
  all `/v1/*` routes, fsck), pg-workers runtime, service scaffolds (core/edges/fake-rails/backup),
  CI + root scripts + README/PARITY/DEVIATIONS/BENCHMARKS. `cargo check` green for all of these.
  Two more agents: route-inventory (P0-T04) and golden vectors (P0-T06).
- 2026-11-28: `pg-db` PgLeaderElection + boot session probe, `pg-http` ntex ApiError responder and rate
  catalogue, `pg-objstore` SDK policy (namespaces, stage validation, GC/retention, orphan guard),
  `pg-types` JsNumber; placeholders + dependencies prepared for the codegen agent (P0-T05).
- 2026-11-28: P0-T03 done (TS `WORKER_DISABLED`/external drain, tests); P0-T07 verified with the real
  internal CA/client certificates against the release object daemon; discovered and fixed the ntex
  catch-all syntax (`/{tail}*`) in every scaffold binary; added RSA-SHA256 sign/verify to pg-crypto.
  Wave 2 (10 agents) launched: three edges, core P3 shell, P6 workers, fake rails, backup daemon,
  pgctl D1/D2, parity harness, TS baselines.
- 2026-11-28 (session 2): wave 2 merged; wave 3 (nine P4 read-route modules) and wave 4
  (`pg-ledger`, `pg-flow-engine`, `pg-egress`, D4 PKI, D5 storage) are in their test gates.
  Coordinator: `routes::find` now matches `:param` templates (exact static path first, table cached
  in a `OnceLock`); new `tests/inventory_parity.rs` checks every mounted route against the
  committed TypeScript inventory. Active modules are still being written: do not edit §7 owners.

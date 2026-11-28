# Porting to ntex Rust — Master Plan (v2)

> **Status:** FUTURE / planning document, revision 2 (2026-11-28). Nothing here is implemented.
> **Canonical tracking part:** `project-design/parts/09-future-and-unimplemented/05-rust-ntex-port.md`.
> **Audience:** the engineer or AI agent implementing the program. This file is the entry point. Read it fully,
> then read the chapter for the task you are doing. Never start a task without reading its chapter section.

Revision 2 replaces revision 1 completely. It adds the deploy engine, a database and security redesign, a
configurability/feature redesign, every CLI, seed and runtime file that revision 1 missed, and it corrects the
revision 1 claims that a repository audit proved wrong (listed in §9).

---

## 1. Document set

| # | File | What it contains | Read it when |
| :--- | :--- | :--- | :--- |
| 0 | `porting_to_ntex_rust.md` (this file) | Program structure, tracks, rules, decisions, phase map, glossary | Always first |
| 1 | `01_current_system_inventory.md` | Every process, route group, table family, worker, CLI, script, runtime file, startup step, dependency and integration that exists today | Before porting anything; when unsure whether something exists |
| 2 | `02_contracts_reference.md` | Byte-level contracts the Rust code must reproduce during the port (wire, crypto, data, Redis, logging, Prisma behaviours) | During every Track P task |
| 3 | `03_target_architecture.md` | Rust workspace, crates, runtime model, route policy registry, config, errors, observability, CLIs, performance engineering | Before writing Rust code |
| 4 | `04_database_v2.md` | Current database review and the target database architecture, with online migration procedures | Track S database items and Track E |
| 5 | `05_security_v2.md` | Threat model, every known security weakness and its fix, key management, supply chain | Track S and Track E security items |
| 6 | `06_features_and_dynamic_configuration.md` | Configuration registry, feature flags, runtime worker control, policy-as-data, regionalisation, approvals v2, rails v2, event platform | Track E feature items |
| 7 | `07_deploy_engine_v2.md` | `pgctl`, the Rust replacement of `deploy/`: desired-state config, SSH, PKI, firewall, provisioners, systemd, zero-downtime, rollback, HA, secrets, lab and stress tooling | Track D |
| 8 | `08_verification_benchmarks_and_cutover.md` | Golden vectors, parity harness, test porting, benchmarks, soak/chaos, cutover and rollback runbooks | Every phase gate |
| 9 | `09_task_catalog.md` | Every task with ID, dependencies, inputs, steps and Definition of Done | When picking up work |

All paths in these documents are relative to the repository root unless stated otherwise.

---

## 2. Goals and scope

### 2.1 Goals

1. **Port** every backend process and every backend/ops tool to Rust, with ntex 4 as the HTTP framework for all
   servers:
   - servers: `core-back` (Live and Sandbox planes), `admin-back`, `merchant-back`, `checkout-back`,
     `fake-rails-back`, `deploy/backup-daemon`, `deploy/object-storage-daemon`;
   - tools: the deploy engine `deploy/` (including `test-matrix/` and `stress/`), all `core-back` CLIs and seeds
     (`migrate-*`, `db-seed`, `seed-fake-rails`, `seed-synthetic-history`, `create-admin`, `create-dev-users`,
     `generate-mtls-certs`, `repair-journal-default-partition`, `communication:bootstrap`, `schema:sql-only-check`
     and the audit utilities), the backup daemon's WAL fetch CLI, and the local/Codespaces launchers.
2. **Fix the measured performance problem**: ledger posting costs about 6–7 ms of application CPU and peaks near
   900 postings/s (TRACKER GAP-065) against a 15,000 TPS design target.
3. **Improve** the system design, database architecture, security, features and configurability, grounded in the
   documented gaps (chapters 4–6 cite every gap they fix).
4. **Keep the business running** throughout: no big-bang cutover, every step reversible by configuration.

### 2.2 What stays outside the program

| Item | Why it stays | Owner after the program |
| :--- | :--- | :--- |
| `admin-front`, `merchant-front`, `checkout-front`, `fake-rails-front`, `packages/ui`, `companion-app` | Frontends; they talk to the edges over unchanged contracts (Track P) or versioned additive APIs (Track E) | Frontend team |
| `scripts/project-design/**` (documentation generator and checker) | Documentation tooling, not runtime | Stays TypeScript/Bun |
| `admin-front/scripts/extract-academy-content.ts`, `extract-guide-content.ts` | Content pipeline owned by the frontend; only its output path changes (§6 of chapter 1) | Frontend team |
| `tests/e2e`, `tests/unit` (Vitest/Playwright UI tests) | They test frontends against mocked APIs | Frontend team; the live journeys are reused as parity checks |
| Voucher system, server-side PDF rendering | Not built today, not part of this program | Future work |

---

## 3. Program structure: four tracks

The program runs four tracks. Each task in chapter 9 belongs to exactly one track.

| Track | Name | Purpose | May change observable behaviour? | When |
| :--- | :--- | :--- | :--- | :--- |
| **P** | Port at parity | Reimplement every server and tool in Rust with byte-identical contracts against the **unchanged** database | **No.** Any difference is a bug unless it is a recorded Track S change | Phases P0–P10 |
| **D** | Deploy engine v2 (`pgctl`) | Replace `deploy/` with a Rust tool that ships Rust binaries, runs both implementations side by side, and then becomes the only deploy path | Operator-facing only (new CLI, new config format with an importer) | D0–D7, interleaved with P (chapter 7 §1 gives the dependency map) |
| **S** | Compatible hardening | Security fixes, safe database changes and operational improvements that both TS and Rust tolerate. Where TS behaviour changes, **TS is patched first** so parity holds | Yes, but only through numbered S-items, each applied to TS and Rust together | Any time after P0, in the order chapter 9 gives |
| **E** | Evolution | Database v2, breaking security upgrades, new features and dynamic configuration, built on the Rust-only codebase | Yes, through versioned, additive APIs and online migrations | After the P10 gate (TS backend retired) |

Why this order: parity can only be **proven** while both implementations run against the same schema and the same
contracts. Mixing redesign into the port would make every parity diff ambiguous ("bug or improvement?"). So the
port is strict, the safe improvements land early through Track S, and the deep redesign lands in Track E once there
is a single codebase to evolve. Chapter 4 §1 and chapter 6 §1 explain which improvement belongs to which track.

### 3.1 Phase map

```
P0 Foundations ─┬─ D0 pgctl skeleton + config importer
                ├─ P1 object-storage daemon ──── D1 binary shipping + systemd units
                ├─ P2 edges ──────────────────── D2 side-by-side core, route tables
                ├─ P3 core skeleton
                ├─ P4 read routes        S1..S6 (TS+Rust hardening, as scheduled)
                ├─ P5 money path ─────────────── D3 zero-downtime, rollback, release manifests
                ├─ P6 workers
                ├─ P7 write routes ───────────── D4 PKI v2, firewall v2, storage TLS
                ├─ P8 report engine, compliance, sandbox, academy, communication
                ├─ P9 fake rails, backup daemon, seeds & CLIs ── D5 backup/HA provisioning
                └─ P10 cutover, certification, TS retirement ── D6 lab + stress port, D7 TS deploy retired
                                   │
                                   ▼
                     E1..E14 Evolution (chapter 4, 5, 6)
```

Rough sizing for planning (one experienced engineer-equivalent, not calendar promises): P0 6 weeks, P1 2, P2 6,
P3 6, P4 10, P5 12, P6 8, P7 14, P8 12, P9 10, P10 6; Track D runs in parallel and totals about 20 weeks;
Track E is a roadmap of independent items of 1–6 weeks each.

---

## 4. Golden rules (non-negotiable)

1. **In Track P the TypeScript code is the specification.** When a document and the TS code disagree, the TS code
   wins. Record the disagreement in `backend-rs/DEVIATIONS.md` (format in chapter 9 §2) and follow the TS code.
2. **No silent behaviour change.** A Track P task never changes a wire contract, a database write, a file format,
   a log line the deploy engine reads, or an error code. Known TS quirks are replicated (example: malformed JSON
   returns HTTP 400 with body code `SERVER_ERROR`). Behaviour changes happen only through a numbered S- or E-item.
3. **Money is never floating point.** Money and quantities use `rust_decimal::Decimal` (scale 4) or
   `bigdecimal` where chapter 2 says so. `f64` is allowed only where the TS code itself uses JS numbers for
   non-money values and a faithful port needs it (PRNGs in fake rails and the academy exam engine, route-health
   percentages, JS-number JSON outputs). A CI check rejects `f32`/`f64` in files under `money`, `ledger`,
   `commission`, `pricing`, `settlement` modules.
4. **Database schema changes during Track P are forbidden**, except Track S database items, which must be
   backward compatible with the running TS code (expand-only or invisible to it; chapter 4 §2).
5. **Every byte-level format has golden vectors** generated by the real TS code (chapter 8 §2). An implementation
   is not done until it passes all of them.
6. **No `unwrap`, `expect`, `panic!`, `todo!`, `unimplemented!`** in request, worker or CLI execution paths.
   Allowed only in tests, build scripts and configuration loading at startup.
7. **Money-moving transaction boundaries, lock orders and idempotency rules are copied exactly** (chapter 2 §15–17).
   If one cannot be reproduced, stop and ask (§8).
8. **Everything ships behind a reversible switch** (route table, worker lists, implementation flags, feature
   flags). Rolling back is a configuration change.
9. **Docs move with code.** Every merged task updates `backend-rs/PARITY.md` / `DEVIATIONS.md` /
   `BENCHMARKS.md` as relevant, the tracking part, and `project-design/TRACKER.md` (repo rule in `AGENTS.md`).
10. **Security fixes reach production through Track S in both implementations at the same time.** Never ship a
    Rust-only fix for a vulnerability that the TS path still has while both serve traffic.

---

## 5. Architecture decisions

| ID | Decision | Rationale | Chapter |
| :--- | :--- | :--- | :--- |
| AD-01 | Strangler migration: TS and Rust side by side on the same databases; edges route per core route; workers hand over through shared advisory locks | ~170k LOC of money-moving code cannot be replaced at once safely | 8 §6 |
| AD-02 | ntex 4.11 on the Tokio runtime for all servers | sqlx, redis-rs, reqwest, lettre, russh and the AWS SDK are Tokio-based | 3 §2 |
| AD-03 | sqlx 0.9 with compile-time checked SQL; raw SQL copied verbatim from TS | catches column/type errors at build time; zero ORM overhead | 3 §4 |
| AD-04 | Schema owned by Prisma migrations until P10; then by a Rust migrator that reads `_prisma_migrations` and a new top-level `db/` directory | one schema owner at a time | 4 §5 |
| AD-05 | Custom least-in-flight upstream pool on hyper for edge→core | the TS pool semantics do not map onto reqwest's pool | 2 §10 |
| AD-06 | Hand-written zod-compatible validation issues | clients read `details[].path` and `details[].code` | 3 §7 |
| AD-07 | mimalloc global allocator (benchmarked against jemalloc and system in P0) | allocation-heavy JSON workloads | 3 §11 |
| AD-08 | Background workers on a separate multi-thread Tokio runtime | protects request p99 | 3 §2 |
| AD-09 | Types generated from the schema (Prisma DMMF until P10, live DB introspection after) | 123 models / 131 enums are too many to hand-write | 3 §5 |
| AD-10 | `panic = "unwind"` plus catch-panic middleware | a panic must fail one request, not a payment process | 3 §11 |
| AD-11 | Every route is registered with a mandatory **policy** (authn, authorities, scope, MFA, maker-checker, rate class); the build fails if a route has none | deny-by-default; fixes the class of gaps "guard forgotten on route X" | 3 §6, 5 §4 |
| AD-12 | Deploy engine becomes `pgctl` (Rust, single static binary) with a declarative TOML desired-state file, an importer for today's `deploy.env`, systemd instead of PM2, versioned releases, automatic rollback | today: no rollback, PM2 absolute-path trap, secrets in argv, TOFU SSH | 7 |
| AD-13 | Secrets reach services through systemd credentials (`LoadCredential=`), not environment variables; services read `$CREDENTIALS_DIRECTORY` first, env second | secrets out of `/proc/*/environ` and process listings | 5 §6, 7 §8 |
| AD-14 | All internal TLS (core, daemons, PostgreSQL, PgBouncer, Redis) uses certificates from one internal CA with full verification | today PostgreSQL uses self-signed certs and `sslmode=no-verify`, Redis has no TLS | 5 §3, 7 §6 |
| AD-15 | Seeds and the synthetic seeder are ported to Rust and reuse the domain crates; `core-back` stays in the repository as a library for them until P9 finishes | the seeder imports core modules directly | 1 §5, 9 P9 |
| AD-16 | Database v2 changes (timestamptz, PII encryption, RLS, roles, queue partitioning, attempt detail split, audit chain head) happen in Track E with online expand/contract migrations | parity first, redesign second | 4 |
| AD-17 | Server-owned configuration registry with typed schemas exposed over the API, scopes and cross-node invalidation; feature flags and runtime worker control built on it | today: settings catalog lives in the frontend, 10 seeded settings are never read, worker knobs need restarts | 6 |

---

## 6. Repository layout at the end of the program

```
backend-rs/                    Rust workspace (all servers, CLIs, pgctl)
  crates/ ...                  libraries (chapter 3 §3)
  bins/
    core-rs/                   core server + core CLI subcommands (migrate, seed, admin, ledger, schema, comms)
    admin-edge/ merchant-edge/ checkout-edge/
    fake-rails-rs/
    backup-daemon-rs/  wal-fetch/  object-storage-daemon-rs/
    pgctl/                     deploy engine, lab and stress tooling
  tools/                       Bun scripts used only during the port (golden vectors, codegen, parity)
  tests/                       golden vectors, parity fixtures, integration suites
db/
  migrations/                  SQL migrations (history imported from core-back/prisma/migrations at P10)
  sql-only-objects.allowlist.json
  schema-snapshot.sql          generated after every migration (pg_dump --schema-only, normalised)
content/
  academy/catalog.json  exam-bank.json   (moved from core-back/content/academy; embedded at build time)
deploy/                        removed at D7 (history kept by git tag `ts-deploy-final`)
core-back/ admin-back/ merchant-back/ checkout-back/ fake-rails-back/   removed at P10-T09 (tag `ts-backend-final`)
```

---

## 7. Definition of "done" for the whole program

- Every route in `backend-rs/tests/golden-vectors/routes.json` is `live-rs` in `PARITY.md`.
- Every worker, CLI and seed listed in chapter 1 has a Rust implementation in production use.
- `pgctl` deploys fresh and update topologies (single-host, split, replicated, HA) with verification, rollback and
  zero-downtime restarts; the TS deploy engine is retired.
- Certification (chapter 8 §8) passes: performance targets S1–S8, 72 h soak, chaos suite, restore drills.
- Track S items are all closed; Track E items are either done or explicitly deferred in the tracking part.

---

## 8. Stop and ask (never guess) when

- A transaction boundary, lock order, idempotency rule or plane fence cannot be reproduced exactly.
- A golden vector cannot be made to pass after following the TS code literally.
- A parity diff remains that you believe is a TS bug: replicate it, log it in `DEVIATIONS.md`, ask before fixing.
- You want to add a dependency not listed in chapter 3 §3, or a listed crate lacks a feature you need.
- The ntex mTLS spike (P0-T07) fails.
- A change would touch the database outside a numbered S/E item, the frontends, released report or spec-importer
  transcripts, certificates, or production data.
- A benchmark regresses more than 10% against the previous Rust run without an obvious cause.
- A Track S change would alter behaviour that a merchant, payer, operator or gateway can observe and the item does
  not already describe that change.

---

## 9. Corrections to revision 1 (proven by the 2026-11-28 audit)

| Revision 1 said | Reality (evidence) | Where revision 2 handles it |
| :--- | :--- | :--- |
| The schema version is checked at boot by `ensureSchemaVersion()` | Only `core-back/prisma/seed.ts:177`, `seedFakeRails.ts:230` and `syntheticSeeder/index.ts:39` call it; core never checks at boot | Chapter 2 §18 (parity: no boot check); Track S item S-DB-01 adds the boot gate to TS and Rust together |
| `coreInternalClient.ts` is three 761-line copies | 993, 993 and 991 lines | Chapter 1 §3 |
| The synthetic seeder shares formats through golden vectors | It imports core TS modules and the Prisma client directly | AD-15; P9 |
| Vault key ids list (10 ids) | Also `attempt-context`, `reporting-payload`, `reporting-xml`, `reporting-xlsx`, `reporting-docx`, `filing-adapter-secret`; anchor key id configurable via `AUDIT_ANCHOR_KEY_ID` | Chapter 2 §6 |
| CryptoEngine only verifies RSA | It also signs (`rsaSha256Sign`, `CryptoEngine.ts:308-318`) and supports SHA-512 | Chapter 2 §11 |
| calamine reads reconciliation uploads | The XLSX statement parser is deliberately unwired; production returns `400 XLSX_PARSER_UNAVAILABLE` | Chapter 2 §22 (parity keeps the 400); Track E item E-F12 enables it |
| `PLANE_FENCE_ALLOW_FAKE_RAILS_ON_LIVE` is read outside the env schema | It is in `core-back/lib/env/index.ts` | Chapter 2 §21 |
| Per-account limiters only in `admin-back` | `merchant-back/lib/authLimiters.ts` exists too | Chapter 2 §9 |
| Fake rails SDK/hosted pages are static files | They are generated per request by factories in `fake-rails-back/api/sdk/*.js.ts` | Chapter 9 P9-T01 |
| "No `as f64` anywhere" | Faithful ports need f64 for PRNGs and JS numbers | Rule 3 above |
| "No `bun install` on Rust hosts" | Seeds, migrations and `prisma generate` ran on core nodes | Chapter 7 §11 (transition) and P9/P10 (Rust CLIs) |
| Migrations stay in `core-back/prisma/migrations` after core-back is deleted | Contradiction | §6 above (`db/`), AD-04 |
| `preserve_order` reproduces JS key order | JS orders integer-like keys first; jsonb has its own order | Chapter 2 §13 |
| Deploy-written DB URLs work with sqlx | They contain `sslmode=no-verify`, which sqlx/libpq reject | Chapter 2 §18 |
| Missing entirely | Startup steps (communication bootstrap, chrome reconcile, leader session safety), runtime files (academy content, `schema.prisma` for Report Studio, PEM expiry checks), communication engine, tipping-off guard, Arabic screening normalisation, academy exam engine and certificates, gateway mTLS egress and token caching, Prisma `@updatedAt`/`now()`/`cuid()` behaviour, admin edge `contract.ts`, `lib/zReady`, backup daemon scheduler/catalog mirror/object-storage backup, operator CLIs, Codespaces/devcontainer | Chapter 1 and chapter 2 (each has its own section) |

---

## 10. Glossary

| Term | Meaning |
| :--- | :--- |
| TS core / Rust core | `core-back` (Bun) / `core-rs` (Rust) |
| Edge | `admin-back`, `merchant-back`, `checkout-back` and their Rust replacements |
| Plane | `LIVE` or `SANDBOX` (`EXECUTION_PLANE`, `system_execution_plane` row) |
| Route table | Edge-side mapping of core routes to the TS pool, the Rust pool or shadow mode (chapter 8 §6) |
| Golden vector | JSON file of `{input, output}` pairs produced by running the real TS function |
| Parity | Rust output equals TS output after normalisation (chapter 8 §3) |
| Expand/contract | Online schema change pattern: add new structure, dual-write, backfill, switch reads, remove old structure |
| `pgctl` | The Rust deploy engine replacing `deploy/` |
| S-item / E-item | A numbered Track S or Track E change (catalogue in chapter 9) |

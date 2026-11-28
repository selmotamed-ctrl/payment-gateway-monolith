# Chapter 9 — Task Catalogue

> Part of the Rust/ntex port plan (`porting_to_ntex_rust.md`). Every task of the program. Pick tasks in ID order
> within a track unless "Depends" allows otherwise. Size: S ≤ 1 day, M ≤ 1 week, L ≤ 3 weeks, XL > 3 weeks
> (split into ≤ L sub-tasks before starting, recorded as `<ID>.a`, `.b`, …).

---

## 1. Working rules for every task

1. Read the task row, the chapter sections it cites, every TS file it names, and the related canonical part in
   `project-design/parts/**`.
2. Port or write tests first (TS tests, golden vectors, parity fixtures); confirm they fail.
3. Implement; keep names close to the TS originals (snake_case) with `/// Port of <path>:<symbol>`.
4. Run: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo nextest run`, `cargo deny check`,
   `cargo sqlx prepare --check`, golden suite, affected parity suites.
5. Update `PARITY.md`, `DEVIATIONS.md`, `BENCHMARKS.md` as relevant, the tracking part and `project-design/TRACKER.md`.
6. One task (or one ≤ 25-route chunk) per pull request; the PR description lists transaction boundaries touched.

## 2. `DEVIATIONS.md` entry format

```
## DEV-<nnn> <title>
- Date / task: YYYY-MM-DD / <task id>
- TS source: <path>:<line>
- What TS does:
- What the plan said (if different):
- What Rust does: (equals TS unless an S/E item or owner approval says otherwise)
- Item / approval: <S-/E-item id or owner name>, or "n/a – replicates TS"
```

## 3. Review checklist (every PR)

- [ ] Routes have policies and parity cases; `PARITY.md` updated.
- [ ] Status codes, error codes, field order and headers match TS.
- [ ] Transaction boundaries and lock order match TS (listed in the PR).
- [ ] No `unwrap`/`expect`/`panic` in request, worker or CLI paths; no floats in money modules.
- [ ] Secrets never logged; blocking work off ntex workers; caches/queues/buffers bounded.
- [ ] Golden vectors pass; docs updated.

---

## 4. Track P — Port at parity

### P0 Foundations

| ID | Size | Depends | Goal and key steps | Definition of Done |
| :--- | :--- | :--- | :--- | :--- |
| P0-T01 | S | — | Install rustup; `backend-rs/` workspace per chapter 3 §3 with empty crates/bins; `rust-toolchain.toml` (≥ 1.97); `[workspace.dependencies]` from chapter 3 §12; release profile chapter 3 §11.1; `deny.toml` | `cargo build --release` green |
| P0-T02 | S | P0-T01 | CI jobs `rs-check`, `rs-test` (PostgreSQL 18 + Redis services); root scripts `rs:check|test|build`; `.gitignore`; devcontainer adds Rust toolchain; update `deploy/test/ci-workflows.test.ts` for new jobs | CI green on empty workspace |
| P0-T03 | M | — | TS: add `WORKER_DISABLED` (comma list) and `WORKER_BACKGROUND_JOBS_DRAINED_EXTERNALLY` to `core-back/lib/env/index.ts`, honour them in `productionRuntime.ts` and the boot precondition; tests; docs/TRACKER | Disabling a worker removes it from `/health.workers`; core-back tests green |
| P0-T04 | M | P0-T01 | `tools/route-inventory` (TS AST for edges, grep for core) → `routes.json` with full paths, file:line, guards, body parser and limits (totals core 610 + 1); `error-codes.json`; `env-schemas.json` (all services incl. daemons and fake rails); `edge-cases.json` captured from running TS services (unknown route, malformed JSON, oversize, 429 headers); vault key-id grep; CI check that new TS routes update `routes.json` | Files committed; CI check active |
| P0-T05 | M | P0-T01 | Codegen (chapter 3 §5): enums, models, meta (updated_at, id kind, Json nullability), `REQUIRED_SCHEMA_VERSION`, `report-schema-catalog.json` | Generated code compiles; every enum round-trips through PostgreSQL |
| P0-T06 | L | P0-T01 | Golden vector generators for every file in chapter 8 §2 that exists in TS today | All files committed, deterministic regeneration |
| P0-T07 | M | P0-T01 | ntex 4.11 + rustls mTLS spike: TLS 1.3, required client cert, CN/SAN available to handlers; tests with rcgen certs (good, wrong CA, wrong CN, none). **Stop condition**: if ntex cannot expose peer certs, build a custom acceptor (rustls handshake → CN → connection state); if impossible, escalate | Spike in `crates/pg-mtls/examples/`; API notes in DEVIATIONS |
| P0-T08 | M | — | TS baselines BL-1…BL-9 on B-local (B-lab if available); `BENCHMARKS.md` created | Baseline table recorded |
| P0-T09 | S | P0-T01 | Allocator and worker-count micro-benchmark (mimalloc/jemalloc/system; physical vs logical cores) | Decision in DEVIATIONS |
| P0-T10 | M | P0-T04 | Parity harness skeleton: normaliser, edge launcher (`EDGE_UNDER_TEST=rs`), read-replay runner, dual-DB write runner, semantic DB differ, `PARITY.md` generator | Harness runs against TS vs TS with zero diffs |
| P0-T11 | S | P0-T10 | Parity database fixture: COMPACT synthetic seed dump stored as a CI artefact with checksum + restore script | Fixture restores in CI |
| P0-T12 | M | — | S-SEC-14 dependency advisories fixed in TS (GAP-081) | `bun audit` high = 0 |

**P0 gate:** CI green; inventories, codegen and golden vectors committed; mTLS spike passed; baselines recorded;
parity harness proven TS-vs-TS.

### P1 Object-storage daemon (pilot)

| ID | Size | Depends | Goal and key steps | DoD |
| :--- | :--- | :--- | :--- | :--- |
| P1-T01 | M | P0 | `pg-config`, `pg-http`, `pg-mtls` minimal: env loading + credentials directory, daemon error shape, CN/SAN allowlist acceptor with raw 403, SO_REUSEPORT listener, sd-notify | Unit + golden env tests |
| P1-T02 | M | P1-T01 | `pg-objstore::blob_store` port (buckets, `.trash`, path rules, atomic write + fsync + rename, SHA-256 header, HEAD size) | Daemon TS tests ported, green |
| P1-T03 | M | P1-T02 | `object-storage-daemon-rs` routes (chapter 2 §7), streaming, `fsck` subcommand | TS daemon HTTP tests pass against Rust; TS core stores/reads objects through it |
| P1-T04 | S | D1-T02 | Ship via pgctl (D1); 24 h on the local stack with TS core; backup daemon reads blobs | Gate passed; memory/throughput vs TS in BENCHMARKS |

### P2 Edges

| ID | Size | Depends | Goal and key steps | DoD |
| :--- | :--- | :--- | :--- | :--- |
| P2-T01 | L | P1-T01 | `pg-upstream`: chapter 2 §10 in full + route table + shadow mode + sandbox pools; port pool white-box tests from all three edges | Ported tests green; fault injection matches TS |
| P2-T02 | M | P1-T01 | `pg-edge` common: security headers, request id, logger, CORS, trusted proxy IP, rate limiter (chapter 2 §9), zod-shaped validation + transforms (`lib/zReady`), `/health`, 404, body limits, cookie session + CSRF, streaming multipart | Unit + `edge-cases.json` vectors |
| P2-T03 | M | P2-T01, P2-T02 | `checkout-edge`: routes, `assertNoMonetaryFields`, pay limiter before body, inbound raw passthrough (allowlist, decompression), SSE passthrough, return redirect, certificate verify | 9 checkout-back test files pass against Rust; BL-4 recorded |
| P2-T04 | L | P2-T03 | `merchant-edge`: `api/contract.ts` translation, `coreSchema` re-validation, uploads with MIME/magic allowlist, external `pg_live_` check, POS SSE, sandbox proxy rewriting, `lib/authLimiters.ts` | merchant-back tests pass against Rust |
| P2-T05 | L | P2-T03 | `admin-edge`: LAN guard, limiters, advisory authority hints, `api/contract.ts` (1,691 LOC, incl. `randomBytes` uses), `api/protected/mutationSchemas.ts`, uploads with `x-upload-*`, `relayStatus`, object-storage and backup forwarding, sandbox proxy, `lib/authLimiters.ts` | admin-back tests pass against Rust (known 429-ordering failures identical) |
| P2-T06 | M | P2-T03..05, D2-T01 | Switch each edge to Rust in staging then production; 24 h soak; rollback rehearsed | P2 gate: three Rust edges live; BL-3/BL-4 compared |

### P3 Core skeleton

| ID | Size | Depends | Goal and key steps | DoD |
| :--- | :--- | :--- | :--- | :--- |
| P3-T01 | L | P0 | `pg-db`: pools for main/replicas/audit/log/report/leader; URL normalisation (`sslmode=no-verify`, `connection_limit`, `pool_max`); `application_name`s; UTC `after_connect`; statement cache knob; SQLSTATE map; plane-fence boot check; Prisma meta application (updated_at, ids) | Tests against PG 18 incl. via PgBouncer |
| P3-T02 | M | P3-T01 | Replica router + LSN (chapter 2 §18) | Ported tests incl. lag fallback |
| P3-T03 | L | P3-T01 | Unit of work, `writeAudit`, audit append (`pg_advisory_xact_lock(994001)`), outbox enqueue, buffered log sink | Storage-engine tests ported |
| P3-T04 | M | P3-T01 | Leader election (same keys) + `verifySessionSafety()` | TS and Rust contend; exactly one leads; kill test |
| P3-T05 | M | P3-T01 | `pg-redis`: buses, caches, velocity Lua, throttles, revocation; failure policies | Cross-implementation pub/sub test; Lua SHA matches vector |
| P3-T06 | L | P0-T06 | `pg-crypto` complete (chapter 2 §5–8, §11) | All related golden vectors pass |
| P3-T07 | M | P3-T01..06, P0-T07 | Core HTTP shell: mTLS + CN guards, middleware order, error handler, logger, access-log sink, health (+ `impl`), channel health, catch-panic, startup sequence (chapter 2 §19; chrome reconcile deferred to P8 while TS runs it), graceful shutdown | Deploy verifier health checks pass on 4010 |
| P3-T08 | M | P3-T07 | Auth double check and principals (chapter 2 §5 core side), Google OAuth JWKS client | Every error code tested; TS-minted tokens verify in Rust and vice versa |
| P3-T09 | M | P3-T01 | `listQuery` exact port (chapter 2, `lib/listQuery.ts`) with typed query builder | Cursor vectors + parity on 5 list routes |
| P3-T10 | M | P3-T07 | Route policy registry + `routes-policy.json` export + diff against `routes.json` | CI fails on any unregistered route |
| P3-T11 | M | D2-T01 | Run both cores in the lab (4010/4015), empty route table | Both cores healthy; zero Rust traffic |

### P4 Read routes

| ID | Size | Depends | Goal and key steps | DoD |
| :--- | :--- | :--- | :--- | :--- |
| P4-T01 | M | P3 | Serialisation helpers: `Money4`, `DecimalJs`, `JsDate`, JS key order, `ryu-js` | Golden vectors pass |
| P4-T02 | L | P4-T01 | Merchant GETs (`merchant.ts` 36, `merchantReportEngine.ts` reads not needing execution) | Replay 100%; shadow 48 h zero diffs; switched |
| P4-T03 | M | P4-T01 | Checkout GETs (9) | same |
| P4-T04 | XL | P4-T01 | Admin GETs: `adminCommerce`, `adminLedger`, `adminOperations`, `adminSystem`, then `admin.ts` GETs in ≤ 25-route chunks by resource | same per chunk |
| P4-T05 | M | P4-T01 | Academy, object-storage and backups GETs | same |
| P4-T06 | M | P4-T01 | Global search (20 providers, replica reads, ranking, `partial`) | Parity on ≥ 200 queries |

**P4 gate:** all 323 GETs `live-rs` or deferred with reason (sandbox GETs move to P8); BL-5 and memory compared.

### P5 Money path

| ID | Size | Depends | Goal and key steps | DoD |
| :--- | :--- | :--- | :--- | :--- |
| P5-T01 | L | P3 | Transforms DSL (39 ops, BigInt), selectors (prototype-key blocking), templates, status rules | Transform vectors 100% |
| P5-T02 | L | P3 | `pg-egress`: API consumer (10 auth methods, token cache with margin/jitter, per-credential mTLS clients, content types, XML templates), SSRF guard, response caps, pinned IPs | Ported tests; fake-rails auth matrix |
| P5-T03 | XL | P5-T01, P5-T02 | Flow engine: `DynamicRailEngine`, `StepExecutor`, rails, compute registry (3 ops), context cipher, spec importer runtime (schema, validator, simulator, materializer) | Ported flow tests; every fake rail journey passes |
| P5-T04 | L | P3 | Ledger poster (chapter 2 §14) incl. account cache, shard writer, `LEDGER_RAW_SQL` refusal, checkpoint/invariant/repair library code | Ledger tests; property tests; criterion ≤ 50 µs; BL-1 recorded |
| P5-T05 | L | P5-T04 | Slot store, attempt guard pipeline, AML rule engine, velocity, screening normalisation (chapter 2 §26) | Oversell test (1,000 concurrent confirms) equals TS; screening vectors |
| P5-T06 | L | P5-T03..05 | Checkout write routes (10) with exact boundaries | Dual-DB write parity incl. ledger balances |
| P5-T07 | M | P5-T06 | Inbound callbacks (raw body, dedupe, transient classification, verification) | Fake-rails callback suite (duplicates, out-of-order, corrupt signature) |
| P5-T08 | M | P5-T06 | SSE (checkout status, POS stream) with broadcast fan-out | BL-7: ≤ 16 KiB/stream, ≤ 100 ms latency at 5k streams |
| P5-T09 | M | P5-T06..08 | Money-path cutover: checkout namespace `rs` in staging → lab → production with watch windows | 7 days live in lab; S3 measured; invariants green |

### P6 Workers

| ID | Size | Depends | Goal and key steps | DoD |
| :--- | :--- | :--- | :--- | :--- |
| P6-T01 | M | P3 | `BaseWorker` runtime (jitter, single tick, singleton lock, health snapshot JSON parity) | Snapshot parity |
| P6-T02 | L | P6-T01 | OutboxRelay (folds, webhook fan-out, parking at 10, pruning) + AuditShipper (lease, batching ready for S-DB-14) | Handed over; 72 h invariants |
| P6-T03 | L | P6-T01 | BackgroundJob worker + handlers RECONCILIATION_RUN, ADJUSTMENT_EXECUTION, REFUND_INQUIRY, DISPUTE_INTAKE, SETTLEMENT_SWEEP, FEE_VARIANCE_TRUE_UP | Handed over |
| P6-T04 | L | P6-T01 | MerchantWebhook + OutboxNotification workers; `pg-domain-comms` transports (lettre SMTP modes, SMS webhook, legacy webhook), templates and tipping-off guard (chapter 2 §25) | Template vectors; handed over |
| P6-T05 | L | P6-T01, P5 | Attempt lifecycle: ExpirySweeper, Poll, InboundInbox, Deadline (`deadlines/*`, `businessTime.ts`), ExpiryHousekeeping, ExpiryNotice, JoinRequestExpiry | Handed over |
| P6-T06 | M | P6-T01, P5-T04 | Ledger workers: Invariant, Checkpoint (+auto-repair), ShardScaler, JournalPartition; CLI `core-rs ledger repair-default-partition` | Handed over |
| P6-T07 | L | P6-T01 | Compliance: PeriodicScreening, KybExpiry, KybScan (clamd `zINSTREAM` + builtin), RegulatoryReport (draft), AuditChainAnchor, CommissionNetting (`croner`, Tripoli) | Handed over |
| P6-T08 | M | P6-T01 | Platform: StatementSchedule, ConsistencyAudit, ObjectStorageMaintenance, GatewayHealth (route-health policy), PlatformMonitor (check families backup/communication/moneyPath/objectStorage/platform incl. PEM expiry), Retention | Handed over |
| P6-T09 | M | P3 | Operator cases library (`lib/operatorCases/**`, case catalogue, sink) | Ported tests |

**P6 gate:** TS `WORKER_DISABLED` lists all 28 workers; TS boots with `WORKER_BACKGROUND_JOBS_DRAINED_EXTERNALLY=true`.

### P7 Remaining write routes

| ID | Size | Depends | Goal and key steps | DoD |
| :--- | :--- | :--- | :--- | :--- |
| P7-T01 | XL | P5, P6-T09 | Governance engine: `GovernanceExecution` (all subject types), maker-checker guard (JSON Patch), approve/reject routes with BACKUP_POLICY and ADJUSTMENT branches | Every subject has a dual-DB scenario |
| P7-T02 | L | P7-T01 | Merchant writes: auth (login, MFA, email verification, password reset, Google OAuth), onboarding + KYB uploads, cash-out (idempotency + wallet lock), tokens, webhook endpoints, POS, applications, links | Write parity |
| P7-T03 | L | P7-T01 | Admin commerce writes | Write parity per ≤ 25-route PR |
| P7-T04 | L | P7-T01 | Admin ledger, adjustments, disputes (attachments upload) | same |
| P7-T05 | L | P7-T01 | AML cases (evidence upload), KYB, join requests, screening admin | same |
| P7-T06 | L | P7-T01 | Staff/users/invitations, platform settings, communication settings | same |
| P7-T07 | L | P7-T01, P5-T03 | Gateways, versions, flows, credential sets, spec verify/import, route-health overrides, commission profiles, velocity rules | same |
| P7-T08 | M | P7-T01 | Reconciliation upload + ingestor (CSV/JSON; XLSX stays unwired → 400), sweeps, follow-ups; object-storage admin; backups routes (backup client env names) ; academy writes | same |
| P7-T09 | S | P7-T06 | CLIs `core-rs admin create`, `admin dev-users` (+ plan logic) | Bootstrap tested on empty DB |
| P7-T10 | M | P7-T02..08 | Cutover of admin and merchant namespaces | Live journeys (`E2E_LIVE=1`, `tests/e2e-live`) pass against Rust |

### P8 Report engine, compliance, sandbox, academy, communication

| ID | Size | Depends | Goal and key steps | DoD |
| :--- | :--- | :--- | :--- | :--- |
| P8-T01 | XL | P3 | Report engine SDK (spec types, compilers, transform executor precision 40, verifier layers, read-only executor, transcripts, chrome, `specHash`, migrations/compatibility, mock preview) | 151 SDK tests ported; transcripts byte-identical; `specHash` equal for all stored specs |
| P8-T02 | L | P8-T01 | Report Studio host: asset storage (object storage + local default), autocomplete providers, embedded schema catalog, default chrome specs, `reconcileReportChromeDefaults` startup step; admin/merchant report-engine routes (POST) | Route parity |
| P8-T03 | L | P8-T01 | Regulatory reporting: XSD compiler/generator/validator, `CanonicalReportContext` (goaml settings), `ReportingRuleEvaluator`, incidents, `OperatorCaseSink`, XLSX/DOCX writers, filing adapters | XML byte-identical; XLSX/DOCX canonical-equal |
| P8-T04 | M | P5-T03 | Spec importer AI transcript + repair prompt byte-identical (embedded JSON Schema artefact) | Transcript bytes equal |
| P8-T05 | L | P5, P7 | Sandbox control (68 routes) + `FakeRailsControlClient` | Sandbox Studio journeys pass |
| P8-T06 | S | P5-T02 | Mock gateway server as in-process ntex server | Gateway-test route parity |
| P8-T07 | M | P6-T04 | Communication admin routes, test delivery, `core-rs comms bootstrap|test-send` | Parity |
| P8-T08 | M | P3 | Academy: embedded catalog/exam bank, exam engine (chapter 2 §27), certificates, routes, checkout verification route on core | Exam vectors; parity |
| P8-T09 | M | P8-* | Cutover of remaining routes | P8 gate: TS core receives zero traffic 7 days in lab |

### P9 Fake rails, backup daemon, seeds and CLIs

| ID | Size | Depends | Goal and key steps | DoD |
| :--- | :--- | :--- | :--- | :--- |
| P9-T01 | L | P1-T01 | `fake-rails-rs`: rusqlite schema + WAL, 20 rails / 9 modes, chaos with identical PRNG, magic values, SDK/hosted JS generators, statements CSV/JSON/XLSX, portal JWT, SSE hub, seeder bulk endpoint, control API, CIDR allowlist | Fake-rails HTTP tests pass; sandbox journeys pass |
| P9-T02 | XL | P1-T01 | `backup-daemon-rs`: mTLS front with control/WAL planes, engines (pg-native, wal-g, barman) via `tokio::process` with identical arguments, AWS SDK S3, PGBKv2, FIFO queue, idempotency, scheduler + cron, catalog mirror, object-storage backup (parity check, keyring escrow), instance lock, logical dump, drills (drift, shard parity, audit chain) | 22 test files ported; cross-implementation restore both ways; lab drill |
| P9-T03 | S | P9-T02 | `wal-fetch` CLI | PITR drill passes |
| P9-T05 | L | P5, P7 | `core-rs seed base` (GL accounts, chrome specs, communication templates, blueprints, platform credential sets, guides, settings) and `seed fake-rails` | Seeded DB semantically equal to TS seed |
| P9-T06 | L | P9-T05 | `core-rs seed synthetic` reusing domain crates (ledger poster, governance, object storage, vault, onboarding, KYB, shard routing); fake-rails bulk sync | Post-seed audit equals TS for the same profile and seed |
| P9-T07 | S | P3 | `core-rs cases backfill`, `audit legacy-evidence`, `audit currency-mismatch`; record retirement of the showcase seeder | CLIs tested |
| P9-T08 | S | P8-T08 | Move academy content to `content/academy/`; retarget `admin-front/scripts/extract-academy-content.ts` output | Build embeds new path; frontend script writes there |

### P10 Cutover, certification, retirement

| ID | Size | Depends | Goal and key steps | DoD |
| :--- | :--- | :--- | :--- | :--- |
| P10-T01 | L | P3 | Rust migrator (chapter 4 §5), `db/` directory with imported history, `migrate status --json`, `rehearse`, `lint`, `schema check-sql-objects` with fingerprints, codegen via introspection | Fresh and existing DBs migrate; `_prisma_migrations` compatible |
| P10-T02 | M | P10-T01 | Audit/log DDL as `db/audit` and `db/log` migrations; provisioner stops creating DDL | Deploy green |
| P10-T03 | M | D5, D6 | pgctl owns all deploy paths; Bun no longer installed on hosts | Fresh + update deploys green |
| P10-T04 | M | P8-T09, P9 | All routes and workers Rust for 7 days in production | No rollback for 7 days |
| P10-T05 | S | P10-T04 | Rust core to ports 4000/4005; edges' pools updated | Verified |
| P10-T06 | L | P10-T05 | Certification (chapter 8 §8) | S1–S8 reported; owner sign-off in TRACKER |
| P10-T07 | M | P10-T06 | PGO | Keep only if ≥ 5% gain |
| P10-T08 | S | P10-T06 | io_uring runtime evaluation for edges | Decision recorded |
| P10-T09 | M | P10-T06 + 30 days | Remove TS backend sources (tag `ts-backend-final`); keep nothing that depends on `core-back` | Repo builds; CI green |
| P10-T10 | L | P10-T09 | Rewrite canonical parts for the Rust system (`00-platform/*`, `01-core-back/*` → core-rs, `02-edge-services/*`, `06-fake-rails/*`, `07-deploy/*` → pgctl, `08-testing/*`); move this plan's tracking part out of `09-future-and-unimplemented` | `bun scripts/project-design/build.ts --check` passes |

---

## 5. Track D — Deploy engine v2

| ID | Size | Depends | Goal and key steps | DoD |
| :--- | :--- | :--- | :--- | :--- |
| D0-T01 | M | P0-T01 | `pgctl` skeleton (`clap`), `pgctl.toml` model + JSON Schema, validation port of `configSchema.ts` rules + new rules (chapter 7 §7) | Unit tests for every rule |
| D0-T02 | M | D0-T01 | `pgctl config import` for all 282 keys; `docs/pgctl/env-import-map.md`; secrets into `secrets.age` | Imports `deploy.env.example` and the lab configs losslessly |
| D0-T03 | L | D0-T02 | Planner port; golden comparison: TS planner JSON (`planHosts` output dumped by a Bun script) vs pgctl plan for every example config and lab topology | Plans equal (modulo documented improvements) |
| D1-T01 | M | P0-T02 | `pgctl release build|sign|verify` (tar.zst, manifest, minisign, SBOM) | Signed artefact verified on a host |
| D1-T02 | M | D1-T01, D1-T03 | systemd unit templates; install/start/verify one Rust service (object-storage daemon) while the TS engine still runs the rest | P1-T04 can ship |
| D1-T03 | M | D0-T01 | russh runner: host-key pinning (`hosts enrol`), sudo via stdin, file transfer with hash check, timeouts, redaction, local mode, per-host lock | Integration test against a container host |
| D2-T01 | L | D1-T02 | Side-by-side services: per-service `impl`, TS services still via PM2, Rust services via systemd, Rust core on 4010/4015, edge pools for both | Lab deploy with mixed impl green |
| D2-T02 | M | D2-T01, P2-T01 | Route table and worker list rendering + push (`route-table`, `workers handover`) | Handover rehearsed in lab |
| D3-T01 | M | D2-T01 | Release manifests with rendered configs per release; `/opt/pg/current` units | Re-render reproducible |
| D3-T02 | M | D3-T01, P1-T01 | Zero-downtime handoff (`@next` unit, SO_REUSEPORT, health, drain) | `pgctl stress noop-redeploy` outage 0 ms single node |
| D3-T03 | M | D3-T01 | `pgctl rollback`, watch window with auto-rollback | Rollback rehearsal in lab |
| D3-T04 | M | D2-T01 | Verification suite (chapter 7 §13) | Matches/extends TS verifier output |
| D4-T01 | L | D1-T03 | PKI v2 (rcgen, ECDSA, root/intermediate, inventory, renew, revoke, CRL, hot reload, `pki dev`) | Rotation in lab without restarts |
| D4-T02 | L | D4-T01, D5-T01..03 | Storage TLS (S-SEC-06): PG/PgBouncer/Redis certs, `verify-full`, client certs, Redis ACL | Negative TLS tests |
| D4-T03 | M | D1-T03 | nftables firewall with auto-revert apply and verification (S-SEC-17) | Lock-out test passes |
| D4-T04 | M | D0-T02 | Secrets store + systemd credentials + `secrets rotate` procedures | `ps`/environ capture shows no secrets |
| D5-T01 | L | D1-T03 | PostgreSQL 18 provisioner (PGDG, clusters, conf from S-DB-05/11/12, replicas, checksums, io_method) | Fresh + update in lab |
| D5-T02 | M | D5-T01 | PgBouncer provisioner (pool budgets, TLS, aliases) | Same |
| D5-T03 | M | D1-T03 | Redis/Valkey provisioner (TLS, ACL, AOF, optional Sentinel) | Same |
| D5-T04 | L | D1-T03 | ClamAV, MinIO, backup daemon (pinned WAL-G/Barman checksums), object storage provisioners | Same |
| D5-T05 | M | P10-T02 | Audit/log DB provisioning via migrations | Same |
| D5-T06 | L | D5-T01 | Optional Patroni HA (`ha = "patroni"`), `db switchover/failover` | Chaos switchover passes |
| D5-T07 | M | D1-T03 | Optional observability stack + alert rules | Alerts fire in chaos tests |
| D5-T08 | M | D1-T03 | Nginx templates + certbot timer + security headers | Public vhosts verified |
| D6-T01 | L | D5 | `pgctl lab` (schema, presets, topologies, 12 + new gates, Rust load generator, reports) | One full certification run |
| D6-T02 | M | D3 | `pgctl stress` (11 scenarios) | Reports produced |
| D6-T03 | M | D2 | `pgctl local up|smoke` (supervisor, object storage, Codespaces mode) | Works in a real Codespace (closes GAP-079) |
| D6-T04 | S | D1-T01 | CI release pipeline | Signed release per tag |
| D7-T01 | S | P10-T03 | Remove `deploy/` TS engine (tag `ts-deploy-final`), port `ci-workflows.test.ts` intent | Docs updated |

---

## 6. Track S — Compatible hardening (scheduled)

| ID | Chapter | Earliest phase | Notes |
| :--- | :--- | :--- | :--- |
| S-DB-01 schema version gate | 4 §3 | P3 | TS + Rust |
| S-DB-02 audit delete bypass | 4 §3 | P0 (urgent) | TS RetentionWorker patch |
| S-DB-03 least-privilege roles | 4 §3 | P3 | config + pgctl refusal |
| S-DB-04 log DB DEFAULT partitions | 4 §3 | P0 | |
| S-DB-05 server settings | 4 §3 | D5 (TS engine earlier if possible) | |
| S-DB-06 retention BRIN indexes | 4 §3 | P0 | |
| S-DB-07 FKs/CHECKs NOT VALID → VALIDATE | 4 §3 | P4 | data audit first |
| S-DB-08 index slimming | 4 §3 | P5 | after 14-day stats |
| S-DB-09 updated_at defaults/trigger | 4 §3 | P3 | |
| S-DB-10 migration linter | 4 §3 | P0 | |
| S-DB-11 PgBouncer budgets | 4 §3 | D5 | |
| S-DB-12 sync replication + hba | 4 §3 | D5 | benchmark first |
| S-DB-13 SQL-only fingerprints | 4 §3 | P10-T01 | |
| S-DB-14 audit chain head + batching | 4 §3 | P6-T02 | |
| S-DB-15 timezone hardening | 4 §3 | P3 | |
| S-SEC-01 … S-SEC-17 | 5 §2 | per row: S-SEC-02/03/04/05/07/08 in P3–P4 (TS patches), S-SEC-06 in D4, S-SEC-09/10 in P9, S-SEC-11/12/13 in P7, S-SEC-14 in P0, S-SEC-15/16/17 in D1–D4 | |
| S-OPS-01 access log real `dbQueries`, `dbDurationMs`, `actorId`, single request id in console and header | 3 §9 | P3 | TS patch for parity |
| S-OPS-02 `/metrics` on loopback | 3 §9 | P3 (Rust only, additive) | |
| S-OPS-03 startup cert hint text points to `pgctl pki dev` | 2 §1 | D4 | TS + Rust |
| S-OPS-04 honour `LOG_LEVEL` | 2 §20 | P3 | TS + Rust |
| S-OPS-05 stop workers when listen fails | 2 §19 | P3 | TS + Rust |

---

## 7. Track E — Evolution (after the P10 gate)

Suggested order (dependencies in parentheses):

1. E-OPS-01 OpenTelemetry tracing.
2. E-DB-05 service roles → E-DB-04 RLS (needs E-DB-05) → IDOR matrix green.
3. E-SEC-03 vault v2 → E-DB-03 PII blind indexes (needs vault v2) → E-DB-02 attempt detail split.
4. E-DB-01 timestamptz conversion (table by table).
5. E-F01 configuration registry → E-F02 worker control → E-F03 feature flags → E-F04 policy as data → E-F05
   regionalisation → E-F06 approvals v2.
6. E-SEC-01 asymmetric sessions → E-SEC-02 session lifecycle → E-SEC-04 API tokens v2 → E-F16 merchant API v2 →
   E-F11 OpenAPI.
7. E-DB-06 partitioned queues → E-DB-07 archives → E-DB-11 single source for logs/audit → E-SEC-08 anchoring.
8. E-DB-08 ledger DB integrity → E-F13 accounting fixes → E-DB-09 adaptive wallet sharding.
9. E-F09 async inbound → E-SEC-09 callback policy → E-F10 SSE v2 → E-F08 event platform.
10. E-F07 rails v2 (phases, native adapters, optional WASM) → E-F19 sandbox improvements.
11. E-F12 reconciliation formats, E-F14 report improvements, E-F15 search v2, E-F17 templates as data, E-F18
    operations console data.
12. E-DB-10 identifiers/enums, E-DB-12 PostgreSQL 18 features, E-DB-13 read models/pagination, E-DB-14 HA default.
13. E-SEC-05 key providers/HSM, E-SEC-06 short-lived certs, E-SEC-07 global rate limits, E-SEC-10 browser headers.

Each E-item follows chapter 6 §12 acceptance and chapter 4 §7 verification for database changes.

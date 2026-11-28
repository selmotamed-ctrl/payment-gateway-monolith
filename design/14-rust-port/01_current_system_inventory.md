# Chapter 1 — Current System Inventory

> Part of the Rust/ntex port plan (`porting_to_ntex_rust.md`). Verified against the code on 2026-11-28.
> This chapter answers "what exists today". If something is missing here, it is missing from the plan: add it
> before porting.

---

## 1. Processes

| Process | Entry | Default bind | Transport | Hand-written size | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| core-back (Live) | `core-back/index.ts` (`start()`), launched via `pm2-compatible-start.js` | `127.0.0.1:4000` (`HOST`/`PORT`) | mTLS only: raw `node:tls` server (TLS ≥1.3, client cert required) handing sockets to `http.Server` + Express 5 | ~131k LOC (`api` 41k, `engine` 50k, `lib` 27k, `prisma` 13k) | `core-back/generated/` (289k LOC) is the Prisma client: **not ported** |
| core-back (Sandbox) | same binary, `EXECUTION_PLANE=SANDBOX` | `:4005` (deploy-assigned) | mTLS | same | separate DB `payment_gateway_sandbox`; boot refuses on plane mismatch |
| admin-back | `admin-back/index.ts` | `127.0.0.1:4101` (`ADMIN_BIND_HOST`) | HTTP from Nginx LAN vhost `:8443` | 11.4k LOC | LAN guard `ADMIN_LAN_CIDRS` |
| merchant-back | `merchant-back/index.ts` | `0.0.0.0:4102` (`BIND_HOST`) | HTTP from Nginx (public 443, LAN 8081) | 5.3k LOC | |
| checkout-back | `checkout-back/index.ts` | `0.0.0.0:4103` | HTTP from Nginx (public 443, LAN 8082) | 2.6k LOC | internet-facing payer surface and gateway callbacks |
| fake-rails-back | `fake-rails-back/index.ts` | `127.0.0.1:4104` (docs; verify `lib/env`) | plain HTTP, Nginx `:8444` | 6.4k LOC | own SQLite (`bun:sqlite`, WAL); off by default in production |
| backup-daemon | `deploy/backup-daemon/src/index.ts` | `127.0.0.1:4090` | `node:tls` front (CN/SAN routing) → inner `Bun.serve` on unix sockets | 9.2k LOC | systemd `pg-backup-daemon.service`, user `pgbackup` |
| object-storage-daemon | `deploy/object-storage-daemon/src/index.ts` | `0.0.0.0:4095` | `node:tls` front → inner HTTP | ~1k LOC | systemd `pg-object-storage-daemon.service`, user `pgobjstore` |
| core mock gateway | `core-back/engine/mockGateway/MockGatewayServer.ts:328` (`Bun.serve`) | ephemeral | HTTP, in-process | small | started by the admin gateway-test route (`api/internal/admin.ts:15647`) |

Call graph: Nginx → edges (loopback HTTP) → core (mTLS, least-in-flight pool over `CORE_BACK_URLS`; sandbox pool
`SANDBOX_CORE_BACK_URLS`) → PostgreSQL (primary, replicas, audit DB, log DB, leader-election session endpoint,
optional report read-only URLs) through PgBouncer; Redis; backup daemon (mTLS); object-storage daemon (mTLS);
payment gateways (HTTPS, optional client certificates per credential set); fake rails (HTTP); ClamAV clamd (TCP or
socket); SMTP; SMS webhook aggregator; Google OAuth (merchant login).

---

## 2. HTTP surface

### 2.1 core-back: 611 routes

610 router routes plus `GET /health` (`core-back/index.ts`). Mount tree: `core-back/api/index.ts`; sub-mounts in
`api/internal/admin.ts:1190-1206` and `api/internal/merchant.ts:1380-1399`.

| File (under `core-back/api/internal/`) | Mount | GET | POST | PUT | PATCH | DELETE | Total | LOC |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| admin.ts | `/internal/admin` | 167 | 108 | 17 | 16 | 7 | 315 | 21,581 |
| adminCommerce.ts | `/internal/admin` | 13 | 6 | 0 | 2 | 1 | 22 | 1,791 |
| adminLedger.ts | `/internal/admin` | 7 | 4 | 0 | 0 | 0 | 11 | |
| adminOperations.ts | `/internal/admin` | 7 | 0 | 0 | 0 | 0 | 7 | 635 |
| adminSystem.ts | `/internal/admin` | 6 | 2 | 1 | 0 | 0 | 9 | 623 |
| adminReportEngine.ts | `/internal/admin` | 16 | 15 | 0 | 0 | 0 | 31 | 2,815 |
| backups.ts | `/internal/admin/system/backups` | 2 | 2 | 1 | 0 | 0 | 5 | 588 |
| academy.ts | `/internal/admin/academy` | 5 | 3 | 1 | 0 | 0 | 9 | |
| objectStorage.ts | `/internal/admin/object-storage` | 4 | 2 | 0 | 0 | 1 | 7 | |
| merchant.ts | `/internal/merchant` | 36 | 37 | 3 | 5 | 3 | 84 | 4,315 |
| merchantReportEngine.ts | `/internal/merchant` | 13 | 10 | 0 | 0 | 0 | 23 | 2,026 |
| checkout.ts | `/internal/checkout` | 9 | 9 | 0 | 1 | 0 | 19 | 2,262 |
| sandboxControl.ts | `/internal/sandbox` | 38 | 25 | 1 | 4 | 0 | 68 | 2,324 |
| **Total** | | **323** | **223** | **24** | **28** | **12** | **610** | |

`/api/public` (`api/public/index.ts`, 15 LOC) has 0 routes behind a 15/hour limiter. The design doc
`01-api-surface.md` §5.1 counts are stale.

Regeneration command (run in `core-back/`; every declaration is single-line):

```bash
grep -HoE "\b(router|route)\.(get|post|put|patch|delete|all)\(\s*[\"'\`][^\"'\`]*" api/internal/*.ts api/public/*.ts \
 | sed -E "s#^api/internal/##; s#\.ts:(router|route)\.([a-z]+)\(\s*.#\t\2\t#" \
 | awk -F'\t' '{c[$1" "toupper($2)]++;n++} END{for(k in c)print k,c[k];print "TOTAL",n}'
```

### 2.2 Edges

| Edge | Route declarations | Beyond proxying |
| :--- | :--- | :--- |
| admin-back | ~411 (mostly multi-line; use the TS AST to extract) | LAN guard; limiters (600/min API, 10/15 min auth, search 120/min by token hash, academy 60/min, uploads, backup jobs 6/10 min); advisory authority hints (decodes JWT payload without verifying); optional cookie session + CSRF; multer uploads re-sent as raw bytes with `x-upload-*` headers; `relayStatus`; sandbox proxy; object-storage and backup forwarding; **public→core translation layer `admin-back/api/contract.ts` (1,691 LOC, uses `randomBytes`)**; `api/protected/mutationSchemas.ts`; per-account limiters `lib/authLimiters.ts` |
| merchant-back | 107 | translation `api/contract.ts` + `coreSchema` re-validation; multer with PNG/JPEG/PDF magic allowlist; `/api/v1/external` `pg_live_` prefix check; POS SSE passthrough; sandbox Studio proxy with path rewriting (`api/sandboxProxy.ts`); cookie session + CSRF; `lib/authLimiters.ts` |
| checkout-back | 19 (≈15 real) | public payer API, `assertNoMonetaryFields`, pay limiter before body parsing, raw inbound callbacks with header allowlist, SSE passthrough, return redirect, academy certificate verification |
| fake-rails-back | 45 + internal `RAIL_ROUTES` dispatch for 20 rails | tester portal (own HS256 JWT `lib/jwt.ts`), SSE hub, `/control`, seeder bulk endpoint, SDK/hosted pages generated per request (`api/sdk/*.js.ts`) |

Shared by all three edges: `lib/coreInternalClient.ts` (993/993/991 lines), `lib/corePools.ts`,
`lib/mtlsClient/index.ts`, security headers, request logger, zod validation (`lib/zReady` includes transforms such as
Libyan phone normalisation `(00|+)?218`), `GET /health`.

---

## 3. Data stores

### 3.1 PostgreSQL 18 — four physical databases

| Database | URL env | Schema owner | Contents |
| :--- | :--- | :--- | :--- |
| main | `DATABASE_URL` (+ `DATABASE_REPLICA_URLS`) | Prisma migrations (`core-back/prisma/migrations`, 50 dirs, latest `20261126100000_communication_channels`) | 123 models, 131 native enums |
| sandbox | same server, DB `payment_gateway_sandbox` (`SANDBOX_DB_NAME`) | same migrations | same schema, stamped `system_execution_plane = SANDBOX` |
| audit | `AUDIT_DATABASE_URL` | `deploy/provisioners/auditAndLogDbProvisioner.ts:13-140` | `audit_records` with hash-chain trigger (`pg_advisory_xact_lock(994001)`), immutability trigger, `verify_audit_chain()`; `pgcrypto`, `pg_trgm` |
| log | `LOG_DATABASE_URL` | same provisioner `:150-318` | monthly-partitioned `attempt_step_logs`, `http_access_logs`; `ensure_log_partitions()`; cron 01:15 |

Other connection URLs: `LEADER_ELECTION_DATABASE_URL` (session-mode `pgw_session` alias),
`REPORT_READONLY_DATABASE_URL`, `REPORT_MERCHANT_READONLY_DATABASE_URL` (fall back to `DATABASE_URL`).

Schema facts: `REQUIRED_SCHEMA_VERSION = 46` (`core-back/prisma/schemaVersion.ts`) in table `schema_versions(id=1)`
appended by `prisma/migrateDev`; **no runtime boot check** (only seeds call `ensureSchemaVersion`). 57 SQL-only
objects guarded by `core-back/scripts/checkSqlOnlyObjects.ts` + `prisma/sql-only-objects.allowlist.json`. About 30
triggers, 177 foreign keys, 59 trigram GIN indexes, `journal_lines` monthly range partitions (2023-01 … 2028-11
pre-created + DEFAULT). Chapter 4 has the full review.

### 3.2 Redis

Single node (`REDIS_URL` or first `REDIS_NODES` entry), no TLS. Uses: invalidation bus
(`payment-gateway:invalidation:<topic>`), realtime bus, cache `pgcache:` (+ in-process L1 30 s), velocity ZSET + Lua,
auth throttles and revocation `pgauth:`. Optional at runtime: failures degrade to per-process memory.

### 3.3 Object storage vault

Filesystem vault managed by the object-storage daemon (`/var/lib/pg-object-storage`, buckets HOT/COLD/QUARANTINE +
`.trash`), objects encrypted client-side by core (`pgos1`). Optional MinIO/S3 for backups.

### 3.4 SQLite

Fake rails only: `fake-rails-back/engine/db/index.ts` + `schema.sql` (scenarios, transactions, step events, webhook
deliveries, statements, portal audit).

---

## 4. Core startup and shutdown sequence (`core-back/index.ts` `start()`)

Order matters; the Rust core must reproduce it (chapter 2 §19):

1. `verifyExecutionPlaneFenceOnBoot()` — process plane must equal the `system_execution_plane` row (v38).
2. `bootstrapCommunicationSettingsFromEnv(client)` — turns `SMTP_*` / `COMMUNICATION_*` / `GOOGLE_AUTH_*` env into
   platform settings under advisory lock `pgw:communication-settings-bootstrap:v1`; failures are logged and skipped.
3. Worker preconditions: boot refuses if `WORKER_ENABLED` or `WORKER_BACKGROUND_JOBS_ENABLED` is false.
4. `configureRedisInvalidation()` — publisher + subscriber clients; no-op without Redis.
5. `createHttpsServer()` and `getStorageEngine()`.
6. If workers enabled: `storage.leaderElection.verifySessionSafety()` — proves the leader endpoint keeps session
   advisory locks (fails on a transaction-pooled endpoint).
7. `createProductionWorkerRuntime(...)` then `workers.start()`.
8. `reconcileReportChromeDefaults()` — fire and forget, errors logged.
9. `server.listen(PORT, HOST)` — logs `Core mTLS server listening on HOST:PORT (TLS 1.3, client certificates required)`.
10. SIGTERM/SIGINT: stop workers, close invalidation transport, `shutdownStorageEngine()`, close server.

Known gap: workers keep running if `listen` fails (frontmatter of `01-core-back/00-foundations.md`).

---

## 5. CLIs, seeds and scripts (every one needs a home)

### 5.1 core-back `package.json` scripts

| Script | Implementation | Used by | Rust home | Phase |
| :--- | :--- | :--- | :--- | :--- |
| `start`, `dev` | `index.ts` | PM2, local | `core-rs serve` | P3 |
| `migrate`, `migrate-deploy` | `prisma migrate deploy` | deploy (`deploy.ts:604-646`), CI, local, Codespaces | `core-rs migrate deploy` (reads `_prisma_migrations`) | P10-T01 (until then TS) |
| `migrate-dev` | `prisma/migrateDev/index.ts` (appends `schema_versions`) | developers | `core-rs migrate new` + docs | P10-T01 |
| `migrate-generate` | `prisma generate` | deploy, CI | removed (sqlx offline data + codegen) | P10 |
| `migrate-reset`, `prisma:format`, `prisma:validate` | Prisma | developers | `core-rs migrate reset` (dev only); format/validate retired | P10 |
| — | `prisma migrate status` (`deploy.ts:1071`) | deploy migration planning | `core-rs migrate status --json` | P10-T01 |
| `db-seed` | `prisma/seed.ts` (+ `seedBlueprints.ts` 4.1k LOC, `seedGlAccounts.ts`, `platformSettingsSeed.ts`, guides, chrome specs, communication templates, platform credential sets) | first deploy | `core-rs seed base` | P9-T05 |
| `seed-fake-rails` | `prisma/seedFakeRails.ts` | deploy step 12 (`deploy.ts:617,1541`) | `core-rs seed fake-rails` | P9-T05 |
| `seed-synthetic-history` | `prisma/syntheticSeeder/` (7.2k LOC; imports `LedgerPoster`, `GovernanceExecution`, object storage SDK, Vault, onboarding, KYB review, shard routing, `createAdminPlan`, Prisma client) | deploy step 12 (`deploy.ts:1549`), labs | `core-rs seed synthetic` reusing domain crates (AD-15) | P9-T06 |
| `create-admin` | `scripts/create-admin.ts` + `createAdminPlan` | **documented production bootstrap** (`deploy/DEPLOYMENT_GUIDE.md:123`) | `core-rs admin create` | P7-T09 |
| `create-dev-users` | `scripts/create-dev-users.ts` + `devUsersPlan` | local, Codespaces | `core-rs admin dev-users` | P7-T09 |
| `generate-mtls-certs` | `scripts/generate-mtls-certs.ts` (openssl) | CI, local, Codespaces; referenced by core's startup error text | `pgctl pki dev` (chapter 7 §6); core's error text updated in the same change as an S-item | D4 |
| `repair-journal-default-partition` | script | ledger operations | `core-rs ledger repair-default-partition` | P6-T06 |
| `communication:bootstrap` | `scripts/bootstrapCommunication.ts` (same logic as boot step 2) | operators | `core-rs comms bootstrap` | P8-T07 |
| `schema:sql-only-check` | `scripts/checkSqlOnlyObjects.ts` + allowlist | CI | `core-rs schema check-sql-objects` (fingerprints definitions, fixing GAP-076) | P10-T01 |
| `backfill-operator-cases`, `seed-operator-case-showcase` | scripts | one-off | `core-rs cases backfill`; showcase retired (record decision) | P9-T07 |
| `legacy-evidence:check` | `scripts/checkLegacyEvidence.ts` (GAP-074 detector) | upgrade audits | `core-rs audit legacy-evidence` | P9-T07 |
| `currency:mismatch-report` | `scripts/auditCurrencyMismatches.ts` | audits | `core-rs audit currency-mismatch` | P9-T07 |
| `mail:dev` | maildev | local only | unchanged (external tool) | — |
| `test`, `typecheck`, `lint` | bun/tsc/oxlint | CI | `cargo nextest`, `clippy`, `fmt` | P0 |

Also in `core-back/scripts/`: `rehearse-migrations-pglite`, `prepare-databases.sh` (migration tooling: replaced by
`core-rs migrate rehearse` against a disposable PostgreSQL 18 in P10-T01).

### 5.2 Other backend/ops CLIs

| Tool | Location | Rust home |
| :--- | :--- | :--- |
| Deploy engine | `deploy/deploy.sh`, `deploy/deploy.ts` (chapter 1 §8) | `pgctl` (chapter 7) |
| Multi-machine lab | `deploy/test-matrix/cli.ts` (validate/plan/bootstrap/run/teardown/schema) | `pgctl lab ...` (D6) |
| Deploy stress | `deploy/stress/**` (11 scenarios) | `pgctl stress ...` (D6) |
| WAL fetch | `deploy/backup-daemon/src/walFetchCli.ts` (scratch drills; production `restore_command` uses curl) | `wal-fetch` binary (P9-T03) |
| Backup trigger/drill scripts | `/usr/local/bin/pg-backup-daemon-trigger`, `pg-backup-restore-drill` (written by provisioner) | rendered by `pgctl` (D5) |
| Local launcher | `scripts/deploy-localhost.sh` (PM2 + Bun, ports 4000/4005/410x) | `pgctl local up` (D6) |
| Codespaces | `scripts/codespaces-start.sh` (770 lines), `scripts/codespaces-smoke.ts`, `.devcontainer/*` | `pgctl local up --codespaces`; devcontainer gains the Rust toolchain (D6) |
| Exhaustive suite | `scripts/run-exhaustive-suite.sh`, `scripts/install-packages.sh` | updated to call cargo targets (P0, P10) |
| Benchmarks | `scripts/run-benchmarks.sh`, `core-back/test/load/ledger-load.ts` | kept as TS harnesses during the port; Rust targets added (chapter 8 §7) |

### 5.3 Cron jobs and timers on hosts

| Job | Written by | Action | Change |
| :--- | :--- | :--- | :--- |
| `/etc/cron.d/pg-journal-partitions` | `postgres18Provisioner.ts:716-723` | `ensure_journal_line_partitions(18)` at 01:30 (also done by a worker) | Removed in E (worker is enough) after S-DB-05 |
| `/etc/cron.d/pg-log-partitions` | `auditAndLogDbProvisioner.ts:314-318` | create 6 months ahead, drop past `LOG_RETENTION_MONTHS` | kept; rendered by pgctl; `http_access_logs` gets a DEFAULT partition (S-DB-04) |
| `/etc/cron.d/pg-backup` | `backupEngineProvisioner.ts` | backup schedule | replaced by the daemon's own scheduler (already exists in `scheduler.ts`) — verify and remove duplication in D5 |
| `pg-certbot-renew.timer` | `deploy.ts` / `lib/certRenewal.ts` | certbot renew 03:00/15:00 + nginx reload hook | rendered by pgctl |

---

## 6. Files read at runtime (must be embedded or shipped)

| File | Reader | Plan |
| :--- | :--- | :--- |
| `core-back/content/academy/catalog.json`, `exam-bank.json` | `engine/academy/catalog.ts:15-16` | Move to `content/academy/` at P8; embed with `include_bytes!` and verify a SHA-256 at build; `admin-front/scripts/extract-academy-content.ts:32-35` writes to the new path |
| `core-back/prisma/schema.prisma` | `engine/reportStudio/schemaCatalog.ts:401` (Report Studio autocomplete, via `import.meta.dir`) | Build-time: generate `report-schema-catalog.json` from the same source (Prisma DMMF until P10, DB introspection after) and embed it |
| Certificate PEM files | `engine/workers/platformMonitorChecks.ts:270` (expiry checks) | Read the same configured paths at runtime (no change) |
| `REPORT_ASSET_STORAGE_DIR` (default `cwd/.report-assets`) | `engine/reportStudio/assetStorage.ts` (`LocalReportAssetStorage`) | Same env; default resolved relative to the service's state directory (`/var/lib/pg-core/report-assets`) — record in DEVIATIONS (path default only) |
| `fake-rails-back/engine/db/schema.sql` | fake rails boot | `include_str!` |
| SDK/hosted JS | generated by `fake-rails-back/api/sdk/*.js.ts` | port the generators |

---

## 7. Domain modules (core-back/engine and core-back/lib)

| Area | Paths | Ported in |
| :--- | :--- | :--- |
| Flow engine, rails, step executor, native adapter registry (unwired), compute registry | `engine/flow/**`, `engine/rails/**`, `engine/runtime/{computeRegistry,slotStore,contextCipher}.ts` | P5 |
| Transforms, selectors, API consumer (10 auth methods, token caching, per-credential mTLS via Bun `fetch({tls})`) | `engine/transforms/**`, `engine/apiConsumer/**` | P5 |
| Crypto | `engine/crypto/{Vault,CryptoEngine}.ts` | P3 |
| Ledger | `engine/ledger/**` (poster, checkpoint, invariant, shard repair, partition maintenance) | P5/P6 |
| Guards | `engine/guards/{AttemptGuardPipeline,AmlRuleEngine,ScreeningProvider}.ts` | P5 |
| Governance | `engine/governance/GovernanceExecution.ts` (4k+ LOC), `api/middleware/makerCheckerGuard.ts`, `lib/approvalQueue.ts`, `DetailChangeService` (unwired) | P7 |
| Compliance | `engine/compliance/**` (reporting XSD compiler/generator/validator, `tippingOff.ts`, `incidents`, `OperatorCaseSink`, `ReportingRuleEvaluator`, `CanonicalReportContext`, baseline CBL schemas) | P8 |
| Reconciliation | `engine/reconciliation/**` (`StatementIngestor` CSV/JSON/XLSX-unwired, `postSettlementSweeps`, `ReconciliationFollowUp`), `api/internal/reconciliationUpload.ts` | P7 |
| Route health | `engine/routeHealth/{policy,decision,override}.ts`, `GatewayHealthWorker` | P5/P6 |
| Notifications and communication | `engine/notifications/{CommunicationTransport,NotificationTransport}.ts`, `lib/communication/*` (1.3k LOC: settings 5 s cache, provider switching, templates, policy, bootstrap, test delivery), `lib/{kybNotifications,commissionNotifications,staffInvitation,automationNotices}.ts` | P6/P8 |
| Webhooks | `engine/webhooks/**`, `lib/webhooks/{standardWebhooks,egress}.ts` (SSRF rules) | P6 |
| Workers | `engine/workers/**` (28 workers, `deadlines/*`, `regulatory/*`, `BackgroundJobHandlers` with DISPUTE_INTAKE, SETTLEMENT_SWEEP, FEE_VARIANCE_TRUE_UP, RECONCILIATION_RUN, ADJUSTMENT_EXECUTION, REFUND_INQUIRY; monitor check families backup/communication/moneyPath/objectStorage/platform) | P6 |
| Report Studio | `lib/reportEngineSdk/**` (8.2k LOC incl. `migrations/*`, `compatibility/*`), `engine/reportStudio/**` (asset storage, autocomplete providers, schema catalog, default chrome specs, reconcile chrome defaults, host configs) | P8 |
| Spec importer | `engine/specImporter/**` (schema, validator, simulator, materializer, `TranscriptBuilder.ts:396` embedding zod JSON Schema, `buildRepairPrompt`) | P5 (runtime) / P8 (transcript) |
| Academy | `engine/academy/**` (catalog, `examEngine.ts` deterministic selection, `certificate.ts`), `api/internal/academy.ts` | P8 |
| Search | `lib/globalSearch.ts` (1.9k LOC), `lib/search/**` (20 providers) | P4 |
| Operator cases | `lib/operatorCases/**`, `lib/operatorCases.ts` | P6 |
| Onboarding/KYB | `lib/{joinRequestOnboarding,kybReview,kybScan,kybScanner,kybNotifications}.ts` (clamd `zINSTREAM` or builtin) | P6/P7 |
| Merchant ops, cash-out | `lib/{merchantOps,cashoutBalance,attemptOutcomes,commerceStatus}.ts` | P7 |
| Storage engine | `lib/storageEngine/**` (4.7k LOC: UoW, replica router, LSN, shard writer, outbox workers, audit/log adapters, leader election, Redis cache/velocity, telemetry, utcSession) | P3 |
| Object storage SDK | `lib/objectStorageSdk/**` (1.1k LOC + crypto, sniff, blob store) | P1/P3 |
| Office formats | `lib/xlsx/**` (exceljs), `lib/docx/regulatoryDocx.ts`, `lib/filing/adapters.ts` | P8 |
| Misc | `lib/{cron,contentDisposition,listQuery,reportingCurrency,systemAutomationUser,realtimeBus,executionPlane}.ts`, `lib/invalidationBus/**`, `lib/rawBody/**`, `lib/requestLogger/**`, `lib/error/**`, `lib/auth/**` (sessions, revocation, MFA, throttles, Google OAuth, merchant authorities) | P3 |

---

## 8. Deploy engine (`deploy/`, ~16k LOC TypeScript)

Summary only; chapter 7 §2 has the full inventory and chapter 7 §3 onward the redesign.

- Size: `deploy.ts` 1,606; `lib/` 6,889 (configSchema 1,766, hostPlanner 1,409, preflight 942, pkiManager 615,
  healthVerifier 578, sshRunner 499, …); `provisioners/` 2,759; `templates/` 524; `test-matrix/` 3,132;
  `stress/` 1,273; 29 test files (6.5k LOC). Only dependency: zod.
- 14-step pipeline: config+plan, preflight, SPA builds, PKI, bootstrap+firewall, storage provisioning, core,
  fake-rails, admin, merchant, checkout (rolling batches), verify, seed, prune/summary.
- Config: custom dotenv parser, `z.strictObject` with 282 keys, node grammar `nodeId@sshHost:sshPort:privateIp:servicePort`.
- PKI via the `openssl` binary on the workstation (RSA-4096 CA 10 y, RSA-2048 leaves 825 d).
- Firewall: UFW only; continues without one if install fails.
- SSH: system `ssh`/`rsync` with ControlMaster, `StrictHostKeyChecking=accept-new`, sudo password on stdin; some
  secrets still in remote argv (`healthVerifier.ts:294,340`, `freshStorage.ts:98,202`, test-matrix).
- Services under PM2 (fork, Bun interpreter, absolute release `cwd`); no rollback; single-node restart gap ~0.4 s.

---

## 9. Tests

| Suite | Files | Kind | Reuse for parity |
| :--- | :--- | :--- | :--- |
| core-back | 241 (~23k assertions, 2026-11-08) | mixed; DB-backed suites need PostgreSQL 18 + Redis | port to Rust (test-first) |
| admin-back / merchant-back / checkout-back | 16 / 13 / 9 | mostly black-box HTTP against a fake mTLS core (`test/helpers/upstream.ts`) | run unchanged against Rust edge binaries |
| fake-rails-back | 7 | HTTP-level + white-box PRNG/chaos | HTTP reused; white-box ported |
| deploy | 29 (+ `ci-workflows.test.ts` asserting CI job layout, `security-regressions.test.ts:208` reading backup daemon source) | white-box | ported with pgctl (D-track) |
| backup-daemon / object-storage-daemon | 22 / 3 | HTTP + white-box | HTTP reused |
| tests/e2e | 45 Playwright specs, mocked APIs | UI | live journeys only (`E2E_LIVE=1`, `tests/e2e-live`) |
| deploy/test-matrix | 12 gates incl. checkout-stress (certification preset 500 TPS, p95 < 35 ms) | system | benchmark harness |

---

## 10. Dependencies and runtime-specific APIs to replace

- core-back: `express`, `cors`, `express-rate-limit`, `zod` 4, `@prisma/client` 7 + `@prisma/adapter-pg`, `pg`,
  `decimal.js`, `bcryptjs`, `jsonwebtoken`, `jose` (also `createRemoteJWKSet` for Google), `exceljs`, `jszip`,
  `fflate`, `nodemailer`, `redis` 5, `ipaddr.js`, `dotenv`. Edges add `multer`. Daemons: `zod`.
- Bun-specific: `Bun.serve` (backup daemon, mock gateway), `Bun.S3Client`, `Bun.file`, `Bun.spawn`, `bun:sqlite`,
  non-standard `fetch(url, {tls:{cert,key,ca}})` (`engine/apiConsumer/ApiConsumer.ts:543-556`),
  `import.meta.dir`, `import.meta.main`.
- External binaries used by the backend: `clamd` (network), `curl` (WAL archive), PostgreSQL client tools and
  `wal-g`/`barman`/`rclone`/`zstd`/`tar`/`redis-cli` (backup daemon).

---

## 11. Integrations

| Integration | Direction | Contract source |
| :--- | :--- | :--- |
| Payment gateways (16 seeded blueprints; spec importer for new ones) | core → gateway HTTPS (optional client certs), gateway → checkout-back inbound callbacks | `engine/apiConsumer`, `engine/crypto/CryptoEngine.ts`, `prisma/seedBlueprints.ts` |
| Merchant webhooks | core → merchant HTTPS | Standard Webhooks, `lib/webhooks/*` |
| Email (SMTP: TLS / STARTTLS / NONE, `allowInsecure`) | core → SMTP | `engine/notifications/CommunicationTransport.ts` |
| SMS aggregator | core → signed webhook (`x-notification-signature: sha256=<hex>`, `x-notification-delivery-id`) | `CommunicationTransport.ts:200-226` |
| Legacy notification webhook | core → `NOTIFICATION_WEBHOOK_URL` (key `HMAC(masterKey, "core-back/notification-webhook/v1")`, 5 s timeout) | `NotificationTransport.ts:106-110` |
| Google OAuth (merchant) | core ↔ Google (PKCE S256, JWKS) | `lib/auth/googleOAuth.ts`, merchant routes `/auth/google/start|callback|exchange` |
| ClamAV | core → clamd `zINSTREAM` | `lib/kybScanner.ts` |
| Regulatory filing | core → authority via pinned-egress webhook client (adapters deferred) | `lib/filing/adapters.ts` |
| Backup daemon, object-storage daemon | core → daemons (mTLS) | chapter 2 §7–8 |
| Fake rails control | sandbox core → fake rails `/control` | `engine/rails/FakeRailsControlClient.ts` |

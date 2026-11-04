# Project Design Tracker

This file is append-only. It records implementation status, changes, open gaps, decisions, documentation drift and verification runs.

## 1. Current status

The generated status matrix is in `project-design/STATUS.md`. Part-level status is the YAML `status` field in `project-design/parts/**`.

## 2. Change log

| Date | Part(s) | Change | Code paths | Design paths | Verification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 2026-11-03 | all | Canonical project-design system created; plan checkpoint at `design/00-process/blueprint-management.md`. | `project-design/**`, `scripts/project-design/**`, agent instruction files | `project-design/parts/**` | `bun scripts/project-design/build.ts --check` |
| 2026-11-03 | all | Completed generated design, status, appendices, per-workspace blueprints and READMEs; removed stale frontend `SCALING_FEATURE.md`/`notes.md`; corrected admin UI system gap text; added project-design gate to exhaustive suite. | `project-design/**`, `scripts/project-design/**`, `*/README.md`, `*/blueprint.md`, `scripts/run-exhaustive-suite.sh` | `project-design/parts/**`, `design/00-process/blueprint-management.md` | `bun scripts/project-design/build.ts --check`, `bun scripts/project-design/check.ts`, `git diff --check`, workspace typechecks/tests/builds |
| 2026-11-03 | deploy, testing, core.storage, core.workers, edge.checkout, edge.merchant | Implemented the two-machine T1-T8 lab: multi-instance PM2/env/release isolation, Nginx least_conn upstreams, Debian multi-cluster PostgreSQL, PgBouncer database mapping, audit hash trigger, LSN telemetry header, Redis realtime SSE bridge, topology generator/bootstrap/teardown/11-gate runner/report. | `deploy/test-matrix/**`, `deploy/lib/**`, `deploy/provisioners/**`, `deploy/deploy.ts`, `core-back/lib/storageEngine/**`, `core-back/lib/realtimeBus.ts`, `core-back/api/internal/{checkout,merchant,admin}.ts`, `core-back/index.ts`, `core-back/engine/{flow,governance}` | `project-design/parts/08-testing/04-two-machine-matrix.md`, affected deploy/core/edge parts | `deploy` typecheck/tests, `core-back` typecheck/tests, generated docs check |
| 2026-11-04 | design, project-design | Reorganised `design/` into topic folders (`00-process` … `10-fixes`, `90-archive/`) with an ACTIVE/REFERENCE/FUTURE/ARCHIVE index; all references rewritten; `check.ts` now auto-discovers every `design/**/*.md` and requires a source-map entry; dangling file references in design docs annotated as-built; stale `lanGuard` comment fixed. | `scripts/project-design/check.ts`, `admin-back/api/middleware/lanGuard.ts` | `design/README.md`, `project-design/appendices/design-source-map.md`, `design/**` | `bun scripts/project-design/check.ts` |
| 2026-11-04 | core.storage, core.data, core.ledger, core.workers, core.api | DB read/write optimisation: batched ledger posting (one `unnest` shard upsert), folded outbox projection, audit-outbox lease, outbox/audit pruning, keyset pagination in `listQuery`, single-statement live balances, trimmed checkout/merchant reads, index changes, schema version 9, replica-helper retry fix; `ledger.entry_posted` no longer emitted by default. | `core-back/lib/storageEngine/**`, `core-back/lib/{listQuery,merchantOps}.ts`, `core-back/engine/{ledger,flow,workers}/**`, `core-back/api/internal/{merchant,checkout,admin}.ts`, migration `20261104090000_db_read_write_optimisation` | `parts/01-core-back/06-storage-engine.md` §12 and related parts; `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` | core-back typecheck; `bun test`; scratch PG 18.6 run earlier (see §6) |
| 2026-11-04 | core.seeder | Synthetic seeder rework: engine-template ledger, lifecycle-valid attempts, profile volumes drive generation, Tripoli UTC+2 time, Vault-encrypted columns, approvals bound to real subjects, namespaced ids, derived route health, read-model projection, full invariant suite and DB/dataset equality in the post-seed audit. | `core-back/prisma/syntheticSeeder/**`, `core-back/test/synthetic-seeder*.ts`, `fake-rails-back/**` sync | `parts/01-core-back/10-synthetic-seeder.md`; `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md` | 35 new DB-free tests; DB-backed run not executed |
| 2026-11-04 | testing.multi-machine-matrix, deploy | Replaced the hard-coded two-machine lab with a JSON-configured multi-machine harness (machines, roles, intensity presets, derived topologies, measured gates, config-hashed reports). SECURITY: removed hard-coded lab password and literal secrets; secrets are generated per lab (0600, git-ignored) and fully redacted from reports. Fixed `sshRunner.writeRemoteFile` sudo path writing the password into the file. | `deploy/test-matrix/**`, `deploy/lib/sshRunner.ts`, `deploy/package.json` | `parts/08-testing/04-multi-machine-matrix.md` (renamed), `design/05-testing/multi_machine_topology_and_stress_test_plan.md` | deploy 232 pass; no live run |
| 2026-11-04 | merchant-ui.portal, merchant-ui.guide | Public landing redesigned (hero payment simulator, flow track, bento with fee preview, lazy developer section, EN/AR catalogue, reduced-motion and RTL). `SegmentedTabs` arrow keys follow RTL. Developer guide and code generator corrected to the real create-link schema and response. | `merchant-front/src/pages/public/landing/**`, `src/content/landing/**`, `src/pages/guide/index.tsx`, `src/content/guide/merchantDeveloperApiGuide.ts` | `parts/04-merchant-front/00-portal.md`, `01-guide-and-developer-api.md`; `design/06-ui/merchant_landing_page_redesign.md` | merchant-front build, 16 unit tests; landing e2e 17/17 on a scratch config |

## 3. Open gaps

Track gaps by severity. A part's frontmatter `gaps` list is the short form; this table is the operational backlog.

| ID | Severity | Part | Gap | Evidence | Next action |
| :--- | :--- | :--- | :--- | :--- | :--- |
| GAP-001 | P0 | core.data | Hand-maintained schema tables in historical designs are stale; generated schema catalog is now authoritative. | `design/01-platform-architecture/payment_gateway_final_design-v5.md` vs `core-back/prisma/schema.prisma` | Keep generated catalog current; no hand counts in READMEs. |
| GAP-002 | P0 | core.storage | Replica routing and keyset pagination are partial (keyset now exists in `listQuery`, used by merchant `/payments`; see GAP-006). | `core-back/lib/listQuery.ts`, `lib/storageEngine/index.ts` | Track as code work, not doc-only. |
| GAP-003 | P0 | deploy.backup-daemon | Backup/restore production smoke test still required. | `deploy/backup-daemon/**` | Run on staging host. |
| GAP-004 | P1 | fake-rails | Fake Rails protocol matrix and callback credential binding are partial. | `fake-rails-back/**`, `core-back/prisma/seedFakeRails.ts` | Track as code work. |
| GAP-005 | P1 | future.voucher | Voucher Provider Management System is absent. | `design/09-voucher-system-external/Voucher-Provider-Management-System-Technical-Design.md` | Keep under future/unimplemented until implemented. |
| GAP-006 | P1 | core.storage | Keyset pagination used only by merchant `/payments`; admin lists/exports/summaries still offset-paged on the primary and load wide columns; dashboards do not read `rm_*`. | `core-back/lib/listQuery.ts` | Roll keyset + replica reads across admin lists. |
| GAP-007 | P1 | core.workers | ExpirySweeper, Poll, InboundInbox, OutboxNotification, PeriodicScreening use `FOR UPDATE SKIP LOCKED` outside a transaction; `KybExpiryWorker` has no cursor. Engine re-reads the attempt 3-4 times per request. | `core-back/engine/workers/**` | Per-worker claim transactions; verify KYB cursor. |
| GAP-008 | P1 | core.seeder | DB-backed seeder run never executed (no local PostgreSQL/Redis); writer not transactional; safety gate has no DB-host check; seven engine observations recorded in the seeder part. | `core-back/prisma/syntheticSeeder/**` | Run `seed-synthetic-history` on PG 18; fix engine observations. |
| GAP-009 | P1 | testing.multi-machine-matrix | Redesigned harness never run live; admin 403 in gates 2/9/10; `primary-pitr` chaos and restore-drill polling missing. | `deploy/test-matrix/**` | Run against real machines with a populated config. |
| GAP-010 | P2 | merchant-ui.guide | Webhook sample in the guide generator is illustrative (no outbound merchant webhooks); `redirectDomainAllowlist` is stored but never enforced; login has no return-to. | `merchant-front/src/pages/guide/index.tsx`, `core-back/api/internal/merchant.ts` | Implement or remove; add return-to on login. |


## 4. Documentation drift register

See `project-design/appendices/stale-claims-register.md` for the full register. Historical `design/**` claims are not current authority.

## 5. Decisions

See `project-design/DECISIONS.md`.

## 6. Verification log

| Date | Scope | Command | Result | Environment limitations |
| :--- | :--- | :--- | :--- | :--- |
| 2026-11-03 | docs scaffold | `bun scripts/project-design/build.ts --check` | pass | none |
| 2026-11-03 | docs consistency | `bun scripts/project-design/check.ts`, `git diff --check` | pass | none |
| 2026-11-03 | core-back | `bun run typecheck && bun test` | 19,125 pass, 3,297 skip, 0 fail | no local PostgreSQL/Redis; DB-backed suites skip |
| 2026-11-03 | deploy | `bun run typecheck && bun test` | 200 pass, 0 fail | none |
| 2026-11-03 | deploy/backup-daemon | `bun run typecheck && bun test` | 73 pass, 0 fail | none |
| 2026-11-03 | admin-back | `bun run typecheck && bun test` | 594 pass, 0 fail | none |
| 2026-11-03 | merchant-back | `bun run typecheck && bun test` | 83 pass, 0 fail | none |
| 2026-11-03 | checkout-back | `bun run typecheck && bun test` | 248 pass, 0 fail | none |
| 2026-11-03 | admin-front / merchant-front / checkout-front | `bun run build` | pass (chunk-size warnings only) | none |
| 2026-11-03 | deploy | `bun run typecheck && bun test` | 207 pass, 0 fail | none |
| 2026-11-03 | core-back | `bun run typecheck && bun test` | 19,127 pass, 3,297 skip, 0 fail | no local PostgreSQL/Redis; DB-backed suites skip |
| 2026-11-03 | two-machine live matrix | `bun run test-matrix:bootstrap` | not executed | HOST_B 10.209.250.205 unreachable (no route/ping) |
| 2026-11-04 | project-design | `bun scripts/project-design/build.ts` then `check.ts`; `git diff --check` | pass | none |
| 2026-11-04 | typecheck | core-back, deploy, admin-back, merchant-back, checkout-back `bun run typecheck` | pass | none |
| 2026-11-04 | core-back | `bun test` | 19,183 pass, 3,305 skip, 0 fail | no local PostgreSQL/Redis at final run; DB suites skip. Earlier scratch PG 18.6 run: 22,504 pass / 4 fail (1 fixed; 3 pre-existing: audit-chain seq gap, audit_log actor FK on unseeded DB x2) |
| 2026-11-04 | deploy / backup-daemon | `bun test` | 232 pass / 73 pass, 0 fail | none |
| 2026-11-04 | admin-back / merchant-back / checkout-back / fake-rails-back | `bun test` | 602 / 83 / 248 / 91 pass, 0 fail | none |
| 2026-11-04 | admin-front / merchant-front / checkout-front / fake-rails-front | `bun run build`; merchant-front `bun run test:unit` | pass; 16 unit tests pass | chunk-size warnings only |
| 2026-11-04 | tests (Vitest) | `bunx vitest run` | 26 pass, 0 fail | Playwright not run in this environment |

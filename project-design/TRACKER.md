# Project Design Tracker

This file is append-only. It records implementation status, changes, open gaps, decisions, documentation drift and verification runs.

## 1. Current status

The generated status matrix is in `project-design/STATUS.md`. Part-level status is the YAML `status` field in `project-design/parts/**`.

## 2. Change log

| Date | Part(s) | Change | Code paths | Design paths | Verification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 2026-11-03 | all | Canonical project-design system created; plan checkpoint at `design/blueprint-management.md`. | `project-design/**`, `scripts/project-design/**`, agent instruction files | `project-design/parts/**` | `bun scripts/project-design/build.ts --check` |
| 2026-11-03 | all | Completed generated design, status, appendices, per-workspace blueprints and READMEs; removed stale frontend `SCALING_FEATURE.md`/`notes.md`; corrected admin UI system gap text; added project-design gate to exhaustive suite. | `project-design/**`, `scripts/project-design/**`, `*/README.md`, `*/blueprint.md`, `scripts/run-exhaustive-suite.sh` | `project-design/parts/**`, `design/blueprint-management.md` | `bun scripts/project-design/build.ts --check`, `bun scripts/project-design/check.ts`, `git diff --check`, workspace typechecks/tests/builds |
| 2026-11-03 | deploy, testing, core.storage, core.workers, edge.checkout, edge.merchant | Implemented the two-machine T1-T8 lab: multi-instance PM2/env/release isolation, Nginx least_conn upstreams, Debian multi-cluster PostgreSQL, PgBouncer database mapping, audit hash trigger, LSN telemetry header, Redis realtime SSE bridge, topology generator/bootstrap/teardown/11-gate runner/report. | `deploy/test-matrix/**`, `deploy/lib/**`, `deploy/provisioners/**`, `deploy/deploy.ts`, `core-back/lib/storageEngine/**`, `core-back/lib/realtimeBus.ts`, `core-back/api/internal/{checkout,merchant,admin}.ts`, `core-back/index.ts`, `core-back/engine/{flow,governance}` | `project-design/parts/08-testing/04-two-machine-matrix.md`, affected deploy/core/edge parts | `deploy` typecheck/tests, `core-back` typecheck/tests, generated docs check |
| 2026-11-04 | admin-ui.guide, admin-ui.help, admin-ui.guide-v2, core.data, edge.admin | Implemented Admin Interactive Guide v1.0: deterministic extractor and committed JSON (14 books, 125 articles, 151 terms, 22 cards, 29 situations, 58 FAQ, 19 error codes, 140 edge cases), eight guide routes and reader, MiniSearch palette, 23-screen context help, 22 safeguard integrations, five simulators, and shared guide-read progress. | `admin-front/scripts/extract-guide-content.ts`, `admin-front/src/content/guide/**`, `admin-front/src/components/guide/**`, `admin-front/src/pages/guide/**`, `admin-front/src/router/index.ts`, `admin-front/src/layouts/default.tsx`, `admin-front/src/components/ui/PageHeader.tsx`, `admin-front/src/styles/guide.css`, `admin-back/api/protected/academy.ts`, `core-back/api/internal/admin.ts`, `tests/unit/guide-*.test.ts`, `tests/e2e/admin/guide-*.spec.ts` | `project-design/parts/03-admin-front/03-guide-and-academy.md`, `04-contextual-help.md`, `06-guide-v2.md`, `09-future-and-unimplemented/03-deferred-features.md`, `design/guide_content_fixes.md`, `design/guide_content_questions.md` | `bun run content:guide`, `admin-front` type-check/build/unit, `tests` unit + admin Playwright, `admin-back` academy tests |
| 2026-11-04 | deploy.storage | Fixed storage provisioning on Ubuntu 24.04+/26.04 single-machine installs: PgBouncer config ownership now follows the systemd unit user (`postgres` on Ubuntu) instead of a non-existent `pgbouncer` account; Redis binds are deduplicated for loopback-only nodes, systemd drop-ins grant `ReadWritePaths=/var/lib/pg-redis`, and the restart health check is authenticated and targeted at the node port. | `deploy/provisioners/postgres18Provisioner.ts`, `deploy/provisioners/redisProvisioner.ts`, `deploy/test/provisioners.test.ts` | `project-design/parts/07-deploy/05-storage-provisioners.md` | `deploy` typecheck + 209 tests; live `pgbouncer` and `redis-server` verified on Ubuntu 26.04 |
| 2026-11-04 | deploy.pipeline, deploy.planner, deploy.health, core.data | Fixed the single-machine deploy end to end: local targets use the orchestrator OS user instead of a non-existent SSH account for release, backup and daemon ownership; the backup daemon receives a real Bun copy readable by `postgres`; core migrations run on the first core node in `auto`/`update` mode after the pre-migration dump; PostgreSQL/PgBouncer readiness waits prevent migration races; merchant/checkout public and LAN vhosts use unique Nginx upstream names; the backup-daemon probe follows `BACKUP_ALLOW_INSECURE_HTTP`; removed a stale empty migration directory. | `deploy/deploy.ts`, `deploy/lib/sshRunner.ts`, `deploy/lib/hostPlanner.ts`, `deploy/lib/healthVerifier.ts`, `deploy/provisioners/postgres18Provisioner.ts`, `deploy/provisioners/backupEngineProvisioner.ts`, `deploy/test/healthVerifierScale.test.ts` | `project-design/parts/07-deploy/04-pipeline.md`, `01-host-planner.md`, `05-storage-provisioners.md`, `07-health-rollback-and-recovery.md` | `deploy` typecheck + 210 tests; full `./deploy/deploy.sh` 14/14 steps, Verification OK, 27 PASS |

## 3. Open gaps

Track gaps by severity. A part's frontmatter `gaps` list is the short form; this table is the operational backlog.

| ID | Severity | Part | Gap | Evidence | Next action |
| :--- | :--- | :--- | :--- | :--- | :--- |
| GAP-001 | P0 | core.data | Hand-maintained schema tables in historical designs are stale; generated schema catalog is now authoritative. | `design/payment_gateway_final_design-v5.md` vs `core-back/prisma/schema.prisma` | Keep generated catalog current; no hand counts in READMEs. |
| GAP-002 | P0 | core.storage | Replica routing and keyset pagination are partial. | `core-back/lib/listQuery.ts`, `lib/storageEngine/index.ts` | Track as code work, not doc-only. |
| GAP-003 | P0 | deploy.backup-daemon | Backup/restore production smoke test still required. | `deploy/backup-daemon/**` | Run on staging host. |
| GAP-004 | P1 | fake-rails | Fake Rails protocol matrix and callback credential binding are partial. | `fake-rails-back/**`, `core-back/prisma/seedFakeRails.ts` | Track as code work. |
| GAP-005 | P1 | future.voucher | Voucher Provider Management System is absent. | `design/Voucher-Provider-Management-System-Technical-Design.md` | Keep under future/unimplemented until implemented. |

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
| 2026-11-04 | guide content | `cd admin-front && bun run content:guide` | 14 books, 125 articles, 151 terms, 22 cards, 29 situations, 58 FAQ | none |
| 2026-11-04 | admin-front | `bun run type-check && bun run test:unit && bun run build` | pass | chunk-size warnings only |
| 2026-11-04 | tests | `bun run test:unit` | 69 pass | none |
| 2026-11-04 | tests/admin e2e | `bunx playwright test --project=admin` | pass after updating existing safeguard/search expectations | no live backend |
| 2026-11-04 | admin-back | `bun test test/academy-progress.test.ts test/admin-surface.test.ts` | 293 pass | none |
| 2026-11-04 | deploy | `bun run typecheck && bun test` | 209 pass, 0 fail | none |
| 2026-11-04 | live storage on Ubuntu 26.04 | `systemctl status pgbouncer`, `systemctl start redis-server`, `redis-cli SAVE` | pass; PgBouncer enabled and Redis `PONG`/`OK` | none |
| 2026-11-04 | local MinIO S3 | `curl /minio/health/live`, authenticated `mc cp` to `s3://payment-gateway-backups/dev` | pass | local dev host; MinIO built from `RELEASE.2025-10-15T17-29-55Z` because dl.min.io returns 410 |
| 2026-11-04 | deploy | `bun run typecheck && bun test` | 210 pass, 0 fail | none |
| 2026-11-04 | live single-host deploy | `./deploy/deploy.sh` | 14/14 steps, Verification OK, 27 PASS, release `20261104124852` | none |
| 2026-11-04 | live portal accessibility | curl + headless Chromium against admin `:8443`, merchant `:8081`/public, checkout `:8082`/public, fake-rails `:8446` | all deployed portals return 200 and boot; JS/CSS assets 200; no console/page errors; checkout `/pay/:linkKey` renders the missing-link state; HTTP vhosts redirect 308 to HTTPS | checkout `/` is a deliberate 404; `/logo.svg` is referenced but absent from `dist` (cosmetic favicon) |
| 2026-11-04 | project-design | `bun scripts/project-design/build.ts --check` | pass | none |
| 2026-11-04 | tests/admin e2e (full) | `bunx playwright test --project=admin` | 51 pass | no live backend |
| 2026-11-04 | admin-back | `bun run typecheck && bun test` | typecheck pass; 593 pass, 1 timeout in `admin-surface` restore-apply (passes in isolation) | test-run timing; no live stack |
| 2026-11-04 | core-back | `bun run typecheck && bun test` | typecheck pass; 22,485 pass, 8 fail in pre-existing `journal_lines` index-parity assertions in the modified working-tree schema | no local PostgreSQL/Redis; schema diff predates this change |
| 2026-11-04 | project-design | `bun scripts/project-design/build.ts --check` | pass | none |

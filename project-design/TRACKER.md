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

## 3. Open gaps

Track gaps by severity. A part's frontmatter `gaps` list is the short form; this table is the operational backlog.

| ID | Severity | Part | Gap | Evidence | Next action |
| :--- | :--- | :--- | :--- | :--- | :--- |
| GAP-001 | P0 | core.data | Hand-maintained schema tables in historical designs are stale; generated schema catalog is now authoritative. | `design/01-platform-architecture/payment_gateway_final_design-v5.md` vs `core-back/prisma/schema.prisma` | Keep generated catalog current; no hand counts in READMEs. |
| GAP-002 | P0 | core.storage | Replica routing and keyset pagination are partial. | `core-back/lib/listQuery.ts`, `lib/storageEngine/index.ts` | Track as code work, not doc-only. |
| GAP-003 | P0 | deploy.backup-daemon | Backup/restore production smoke test still required. | `deploy/backup-daemon/**` | Run on staging host. |
| GAP-004 | P1 | fake-rails | Fake Rails protocol matrix and callback credential binding are partial. | `fake-rails-back/**`, `core-back/prisma/seedFakeRails.ts` | Track as code work. |
| GAP-005 | P1 | future.voucher | Voucher Provider Management System is absent. | `design/09-voucher-system-external/Voucher-Provider-Management-System-Technical-Design.md` | Keep under future/unimplemented until implemented. |

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

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
| 2026-11-05 | core.engine, core.api, core.ledger, core.workers, core.governance, core.data, core.backup, core.tests, platform.overview, platform.topology, platform.security, platform.runtime, platform.observability, core.foundations, edge.shared, edge.admin, edge.merchant, edge.checkout, admin-ui.system, admin-ui.routes, admin-ui.operations, merchant-ui.portal, checkout-ui.flow, fake-rails.backend, fake-rails.chaos, fake-rails.integration, deploy.topology, deploy.planner, deploy.firewall, deploy.pipeline, deploy.storage, deploy.backup, deploy.health, testing.strategy, testing.suites | Security hardening documented: payer evidence ignored on confirm and webhook/commission/idempotency/SSRF fixes in core; MFA challenge table, closed merchant authority catalogue, principal separation, cash-out state machine and maker-checker for admin users; schema version 10 and 76 models (migration `20261104120000_mfa_challenges`); edge trusted-proxy, authorityGuard, upstream client, inbound/limiter/redaction/CORS hardening; deploy quoting, secrets-at-rest, pinned and verified downloads, backup-daemon mTLS CN/SAN authorization, config hardening; frontend allow-lists and route guard; new regression suites. Remaining risks added as GAP-011 to GAP-031. READMEs updated (create-admin now uses ADMIN_PASSWORD, `.env.example`, CORS/TRUSTED_PROXY_CIDRS, schema version). | `core-back/engine/**`, `core-back/api/internal/**`, `core-back/lib/auth/**`, `core-back/lib/cashoutBalance.ts`, `core-back/lib/kybScan.ts`, `core-back/prisma/migrations/20261104120000_mfa_challenges`, `core-back/scripts/createAdminPlan.ts`, `admin-back/**`, `merchant-back/**`, `checkout-back/**`, `deploy/lib/quoting.ts`, `deploy/provisioners/**`, `deploy/deploy.ts`, `deploy/backup-daemon/**`, `fake-rails-back/**`, `admin-front/src/utils/**`, `merchant-front/**`, `checkout-front/**`, `scripts/deploy-localhost.sh` | `project-design/parts/**` (affected parts above), `README.md`, `core-back/README.md`, `deploy/README.md`, `admin-back/README.md`, `merchant-back/README.md`, `checkout-back/README.md`, `admin-front/README.md`, `merchant-front/README.md`, `checkout-front/README.md`, `fake-rails-front/README.md`, `tests/README.md` | `bun scripts/project-design/build.ts`, `bun scripts/project-design/build.ts --check`; documentation only in this entry, code verification is recorded by the code change (new suites run with `bun test ./path`) |

## 3. Open gaps

Track gaps by severity. A part's frontmatter `gaps` list is the short form; this table is the operational backlog.

| ID | Severity | Part | Gap | Evidence | Next action |
| :--- | :--- | :--- | :--- | :--- | :--- |
| GAP-001 | P0 | core.data | Hand-maintained schema tables in historical designs are stale; generated schema catalog is now authoritative. | `design/01-platform-architecture/payment_gateway_final_design-v5.md` vs `core-back/prisma/schema.prisma` | Keep generated catalog current; no hand counts in READMEs. |
| GAP-002 | P0 | core.storage | Replica routing and keyset pagination are partial. | `core-back/lib/listQuery.ts`, `lib/storageEngine/index.ts` | Track as code work, not doc-only. |
| GAP-003 | P0 | deploy.backup-daemon | Backup/restore production smoke test still required. | `deploy/backup-daemon/**` | Run on staging host. |
| GAP-004 | P1 | fake-rails | Fake Rails protocol matrix and callback credential binding are partial. | `fake-rails-back/**`, `core-back/prisma/seedFakeRails.ts` | Track as code work. |
| GAP-005 | P1 | future.voucher | Voucher Provider Management System is absent. | `design/09-voucher-system-external/Voucher-Provider-Management-System-Technical-Design.md` | Keep under future/unimplemented until implemented. |
| GAP-011 | P0 | core.ledger | Ledger checkpoint is not atomic and mixes app and DB clocks (`CheckpointService`); no runtime shard-vs-journal parity check. | `core-back/engine/ledger/**` | Make checkpoint transactional on DB time; add parity check. |
| GAP-012 | P0 | core.workers | PollWorker, ExpirySweeper, InboundInbox and OutboxNotification claim rows with SKIP LOCKED outside a transaction; singleton workers have no leader election or advisory lock. | `core-back/engine/workers/**` | Claim inside a transaction; add advisory-lock leader election. |
| GAP-013 | P0 | core.ledger | No append-only protection (triggers/REVOKE) on journal_entries, journal_lines and audit_log; the application is the DB owner. | `core-back/prisma/migrations/**` | Add triggers/REVOKE and a non-owner app role. |
| GAP-014 | P0 | deploy.pipeline | No CI at the repo root; legacy per-service deploy.yml workflows deploy with no tests, StrictHostKeyChecking=no and rsync --delete. | `*/.github/workflows/deploy.yml` | Add root CI gate; fix or remove legacy workflows. |
| GAP-015 | P1 | core.governance | AML HOLD books escrow before capture and RELEASE credits without gateway verification. | `core-back/engine/**` | Reorder escrow after capture; verify before release. |
| GAP-016 | P1 | core.engine | Re-finalize guard for terminal attempts in verifyCallback/finalizeSuccess is not implemented. | `core-back/engine/flow/DynamicRailEngine.ts` | Refuse finalize on terminal attempts. |
| GAP-017 | P1 | core.governance | Payout-account changes have no approval step and the KYB payoutAccountHash is not mandatory (cash-out destinations without a hash are flagged payoutVerified:false). | `core-back/api/internal/merchant.ts` | Add maker-checker for payout account; require hash. |
| GAP-018 | P2 | core.governance | Per-source statement file_hash uniqueness needs a schema and repository change (currently a cross-source 409 check only). | `core-back/api/internal/admin.ts` | Add unique (source, file_hash) constraint. |
| GAP-019 | P1 | platform.security | No admin/merchant logout or revoke endpoint (admin logout is client-only) and tokens are not in httpOnly cookies (admin, merchant, fake-rails). | `admin-front/**`, `merchant-front/**`, `fake-rails-front/**` | Add revoke endpoints and cookie storage. |
| GAP-020 | P2 | platform.security | No distinct JWT aud per channel (admin-back requires aud=payment-gateway-edge). | `core-back/lib/auth/**` | Issue per-channel aud and enforce. |
| GAP-021 | P2 | edge.shared | Upstream breaker has no consecutive-failure threshold. | edge `lib/coreClient` copies | Add threshold in all three copies. |
| GAP-022 | P1 | deploy.backup | Backup daemon runs as the postgres user and no PostgreSQL TLS/hostssl-only provisioning exists. | `deploy/backup-daemon/**`, `deploy/provisioners/**` | Dedicated service user; provision TLS and hostssl. |
| GAP-023 | P1 | deploy.storage | Real SHA256 values for WAL-G, bun and barman versions must be supplied (BACKUP_WALG_SHA256, BUN_SHA256). | `deploy/deploy.env.example` | Operator supplies hashes per release. |
| GAP-024 | P2 | fake-rails.chaos | Fake Rails /hosted/* approve/decline is public with no token on the action POST; SSE token remains in the query string. | `fake-rails-back/**` | Bind action POST to a token. |
| GAP-025 | P1 | core.governance | No real malware scanner; KYB scanning is content sniffing plus EICAR only. | `core-back/lib/kybScan.ts` | Integrate a real scanner engine. |
| GAP-026 | P1 | platform.security | No PCI scope statement for card data and no PAN-rail guard. | `design`/`project-design` | Write scope statement; add guard. |
| GAP-027 | P2 | platform.security | Login/MFA throttle counters are per-instance in-process memory; the DB attempt counter is the only durable guarantee. | `core-back/lib/auth/throttle.ts` | Move counters to Redis/DB. |
| GAP-028 | P2 | deploy.storage | Replica .pgpass is written via printf argv (replication password visible in process args). | `deploy/provisioners/postgres18Provisioner.ts` | Stream via stdin or temp file. |
| GAP-029 | P1 | checkout-ui.flow | xlsx 0.18.5 is vulnerable and an unused @prisma/client dependency remains in checkout-front. | `checkout-front/package.json` | Replace/upgrade xlsx; drop unused dependency. |
| GAP-030 | P1 | core.storage | Timezone pinning (timestamptz and timezone=UTC) is not done. | `core-back/prisma/**`, `deploy/provisioners/**` | Pin session/server timezone to UTC. |
| GAP-031 | P2 | core.storage | Redis velocity adapter failure handling is incomplete. | `core-back/lib/storageEngine/**` | Define fail-open/closed policy and test. |

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
| 2026-11-05 | project-design docs | `bun scripts/project-design/build.ts`, `bun scripts/project-design/build.ts --check`, `git diff --check` | pass (generator regenerated; check up to date; no whitespace errors beyond LF/CRLF autocrlf warnings) | parts normalized to LF (generator requires LF frontmatter); code suites not re-run by this documentation change |

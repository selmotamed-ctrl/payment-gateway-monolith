# Blueprint Management Plan — Canonical `project-design/` System

**Status:** APPROVED / IN PROGRESS  
**Date:** 2026-11-03  
**Authority:** This file is the recovery checkpoint for the documentation refactor. If a session is compacted or interrupted, resume from here.

---

## 0. Confirmed decisions

1. `project-design/parts/**` is the editable source of truth.
2. `project-design/PROJECT_DESIGN.md` is generated from the parts as the centralized verbose master document.
3. `design/**` is kept as a frozen historical/reference archive with a banner and a source map. It is not current authority.
4. Full future/unimplemented designs (voucher system, guide v2, smart-AI voucher half, deferred features) are included under `project-design/parts/09-future-and-unimplemented/` with explicit `MISSING` / `DEFERRED` status.
5. Every `blueprint.md` is generated from project-design parts. Generated files carry a “GENERATED FILE” header.
6. Stale `SCALING_FEATURE.md` and duplicate `notes.md` files in the three frontends are deleted.
7. `bun scripts/project-design/build.ts --check` is added to the exhaustive runner and PR checklist.
8. Root `AGENTS.md` is canonical; Claude, Gemini, Cursor, Windsurf, Copilot and OpenCode adapters point to it and to `project-design/INDEX.md`.

---

## 1. Investigation result

The docs are not slightly stale; they are structurally unreliable.

- ~20 design documents under `design/`, ~27k lines, mixing normative design, aspirational plans, historical versions, session transcripts and delivery logs.
- No canonical design entrypoint.
- No root `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / Cursor / Windsurf / Copilot instructions.
- Only `.opencode/compaction-context.md` and a compaction plugin, injected only during compaction.
- Service READMEs cover operations but not full project usage.
- `blueprint.md` files are short summaries, not full design documents.
- Many false/outdated claims remain even after the PostgreSQL pass.

Key drift examples:

| Area | Actual code | Docs still say / omit |
| :--- | :--- | :--- |
| Schema size | 75 models, 105 enums, schema version 8 | 64 models / 100 enums / schema version 5–6 |
| Attempt lifecycle | 14 statuses | “13-state” |
| Runtime phases | 7 runtime phases + separate credential check | “10-phase engine” presented as runtime |
| Ledger scenarios | 17 `LedgerScenario` values | “15 worked entries/templates” |
| GL account types | 11 | “10” |
| Transform ops | 39 | “36” |
| Migrations | baseline + storage indexes + CQRS + hardening | one migration creates all tables |
| Read models | `rm_merchant_daily_stats`, `rm_route_daily_volumes` | `rm_merchant_dashboard_stats`, `rm_wallet_statements` |
| CQRS | `ledger.entry_posted` no-op; `rm_*` write-only | ledger-driven read models power dashboards |
| Replica reads | search + 3 merchant lists only | all dashboards/lists/exports |
| Pagination | offset pagination | keyset pagination |
| Audit outbox | marks `shipped_at`, never deletes | shipper deletes shipped rows |
| Backup scheduler | UTC, full/delta/drill only | Tripoli 03:00 + hourly Redis BGSAVE |
| Backup certs | uploaded as root, daemon runs as `pgbackup` | ready-to-run mTLS |
| Deploy prune | inside `deployService()` | step 13 / step 11 |
| PM2 templates | present but unused | deployment design implies used |
| Storage mTLS | certs generated, not consumed by PostgreSQL/Redis | implemented storage mTLS |
| Admin UI routes | 37 protected routes | 36 |
| Merchant routes | 16 portal routes | 15 |
| Admin guide | 12 books, 8 academy modules | guide v2 specifies 14 books / 125 articles |
| Guide v2 | not implemented | presented as current |
| Fake Rails | 20 descriptors, 13 core gateways, route mismatches | 20 fully working gateways, all modes/phases |
| Voucher system | entirely absent | full technical design exists |
| Exhaustive tests | 1,778 literal declarations, mocked/skipped | 38,500+ assertions |
| Frontend docs | removed app scaling; unrelated notes | still committed |

---

## 2. Canonical authority model

1. `project-design/` is the only canonical design.
2. `design/` is historical/reference material only.
3. Code is the authority for as-built behavior.
4. Generated appendices are the authority for counts, routes, env keys, schema and tests.
5. A behavior/contract/config/schema change must update `project-design/` in the same change.
6. Unimplemented features are explicitly `MISSING` or `DEFERRED`; never mixed into current behavior.
7. `blueprint.md` files are generated from `project-design/parts/**`; they are not hand-edited.
8. `README.md` files are hand-written usage manuals, linking to generated appendices.

---

## 3. Target tree

```text
project-design/
├── README.md
├── INDEX.md
├── PROJECT_DESIGN.md             # generated
├── STATUS.md                     # generated
├── TRACKER.md
├── DECISIONS.md
├── GLOSSARY.md
├── parts/
│   ├── 00-platform/
│   ├── 01-core-back/
│   ├── 02-edge-services/
│   ├── 03-admin-front/
│   ├── 04-merchant-front/
│   ├── 05-checkout-front/
│   ├── 06-fake-rails/
│   ├── 07-deploy/
│   ├── 08-testing/
│   └── 09-future-and-unimplemented/
├── appendices/
│   ├── design-source-map.md
│   ├── code-surface-map.md
│   ├── schema-catalog.md          # generated
│   ├── migration-catalog.md       # generated
│   ├── api-route-matrix.md        # generated
│   ├── env-and-config-matrix.md   # generated
│   ├── test-inventory.md          # generated
│   └── stale-claims-register.md
└── changes/
```

Part files use YAML frontmatter:

```yaml
---
id: core.storage
title: Storage Engine
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - core-back/lib/storageEngine/**
design_sources:
  - design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md#2-6
tests:
  - core-back/test/storage-engine/**
gaps:
  - keyset pagination not implemented
---
```

Part body template:

```md
# <Part title>
## 1. Purpose and scope
## 2. Design intent (extracted and synthesized from ./design)
## 3. As-built architecture
## 4. Contracts and invariants
## 5. Data / API / config / deployment surface
## 6. Operational usage
## 7. Status and deviations
### Implemented
### Partial
### Missing / deferred
### Known bugs / risks
## 8. Verification and tests
## 9. Source references
### Old design sections
### Code paths
### Generated appendices
## 10. Change history
```

---

## 4. Part extraction map

| New part | Absorbs from `design/` | Primary code evidence |
| :--- | :--- | :--- |
| `00-platform` | v5 §1–3, §12; v4.1 §1–2, §10–11; v2 §1–3; deployment guide; storage blueprint §1 | repo tree, `core-back/index.ts`, `api/middleware/*`, env/config schemas |
| `01-core-back/00-foundations` | v5 §2–3, opencode §1–3 | `core-back/index.ts`, `engine/runtime/**`, `lib/env`, `lib/error`, `lib/requestLogger` |
| `01-core-back/01-api-surface` | v5 §16, v4.1 §14–15, v2 §15, fixes/operator-cases | `api/internal/{admin,merchant,checkout,backups}.ts` |
| `01-core-back/02-engine` | v5 §8, v4.1 §6, v2 §5–7, opencode §15 | `engine/{flow,apiConsumer,crypto,transforms,specImporter,mockGateway,runtime}` |
| `01-core-back/03-ledger` | v5 §11, v4.1 §9, v2 §10, storage blueprint §3.1 | `engine/ledger/**`, shard writer, `gl_account_shards` |
| `01-core-back/04-governance-compliance` | v5 §12, §17–22; v4.1 §15–20; v2 §9–13; fixes/operator-cases | `engine/{governance,guards,compliance}`, approval queue, KYB/AML libs |
| `01-core-back/05-workers` | opencode §10–14/§28, v5 §9.1 | `engine/workers/**`, `storageEngine/outboxWorkers.ts` |
| `01-core-back/06-storage-engine` | storage blueprint §2–4 | `lib/storageEngine/**`, migrations |
| `01-core-back/07-data-schema-and-migrations` | v5 §7, v4.1 §5, v2 §4, seeder doc | `prisma/schema.prisma`, migrations, seeds |
| `01-core-back/08-search` | deep-search plan, storage blueprint §3.2 | `lib/globalSearch.ts`, `lib/search/**`, BFF search, admin palette |
| `01-core-back/09-backup-control` | storage blueprint §5 | `api/internal/backups.ts`, `backupControlClient.ts`, daemon, admin UI |
| `01-core-back/10-synthetic-seeder` | synthetic seeder doc | `prisma/syntheticSeeder/**` |
| `01-core-back/11-tests-and-benchmarks` | master exhaustive plan, storage blueprint §7 | `test/**`, `scripts/run-benchmarks.sh` |
| `02-edge-services` | v5 §2, deployment design §6.2, edge READMEs/blueprints | `admin-back`, `merchant-back`, `checkout-back` |
| `03-admin-front` | UI v1/v2/plan, complete guide spec, guide v2, opencode §17–27 | `admin-front/**` |
| `04-merchant-front` | UI plan, complete guide spec, merchant docs | `merchant-front/**` |
| `05-checkout-front` | UI plan, deployment guide §13, checkout README | `checkout-front/**` |
| `06-fake-rails` | fake-rails design, opencode §17 | `fake-rails-back/**`, `fake-rails-front/**`, core seed |
| `07-deploy` | deployment design, storage blueprint §6, deploy guide | `deploy/**` |
| `08-testing` | master exhaustive plan, storage blueprint §7, e2e specs | `test/**`, `tests/**` |
| `09-future-and-unimplemented` | voucher technical/raw designs, smart AI plan, guide v2, unimplemented parts | design-only evidence |

`appendices/design-source-map.md` must map every old design section to a new part or mark it `HISTORICAL` / `SUPERSEDED` / `FUTURE`.

---

## 5. Documentation corrections backlog

### P0 — factual contradictions

- Regenerate schema counts: 75 models / 105 enums / schema version 8.
- Attempt lifecycle: 14 statuses.
- Engine: 10 declarative names, 7 runtime phases, separate credential check; CAPTURE/SETTLEMENT_FETCH reserved.
- Ledger: 17 scenarios; 11 GL account types.
- Transform library: 39 operations.
- Replace hand-maintained schema tables with generated catalog.
- Replace stale API surfaces with actual `/internal/*` + edge `/api/v1/*` routes.
- Document actual maker-checker execution coverage and missing handlers.
- Document gateway version mutability unless code is fixed.
- Document actual security enforcement (session revocation/IP/MFA, Google OIDC 501).
- Document actual CQRS (`ledger.entry_posted` no-op; `rm_*` write-only; no `rm_wallet_statements`).
- Correct storage DDL locations, read-model names, post-commit flush LSN, backup endpoints and `/catalog`.
- Correct deploy step 13/prune and dead PM2 templates.
- Document storage mTLS as generated but not consumed unless code is fixed.
- Document voucher system as not implemented.
- Correct test plan claims.
- Delete stale `SCALING_FEATURE.md` and `notes.md`.

### P1 — subsystem accuracy

- Backup scheduler UTC, no hourly Redis.
- Backup cert ownership, audit drill role, Barman audit slot, WAL archive lag query, secondary mirror limits, `target=all` audit-data-dir.
- Replica routing limited; keyset pagination absent.
- Audit/log gaps: no `gateway_wire_logs`, no disk spool, zero DB metrics, no outbox/audit retention.
- Seeder drift: 55 collections, 9 generators, only payment/adjustment ledger refs, plain-base64 ciphertexts, profile volumes not enforced, safety gate differs.
- Fake Rails drift: webhook path, `cbl_lypay`/`evo_pay` mismatches, missing callback secrets, blocked embedded widgets, dead auto-approve, 13 core gateways.
- Guide v2 is future, not current.
- Admin guide 12 books/8 modules; help coverage gaps; merchant help mapping bug.
- Checkout 404 broken; merchant Statements route not UI-gated.
- `CORE_INBOUND_BASE_URL` HTTP/private-IP mismatch.
- `SshRunner` NOPASSWD risk; `pg_dump` client not installed on core host.
- Barman health uses WAL-G binary.

### P2 — wording/history/links

- Fix missing design-file references.
- Mark v2/v4.1 historical.
- Remove session log from normative references.
- Replace empty READMEs/stale notes.
- Ensure every old claim is labelled historical or replaced.

---

## 6. README and blueprint strategy

READMEs: root, core-back, admin-back, merchant-back, checkout-back, admin-front, merchant-front, checkout-front, fake-rails-back, fake-rails-front, deploy, deploy/backup-daemon, tests, project-design.

Required README sections:

1. Purpose/boundaries.
2. Quick start.
3. Architecture summary + blueprint link.
4. Full command reference.
5. Complete env/config table or generated appendix link.
6. Entry points/routes/pages.
7. Data/storage/worker/backup behavior where applicable.
8. Testing/benchmark commands.
9. Deployment/troubleshooting.
10. Design source-of-truth links.

Blueprints generated from parts:

| Blueprint | Source |
| :--- | :--- |
| `core-back/blueprint.md` | `parts/01-core-back/**` |
| `admin-back/blueprint.md` | shared + admin-back part |
| `merchant-back/blueprint.md` | shared + merchant-back part |
| `checkout-back/blueprint.md` | shared + checkout-back part |
| `admin-front/blueprint.md` | `parts/03-admin-front/**` |
| `merchant-front/blueprint.md` | `parts/04-merchant-front/**` |
| `checkout-front/blueprint.md` | `parts/05-checkout-front/**` |
| `fake-rails-back/blueprint.md` | fake-rails backend parts |
| `fake-rails-front/blueprint.md` | fake-rails portal part |
| `deploy/blueprint.md` | `parts/07-deploy/**` |
| `deploy/backup-daemon/blueprint.md` | backup-daemon part |

Generated header:

```md
<!-- GENERATED FILE. Edit project-design/parts/... instead. -->
```

Stale files:

- Delete `admin-front/SCALING_FEATURE.md`, `merchant-front/SCALING_FEATURE.md`, `checkout-front/SCALING_FEATURE.md`.
- Delete or replace the three identical `notes.md` files.
- Replace identical `src/styles/README.md`.
- Add `design/README.md` historical banner.

---

## 7. Tracker design

`project-design/TRACKER.md` contains:

1. Current status summary.
2. Append-only change log.
3. Open gaps P0/P1/P2.
4. Doc drift register.
5. Decision log.
6. Verification log.

`STATUS.md` is generated from frontmatter. `TRACKER.md` is hand-maintained and append-only.

---

## 8. Agent instruction rollout

Create:

- `AGENTS.md` (canonical)
- `opencode.json` with `instructions`
- updated `.opencode/compaction-context.md`
- updated `.opencode/plugins/compaction.ts`
- `CLAUDE.md`
- `GEMINI.md`
- `.cursor/rules/project-design.mdc`
- `.cursorrules`
- `.windsurfrules`
- `.github/copilot-instructions.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `CONTRIBUTING.md`

Mandatory rule:

```md
## Project design is canonical
- Read `project-design/INDEX.md` and the relevant `project-design/parts/**` file before coding.
- `design/**` is historical source material, not current authority.
- Any change to behavior, APIs, schema/migrations, env/config, deploy, UI routes, tests, or invariants must update the affected project-design part(s) and `project-design/TRACKER.md` in the same change.
- If code and design conflict, fix the code or record the deviation in `project-design/STATUS.md` and `TRACKER.md`; never leave silent drift.
- Run `bun scripts/project-design/build.ts --check` before finishing.
- Generated files: `PROJECT_DESIGN.md`, `STATUS.md`, appendices, and `*/blueprint.md`. Edit only their sources.
```

---

## 9. Generator and validation

Add:

- `scripts/project-design/build.ts`
- `scripts/project-design/check.ts`
- `scripts/project-design/lib/*.ts`

`build.ts`:

- Validate frontmatter and required fields.
- Check code/design paths exist.
- Generate `PROJECT_DESIGN.md`, `STATUS.md`, appendices, `*/blueprint.md`.
- Fail on duplicate IDs, missing links, stale output.

`check.ts`:

- Run build in check mode.
- Verify every `design/**` heading is mapped.
- Verify every workspace has README + blueprint.
- Fail on known stale strings outside historical files.
- Verify `implemented` claims have test/code references.

Add to `scripts/run-exhaustive-suite.sh` and PR checklist.

---

## 10. Execution phases

### Phase 0 — Scaffold and rules
- Create tree, templates, frontmatter, INDEX/TRACKER skeleton, AGENTS/adapters, generator/check scripts, design banner.

### Phase 1 — Platform + core foundations/API/engine
- Agent A: platform, core foundations, API, engine.
- Agent B: core ledger, governance/compliance, workers.

### Phase 2 — Storage/data/search/backup/seeder
- Agent C: storage, schema/migrations, search, backup, seeder, tests/benchmarks.

### Phase 3 — Edge + deploy + backup daemon
- Agent D: edge services, deploy parts.

### Phase 4 — Frontends, guides, fake rails, future, testing
- Agent E: admin/merchant/checkout frontends.
- Agent F: fake rails, testing, future/unimplemented.

### Phase 5 — Generate blueprints/appendices/READMEs
- Generate all derived docs.
- Rewrite READMEs.
- Delete stale files.
- Update historical banners.

### Phase 6 — Independent verification
- Accuracy audit vs code.
- Link/structure audit.

### Phase 7 — Final gates
- `build.ts --check`, typechecks, tests, frontend builds, diff check.

---

## 11. Acceptance criteria

1. `project-design/INDEX.md` is the single canonical entrypoint.
2. `PROJECT_DESIGN.md` contains full verbose design of every part.
3. Every part has intent/as-built/status/contracts/verification/sources.
4. Every old `design/**` heading mapped or marked historical/future.
5. Every workspace has accurate README + generated blueprint.
6. `TRACKER.md` has status, change log, gaps, decisions, drift register, verification log.
7. All harnesses receive the update rule.
8. `build.ts --check` passes and fails on stale generated docs.
9. P0 contradictions resolved.
10. No stale `SCALING_FEATURE.md`, duplicate `notes.md`, or normative old claims.
11. Tests/builds pass, skipped DB/live suites reported.

---

## 12. Recovery instructions

If the session is compacted:

1. Read this file.
2. Read `project-design/INDEX.md`, `project-design/STATUS.md`, `project-design/TRACKER.md`.
3. Run `git status` and inspect `project-design/parts/**` progress.
4. Continue from the first incomplete phase in section 10.
5. Never treat `design/**` as current authority.
6. Run `bun scripts/project-design/build.ts --check` before finishing.

---

## 13. Execution status

Completed 2026-11-03. Canonical `project-design/` generated, stale frontend docs removed, workspace READMEs/blueprints generated, agent instruction files installed, and final verification passed. See `project-design/TRACKER.md` for the verification log and open code gaps (replica routing, backup staging smoke test, Fake Rails protocol matrix, future voucher system).

# Reporting Studio and Automation Test Plan

Status: implementation plan
Date: 2026-11-10
Owner tracks: `core-back`, `admin-back`, `admin-front`, `tests`
Supersedes: the Studio follow-up section of `declarative_regulatory_reporting_engine_final_design.md` and extends the automation plan with a complete verification programme.

## 1. Confirmed decisions

| Decision | Choice |
| :--- | :--- |
| XSD constructs | Implement attributes and `choice`; block `xs:any`, `xs:group`, `xs:attributeGroup`, substitution groups, abstract elements and unsupported unions/lists explicitly. |
| XLSX templates | Ship generated workbooks first; add uploaded CBL workbooks with named-range anchors immediately after the named-range contract is defined. |
| Schema cloning | Clone any readable version; copy definition, mapping and template; never copy approvals, default bindings or real/PII sample context. |
| Confirmed immutability | Enforce in the service and with a database trigger. |
| CI | Add nightly PostgreSQL + live-stack + Playwright jobs and weekly deploy/stress/lab jobs. |
| `amlCaseId` uniqueness | Drop the unique index; allow multiple reports per AML case with a normal index and per-report-key dedupe. |

## 2. Bugs to fix before the visual editor

### P0 — invalid or unsafe output

1. **LTR XML date mismatch.** The baseline mapping reads `tx.createdAt` (`baselineSchemas.ts`) while batch rows expose `date` (`CanonicalReportContext.ts`); `date_transaction` is empty and LTR XML is invalid. Map the correct field and add a generated-XML regression.
2. **Manual reports cannot generate a usable output.** The admin-back mapper strips context; periodic reports get no `reportCode` and per-attempt reports have no transactions. Build the context from the referenced rule/attempt/case, derive report code, and test generation/submission.
3. **XLSX template mode is dead.** Templates are stored but never passed to the renderer. Decrypt and pass them in `ReportGenerationService`; implement the `mode` contract; run macro/OLE/zip checks at upload and generation.
4. **Default bindings can be wrong or implicitly confirm a schema.** Require `CONFIRMED`, exact key match, dedupe pending requests and apply the binding even when the schema is already `CONFIRMED`.
5. **Confirmed schemas can be recompiled in place.** Reject compile/promote/edit updates on `PENDING_APPROVAL`, `CONFIRMED`, `SUPERSEDED` and `ARCHIVED`.
6. **Payload/narrative edits do not invalidate outputs and approval is not hash-bound.** Store `mappingSha256`; bind approval to `definitionSha256`, `mappingSha256` and payload hash; mark stale outputs and refuse filing after a payload change.
7. **Output storage is non-atomic and races.** Supersede/create in one transaction with optimistic uniqueness; map `P2002` to a retry/conflict response.
8. **XSD generation/validation is incomplete.** Implement attributes and `choice`, reject unknown/out-of-order elements, enforce attribute facets, positive integers, total digits and XSD-like date/regex checks.
9. **Corrupt payloads become `{}`; empty required formats bypass the gate.** Fail closed and require at least one required format when the rule/report declares one.
10. **`amlCaseId @unique` prevents multi-report workflows.** Replace with a normal index and a report-code/period dedupe key.

### P1 — studio correctness

11. No mapping validation. Add paths-exist, duplicate path, repeat alias, code-map, transform and assertion checks.
12. Code lists merge by element name; key them by path/type.
13. Reporting Studio guesses `reportCode` from `schemaCode`; use the stored field.
14. Narrative sections cannot be added in the UI; derive them from the bound schema.
15. Compile failures become 500; map `XsdCompileError`/`XmlSecurityError` to 400.
16. The Studio is absent from the exhaustive admin surface test and has no functional UI coverage.

## 3. Part A — Visual Reporting Studio

### 3.1 Data model

Add to `RegulatoryReportSchema`:

- `revision Int @default(1)`
- `clonedFromSchemaId String?`
- `mappingSha256 String? @db.Char(64)`
- `compiledFromSha256 String? @db.Char(64)`

Add a DB trigger that blocks changes to definition/mapping/compiled/template fields when `status <> 'DRAFT'`. Status transitions and approval fields remain allowed.

Add `RegulatoryRuleSchemaBinding` CRUD; the model is currently read by generation but has no API.

Drop `RegulatoryReport.amlCaseId @unique`; add `@@index([amlCaseId])`. Add a report-key dedupe key `(report_code, period_key)` remains for scheduled reports.

### 3.2 API

| Method | Route | Purpose |
| :--- | :--- | :--- |
| GET | `/aml/report-schemas/:id` | Detail: definition, mapping, compiled, sample context, notes, revision, approval, template metadata, usage, capabilities. |
| GET | `/aml/report-schemas/:id/definition` | Separate large definition payload. |
| GET | `/aml/report-schemas/:id/ast?path=&depth=` | Bounded AST explorer. |
| PUT | `/aml/report-schemas/:id` | Save DRAFT with `baseRevision`; recompile XML/XLSX JSON; recompute hashes; audit. |
| POST | `/aml/report-schemas/:id/clone` | Next version as DRAFT; copy definition/mapping/template; no approval/default/sample PII. |
| POST | `/aml/report-schemas/validate` | Validate a draft without saving. |
| POST | `/aml/report-schemas/:id/validate` | Validate the stored draft. |
| GET | `/aml/report-schemas/context-catalog` | Canonical context paths, item shapes, source kinds, transforms, operators. |
| POST | `/aml/report-schemas/:id/sample-context` | Build ephemeral context from attempt/case/report/sample; mask PII by default. |
| POST | `/aml/report-schemas/:id/code-lists/preview` | Allowed values, mappings, fallback, coverage, mapped/fallback/unmapped rows. |
| GET/PUT | `/aml/report-schemas/:id/template` | Download/upload XLSX template with macro/OLE/zip guards. |
| POST | `/aml/report-schemas/:id/workbook/preview` | Bounded sheet/column/row preview. |
| GET/PUT | `/aml/reporting-rules/:id/schema-bindings` | Per-rule schema bindings. |
| GET | `/aml/reports/:id/requirements` | Resolved schema, narrative sections, pending, editable. |
| PATCH | `/aml/reports/:id/payload` | Narrative-only update with `basePayloadSha256`. |

Fix existing routes: compile 400 mapping, immutable status checks, exact default binding, confirmed-binding application, baseline seeding before manual generation, atomic output store, payload/output hash invalidation.

### 3.3 Engine

- XSD attributes: binding path `.../@name`, generator emission, validator required/default/facets.
- `choice`: condition-selected branch, one-of validation.
- Mapping validation service shared by save/promote/validate.
- Explicit unsupported-construct errors.
- Path-scoped code lists.
- Output bounds/truncation marker.
- XLSX `REQUIRED_SECTION` and `list` values.
- Template decryption and macro/OLE/zip validation in the production path.
- Payload/output hash invalidation and stale-output filing block.
- LTR/manual context fixes.

### 3.4 Frontend

Routes:

- `/aml/reporting-studio` — registry/defaults.
- `/aml/reporting-studio/:id` — studio, URL-synced tabs.

Tabs:

1. Overview — lifecycle, hashes, revision, approval, usage, versions.
2. Definition — XSD/workbook source, upload, compile/validate.
3. Structure — XML tree + binding editor; code lists; assertions; XLSX sheets/columns/totals/narrative/validations/template.
4. Simulate — sample/paste/real context, draft simulation, XML/XLSX preview, issues.
5. Bindings & approval — defaults keyed by full `(authority, reportType, reportCode, format)`, rule bindings, clone, promote, set default.

UX: dirty guard, revision conflict, immutable read-only, validation issue navigation, large-XSD virtualisation, accessibility, RTL/AR/EN, report drawer requirements/narrative/output details/Open in Studio.

### 3.5 Studio tests

- `core-back/test/reporting-schema-studio.test.ts` (DB): update/clone/validate/context/code lists/template/default binding/authorization.
- `core-back/test/reporting-output-integration.test.ts`: worker output persistence, revisions, hashes, invalidation, races.
- `core-back/test/reporting-lifecycle-pg.test.ts`: real-DB approval/rejection/expiry/gate matrix/corrupt payload/empty formats/amlCase.
- `core-back/test/reporting-xsd-edge.test.ts`: attributes, choice, assertions, limits, XXE variants, out-of-order/unknown nodes.
- `core-back/test/reporting-xlsx-edge.test.ts`: template mode, macro/OLE/zip, list/REQUIRED_SECTION, totals precision.
- `admin-back/test/reporting-studio-forwarding.test.ts`.
- `tests/unit/reporting-studio-*.test.ts`.
- `tests/e2e/admin/reporting-studio.spec.ts`.
- Update exhaustive admin surface.

## 4. Part B — Automation test plan

### 4.1 Test categories

H happy, I idempotency, C concurrency, F failure/retry, D dry-run, T time/calendar, DB real DB constraints, S security, M health/monitor, N audit/cases/notifications, R retention, A API/UI.

### 4.2 Coverage targets

Strong (add cross-cutting): AUTO-01, 02, 05, 06, 13, 19, 20, 21, 22, 23, 24, 27, 34.
Partial (close specific gaps): AUTO-03, 04, 07, 08, 10, 11, 12, 16, 25, 26, 28, 32.
Open (acceptance suites): AUTO-09, 14, 15, 17, 18, 29, 30, 31, 33.

### 4.3 New suites

Core P0/P1:

- `automation/inbound-async.test.ts`
- `automation/gateway-health.test.ts`
- `automation/settlement-schedule.test.ts`
- `automation/aml-batch.test.ts`
- `automation/manual-rails.test.ts`
- `automation/retention-full.test.ts`
- `automation/worker-contract.test.ts` (env switches, leader keys, per-worker health/backlog, bounded ticks, dry-run defaults)
- `automation/platform-monitor-real-schema.test.ts`
- `automation/notification-delivery.test.ts`
- `automation/kyb-expiry-pg.test.ts`
- `automation/statement-snapshot.test.ts`

Cross-cutting:

- crash/lease/rollback for Deadline/ExpiryHousekeeping/ExpiryNotice/Poll, real KYB cursor, notification delivery and EN/AR catalogue, real backup-daemon contract, HTTPS/DNS webhook transport, retention of new automation tables, performance/lock-hold baseline.

### 4.4 CI

Fix now:

- Core CI: `bun test --parallel=1 --timeout 60000` on PostgreSQL 18 + Redis; fail on unexpected skips.
- Design job: project-design check and `git diff --check`.
- Add frontend unit, root unit, mocked Playwright smoke and companion.
- PgBouncer test fails loudly if PgBouncer is absent.
- No `reuseExistingServer` in CI; free ports.
- Include orphaned `sessionToken` tests.
- Upload artifacts.

Cadence:

- PR: static, unit/fake, real DB core, frontend units, mocked Playwright smoke.
- Nightly: exhaustive core, full Playwright, live local stack, benchmarks.
- Weekly/manual: deploy stress, multi-machine matrix, backup PITR/labs, Android device smoke.

### 4.5 Edge-case catalogue

Time (Tripoli week/holidays/boundaries/clock skew), concurrency (leaders/leases/SKIP LOCKED/crash/races), failure (DB/Redis/daemon/scanner/gateway down, poison rows, malformed XML/XLSX/JSON, retries, max attempts), data (empty/huge/duplicate/corrupt/sandbox/PII/precision), security (authz, confidential, maker-checker, SSRF, XXE, macro, formula injection, redaction, tipping-off), UI (dirty/conflict/read-only/RTL/a11y/responsive), ops (migration/deploy/restart/backup/restore/retention).

### 4.6 Definition of done

Every AUTO item has a named suite and explicit category coverage. Every DB suite is green with no unexpected skips. Reporting Studio has unit/API/Playwright coverage for every tab and mutation. Every bug in section 2 has a regression test. Nightly/live/stress jobs cannot be green by skipping required coverage. `parts/08-testing`, suite catalog, TRACKER and appendices are updated.

## 5. Delivery order

1. Backend foundations and bug fixes (migration, APIs, generation, governance).
2. XML studio + mapping validation + code lists.
3. XLSX builder/template/simulation.
4. Bindings/approval/clone/read-only lifecycle.
5. Report drawer/narrative/output details.
6. Studio tests and UI tests.
7. Automation test phase 1 (P0 gaps), phase 2 (P1), phase 3 (CI/nightly/live).

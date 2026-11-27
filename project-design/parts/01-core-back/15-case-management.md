---
id: core.case-management
title: Type-Aware Operator Case Management
status: partial
confidence: high
last_verified: 2026-11-16
verified_against: 53afea5+working-tree
code:
  - core-back/lib/operatorCases/**
  - core-back/engine/workers/PlatformMonitorWorker.ts
  - core-back/engine/workers/automationCases.ts
  - core-back/engine/workers/StatementScheduleWorker.ts
  - core-back/engine/routeHealth/GatewayHealthWorker.ts
  - core-back/engine/governance/GovernanceExecution.ts
  - core-back/api/internal/admin.ts
  - core-back/prisma/schema.prisma
  - core-back/prisma/migrations/20261116130000_case_management_taxonomy
  - core-back/scripts/backfillOperatorCases.ts
  - core-back/scripts/seedOperatorCaseShowcase.ts
  - admin-front/src/pages/operator-cases/**
  - admin-front/src/tables/tableRegistry.ts
design_sources:
  - design/10-fixes/_0001_operator_cases.md
  - design/11-automation/background_automation_and_workers_plan.md
  - design/11-automation/declarative_regulatory_reporting_engine_final_design.md
tests:
  - core-back/test/operator-case-catalog.test.ts
  - core-back/test/operator-cases.test.ts
  - core-back/test/automation/platform-monitor.test.ts
  - core-back/test/automation/statement-schedule.test.ts
  - core-back/test/automation/regulatory-reports.test.ts
  - core-back/test/governance-execution.test.ts
  - tests/e2e/admin/operator-cases.spec.ts
gaps:
  - Not every specialist source has a dedicated live context presenter yet; the generic Case context uses the stored title/summary/details and source link.
  - The synthetic seeder and a few direct test-only producers still create legacy-shaped cases; the API classifier displays them, but the DB filters require the backfill or a producer update.
  - Guide/Academy translations are authored in English; the new case-type/action labels are not yet in the Arabic catalogue.
---

# Type-Aware Operator Case Management

## 1. Why this exists

An operator case was a row with a seven-value `kind`, an optional attempt/reconciliation link and a free-text `resolutionNotes` field. That was enough for payment attempts, but the platform now opens cases for backups, regulatory returns, route health, credentials, KYB, ledger/checkpoints, statements, audit-chain integrity, cash-outs, disputes and platform workers. All of them were `MANUAL_REVIEW`, all rendered as UUID-heavy payment contexts, and the UI offered payment-attempt resolution choices to every case.

The real taxonomy was already present in the producer `subjectKey` namespace (`platform.backup:*`, `report.overdue:*`, `route.health:*`, `ledger.shard:*`, etc.). It is now a first-class case type with a human title, summary, subject, source and timeline.

## 2. Taxonomy and model

`OperatorCase` keeps `kind` as the compatibility queue bucket and adds:

- `case_number` and the API-derived `CASE-<year>-<number>` reference.
- `case_type` (stable catalog code), `source`, `domain`, `confidentiality`.
- `title_key`, `title_params`, `title_text`, `summary`, `details_json`.
- `subject_type`, `subject_id`, `subject_label`.
- `resolution_code`, `resolution_summary`, `resolved_at`, `resolved_by_user_id`.

Two append-only tables preserve the narrative:

- `operator_case_events` — opened, acknowledged, state/assignment, SLA, source cleared, retripped, resolution proposed/resolved.
- `operator_case_links` — additional related records.

The code catalog is `core-back/lib/operatorCases/caseCatalog.ts`; it is exposed at `GET /internal/admin/operator-cases/catalog` (types, actions and resolution codes). The catalog decides the source, domain, confidentiality, default priority/SLA, subject type and allowed actions. `kind` is never used as the case identity. The current sources are mapped 1:1 from their existing subject-key prefixes; unknown rows fall back to `LEGACY_UNCLASSIFIED`.

## 3. Creation and lifecycle

`core-back/lib/operatorCases/caseService.ts` provides the shared metadata/event helpers and `clearKeyedCase`.

- `openKeyedOperatorCase`, the platform monitor sink, the engine `PrismaOperatorCaseSink`, ledger alerts and governance cases populate the new metadata.
- `clearKeyedCase` sets `RESOLVED`, records `SOURCE_CLEARED` and an event; it does not leave a `[CLEARED]` marker on an OPEN case. A recurrence opens a new case.
- Platform-monitor, route-health, statement-arrival and report-submission paths use the system-clear behavior. A manual `CLOSE_CASE` closes only the case; it does not fix the source.
- Resolution overwrites the final `resolution_notes`, but the original finding remains in `summary`, `details_json` and the `OPENED` event.

## 4. Actions

The server exposes case-type-aware actions:

- Payment-attempt types: `INQUIRE`, `MARK_SUCCEEDED`, `MARK_FAILED`, `CLOSE_CASE` (terminal attempt only) and `ACKNOWLEDGE`.
- Operational types: `ACKNOWLEDGE`, `CLOSE_CASE` with a resolution code (`FIXED_AT_SOURCE`, `FALSE_POSITIVE`, `DUPLICATE`, `ACCEPTED_RISK`, `REFERRED`, `NO_ACTION_REQUIRED`, `SOURCE_CLEARED`, `OTHER`) and an evidence reference; `OPEN_SOURCE` is a link, not a mutation.
- No operational type receives provider-reference, settled-amount or attempt-success controls.
- `POST /operator-cases/:id/acknowledge` is single-actor triage (OPEN → IN_PROGRESS) with an event and audit.
- `POST /operator-cases/:id/resolve` validates the action against the case type; `CLOSE_CASE` for a non-payment case requires a resolution code. Resolution remains maker-checker and the existing attempt/ledger execution path is unchanged.

## 5. API and UI

- `GET /operator-cases` returns `caseReference`, `caseType`, `title`, `summary`, `subjectType/id/label`, `domain`, `source`, `confidentiality`, `availableActions` and the old flattened payment/reconciliation context. It filters by `caseType` and hides `confidentiality=AML` without `aml.read_confidential`; the detail refuses the same.
- `GET /operator-cases/:id` includes `events`, `links`, `resolvedBy` and the detail payload. The UI no longer treats `attempt` as mandatory.
- Admin list: a human reference/title/type/context column, priority, state, SLA, assignee and actions. The primary action is **Open**; **Inquire** is an overflow action only for attempt cases. Raw payment/attempt/slot/reconciliation columns were removed from the default table; the type filter is catalog-driven.
- Admin detail: **Case context** from the title/summary/subject/details, a type-specific source link, the type-aware narrative and case timeline. Merchant/payment/route cards render only for an attempt; reconciliation cards only for a reconciliation item. Technical identifiers are collapsed under **Technical identifiers**. The resolution modal shows provider/settled fields only for `MARK_SUCCEEDED`; operational cases show the resolution outcome and evidence reference.
- Checkers receive `case:read`/`operator:read` in the seeded FINANCE/COMPLIANCE/MLRO roles, so the Approvals “Open subject” link can reach the evidence.

## 6. Migration and backfill

Schema version 41 (`20261116130000_case_management_taxonomy`) adds the columns and the two tables. `bun run backfill-operator-cases` classifies existing rows, creates the initial event/link and repairs the initial summary from the historical monitor/report evidence where available. The pre-migration dump is taken by the deploy engine. The migration is forward-only.

## 7. Tests and open scope

The catalog test covers classification, attempt-only actions, backup/regulatory readability and references; platform-monitor tests cover source-clear and recurrence; the admin Playwright suite covers the payment and backup cases; live verification covered the observed backup and PSP-M cases. The synthetic seeder and specialist live context presenters remain partial (see frontmatter gaps).

## v46 communication readiness case (2026-11-26)

The case catalog adds `COMMUNICATION_UNCONFIGURED` (group `PLATFORM`, domain
`OPERATIONS`, source `PLATFORM_MONITOR`, subject `COMMUNICATION_CHANNEL`,
auto-clear). `communication_readiness` raises the keyed case
`platform.communication:email` while email is not configured; the case clears
when the condition disappears. The admin Operator Cases screen maps it to
Platform Settings → Communication, and authorised staff are notified in-app and
by SMS when configured.

---
id: admin-ui.operations
title: Backups Settings and Operations
status: partial
confidence: high
last_verified: 2026-11-26
verified_against: working-tree 2026-11-26
code:
  - admin-front/src/pages/system/backups/**
  - admin-front/src/pages/settings/platform/**
  - admin-front/src/pages/settings/platform/components/**
  - admin-front/src/components/builders/model/settingsSchemas.ts
  - admin-front/src/components/builders/model/settingsCatalog.ts
  - admin-front/src/components/builders/model/settingsSearch.ts
  - admin-front/src/pages/settings/checkout-help/**
  - docs/developer/platform-settings.md
  - admin-front/src/pages/academy/index.tsx
  - admin-front/src/constants/urlsMap/index.ts
  - admin-front/src/utils/xlsx/**
  - admin-front/src/components/ui/SummaryExportCard.tsx
  - admin-front/src/components/ui/FormChecklist.tsx
design_sources:
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md
  - design/06-ui/portal_ui_implementation_plan.md
tests:
  - tests/e2e/admin/backups.spec.ts
  - core-back/test/backup-admin/backup-admin-routes.test.ts
  - admin-front/src/content/__tests__/content-completeness.test.ts
  - tests/unit/frontend-security-admin.test.ts
  - tests/unit/platform-settings.test.ts
  - tests/e2e/admin/platform-settings.spec.ts
gaps:
  - Backup policy edits create an approval request but the backup page has no direct approvalRequestId continuation; the checker must use the general Approvals queue.
  - The Approvals filter/registry subject-type list does not include `BACKUP_POLICY`, so the subject cannot be selected from the shared filter options.
  - Platform settings and checkout-support saves create new versions and audits directly; they are not maker-checker executions. The settings UI now says so and records a required change note.
  - The settings catalog lives in the admin frontend. A core key without a catalog entry appears as **Unregistered** until the catalog and translations are added.
  - Restore has strong version-conflict checks but no second-person approval.
  - Table XLSX exports remain current-page only, while summary exports use the shared CSV-to-XLSX path.
---

# Backups Settings and Operations

## 1. Purpose and scope

This part owns the admin operational pages that are neither the primary merchant/payment queues nor the guide:

- Backup management at `/system/backups`.
- Platform settings versioning and restore at `/settings/platform`.
- Checkout support configuration, history and diff at `/settings/checkout-help`.
- Academy team view at `/academy/team` (`SECURITY_ADMIN`).
- Their shared export/checklist behavior and authority gating.

It does not own the backup daemon, PostgreSQL WAL configuration or restore-drill engine. Those are in the deploy and storage parts. It documents the admin UI and the backend contracts that the UI calls.

## 2. Design intent (extracted and synthesized from ./design)

The operations surfaces follow the same governance pattern as the rest of the admin portal:

1. **Read is separate from write.** Operators with read authority can inspect health, versions and history; writes require a stronger authority and are visibly hidden from read-only users.
2. **Versioned configuration, not in-place edits.** Platform settings and checkout support create a new immutable version; the effective version is the highest version whose effective date has passed.
3. **Restore is preview-first.** A backup file is parsed and summarized before anything is written; invalid entries and version conflicts block apply.
4. **Reason and checklist are part of the audit.** Restore and settings edits record the operator, reason and checklist keys.
5. **Backup policy is maker-checker.** A policy save creates a pending approval; a different checker executes the policy through the approvals queue.
6. **Exports are audited.** Summary and certification exports write audit entries and use the shared XLSX pipeline.
7. **Visibility flags are runtime-config controlled.** Checklist panels can be hidden by deploy configuration without changing the underlying action path.

## 3. As-built architecture

### 3.1 Backup management (`/system/backups`)

Page: `admin-front/src/pages/system/backups/index.tsx`.

Endpoints:

| Operation | Endpoint | Authority |
| :--- | :--- | :--- |
| Overview | `GET v1/admin/system/backups/overview` | `security:read` or `gateway:read` |
| Trigger backup | `POST v1/admin/system/backups/trigger` | `security:write` |
| Run restore drill | `POST v1/admin/system/backups/drill` | `security:write` |
| Update policy | `PUT v1/admin/system/backups/policy` | `security:write` |

The page renders:

- Metric strip: WAL archive lag vs alert threshold, daemon reachability, healthy storage targets, latest backup status/time, latest drill status.
- Alerts when backups are not configured or the daemon is unreachable.
- WAL archive lag card: archive lag, current LSN, last archived LSN, lag bytes, alert threshold.
- Daemon status card: engine mode, configured, overall health, generated time.
- Storage target cards: target name, kind, health and detail.
- Backup history table (latest 30 from daemon or local catalog): id, target, kind, engine, status, start/completion, duration, size, error.
- Latest drill card: status, target time, replayed LSN, double-entry drift, balance mismatches, audit broken links, journal line count and the three invariant checks (double-entry zero drift, sharded balance parity, audit hash chain).
- Trigger modal: target `all`/`postgres_core`/`audit_db`/`redis`; kind `full`/`delta`.
- Restore drill confirmation: explains the isolated scratch restore and invariant verification.
- Policy modal: full cron, delta cron, drill cron, full retention days, WAL retention days, alert lag seconds.

The write buttons are hidden without `security:write`, and the backend re-checks the same authority. A policy update without an `approvalRequestId` returns `202 PENDING_REVIEW`; the page displays the approval id but does not open the approval. The checker executes the policy through the general approvals flow, where `BACKUP_POLICY` has a dedicated handler. The checker must differ from the maker.

The overview endpoint is `no-store`, syncs daemon catalog rows into `backupCatalogRun`/`backupRestoreDrill`, and falls back to the local catalog when the daemon returns no data. The page does not call the separate `/catalog` endpoint.

### 3.2 Platform settings (`/settings/platform`)

Page: `admin-front/src/pages/settings/platform/index.tsx`.
Catalog: `admin-front/src/components/builders/model/settingsCatalog.ts`.
Search/merge/version model: `admin-front/src/components/builders/model/settingsSearch.ts`.
Typed value definitions: `admin-front/src/components/builders/model/settingsSchemas.ts`.

Endpoints:

| Operation | Endpoint | Authority |
| :--- | :--- | :--- |
| List settings | `GET v1/admin/settings` | `settings:read` |
| Summary | `GET v1/admin/settings/summary` | `settings:read` |
| Summary export | `GET v1/admin/settings/summary/export` | `settings:read` |
| Backup export | `GET v1/admin/settings/export` | `settings:read` |
| Restore preview | `POST v1/admin/settings/restore-preview` | `settings:read` |
| Restore apply | `POST v1/admin/settings/restore-apply` | `settings:write` |
| Save setting | `PUT v1/admin/settings` | `settings:write` |

The page is a searchable workspace, not a flat key list:

- **Sections**: All settings, Payments & routing, Merchants & onboarding, Risk &
  screening, Reporting & compliance, Governance & approvals, Operations & data,
  Checkout & support, Advanced & unregistered.
- **Search** matches the title, key, section, summary, description, reader,
  effect, field labels, field hints, option hints, keywords, current value and
  Arabic text. Multi-word search is AND; the result count is announced.
- **Status filters**: All, Live policies, Decision records, Using defaults and
  Needs attention.
- **Rows** show the human title, technical key, lifecycle/status badge, risk,
  effective version, scheduled marker, summary, a one-line value preview and the
  effect. Clicking a row opens a detail drawer.
- **Detail drawer** tabs: Overview (description, reader, effect, risk reason,
  default, related settings, Guide link, governance warning), Value (typed editor
  grouped by field group with hints, units, option hints and a field filter) and
  History (current/scheduled/superseded versions, diff, load into editor).
- **Deep links**: `?section=risk&open=screening.fail_closed`.
- **New setting** lists known runtime settings with no stored row and an advanced
  custom-key path. A custom key is explicitly described as stored value only; the
  platform will not read it until a core reader and catalog entry exist.

Lifecycle semantics:

| Status | Meaning |
| :--- | :--- |
| **Live policy** (`RUNTIME`) | Core reads the key at runtime. |
| **Legacy fallback** (`FALLBACK`) | Read only when the canonical key is absent. |
| **Recorded decision** (`DECISION`) | Decision-register record; no runtime effect. |
| **Retired** (`DEPRECATED`) | No longer read; read-only. |
| **Managed elsewhere** (`MANAGED`) | Another screen owns it; the drawer links there. |
| **System-managed** (`SYSTEM`) | Seeder/deploy owns it; read-only. |
| **Gateway evidence** (`DYNAMIC`) | `gateway.go_live.*` family created by the wizard. |
| **Using default** (`UNCONFIGURED`) | Known runtime key with no stored row; defaults are shown. |
| **Unregistered** (`UNREGISTERED`) | Key is not in the catalog; the screen warns instead of guessing. |

The UI distinguishes **latest**, **effective** and **scheduled** versions:

- Latest = highest version number.
- Effective = highest version whose `effectiveFrom` has passed.
- Scheduled = future-effective versions.

The row shows the effective value. A scheduled version is flagged and the drawer
warns that saving a new version now supersedes it. The edit form is prefilled
from the latest version so a scheduled value is not silently replaced in the
editor.

A save:

1. Validates the key against `^[A-Za-z0-9._:-]{2,120}$`.
2. Requires a JSON object (not an array or scalar) and the typed field checks.
3. Requires the setting checklist when checklists are visible.
4. Requires a change note of at least three characters.
5. Calls `PUT v1/admin/settings` with `settings: { [key]: parsed }`, the checked
   keys and `reason`.
6. Core writes the next immutable version, audit `PLATFORM_SETTINGS_UPDATED`
   with the settings, checklist and reason, and invalidates the merchant-report
   and route-health policy caches.

The settings page is **not maker-checker**. The UI does not show a false
"Four-Eyes Required" badge; it states that the change is immediate and audited,
and recommends a second reviewer for high-risk settings. Maker-checker for
platform settings remains a separate future feature.

`checkout.support_config` is listed as **Managed elsewhere** and links to
`/settings/checkout-help`.

Page: `admin-front/src/pages/settings/checkout-help/index.tsx`.

Endpoints:

| Operation | Endpoint | Authority |
| :--- | :--- | :--- |
| Current config | `GET v1/admin/settings/checkout-support` | `settings:read` |
| Version history | `GET v1/admin/settings/checkout-support/history` | `settings:read` |
| Summary | `GET v1/admin/settings/checkout-support/summary` | `settings:read` |
| Summary export | `GET v1/admin/settings/checkout-support/summary/export` | `settings:read` |
| Save config | `PUT v1/admin/settings/checkout-support` | `settings:write` |

The form edits the `checkout.support_config` platform setting:

- `enabled`.
- `show_platform_contact`, `show_merchant_contact`.
- Support phone, WhatsApp and email.
- Working hours in Arabic and English.
- A bilingual FAQ list.

Validation:

- Email must look like an email when present.
- Phone/WhatsApp digits must be 6-15 when present.
- At least one of Arabic/English question and answer must be present for an FAQ entry to be saved.
- The edit checklist is `SUPPORT_CHANNELS_VERIFIED`, `FAQ_CONTENT_REVIEWED`, `WORKING_HOURS_VERIFIED`, `PAYER_VISIBILITY_REVIEWED`.
- The page warns when there are unsaved changes and registers `beforeunload`.

Saving creates the next immutable version directly, writes `CHECKOUT_SUPPORT_UPDATED` with the before/after value, and writes `CHECKOUT_SUPPORT_EDIT_CHECKLIST` with the version and checklist keys. This is versioned and audited but not maker-checker.

The live preview shows the current working hours, platform contact block, merchant-contact explanation and FAQ entries. It does not simulate the actual payer drawer; the real drawer also includes state help, reference copy and per-rail guide.

The version history card lists all versions with effective/created timestamps. "Compare with current" flattens the selected and current JSON and lists added/removed/changed paths. "Load into editor" copies the selected version into the form; saving creates a new version.

### 3.4 Academy reporting and certification

The Academy was rebuilt on 2026-11-04 and is specified in `03-guide-and-academy.md` (§6-7). Its operational surface is the `SECURITY_ADMIN` team view and the per-user progress calls:

| Operation | Endpoint | Authority |
| :--- | :--- | :--- |
| Own progress | `GET/PUT v1/admin/academy/progress` | authenticated back-office user |
| Exam eligibility / start / submit | `GET .../exams/:examId/eligibility`, `POST .../start`, `POST .../submit` | authenticated back-office user (server-graded) |
| Team view | `GET v1/admin/academy/team` | `SECURITY_ADMIN` role (admin-back + core-back; audited `ACADEMY_TEAM_VIEWED`) |

The old summary/overview/export endpoints (`/progress/overview*`, `ACADEMY_SUMMARY_EXPORTED`, `ACADEMY_CERTIFICATIONS_EXPORTED`) and their export checklist were removed; the team page exports the visible rows as CSV client-side. Only `AdminAcademyTeam` is role-gated in the router; every other Academy route needs no authority.

### 3.5 Exports and checklist behavior

All spreadsheet exports use `admin-front/src/utils/xlsx/**`:

- Summary metric rows are converted with `downloadXlsxFromCsvLines`.
- Table exports use `useTableXlsx` and export the currently rendered page.
- The summary export card disables the export button until the checklist is complete.
- When `ADMIN_SHOW_CHECKLISTS` is false, the checklist is hidden and the completeness guard is treated as true.
- Export endpoints generally write audit entries with the checklist keys.

The deploy engine writes both build-time Vite values and `runtime-config.js`; runtime values take precedence. `ADMIN_SHOW_HELP_PANELS` controls the inline KYB/approvals/merchants help panels, not these exports.

### 3.6 Authority gating summary

| Surface | UI route gate | Backend read | Backend write |
| :--- | :--- | :--- | :--- |
| Backups | `security:read` or `gateway:read` | `security:read`/`gateway:read` | `security:write` |
| Platform settings | none | `settings:read` | `settings:write` |
| Checkout help | none | `settings:read` | `settings:write` |
| Academy pages | none (Team: role `SECURITY_ADMIN`) | self: authenticated; team: `SECURITY_ADMIN` | self: authenticated |
| Approvals | `approvals.approve`/`reject` | approval authority | `approval:check` and checker separation |

The UI hides write controls where it knows the authority. The backend remains authoritative.

## 4. Contracts and invariants

1. **Platform settings are append-only versions.** A save never mutates an existing row; the next version is `latest + 1`.
2. **The effective version is the highest version whose effective date has passed.** The row shows the effective value; a future version is shown as scheduled and is never displayed as current.
3. **The catalog is the explanation.** Every seeded key and every runtime key must have a catalog definition with a section, summary, description, reader, effect, risk, risk reason, defaults and hints for every field. An unknown key is shown as Unregistered, not silently edited as if it were understood.
4. **Restore must preview first.** Apply requires explicit confirmation, a reason, the checklist, and matching `expectedCurrentVersion` values.
5. **Invalid restore entries block apply.** The UI and backend both refuse to apply when `invalid > 0`.
6. **Backup policy is maker-checker.** The maker submits; a different checker executes through approvals.
7. **Backup trigger/drill are immediate writes under `security:write`.** They are not maker-checker approvals.
8. **Checkout support save creates a new version and audit entries.** It is not a maker-checker execution.
9. **Platform settings are immediate and audited, not maker-checker.** The UI states this and requires a change note; high-risk settings should be reviewed by a second person out of band.
10. **The Academy team view requires the `SECURITY_ADMIN` role and writes an audit entry; exam grading is server-side.**
11. **All spreadsheet exports use the shared XLSX pipeline.**
12. **Runtime visibility flags override build-time flags.**

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Backup page | `admin-front/src/pages/system/backups/index.tsx` |
| Platform settings page | `admin-front/src/pages/settings/platform/index.tsx` |
| Checkout help page | `admin-front/src/pages/settings/checkout-help/index.tsx` |
| Academy pages | `admin-front/src/pages/academy/*.tsx` |
| URL map | `admin-front/src/constants/urlsMap/index.ts` |
| XLSX pipeline | `admin-front/src/utils/xlsx/**` |
| Summary/checklist primitives | `admin-front/src/components/ui/SummaryExportCard.tsx`, `FormChecklist.tsx` |
| Deploy flags | `ADMIN_SHOW_CHECKLISTS`, `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST`, `ADMIN_SHOW_HELP_PANELS` |
| Backup config | deploy `FAKE_RAILS_*` is unrelated; backup daemon config is in the deploy/backup parts |

## 6. Operational usage

- Review backups: start with WAL lag, daemon reachability, target health and the latest drill. A failed/absent drill is not a healthy backup posture.
- Trigger a backup: choose a target and kind; `delta` is not a substitute for a full restore point.
- Change backup policy: submit the form, then have a different checker execute the pending approval. The backup page will not execute it directly.
- Change a platform setting: search by name or key, open the row, read the reader/effect/risk and field hints, complete the checklist, write a change note and save. Verify the current and scheduled versions. The change is immediate and audited; ask a second person to review high-risk settings out of band.
- Restore settings: preview, inspect invalid/missing/version conflicts, then apply with a real reason. Do not retry a version conflict without re-previewing.
- Change checkout support: ensure contact channels and FAQ content are valid in both languages, preview the result, and save. This changes payer-visible help immediately for new fetches.
- Academy team view not visible: it needs the `SECURITY_ADMIN` role.

## 7. Status and deviations

### Implemented

- Backup health, WAL lag, targets, backup history, drill verification, trigger, drill and policy UI.
- Backup policy maker-checker execution through the approvals queue.
- Platform settings list, version history, diff, backup export, restore preview/apply, summary and summary export.
- Checkout support config, live preview, version history, diff, summary and summary export.
- Academy team view (CSV export of the visible rows).
- Shared XLSX and checklist behavior.

### Partial

- The backup page does not hand the operator into the specific pending approval after a policy save.
- `BACKUP_POLICY` is missing from the shared approvals subject-type filter options, even though the backend supports it.
- Platform settings and checkout support are versioned/audited but not maker-checker. The settings page states this honestly and requires a change note.
- The settings catalog is frontend metadata; a new core key without a catalog entry appears as Unregistered until the catalog, hints and translations are added.
- Checkout support is managed on its own screen and appears read-only in the settings workspace.
- Academy labs are browser-graded practice; certification is decided only by server-graded exams.

### Missing / deferred

- No immutable certificate registry or re-certification cycle.
- No backup catalog browser beyond the latest-30 history.
- No direct restore-from-backup UI; only restore drills.
- No schedule editor validation preview for cron syntax beyond the five-field check.

### Known bugs / risks

- **Workflow gap:** a backup policy maker cannot continue directly to approval; the pending request must be found in the general approvals queue.
- **Filter gap:** the approvals subject filter cannot select `BACKUP_POLICY`.
- **Governance gap:** platform settings/checkout help saves are immediate and audited, not maker-checker. High-risk settings rely on an out-of-band second review.
- **Catalog drift risk:** a runtime key added without a catalog definition will display as Unregistered and cannot explain its effect.
- **Export scope risk:** table exports are current-page only; do not treat them as full-result exports.
- **Documentation gap:** historical design claims about weekly drills/hourly Redis/ready-to-run backup certificates are superseded by the storage/backup parts.

## 8. Verification and tests

- `tests/e2e/admin/platform-settings.spec.ts` proves sections, search, status badges, the drawer, current vs scheduled versions, unconfigured/managed settings, the typed save body with change note and the phone layout.
- `tests/unit/platform-settings.test.ts` proves seeded-key catalog coverage, field hints, section/status translation, defaults, effective/scheduled versions, unregistered keys, search (including Arabic) and go-live aspect editors.
- `tests/e2e/admin/backups.spec.ts` mocks the backup overview and verifies the rendered health/schedule/drill state and the trigger request payload.
- `core-back/test/backup-admin/backup-admin-routes.test.ts` covers backup route authority, trigger/drill/policy behavior and audit entries.
- `core-back/test/automation/business-time.test.ts` covers the `calendar.holidays` object shape.
- `admin-back/test/core-contract.test.ts` proves the change note (`reason`) is forwarded to core.
- `tests/unit/academy-content.test.ts` covers the Academy content counts.
- The XLSX pipeline has no dedicated unit test in this repository; coverage is through page-level usage and the shared UI compliance test.

The backup E2E suite requires the live stack; the core backup test requires PostgreSQL/Redis.

## 9. Adding or changing a platform setting

The full developer checklist is in `docs/developer/platform-settings.md`. The
canonical rule is:

1. Decide whether it is a platform setting, deploy/env config, a domain column or
   static UI text. Never store secrets, personal data or AML-confidential
   evidence in a setting.
2. Choose an immutable `domain.name` key and a JSON object value with safe
   defaults.
3. Add the default to `core-back/prisma/platformSettingsSeed.ts` when every
   environment should have it.
4. Add the core reader with defensive parsing, a safe fallback and cache
   invalidation after a settings save.
5. Add the catalog definition in `settingsCatalog.ts`: section, summary,
   description, readBy, effect, risk, riskReason, defaults, keywords, edit/create
   flags and a hint for every field.
6. Add the typed namespace in `settingsSchemas.ts`; every field needs a label,
   hint, type and optional unit/default/options.
7. Add English and Arabic text in `admin-front/src/constants/i18n/settings.ts`.
8. Add or update unit, core, edge and Playwright tests.
9. Update this part, the route/test catalogues, `TRACKER.md`, the Guide article
   and the Companion snapshot when the operator-facing behavior changes.
10. Run `bun scripts/project-design/build.ts --check`, `git diff --check` and the
    relevant workspace gates.

Lifecycle status must be honest: if nothing reads the key at runtime, mark it
`DECISION` and say so. Do not present a recorded decision as a live switch.

## 10. Source references

### Old design sections

- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` — backup/restore/drill intent and corrected as-built notes.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` — admin operations/guide placement.
- `design/06-ui/portal_ui_implementation_plan.md` — settings, backups and export rollout.

### Code paths

- `admin-front/src/pages/system/backups/index.tsx`
- `admin-front/src/pages/settings/platform/index.tsx`
- `admin-front/src/pages/settings/platform/components/**`
- `admin-front/src/components/builders/model/{settingsSchemas,settingsCatalog,settingsSearch}.ts`
- `admin-front/src/pages/settings/checkout-help/index.tsx`
- `docs/developer/platform-settings.md`
- `admin-front/src/pages/academy/*.tsx`
- `admin-front/src/utils/xlsx/**`
- `admin-front/src/components/ui/SummaryExportCard.tsx`
- `admin-front/src/components/ui/FormChecklist.tsx`
- `core-back/api/internal/backups.ts`
- `core-back/api/internal/admin.ts` (settings handlers), `core-back/api/internal/academy.ts`
- `core-back/lib/approvalQueue.ts`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/test-inventory.md`

## 11. Change history

- 2026-11-03 — Initial canonical operations part. Records backup/target/drill/policy behavior, settings versioning/restore, checkout-support history/diff, academy reporting, export/checklist behavior, and the authority/workflow gaps.

## Security hardening (2026-11-05)

Backups page: actions are disabled unless backups are configured and the daemon is reachable; a full backup of all targets needs an extra confirmation; trigger and drill send an `Idempotency-Key` header (required by admin-back); policy form validation mirrors the edge rules (cron, minimum gaps, retention floors); server error text is sanitized and clipped.

## Safeguard checklists (2026-11-23)

Backup trigger, restore drill and policy changes now require the shared checklist before submission. Trigger keys: `BACKUP_TARGET_VERIFIED`, `LOAD_IMPACT_REVIEWED`, `AUTHORITY_CONFIRMED`; drill keys: `DRILL_SCOPE_VERIFIED`, `SCRATCH_ISOLATION_REVIEWED`, `AUTHORITY_CONFIRMED`; policy keys: `POLICY_SCOPE_REVIEWED`, `RETENTION_IMPACT_REVIEWED`, `APPROVAL_PATH_CONFIRMED`. The drill is now a checklist modal instead of an immediate confirm. Core filters the keys and records them in `BACKUP_TRIGGERED` / `BACKUP_DRILL_TRIGGERED` (including deduplicated retries) and the policy approval payload. Jobs/Outbox retries, notification retries, object-storage legal holds/maintenance, notification-template edits and settings/checkout-help exports use the same pattern. `ADMIN_SHOW_CHECKLISTS` hides the UI gate without changing the server path.

## Second-pass restore-drill rendering (2026-11-25)

The Backups page now reads the daemon's camelCase check objects (`doubleEntry`, `balanceParity`, `auditChain`, `objectStorage`) and their `ok` boolean before falling back to counters. A failed check with a successful query counter can no longer render as **Passed**. The object-storage parity check is shown as a fourth badge when the daemon includes it; the core DTO exposes `checks.objectStorage` as optional.

## 12. Communication settings (2026-11-26)

The settings catalog registers four runtime keys with typed editors:

| Key | Section | Purpose |
| :--- | :--- | :--- |
| `communication.email` | Operations & data | Primary SMTP channel: host, port, security, credentials, sender and timeout. Merchant registration and sign-in stay in maintenance while it is not configured. |
| `communication.sms` | Operations & data | Optional signed SMS aggregator webhook and sender ID. SMS is additive; email remains primary. |
| `communication.policy` | Operations & data | Which templates may also use SMS (`OFF`, `AUTH_ONLY`, `CRITICAL_ONLY`, `ALL`) and whether staff may fall back to SMS when email is missing. |
| `auth.google` | Merchants & onboarding | Server-side Google OAuth 2.0 client ID, secret, redirect URI and optional hosted domain for merchant sign-in and registration. |

All four use `showWhenUnconfigured`, so they appear as **Using default** before the first save and can be created from the detail drawer. Secrets (`smtpPassword`, `webhookSecret`, `clientSecret`) use the `secret` field kind: the API returns a mask, a blank input keeps the stored value, and the value is stored encrypted in `platform_setting_secrets`.

The **Communication** tab sits beside **Platform settings** and **Notification templates**. It shows email, SMS and Google readiness (configured, source, missing fields, last test, last delivery, consecutive failures), the merchant maintenance banner and test-send actions. Each card opens the matching typed setting in the same detail drawer. The tab does not save values itself, so the change-note, checklist and immutable-version rules are identical to every other setting.

`tests/unit/platform-settings.test.ts` requires every definition string and field hint to have an Arabic entry; the communication strings live in `constants/i18n/settings.ts`. `tests/e2e/admin/platform-settings.spec.ts` covers the tab, the maintenance banner and opening the typed email editor.

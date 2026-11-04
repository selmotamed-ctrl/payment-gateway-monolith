---
id: admin-ui.operations
title: Backups Settings and Operations
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - admin-front/src/pages/system/backups/**
  - admin-front/src/pages/settings/platform/**
  - admin-front/src/pages/settings/checkout-help/**
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
gaps:
  - Backup policy edits create an approval request but the backup page has no direct approvalRequestId continuation; the checker must use the general Approvals queue.
  - The Approvals filter/registry subject-type list does not include `BACKUP_POLICY`, so the subject cannot be selected from the shared filter options.
  - Platform settings and checkout-support saves create new versions and audits directly; they are not maker-checker executions despite `sensitiveMakerChecker` field hints.
  - The platform settings, checkout help and academy routes have no router-level authority gate; the backend still enforces `settings:read`/`settings:write` or `user:read`.
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

The page groups all versions by setting key, newest first, and shows:

- Key, latest version, scope, version count and effective date.
- A JSON preview.
- History and edit dialog.

A save:

1. Validates the key against `^[A-Za-z0-9._:-]{2,120}$`.
2. Requires a JSON object (not an array or scalar).
3. Requires the setting checklist when checklists are visible.
4. Calls `PUT v1/admin/settings` with `settings: { [key]: parsed }` and the checked keys.
5. The backend creates the next version with `scope: "PLATFORM"` and an effective date (now unless supplied) and writes a `PLATFORM_SETTINGS_UPDATED` audit entry.

This path is versioned and audited but is **not** a maker-checker approval. The form marks fields as sensitive/maker-checker, but the backend handler writes directly for an operator with `settings:write`.

The history dialog can compare an older version with the current version. The diff is computed by flattening both JSON objects and listing added/removed/changed paths. "Load into editor" copies a version's JSON into the editor; it does not write until the operator saves.

Backup export downloads a JSON file containing the latest version per key with `exportedAt`, key/scope/version/value/effective/updated fields, and writes a `PLATFORM_SETTINGS_EXPORTED` audit entry.

Restore is preview-first:

- The operator selects a JSON file.
- The backend validates entries, computes `ADDED`/`CHANGED`/`UNCHANGED`/`INVALID` and the missing-in-backup keys, and returns the preview. Preview requires only read authority and writes a preview audit entry.
- Apply requires a reason of at least 3 characters, the restore checklist, `confirm: true`, and only sends entries that are added/changed and have a value.
- The backend rejects invalid entries before apply and checks `expectedCurrentVersion` for each setting inside a transaction. A concurrent change returns `409 SETTING_VERSION_CONFLICT`.
- Apply creates new versions and writes `PLATFORM_SETTINGS_RESTORED` with the reason and checklist.

The summary card shows keys, versions, updates in the last 24 hours, future-effective count, and per-scope counts. The summary export is a CSV-to-XLSX workbook of those metrics.

### 3.3 Checkout help settings (`/settings/checkout-help`)

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
2. **The effective version is the highest version whose effective date has passed.** Future-effective versions remain visible but are not yet effective.
3. **Restore must preview first.** Apply requires explicit confirmation, a reason, the checklist, and matching `expectedCurrentVersion` values.
4. **Invalid restore entries block apply.** The UI and backend both refuse to apply when `invalid > 0`.
5. **Backup policy is maker-checker.** The maker submits; a different checker executes through approvals.
6. **Backup trigger/drill are immediate writes under `security:write`.** They are not maker-checker approvals.
7. **Checkout support save creates a new version and audit entries.** It is not a maker-checker execution.
8. **The Academy team view requires the `SECURITY_ADMIN` role and writes an audit entry; exam grading is server-side.**
9. **All spreadsheet exports use the shared XLSX pipeline.**
10. **Runtime visibility flags override build-time flags.**

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
- Change a platform setting: edit the JSON object, record the checklist, and save; verify the new version and effective date. Treat the form's maker-checker hint as advisory only.
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
- Platform settings and checkout support are versioned/audited but not maker-checker.
- The route-level UI gates for platform settings and checkout help are absent (the Academy team route is role-gated).
- Academy labs are browser-graded practice; certification is decided only by server-graded exams.

### Missing / deferred

- No immutable certificate registry or re-certification cycle.
- No backup catalog browser beyond the latest-30 history.
- No direct restore-from-backup UI; only restore drills.
- No schedule editor validation preview for cron syntax beyond the five-field check.

### Known bugs / risks

- **Workflow gap:** a backup policy maker cannot continue directly to approval; the pending request must be found in the general approvals queue.
- **Filter gap:** the approvals subject filter cannot select `BACKUP_POLICY`.
- **Governance gap:** `sensitiveMakerChecker` hints on platform settings/checkout help fields do not produce a maker-checker approval.
- **Authorization risk:** direct navigation to settings/checkout help is not blocked by the router; the page loads and then fails backend calls for unauthorized users.
- **Export scope risk:** table exports are current-page only; do not treat them as full-result exports.
- **Documentation gap:** historical design claims about weekly drills/hourly Redis/ready-to-run backup certificates are superseded by the storage/backup parts.

## 8. Verification and tests

- `tests/e2e/admin/backups.spec.ts` mocks the backup overview and verifies the rendered health/schedule/drill state and the trigger request payload.
- `core-back/test/backup-admin/backup-admin-routes.test.ts` covers backup route authority, trigger/drill/policy behavior and audit entries.
- `tests/unit/academy-content.test.ts` covers the Academy content counts.
- The XLSX pipeline has no dedicated unit test in this repository; coverage is through page-level usage and the shared UI compliance test.

The backup E2E suite requires the live stack; the core backup test requires PostgreSQL/Redis.

## 9. Source references

### Old design sections

- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` — backup/restore/drill intent and corrected as-built notes.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` — admin operations/guide placement.
- `design/06-ui/portal_ui_implementation_plan.md` — settings, backups and export rollout.

### Code paths

- `admin-front/src/pages/system/backups/index.tsx`
- `admin-front/src/pages/settings/platform/index.tsx`
- `admin-front/src/pages/settings/checkout-help/index.tsx`
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

## 10. Change history

- 2026-11-03 — Initial canonical operations part. Records backup/target/drill/policy behavior, settings versioning/restore, checkout-support history/diff, academy reporting, export/checklist behavior, and the authority/workflow gaps.

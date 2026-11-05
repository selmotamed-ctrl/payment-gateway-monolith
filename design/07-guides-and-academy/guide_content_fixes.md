# Guide content fixes

Append-only log for label and route-map corrections made while implementing the
Admin Interactive Guide. Format: `articleId | old label | new label | file:line`.

## Context-map route names (guide design §II-6, phase G-4)

| Screen | Change | Reason | Source |
| :--- | :--- | :--- | :--- |
| JoinRequests | Added `JoinRequestNew`, `JoinRequestDetail`, `KybReviewDetail` | Router names rendered by pages in `pages/join-requests` and `pages/kyb`, which the design groups under JoinRequests. | `admin-front/src/router/index.ts` |
| OperatorCases | Added `OperatorCaseDetail`, `GatewayInquirySchedules` | Detail and inquiry pages use `pages/operator-cases`. | `admin-front/src/router/index.ts` |
| Finance | Added `PricingControls` | `pages/finance/pricing` has no dedicated screen entry; Finance owns `pages/finance`. | `admin-front/src/router/index.ts` |
| Routes | Added `GatewayRoutes` | The real router name is `GatewayRoutes`, not `Routes`. | `admin-front/src/router/index.ts` |
| CheckoutHelp | Added `AdminCheckoutHelp` | The real router name is `AdminCheckoutHelp`, not `CheckoutHelp`/`SettingsCheckoutHelp`. | `admin-front/src/router/index.ts` |
| General | Added `AdminUsers`, `AdminUserDetail`, `AuditLog`, `AdminPlatformSettings`, `SystemBackups` | These route names render pages without a dedicated screen entry; General is the fallback screen. | `admin-front/src/router/index.ts` |

## Label corrections verified against the code

No article label text was changed. The following code labels differ from the
guide design's wording; they are recorded here and in
`guide_content_questions.md` (same folder) rather than editing an explanation:

| Card | Design label | Actual label | File:line |
| :--- | :--- | :--- | :--- |
| `sg-bulk-inquiry` | **Bulk Inquiry** | **Inquire selected** / **Inquire about selected cases** | `admin-front/src/pages/operator-cases/index.tsx:1074` |
| `sg-resolve-unknown` | **Mark succeeded** / **Mark failed** | **Resolve as succeeded** / **Resolve as failed and release reservation** | `admin-front/src/pages/operator-cases/[id].tsx:189` |
| `sg-suspend-merchant` | **Suspend Merchant** | **Suspend** (dialog **Suspend merchant**) | `admin-front/src/pages/merchants/[id].tsx:714` |
| `sg-reinstate-merchant` | **Reinstate Merchant** | **Reinstate** (dialog **Reinstate merchant**) | `admin-front/src/pages/merchants/[id].tsx:717` |
| `sg-edit-merchant-sensitive` | **Submit For Approval** | **Submit for approval** | `admin-front/src/pages/merchants/components/MerchantEditDialog.tsx:223` |
| `sg-aml-rule-change` | **Create** / **Save** | **Draft rule** → **Create draft** (no Save action) | `admin-front/src/pages/aml/rules/index.tsx:456` |
| `sg-aml-report` | **Create** / **Save** | **Draft report** → **Create draft**; **Save authority decision** | `admin-front/src/pages/aml/reports/index.tsx:582` |
| `sg-run-reconciliation` | **Run File** | **Upload** | `admin-front/src/pages/reconciliation/index.tsx:793` |

## Content corrections verified against the code (2026-11-05)

These are prose corrections, not label renames. Each was checked against the built screen or
the core/edge behaviour before editing.

| Article | Old claim | Corrected claim | Evidence |
| :--- | :--- | :--- | :--- |
| `b03-01`, `b01-07`, glossary `mfa` | MFA code comes from an authenticator app | six-digit code sent by SMS to the phone registered on the account; no phone means the Security Admin must add one first | `core-back/lib/auth/mfaChallenges.ts`, `core-back/api/internal/{admin,merchant}.ts` |
| `b03-01`, `b11-03` | sessions only described as short | `Sign out` revokes the session on the server, not only in the browser | `core-back/api/internal/{admin,merchant}.ts` logout routes |
| `b03-02` | authorities listed without the escalation rule | the catalogue is closed; nobody grants an authority they do not hold or changes their own account | `core-back/lib/auth/merchantAuthorities.ts`, `core-back/api/internal/admin.ts` |
| `b03-03` | menu table omitted Audit Log, Admin Users, Inquiry Schedule, Backups, Platform Settings and Pricing & Limits | all six rows added | `admin-front/src/layouts/sections.tsx` |
| `b03-02`, `b07-09`, `b12-07` | Admin Users, Inquiry Schedule and Platform Settings existed only as menu entries | short screen subsections describe the available actions and their limits | `admin-front/src/pages/users`, `admin-front/src/pages/operator-cases/inquiries`, `admin-front/src/pages/settings/platform` |
| `b03-08` | staff accounts, commission/velocity, audit search and platform settings had "no screen" | only statement-source creation remains partial; the rest are real screens | `admin-front/src/router/index.ts`, `admin-front/src/pages/**` |
| `b04-07` | audit log search "not yet available" | the Audit Log screen filters and exports | `admin-front/src/pages/audit-logs/index.tsx` |
| `b04-05` | staff role/authority change "sessions revoked" | permissions are re-read on the next request; a disabled account is refused | `core-back/api/middleware/authDoubleCheck.ts` |
| `b08-03`, `b09-04` | commission profiles and velocity rules had no screen | Pricing & Limits manages both; changes need a checker | `admin-front/src/pages/finance/pricing/index.tsx` |
| `b08-06` | the same statement file can never be loaded twice | uniqueness is per statement source; another source may load the same bytes | `core-back/prisma/migrations/20261105130000_statement_unique_source_file_hash` |
| `b12-07` | backups only described as a pre-migration dump | the Backups screen shows engine/schedule/last backup and runs restore drills; policy changes need approval | `admin-front/src/pages/system/backups/index.tsx`, `deploy/backup-daemon/**` |

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

## Readability overhaul (2026-11-07)

This pass changed presentation only. No fact, count, id, `related` entry, safeguard checklist,
quick answer or question was added or removed; the 14 books / 128 articles / 151 terms /
25 cards / 32 situations / 58 FAQ / 140 edge cases are unchanged.

| Change | Scope | Why |
| :--- | :--- | :--- |
| Short inline labels | 345 bare `[[a:…]]` / `[[c:…]]` / `[[s:…]]` / `[[g:…]]` tokens labelled outside tables (plus labels on existing parenthetical links) | A bare article link used to render its full 10-to-15-word title inside the sentence. `scripts/overhaul-guide-and-academy-clarity.ts` now labels bare links and `--check` keeps them labelled. Table cells stay bare because `|` would split the cell; the readers shorten them at render time. |
| Parenthetical reference trays | Renderer in `admin-front/src/components/guide/MarkdownView.tsx` and `companion-app/src/lib/markdown.ts` | Pure pointer parentheticals are moved to a per-section **Related** tray; meaningful prose such as `(called rails, …)` is preserved. No link is lost. |
| `:::summary` callouts | 22 articles: Book 2 (`b02-01`–`b02-07`), `b04-03`, `b05-01`, `b05-02`, `b05-07`, `b06-03`, `b06-06`, `b06-07`, `b06-11`, `b06-12`, `b07-01`, `b07-02`, `b07-03`, `b08-04`, `b08-12`, `b11-03` | Gives a CEO, a new hire and an operator the whole point of an article before the detail, following the plan's 3-speed reader. |
| `:::refs` footer | `b02-07` (database tour) | Demonstrates the explicit "Where to go next" block with two curated next steps. |
| No verbatim Book 2 replacement | All articles | The plan's Book 2 replacement blocks were written against an older 94-article snapshot with different article ids and titles (for example `b02-04` was "The fourteen payment states" there, but is "The life of a merchant" here). Applying them would have deleted current topics and broken cross-references, so the clarity principles were applied to the current canonical articles instead. |

## Readability overhaul, second pass (2026-11-07)

101 articles (Books 2 and 4 to 12) were rewritten for readability: a plain-language opening, an "In plain words" summary, short sections, worked examples and the original tables with every row kept. Every rewrite was compared with the old text and the code by an independent reviewer. These factual corrections came out of that review:

| Item | Old claim | Corrected claim | Evidence |
| :--- | :--- | :--- | :--- |
| `b02-07` | The database has 64 tables | 76 models, regrouped into seven groups (A to G) | `core-back/prisma/schema.prisma` (`grep -c '^model '` = 76) |
| `b02-04`, `b05-01` summaries | A merchant can be suspended, frozen or terminated | The merchant states are PENDING, ACTIVE, SUSPENDED, REJECTED and CLOSED; FROZEN is a wallet status | `enum MerchantStatus` |
| `b02-05` | Sadad sends us messages through inbound callbacks | The core asks Sadad; Sadad has no webhook endpoint | `project-design/parts/06-fake-rails/01-protocol-matrix.md` |
| `b08-02` | `COMMISSION_RECEIVABLE` has one account per merchant | One per platform | `core-back/engine/ledger/LedgerPoster.ts` (`ACCOUNT_SCOPING`) |
| `b12-05`, `b12-07` | A failed end-to-end check returns to the previous release automatically | There is no automatic rollback: the new release stays current, the previous release stays on disk and an operator rolls back by hand (restarting the backend from the previous release folder, not a plain `pm2 restart`). Undo never reverses database changes. | `deploy/README.md` sections 7 and 12, `deploy/deploy.ts` |
| `b04-03` example | Compliance checks a payout-bank change | Example now uses a Finance checker (the matrix says Compliance or Finance, by field) | `b04-05` |
| `b06-11`, `b06-12` examples | Sadad has two routes | Sadad has one route (`sadad-direct`); the examples use an invented rail | seeded gateways |

Facts that were **kept as written although code or another article disagrees** are listed in `guide_content_questions.md` for an owner decision.

## Sandbox and Live accuracy pass (2026-11-25)

Checked against the v38-v39 parallel execution plane and the inbound webhook code. The old text treated Sandbox as only the partner's practice environment and claimed a wrong-environment webhook raised an alert; the platform actually rejects it without creating an alert, and our own Sandbox is a separate core process and database. Counts, ids and related links are unchanged.

| Item | Old claim | Corrected claim | Evidence |
| :--- | :--- | :--- | :--- |
| `b01-08` | Sandbox is the partner's practice world; the two worlds have different addresses and a sandbox webhook at the live address raises an alert. | Sandbox is a separate core service and database with `sbx_` links, `pg_test_` tokens, test-money wallets and Fake Rails; a wrong-environment webhook is rejected, not alerted. | `project-design/parts/00-platform/05-sandbox-execution-plane.md`, `core-back/lib/executionPlane.ts`, `core-back/api/internal/checkout.ts` (inbound environment binding) |
| `b05-01` | A `PENDING` merchant may use sandbox "if the platform setting allows it". | No such setting exists: the separate sandbox envelope is created as `ACTIVE`, while Live stays blocked. | `core-back/lib/commerceStatus.ts`, `core-back/api/internal/sandboxControl.ts` |
| `b06-10` | Each environment has its own webhook secret path; a wrong-environment webhook raises an alert. | The webhook address includes the environment and the channel's secret path; the wrong environment is rejected. | `core-back/api/internal/checkout.ts`, `core-back/prisma/schema.prisma` (`ConfirmationChannel`, `GatewayEnvironment`) |
| `b07-05` | A sandbox message at the live address produces a priority-2 security alert. | It is rejected and nothing changes; a repeating case means the partner's sandbox URL is wrong. | `core-back/api/internal/checkout.ts` |
| `b12-06`, glossary `sandbox`/`fake-rails`, `q-055`, `q-056` | Sandbox described only as the partner's environment; Fake Rails described as an internal drill service. | Our Sandbox plane and Fake Rails' role as its rail emulator are described; production refusal is stated accurately. | `project-design/parts/00-platform/05-sandbox-execution-plane.md`, `deploy/lib/configSchema.ts` |
| `l-m5-5`, `q-m1-009` | A sandbox webhook at the live address "raises an alert". | It is rejected and cannot change a live payment. | `core-back/api/internal/checkout.ts` |
| Merchant shell | The drawer showed `LIVE` inside `/sandbox/*`. | The route lives at `/portal/sandbox/*`, but `isSandboxPath()` only matched `/sandbox*`, so `sandboxMode` never turned on: the badge stayed `LIVE` and the Sandbox Live Mirror called Live API paths. `isSandboxPath()` now accepts both forms; the badge follows the route and mirror calls stay under `/api/v1/merchant/sandbox/...`. | `merchant-front/src/state/sandbox/index.ts`, `merchant-front/src/layouts/default.tsx`, `state/api/index.ts`, `tests/e2e/merchant/shell.spec.ts` |

## Second-pass accuracy sweep (2026-11-25)

A second read-only sweep covered Books 1-13 against the working tree after the first remediation commit. It found another set of claims that described the target state rather than the code. The Guide was corrected, and the code was fixed where the code was the defect:

| Area | Correction |
| :--- | :--- |
| Join-request SLA | `INFO_REQUESTED` pauses the five-day clock and resumes with the remaining time; the SLA now starts at submission, not at draft creation. |
| Four-eyes | Raising the risk tier to `HIGH` at decision time now forces a second reviewer; the Guide lists large ownership share and duplicate/related flags as risk-based triggers. |
| Beneficial owners | A recorded `CONTROLLER` satisfies the ownership gate when no owner reaches the threshold; the Academy was aligned. |
| Join rejection | A rejection now requires a reason code and a written note. |
| Applications | Resuming after a platform pause is maker-checker; contact phone/e-mail are sensitive maker-checker fields. |
| Merchant close | Closing revokes API tokens and token authentication rejects a non-`ACTIVE` merchant; there is no final payout after close. |
| AML | `aml:read`/`aml:write` now open the AML screens and confidential operator cases; a confirmed match is a direct suspension, not the emergency-ratification path. |
| AML output | There is no daily batch, no historical screening replay, no rule-precision metric, no automatic STR draft, and no generic maker withdraw for an AML case. |
| Adjustments | Only a `FINANCE` checker may approve an adjustment; the state paths and the per-adjustment commission reversal are described from the code. |
| Refunds and disputes | A ceiling breach refuses a refund or holds a chargeback; it does not always open a P1 case or notify the merchant. |
| Reconciliation | `MISSING_AT_GATEWAY` opens P2/24 h and `MISSING_LOCALLY` P3/72 h. The same bytes return the existing ingest run; a changed file creates a new one. |
| Reporting | The catalog is filtered by run authority; provisional rules are rejected before the filing adapter is called; report corrections are not linked. |
| Gateway checks | The wizard `CREDENTIAL_CHECK` button only previews phases and does not test credentials; an unmatched 2xx on a money step is `SUCCEEDED`. |
| Webhooks | Verification is synchronous; dedupe is permanent; an unknown reference is stored and rejected, not matched later; retention can purge old inbox rows. |
| OTP | The resend button only refreshes the cooldown and does not send a new SMS. |
| Cash-out | One Finance actor processes the payout; the merchant requester and the audit row are the separation. |
| Drift | The invariant opens a P1 case; it does not stop payouts automatically. |
| Backups | The pg-native engine owns zstd/AES-256-GCM and `pg_receivewal`; the drill UI reads the daemon's `ok` flags and shows the object-storage badge. Pruning happens during each service deploy. |
| Security | There is no step-up re-authentication or self-service password change; a reset returns the account to `INVITED` and re-issues the invitation. Storage client certificates are provisioned but not yet enforced. |
| Dashboard and roles | Gross Volume follows the selected currency; the Security Admin default can read credential sets and settings; the Finance default can open reconciliation and pricing; sandbox routes are visible to the roles the Guide names. |

These corrections keep the Guide and the Academy consistent with each other and with the working tree.

## Context-help route mapping (2026-11-27)

| Screen | Change | Reason | Source |
| :--- | :--- | :--- | :--- |
| Transactions (new) | Added a `Transactions` screen with `routeNames: ["Transactions"]`, `pageDir: pages/transactions`, summary from article `b03-11` and that article as its reading list. | `/transactions` was listed under `OperatorCases`, so the help drawer opened operator-case help on the Transactions page. A screen per page is the only way to open the Transactions help; the summary reuses the existing `b03-11` plain-words paragraph. | `admin-front/src/router/index.ts`, `design/07-guides-and-academy/guide_system_design_and_content.md` article `b03-11` |
| OperatorCases | Removed `Transactions` from `routeNames`. | The route name belongs to the new Transactions screen. | `admin-front/src/router/index.ts` |

`ContextHelpDrawer` now resolves the current path with `resolveGuideScreenForPath` (exact path, dynamic route, exact name, longest segment-aligned page-directory prefix, fallback). The prefix rule is segment-aligned, so `/operator-cases` cannot capture `/transactions`.

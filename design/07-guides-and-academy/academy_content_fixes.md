# Academy content fixes

Append-only log of label and route-map corrections made while implementing the Employee Academy
(`academy_system_design_and_content.md`, Part 0 rule 5). Format for label corrections:
`itemId | old label | new label | file:line`. Only label text is ever changed here; explanations,
option correctness and scores are never edited (behaviour doubts go to `academy_content_questions.md`).

## Guide context-map route names (Academy design §I-5)

| Screen | Change | Reason | Source |
| :--- | :--- | :--- | :--- |
| Academy | Added `AdminAcademyTracks`, `AdminAcademyTrack`, `AdminAcademyModule`, `AdminAcademyLesson`, `AdminAcademyLab`, `AdminAcademyExam`, `AdminAcademyCertificate`, `AdminAcademyTeam`, `AdminAcademyHelp` to `routeNames` in `guide_system_design_and_content.md` §III-F.3 | The Academy now has ten routes; the contextual-help drawer resolves the current route through this map. | `admin-front/src/router/index.ts` |

## Spec corrections (not content)

| Item | Change | Reason |
| :--- | :--- | :--- |
| §II-13 A-3 | "the 14 labs" → "the 16 labs" (was 15 before `l-m10-5` was added) | §II-2.5 and Part III now define 16 labs. |
| §II-2.6 `Panel` | Added the title-only form | Lab `lab-security-desk/s5` has a panel that is only a scenario statement. |
| §II-1 / §II-7 | Paths mapped to the real repository layout; no migration | `users.academy_progress_json` already exists. |

## Label corrections

<!-- itemId | old label | new label | file:line -->
l-m3-2 | **Details** | **Review** | `admin-front/src/pages/approvals/index.tsx:730`
lab-approval-desk (option "Approve without opening…") | **Details** | **Review** | `admin-front/src/pages/approvals/index.tsx:730`
lab-approval-desk (option "I read the old and new value in…") | **Details** | **Review** | `admin-front/src/pages/approvals/index.tsx:730`
lab-approval-desk (task text) | **Decision Reason** | **Decision reason** | `admin-front/src/pages/approvals/index.tsx:1067`
l-m5-4 (×2) | **Bulk Inquiry** | **Inquire selected** | `admin-front/src/pages/operator-cases/index.tsx:1077`
lab-incident-unknown | **Mark succeeded** | **Resolve as succeeded** | `admin-front/src/pages/operator-cases/[id].tsx:190`
lab-compliance-desk | **Propose** | **Propose resolution** | `admin-front/src/pages/aml/cases/index.tsx:656`
drill-breaker | **Open Circuit Breakers** (Dashboard tile) | **Open breaker** (Route health card) | `admin-front/src/pages/dashboard/index.tsx:509`

## Content corrections verified against the code (2026-11-05)

| Item | Old claim | Corrected claim | Evidence |
| :--- | :--- | :--- | :--- |
| `l-m1-5` | MFA is "usually a code from your phone" | six-digit code sent by SMS to the phone number on the account | `core-back/lib/auth/mfaChallenges.ts` |

## Readability overhaul (2026-11-07)

Ten foundational lessons were rewritten as self-contained mini-tutorials: `l-m1-1`, `l-m1-2`,
`l-m1-3`, `l-m2-1`, `l-m2-2`, `l-m2-3`, `l-m4-1`, `l-m4-2`, `l-m5-1` and `l-m6-1`. Each keeps
the six required `###` headings in order, the same two check ids and the same facts; the worked
examples now use named merchants/customers and real numbers, and the common mistakes explain
the consequence. Counts at that date: 8 tracks, 11 modules, 50 lessons, 100 checks, 16 labs,
92 lab tasks, 8 exams and 223 exam-pool questions. The plan's replacement lessons used a
different module map (for example its `l-m2-4` does not exist here; `l-m4-1` is merchant states),
so they were adapted to the current lesson ids instead of copied verbatim.

## Readability overhaul, second pass (2026-11-07)

The remaining 40 lessons (every lesson except the ten rewritten earlier today) were rewritten as self-contained 350 to 600 word tutorials. All 50 lessons then in the file had the same shape, with the six required `###` headings in order, the same check ids and the same Read-now links. Counts at that date: 8 tracks, 11 modules, 50 lessons, 100 checks, 16 labs, 92 lab tasks, 8 exams and 223 exam-pool questions.

| Item | Old claim | Corrected claim | Evidence |
| :--- | :--- | :--- | :--- |
| `l-m10-3`, quiz `q-m10-107` | The deployment returns to the previous release automatically after a failed end-to-end check | No automatic rollback; the new release stays current and an operator rolls back by hand | `deploy/README.md` sections 7 and 12 |
| quiz `q-m10-110` | Rollback is switching the current link and restarting | Rollback points the current link at the previous release and restarts the backend services from that release's folder | `deploy/README.md` section 12 |
| `l-m1-1` example | A Pending-to-Available balance flow and a 2 LYD "gateway fee" | Only what the Guide states: the partner confirms the charge, the platform verifies and books it, and settlement and reconciliation follow; the cast is now Layla, Noon Mart and Sadad | `b01-01`, Book 8 |
| `l-m3-4`, `l-m1-5` and others | Examples gave an unsupported role or an unsupported sentence | Roles follow the approval matrix in `b04-05`; unsupported sentences were removed | review notes |

## Accuracy pass against the code (2026-11-25)

The counts in the 2026-11-07 entries above are historical. The current content has **8 tracks, 11 modules, 51 lessons, 102 lesson checks, 224 exam-pool questions (44 critical), 16 labs, 92 lab tasks and 8 exams**; the spec's EXPECTED COUNTS table now matches `admin-front/src/content/academy/generated/meta.json`. `l-m10-5` and the later exam questions are the difference.

Behaviour and answer-key corrections (not label-only; approved as an accuracy pass):

| Item | Old claim | Corrected claim | Evidence |
| :--- | :--- | :--- | :--- |
| `q-m0-002` | Refuse to approve a senior colleague's own request | You are the different person the rule requires: review it as the checker and decide | `core-back/engine/governance/ApprovalService.ts` (`MAKER_CHECKER_SEPARATION`) |
| `l-m2-2`, `c-l-m2-2-2` | Staff never see a token, not even a masked one | Staff see only `****lastFour`; the secret is never shown | `core-back/api/internal/adminCommerce.ts` (`lastFour`), `admin-front/.../ApplicationDetailDrawer.tsx` |
| `l-m3-2`, `q-m3-004`, `c-l-m3-2-2` | An expired approval returns to draft | It becomes final `EXPIRED`; a stale approve is refused with `409` | `core-back/engine/workers/ExpiryHousekeepingWorker.ts`, `ApprovalService.assertPending` |
| `l-m3-4` | Checklist ticks are not recorded anywhere | They are stored in the audit/payload JSON and the report execution audit | `core-back/api/internal/adminCommerce.ts` (`afterJson: { ..., checklist }`), `adminReportEngine.ts` (`checklistJson`) |
| `l-m4-2`, `lab-kyb-desk/k1` | 60/40 owners made a clean case with no four-eyes trigger | Every owner at or above 25% adds `LARGE_OWNERSHIP_SHARE`; the clean example is now 20/20/10 | `core-back/api/internal/merchant.ts` lines 409-419 |
| `l-m4-3` | Owner threshold setting is `aml.owner_threshold_percent` | `join_request.four_eyes_policy.ownerThresholdPercent` (alias `OD-2`) | `core-back/lib/joinRequestOnboarding.ts`, `core-back/api/internal/merchant.ts` |
| `l-m4-3`, `l-m10-2`, `q-m4-017` | The most senior manager is recorded automatically as controller, satisfying readiness | Record a `CONTROLLER` with a reason, but readiness still requires the active owners' recorded shares to total at least the threshold | `core-back/lib/joinRequestOnboarding.ts` (`ownersReady`), `core-back/api/internal/adminCommerce.ts` (`CONTROLLER` role) |
| `l-m4-4`, `l-m4-1`, `q-m4-010`, `q-m4-011` | Reinstatement is approved by Compliance/MLRO; closure needs balance zero and no dispute | A maker with `merchant:write` and the maker switch, plus a different Compliance/Finance/MLRO checker; closure also needs no open cash-out | `core-back/api/internal/admin.ts` (`/merchants/:id/reinstate`, `/close`), `DOMAIN_CHECKER_ROLES.MERCHANT` |
| `l-m5-5`, `q-m5-017`, `q-m5-024` | The grace window keeps listening for 24 h; an unknown attempt is retried for a minute | The grace value is stored but not enforced; only transient errors retry; an unknown reference is stored with no attempt and no effect | `core-back/engine/guards/AttemptGuardPipeline.ts` (`graceExpiresAt`), `InboundInboxWorker.ts`, edge-case 16 |
| `l-m5-5`, `q-m5-014` | Resend has a cap; use resend once | Only a cooldown is enforced | `core-back/api/internal/checkout.ts` (`OTP_RESEND_COOLDOWN`) |
| `l-m6-1`, `q-m2-006` | A wallet balance is calculated and not stored | Stored per shard in `gl_account_shards.current_balance`; it can drift and shard repair rebuilds it | `core-back/engine/ledger/ShardRepair.ts`, `adminLedger.ts` shard payload |
| `l-m6-6`, `c-l-m6-6-1`, `q-m6-019`, `lab-cashout-adjustments` | Two Finance people; the final subtraction is `SUBTRACTED` | One Finance user with `cashout:review`; the flow ends at `COMPLETE` (legacy `SUBTRACTED` is never written) | `core-back/engine/governance/GovernanceExecution.ts` (`executeCashout`), `admin.ts` (`/cashouts/:id/process`) |
| `l-m6-7`, `q-m6-025`, `q-m6-027`, `q-m6-028`, `c-l-m6-7-*`, `drill-dispute` | Nothing moves until the checker; the ceiling only blocks the outcome | The intake reserve posts before the checker when it fits the ceiling; an over-ceiling reserve is held with a P1 case, and the outcome waits for Finance | `core-back/engine/governance/GovernanceExecution.ts` (`openDisputeWithDraftedAdjustment`, reserve block), `LedgerPoster.ts` (`CHARGEBACK_RESERVE_AND_LOST` RESERVE) |
| `l-m6-7`, `l-m7-3`, `q-m7-116` | A chargeback on an AML hold is taken from the hold | It is not; it debits the merchant wallet and platform income, and the AML case resolves the hold | same `CHARGEBACK_RESERVE_AND_LOST` template; no `AML_HOLD` leg |
| `l-m7-2`, `q-m7-101` | Structuring checks run in a daily batch on local data | The start-of-payment guard loads the rules and a bounded 24-hour SQL window (count, total, structuring amounts) | `core-back/engine/guards/AttemptGuardPipeline.ts` lines 649-679 |
| `l-m6-2`, `l-m6-5`, `l-m6-6`, `l-m9-2`, `q-m6-005`, `q-m9-107`, `c-l-m9-2-1`, `lab-runbook-drill`, `lab-cashout-adjustments` | Drift stops automatic payouts | The invariant worker opens a P1 case; it does not stop cash-outs or payouts automatically, so the Academy tells staff not to cash out while the cause is unknown | `core-back/engine/workers/LedgerInvariantWorker.ts` |
| `l-m5-4`, `q-m5-*`, `lab-runbook-drill` | The button is called Bulk Inquiry | The built label is **Inquire selected**; the Academy uses that label and calls the concept "inquiry" | `admin-front/src/pages/operator-cases/index.tsx:1077` |
| `l-m6-6`, `lab-cashout-adjustments` | A **Reverse** button proposes an offsetting adjustment | The Adjustments screen has no Reverse action (only **Reverse commission**); propose an offsetting adjustment from the form | `admin-front/src/pages/adjustments/index.tsx` |
| `l-m4-2`, `q-m4-012`, `c-l-m4-2-2` | Request information pauses the SLA | The endpoint stores a pause marker, but `JoinRequestExpiryWorker` still expires overdue `INFO_REQUESTED` requests; the Academy says the clock does not pause today | `core-back/engine/workers/JoinRequestExpiryWorker.ts`, `core-back/api/internal/admin.ts` (`/join-requests/:id/request-info`) |
| `l-m7-3`, `q-m7-107`, `lab-compliance-desk` | A suppression must have an expiry and hides future matches | The API asks for an expiry, but the current screening path does not consult the stored suppression; the Academy says not to rely on it | `core-back/api/internal/admin.ts` (disposition route), `guide_system_design_and_content.md` (`b09-03`) |
| `lab-approval-desk` | Every decision needs a reason | A reason is required for rejection; approval needs the review and a note of what was checked | `core-back/engine/governance/ApprovalService.ts` (`rejectRequest`), `admin-front/src/pages/approvals/index.tsx` |
| `lab-kyb-desk` | **Approve** / **Reject** could be read as document-review buttons | The lab now says **Approve the join request** / **Reject the join request**; document review uses **Accept** / **Reject** / **Save decision** | `admin-front/src/pages/kyb/components/KybReviewDialog.tsx` |
| `l-m7-3`, `q-m7-112` | AML SLAs are 4 h / 1 / 3 / 5 business days | 4 / 24 / 72 / 120 calendar hours | `core-back/engine/governance/GovernanceExecution.ts` (`slaHoursForSeverity`) |
| `l-m7-4`, `q-m7-119` | Three report types | Four, including `INCIDENT` | `core-back/api/internal/admin.ts` report type enum |
| `l-m3-3`, `c-l-m3-3-2`, `q-m3-006`, `l-m7-4`, `q-m7-117` | An unratified emergency suspension is never reversed | It stays in force through a 48-hour grace, then lifts automatically and the approval becomes `EXPIRED` | `core-back/engine/workers/deadlines/emergencyDeadlines.ts` |
| `l-m3-1`, `l-m3-3` | Every velocity rule change needs two people | Creating or tightening a velocity rule is direct with `velocity:write`/`compliance:write`; deactivation creates an approval | `core-back/api/internal/admin.ts` velocity-rule routes |
| `l-m3-1`, `l-m7-3` | AML case and rule makers are the default COMPLIANCE role | FINANCE/COMPLIANCE/MLRO are checker-only defaults; the Academy names the required `aml:review`/`compliance:write`/`aml:write` authority instead | `core-back/scripts/createAdminPlan.ts` (`ROLE_FLAGS`), `core-back/api/internal/admin.ts` (`assertAmlWrite`) |
| `l-m8-1`, `l-m8-3`, `l-m8-5`, `q-m8-010`, `c-l-m8-5-2` | Only partner faults count toward the breaker | The error map decides per error (`counts_toward_breaker`); customer errors and 429 are excluded | `core-back/engine/routeHealth/decision.ts`, `GatewayHealthWorker.ts` |
| `l-m8-5`, `l-m9-1` | Route resume/pause needs approval | Direct with `gateway:write`, audited, no approval queue | `core-back/api/internal/admin.ts` (`POST /routes/:id/state`) |
| `l-m9-1`, `l-m9-2`, `q-m9-112`, `lab-runbook-drill` | Stored messages are replayed; credentials need two-person approval; `CREDENTIAL_CHECK` is a button | No core replay button; ask the partner to resend. `credential:write` updates the set directly, and the UI action is **Rotate secrets** + **Verify**; there is no gateway-credential overlap | `core-back/api/internal/admin.ts` credential routes; `admin-front/src/pages/credential-sets/index.tsx`; no core replay route |
| `l-m10-3`, `l-m10-4`, `q-m10-101`, `q-m10-107`, `c-l-m10-4-2`, `drill-pitr-recovery`, `l-m10-5` | 12 deployment steps; DB never shares a host; only four certificates; three drill checks; `AvScanWorker` | 14 steps; roles may share a host; one CA plus core, edge and service certificates; object-storage drill check when configured; `ObjectStorageMaintenanceWorker.runAvScanBatch` | `deploy/deploy.ts` steps 1-14, `deploy/lib/pkiManager.ts`, `restoreDrillRunner.ts`, `ObjectStorageWorkers.ts` |
| `drill-webhook-replay`, `drill-breaker`, `drill-dispute`, `lab-runbook-drill` | Non-existent UI labels (`Trigger Webhook Replay`, `Full Outage 503`, upstream chargeback button) and a replay step | **Compose webhook** / **Duplicates** / **Forge signature**, **Full outage**, **Open dispute**, and the credential-check step | `fake-rails-front/src/components/WebhookComposerModal.tsx`, `pages/chaos-matrix/index.tsx` |

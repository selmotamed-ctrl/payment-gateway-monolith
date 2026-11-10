---
id: core.governance
title: Governance and Compliance
status: partial
confidence: high
last_verified: 2026-11-10
verified_against: working-tree 2026-11-10
code:
  - core-back/engine/governance/ApprovalService.ts
  - core-back/engine/governance/GovernanceExecution.ts
  - core-back/engine/governance/DetailChangeService.ts
  - core-back/engine/compliance/ReportingRuleEvaluator.ts
  - core-back/engine/compliance/reporting/XsdCompiler.ts
  - core-back/engine/compliance/reporting/XsdXmlGenerator.ts
  - core-back/engine/compliance/reporting/XsdXmlValidator.ts
  - core-back/engine/compliance/reporting/ReportGenerationService.ts
  - core-back/engine/compliance/reporting/baselineSchemas.ts
  - core-back/lib/xlsx/regulatoryWorkbook.ts
  - core-back/lib/xlsx/template.ts
  - core-back/lib/docx/regulatoryDocx.ts
  - core-back/lib/filing/adapters.ts
  - core-back/engine/compliance/incidents.ts
  - core-back/engine/compliance/OperatorCaseSink.ts
  - core-back/engine/compliance/tippingOff.ts
  - core-back/engine/guards/AmlRuleEngine.ts
  - core-back/engine/guards/MerchantScreeningService.ts
  - core-back/engine/guards/ScreeningProvider.ts
  - core-back/engine/guards/AttemptGuardPipeline.ts
  - core-back/lib/approvalQueue.ts
  - core-back/lib/joinRequestOnboarding.ts
  - core-back/lib/kybReview.ts
  - core-back/lib/merchantOps.ts
  - core-back/lib/auth/confidentialAccess.ts
  - core-back/api/middleware/makerCheckerGuard.ts
  - core-back/api/internal/admin.ts
  - core-back/api/internal/merchant.ts
  - core-back/prisma/schema.prisma
  - core-back/lib/cashoutBalance.ts
  - core-back/lib/kybScan.ts
  - core-back/lib/auth/merchantAuthorities.ts
  - core-back/lib/commerceStatus.ts
  - core-back/api/internal/adminCommerce.ts
design_sources:
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#part-ix-platform-interfaces-onboarding-governance-compliance-program
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#15
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#16
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#17
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#18
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#19
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#20
  - design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md#9
  - design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md#13
  - design/10-fixes/_0001_operator_cases.md
  - design/11-automation/declarative_regulatory_reporting_engine_final_design.md
tests:
  - core-back/test/gaps/gap-015-018-regressions.test.ts
  - core-back/test/engine/governance.test.ts
  - core-back/test/governance-execution.test.ts
  - core-back/test/approval-queue.test.ts
  - core-back/test/onboarding-four-eyes.test.ts
  - core-back/test/kyb-review.test.ts
  - core-back/test/screening-and-caps.test.ts
  - core-back/test/aml-resolution-finalization.test.ts
  - core-back/test/regulatory-report-lifecycle.test.ts
  - core-back/test/reporting-rule-evaluator.test.ts
  - core-back/test/reporting-xsd-xlsx.test.ts
  - core-back/test/refund-three-phase.test.ts
  - core-back/test/operator-cases.test.ts
  - core-back/test/gateway-inquiry-schedules.test.ts
  - core-back/test/phase4-onboarding-aml-disputes-recon.test.ts
  - core-back/test/exhaustive/07-workflows/onboarding-and-aml.test.ts
  - core-back/test/security-regressions/h3-admin-users-and-approvals.test.ts
  - core-back/test/security-regressions/h4-cashout.test.ts
  - core-back/test/security-regressions/h1h2-authz.test.ts
  - core-back/test/security-regressions/m9-m12-upload-kyb.test.ts
  - core-back/test/admin-commerce.test.ts
  - core-back/test/security-regressions/commerce-status-enforcement.test.ts
gaps:
  - "`executeApprovalSubject` has no handler for `APPLICATION`, `CASHOUT_REQUEST`, or `PLATFORM_SETTING`; an application-sensitive change cannot be executed through the approvals route."
  - "`PUT /admin/settings` writes platform settings directly without an approval request or maker-checker."
  - "Cash-out processing is a direct single-actor route; no `CASHOUT_REQUEST` approval row is created."
  - "The approval lifecycle deviates from the design because proposals go straight to `PENDING_REVIEW`, rejection ends in `REJECTED` rather than returning to `DRAFT`, and emergency ratification does not re-execute through a checker."
  - "Per-domain checker enforcement is incomplete; `approval:check` is not domain-scoped, and AML approvals are not gated by the confidential-AML check."
  - "`DetailChangeService` is not wired into the admin routes; changes are written directly and coverage is narrow."
  - "AML layer L4 deferred/batch monitoring, rule dry-run, and emergency tightening with 24-hour ratification are not implemented."
  - "Retention is opt-in and does not cover AML cases, screenings, KYB documents, or regulatory reports."
  - "The format-aware reporting engine is implemented for provisional XML/XLSX generation, but no FIU-confirmed XSD or CBL workbook has been uploaded; the baseline schemas/templates remain PROVISIONAL and the filing gate blocks them."
  - "INC, narrative export to a separate DOCX/PDF, and external authority filing adapters are deferred."
  - "The XSD/XLSX visual mapper is a first-pass registry/JSON editor; per-element drag/drop mapping, code-list translation UI and schema version cloning remain."
  - "Residual (GAP-015): an AML case does not carry the escrow journal entry id any more (`hold_journal_entry_id` is not written; release/void look the escrow up by the attempt), and a merchant-direct held attempt has no escrow at all."
  - No real malware scanner; KYB scanning is content sniffing only (TRACKER GAP-025).
  - "Residual (GAP-018): two concurrent uploads of the same statement bytes for one source race past the application-level duplicate check and the loser hits the unique index as a raw Prisma `P2002` instead of the friendly duplicate response."
---

# Governance and Compliance

## 1. Purpose and scope

This part owns the four-eyes approval wrapper, governance execution handlers, merchant onboarding and KYB, AML screening and rules, AML cases and hold escrow, disputes and adjustments, cash-outs, regulatory reporting, operator cases and inquiry schedules, confidentiality/tipping-off controls, and the authority model.

It does not own the ledger templates themselves (see `core.ledger`), the rail engine, or the payment lifecycle. It calls those subsystems inside its transactions. It also does not own the frontend approval screens; it defines the server-side contracts they use.

## 2. Design intent (extracted and synthesized from ./design)

The design defines ten roles (`GATEWAY_ADMIN`, `SECURITY_ADMIN`, `FINANCE`, `OPERATOR`, `COMPLIANCE`, `MLRO`, `SUPPORT`, `MERCHANT_ADMIN`, `MERCHANT_STAFF`, `MERCHANT_CASHIER`), a closed `authorities_map` catalogue, and a single `approval_requests` wrapper for every sensitive action. The intended lifecycle is `DRAFT -> PENDING_REVIEW -> APPROVED -> EXECUTED`, with a rejection returning to `DRAFT`. Maker and checker must differ, and the database enforces this with a `CHECK` constraint and an update trigger.

The design's four-eyes matrix covers:

| Action | Intended maker | Intended checker |
| :--- | :--- | :--- |
| Adjustment (refund, chargeback, manual credit/debit, correction) | `FINANCE`, `OPERATOR`, or system drafting | `FINANCE`, different user |
| Cash-out completion/subtraction | `FINANCE` | `FINANCE`, different user |
| Commission profile create/change | `FINANCE` | `FINANCE` or `SECURITY_ADMIN` |
| Sensitive merchant fields | `OPERATOR`, `COMPLIANCE`, or merchant request | `COMPLIANCE` or `FINANCE` by field domain |
| Sensitive application fields | merchant admin or operator | operator or compliance |
| Velocity and AML rules | `COMPLIANCE`/`FINANCE` | `MLRO` for AML; `SECURITY_ADMIN`/`FINANCE` for velocity |
| AML case release/void/freeze | `COMPLIANCE` | `MLRO` |
| Regulatory report submission | `COMPLIANCE` | `MLRO` |
| Join-request decision | `OPERATOR`/`COMPLIANCE` | per `join_request.four_eyes_policy` |
| Merchant suspension | `OPERATOR`/`COMPLIANCE` | emergency ratification within 24 h |
| Merchant reinstatement | `OPERATOR`/`COMPLIANCE` | `COMPLIANCE`/`MLRO`, never emergency |
| Gateway version go-live and credential changes | `GATEWAY_ADMIN` | `SECURITY_ADMIN` |
| Admin user/role/authority changes | `SECURITY_ADMIN` | another `SECURITY_ADMIN` |
| `platform_settings` compliance keys | `COMPLIANCE`/`FINANCE` | `MLRO`/`SECURITY_ADMIN` |

The design also specifies the onboarding state machine, KYB document controls, field classification and pending-change semantics, the seven-layer AML program, declarative AML rules, dispute intake and automated drafting, regulatory reporting as configuration, operator cases, and strict no-tipping-off rules.

## 3. As-built architecture

### 3.1 Authority model

Authentication is bearer-token based (`core-back/api/middleware/authDoubleCheck.ts`). A session resolves the user's `authoritiesMap`; an API token resolves its `scopes` and optional IP allowlist. Empty authorities are rejected for a session. `requireAuthorities` accepts a request if the principal has any one of the listed authorities or `*`; it is an OR check, not an AND check.

`actorFromRequest` requires a human user, rejects the `SYSTEM_AUTOMATION` role, and marks the actor as a checker only when `approval:check` is present (`core-back/api/middleware/makerCheckerGuard.ts:13`). `assertCheckerIsNotMaker` is reused by the admin routes.

The seeded production roles are inconsistent with the design matrix: only `FINANCE` receives `approval:check` and `approval:write`; `COMPLIANCE`, `MLRO`, `OPERATOR`, `SECURITY_ADMIN`, and `SUPPORT` do not (`core-back/prisma/seed.ts:160`). The approval route therefore cannot be exercised as designed by the seeded compliance roles without a custom authority grant.

### 3.2 Approval lifecycle as implemented

`ApprovalService` (`core-back/engine/governance/ApprovalService.ts:270`):

- `proposeApproval` validates the maker, JSON patch shape, and base version, then creates the row directly in `PENDING_REVIEW` (not `DRAFT`); `DRAFT` exists in the enum and UI filters but most producers do not use it.
- `approveRequest` allows a request in `PENDING_REVIEW` or `APPROVED`, rejects maker = checker, verifies `baseVersion`, applies the patch callback, executes the handler callback, and sets `EXECUTED` (or `APPROVED` when `executeImmediately === false`).
- `rejectRequest` requires a reason and sets `REJECTED`; it does not return the request to `DRAFT`.
- `emergencyExecuteWithRatification` executes immediately without a checker, records `EMERGENCY_RATIFICATION`, and sets a ratification deadline. The ratifier only records `checkerUserId` and a note; the request is already `EXECUTED`, and the ratification does not re-run the execution.
- `SYSTEM_AUTOMATION` is rejected as a checker and as a human actor.

The actual admin approve route (`core-back/api/internal/admin.ts:6014`) is more specific than the service:

- requires `approval:check` (via `assertCheckerAuthority`) and either `approval:check` or `approval:write` in the route guard;
- permits `PENDING_REVIEW` or `DRAFT`;
- rejects expired requests; since AUTO-05 an approval nobody decided before `expires_at` is also CLOSED by `ExpiryHousekeepingWorker` into the final state `EXPIRED` (reason `EXPIRED: not decided before <time>`, audit `APPROVAL_REQUEST_EXPIRED`, maker notified), which releases its subject exactly like a rejection (a join request back to `IN_REVIEW`, an operator case back to `IN_PROGRESS`) so a stale approval no longer locks the subject; the approve and reject routes refuse an `EXPIRED` request through the pending-state claim (`APPROVAL_NOT_PENDING`), not only through the expiry clock;
- enforces maker ≠ checker;
- adds a join-request admin-assisted maker check and a merchant payload checker-domain check;
- special-cases `BACKUP_POLICY` through `executeBackupPolicyApproval` (claim first, then the backup daemon; shared with `PUT /system/backups/policy`);
- queues `ADJUSTMENT` execution as a background job and executes everything else through `executeApprovalSubject` in one transaction;
- records a decision checklist audit row.

### 3.3 Execution coverage by subject type

`executeApprovalSubject` (`core-back/engine/governance/GovernanceExecution.ts:3035`) dispatches only the following subject types:

| Subject type | Handler | Notes |
| :--- | :--- | :--- |
| `AML_CASE` | `executeAmlCaseResolution` | Release/void posts ledger, finalises attempt and slot; `MERCHANT_DIRECT` is case-only. |
| `OPERATOR_CASE` | `executeOperatorCaseResolution` | `MARK_SUCCEEDED`, `MARK_FAILED`, `CLOSE_CASE`; may post confirmation or release a slot. |
| `ADJUSTMENT` | `executeAdjustment` | Chargeback, refund, correction, manual credit/debit; refund runs three phases around the gateway call. |
| `REGULATORY_REPORT` | `executeRegulatoryReportApproval` | Sets report to `APPROVED`; submission is a separate route. |
| `REPORTING_RULE` | `executeReportingRuleApproval` | Promotes a rule to `CONFIRMED`. |
| `AML_RULE` | inline handler | Activates the rule and increments its version. |
| `JOIN_REQUEST` | `activateApprovedJoinRequest` or inline rejection | Approval activates merchant and KYB; rejection sets merchant `REJECTED` when still pending. |
| `MERCHANT` | `executeMerchantPatch` / `executeMerchantLifecycle` | Sensitive field patch, suspend, emergency suspension, reinstate, close. |
| `COMMISSION_PROFILE` | `executeCommissionProfileExpiry` | Only the expiry lifecycle is executable; create/change does not create an approval. |
| `VELOCITY_RULE` | `executeVelocityRuleDeactivation` | Only deactivation is executable; create is direct. |
| `USER` | `executeUserAuthorityChange` | Applies role/authority map. |
| `GATEWAY_VERSION` | `activateGatewayVersionInTransaction` | Runs the go-live gates and supersedes the previous live version. |

**Missing handlers:** `APPLICATION`, `CASHOUT_REQUEST`, and `PLATFORM_SETTING` have no branch. The merchant application route does create `APPLICATION` approval rows for sensitive changes (`core-back/api/internal/merchant.ts:1537`), but approving one fails with `NO_EXECUTABLE_SUBJECT`. `CASHOUT_REQUEST` appears in the approval-domain map but no cash-out approval is created. `PLATFORM_SETTING` appears in the settings domain and the schema links settings to approvals, but `PUT /admin/settings` writes new versions directly (`core-back/api/internal/admin.ts:16132`).

Other subject types that appear in the queue/domain map but have no `executeApprovalSubject` branch are `KYB_DOCUMENT`, `GATEWAY`, and `CREDENTIAL_SET`. `BACKUP_POLICY` is handled by a special branch in the approve route rather than by the dispatcher.

The dispatcher enforces maker ≠ checker and rejects system automation, but it does not re-check a domain-specific role for AML, regulatory reporting, user administration, or gateway version go-live. Within the dispatcher, only chargeback execution checks that the checker is a finance checker (`assertFinanceChecker` in `GovernanceExecution.ts`).

### 3.4 Detail change log

Admin merchant descriptive edits write `detail_change_logs` rows directly inside the update transaction (`core-back/api/internal/admin.ts:5369`). Emergency suspension writes status field rows tied to the approval (`admin.ts:5511`). Approved sensitive merchant patches write one row per JSON Patch operation inside `executeMerchantPatch`, with the checker as actor, the approval id as request id, and source `ADMIN` (`GovernanceExecution.ts:942`).

`DetailChangeService` implements recursive JSON diffing and optional redaction, but no production route constructs or calls it. The implemented log therefore has narrower coverage than the design's “every edit, with source/request/IP” semantics, and the actor recorded for a sensitive change is the checker rather than the maker.

### 3.5 Onboarding and KYB

The join-request state machine is implemented in `core-back/api/internal/admin.ts`:

- admin-assisted creation starts in `DRAFT`; submit performs profile/owner/document checks, runs onboarding screening, computes the four-eyes decision, refreshes duplicate flags, and sets `SUBMITTED`, `IN_REVIEW`, or a screening outcome;
- assign moves to `IN_REVIEW`;
- request-info pauses the SLA by storing `slaPausedAt` and `slaRemainingSeconds` and sets `INFO_REQUESTED`;
- decide enforces readiness, blocks open confirmed-match cases, creates an approval when `fourEyesRequired`, or executes approval/rejection inline when it is not;
- withdraw invalidates a pending approval and sets `WITHDRAWN`;
- `JoinRequestExpiryWorker` expires abandoned drafts and overdue reviews.

Readiness (`core-back/lib/joinRequestOnboarding.ts:249`) requires the canonical checklist, required accepted and unexpired documents, active beneficial owners meeting the ownership threshold, owner screening status, a non-blocked screening result, and a payout bank; it reports `approvalPending` separately rather than adding it to `blockers`. Duplicate detection compares tax id, registration, phone, and e-mail and hashes the payout account, owner national id, and document SHA-256 (`joinRequestOnboarding.ts:84`).

The four-eyes decision (`core-back/api/internal/merchant.ts:358`) reads `join_request.four_eyes_policy` and supports `ALWAYS`, `RISK_BASED`, and `NEVER`. Risk-based triggers include high risk tier, any screening match list, PEP owners, large ownership share, high-risk category, previous rejection, duplicate/related flags, payout owner mismatch, and expected volume above threshold.

KYB controls (`core-back/lib/kybReview.ts`) implement expiry state, actionable-document rules, duplicate justification, payout-holder name comparison, configurable required documents, refresh policy, and KYB status recomputation. `KybExpiryWorker` marks expired documents, queues 30/7-day notices, suspends after the grace period, starts periodic revalidations, and expires overdue revalidation requests.

### 3.6 AML program

The seven design layers map to code as follows:

| Layer | Actual implementation |
| :--- | :--- |
| L1 onboarding screening | `MerchantScreeningService.submitOnboarding`, called from join-request submit; confirmed match raises a case and blocks activation; provider error fails closed. |
| L2 ongoing screening | `PeriodicScreeningWorker` re-screens active merchants on the configured interval, refreshes list versions, raises one confirmed-match case and suspends the merchant. |
| L3 transaction-time posture | `AttemptGuardPipeline` checks merchant status, velocity, local watch-list, and AML rules inside the attempt-creation transaction; a confirmed sanctions match or a `BLOCK` rule creates a terminal blocked attempt. |
| L4 transaction monitoring | AML rules are evaluated at attempt initiation. There is no deferred confirmation pass and no daily batch analytics for structuring/fan-in/fan-out. |
| L5 case management | `aml_cases` with severity, SLA, reviewer, confidential flag; resolution is proposed by a confidential reviewer and approved by a different checker; release/void post the ledger and finalise the attempt. |
| L6 regulatory reporting | `ReportingRuleEvaluator` creates DRAFT reports on settlement; `RegulatoryReportWorker` drafts scheduled returns; the schema registry and `ReportGenerationService` generate validated XML/XLSX outputs. Manual drafting, request-approval, payload/narrative editing, submit and acknowledge routes exist. Confirmed FIU/CBL schemas and an external authority adapter are still missing. |
| L7 record keeping | Audit rows, rule versions, detail changes, and the retention worker. Retention is opt-in and incomplete for AML evidence. |

Screening is a provider interface (`ScreeningProvider`) with Arabic normalization, name similarity, internal watch-list provider, mock provider, and a cached provider. `MerchantScreeningService` persists `aml_screenings` and `aml_screening_matches` with list versions and input hashes, applies owner screening status, and raises a confirmed-match case only. Potential matches remain in the screening queue for disposition.

The AML rule engine (`core-back/engine/guards/AmlRuleEngine.ts`) supports `SINGLE_AMOUNT`, `CUMULATIVE_WINDOW`, `STRUCTURING`, `RISK_TIER`, `COUNTERPARTY_COUNTRY`, `RAIL`, and `MERCHANT_DIRECT_AMOUNT`; actions are `HOLD`, `FLAG`, `BLOCK`, `CASE_ONLY`. Severity starts at the rule base, correlates with velocity, raises for high merchant tier, volume multiple, another open case, confirmed sanctions, and potential PEP. On a `HOLD`, the guard only records the decision (`AML_HOLD_PENDING_CAPTURE`) and the `AML_HOLD` substatus; it does NOT post anything, because no money has been captured yet. The escrow is booked by the engine after a verified gateway capture (see `core.engine`).

AML case resolution (`GovernanceExecution.ts:1470`):

- `RELEASE` posts `AML_HOLD_AND_RELEASE` release lines only when the verified-capture escrow exists (otherwise `409 AML_HOLD_CAPTURE_NOT_VERIFIED`), sets attempt `SUCCEEDED`, clears the `AML_HOLD` substatus, commits the link slot.
- `REJECT` posts `AML_VOID` only when an escrow exists; a not-yet-captured hold is simply failed with no posting, and the attempt substatus becomes `AML_VOID`.
- `ESCALATE` leaves the money in `AML_HOLD`, sets `ESCALATED_STR`, and opens a P1 operator case.
- `HOLD` freezes the case without moving money.
- `MERCHANT_DIRECT` cases never post.

### 3.7 Disputes and adjustments

Dispute intake is exposed as `POST /admin/disputes`; the route queues an `ADJUSTMENT_EXECUTION` job with `kind: DISPUTE_INTAKE` and answers `202`. The worker transaction calls `openDisputeWithDraftedAdjustment` (`core-back/engine/workers/BackgroundJobHandlers.ts:359`), which:

1. dedupes on `(gatewayId, externalDisputeRef)`;
2. locks the attempt, caps the chargeback to the unrefunded amount;
3. creates the dispute;
4. creates a `CHARGEBACK` adjustment in `PENDING_REVIEW` and a `SYSTEM_AUTOMATION` approval request;
5. posts the reserve leg for non-`MERCHANT_DIRECT` settlements;
6. writes audit rows.

There is no webhook or statement dispute-intake wiring in `DynamicRailEngine` or reconciliation; the admin manual route is the implemented intake path.

Adjustment execution supports `REFUND` (three phases: claim, gateway refund, finalize), `CHARGEBACK` (won/lost/insufficient), `CORRECTION` (fee variance), `MANUAL_DEBIT`/`CASHOUT_SUBTRACTION` (cash-out template), and `MANUAL_CREDIT` (internal confirmation with zero commission). Chargebacks require a finance checker; a missing dispute outcome or a breach of `negativeBalanceCeiling` holds the adjustment and opens an operator case. Refunds are capped to the unrefunded settled amount and are idempotent on the adjustment id. The refund template follows the ownership mode of the payment (`refundScenarioFor`, see `core.ledger`): a `MERCHANT_DIRECT` refund only reverses the commission recognition (`Dr PLATFORM_INCOME` / `Cr COMMISSION_RECEIVABLE`) and never debits the wallet or credits treasury; with nothing to reverse the adjustment is `EXECUTED` with no journal entry.

### 3.8 Cash-outs

A merchant creates a `CashoutRequest` in `PENDING` with a destination bank snapshot (`core-back/api/internal/merchant.ts:1828`). The admin `POST /admin/cashouts/:id/process` route calls `executeCashout` directly (`core-back/api/internal/admin.ts:14219`). `executeCashout` creates a `CASHOUT_SUBTRACTION` adjustment, posts `CASHOUT` (`Dr MERCHANT_WALLET` / `Cr TREASURY`), sets the request to `COMPLETE`, and writes audit. Rejection creates a rejected adjustment and sets `REJECTED`.

No `CASHOUT_REQUEST` approval row is created and there is no `PENDING -> PROCESSING -> COMPLETE -> SUBTRACTED` transition; `PROCESSING` and `SUBTRACTED` exist in the enum but the execute path writes `COMPLETE` directly on approval. The route requires `cashout:review` or `finance:write`, but one actor can process a request without a recorded second approval.

### 3.9 Regulatory reporting

The reporting engine is now format-aware (`design/11-automation/declarative_regulatory_reporting_engine_final_design.md`). A report has a canonical encrypted JSON payload and zero or more derived outputs: XML validated against a compiled XSD, and XLSX generated from a declarative workbook/template. One schema registry (`RegulatoryReportSchema`) and per-(authority, report type, report code, format) default bindings resolve the contract; rules can pin a schema per format. Every schema has a lifecycle (`DRAFT`, `PROVISIONAL`, `PENDING_APPROVAL`, `CONFIRMED`, `SUPERSEDED`, `ARCHIVED`) and is promoted through a `REGULATORY_REPORT_SCHEMA` maker-checker approval.

`ReportingRuleEvaluator` evaluates a settled attempt against effective rules. It now creates every report as `DRAFT` (with `reportCode` and `requiredOutputFormats`) and calls the generation service; it never creates a `PENDING_CHECKER` report without an approval. `RegulatoryReportWorker` drafts the scheduled returns as `DRAFT`, stores the encrypted payload and its SHA-256, then generates every required output. The regulatory aggregates filter `payment_attempts.env = 'LIVE'`, so sandbox traffic cannot enter a filing. The output generator:

- builds a format-neutral `CanonicalReportContext` (institution, report, merchant, wallet, transactions, AML case, indicators, aggregates, narrative, pending sections);
- for XML, compiles the uploaded `.xsd` into a safe AST, walks it in `xs:sequence` order, applies the mapping blueprint and `TransformPipeline`, escapes values, and validates cardinality, types, facets, enums and cross-field assertions;
- for XLSX, loads an uploaded workbook or generates the declared workbook server-side with `exceljs`, fills mapped rows/totals/narrative sections, guards formula injection, and validates required columns, totals and narrative sections;
- encrypts and hashes the result in `RegulatoryReportOutput` (revision, schema version, validation status `NOT_GENERATED`/`PROVISIONAL_SCHEMA`/`VALIDATED`/`INVALID`, errors).

Manual report creation (`createRegulatoryReportViaApproval`) now encrypts the payload with `VaultContextCipher("reporting-payload")`; the read path understands both the Vault envelope and legacy plaintext. Existing DRAFT reports can be sent for approval through `POST /aml/reports/:id/request-approval`; rejection/expiry returns them to `DRAFT`. Submission enforces the format-aware gate: every `requiredOutputFormats` entry must have a current `VALIDATED` output backed by a `CONFIRMED` schema/template, and a `PROVISIONAL_SCHEMA`/`INVALID`/missing output blocks filing. XLSX-only returns such as PSP-M and AML-Q have no XSD requirement; XML returns such as STR/LTR still require a confirmed XSD. Acknowledgement records the authority decision and timestamp/reason.

The admin surface includes the report payload/output endpoints, output download (hash verified), schema registry/compile/simulate/promote/default-binding routes, schema detail/update/clone/validate, context catalog and sample context, code-list preview, template download/upload, workbook preview, per-rule schema bindings, report requirements, and the Reporting Studio page at `/aml/reporting-studio` with an XML element mapper, code-list translator, XLSX workbook builder, draft save with revision conflict, clone-as-new-version and read-only lifecycle states. Outputs are bound to the payload SHA-256; changing the payload marks current outputs stale, and filing refuses stale/missing/provisional/invalid outputs. The baseline seeds are provisional: `cbl-goaml-str-v1`, `cbl-goaml-ltr-v1`, `cbl-psp-m-v1`, `cbl-aml-q-v1`, `cbl-aml-a-v1`, and `cbl-goaml-ltr-xlsx-v1`. No FIU XSD or CBL workbook is present in the repository, so they remain `PROVISIONAL` and cannot be filed. INC and separate narrative DOCX/PDF rendering are deferred.

### 3.10 Operator cases and inquiry schedules

`PrismaOperatorCaseSink` opens an operator case at most once per `(attemptId, kind)` while the case is `OPEN`, `IN_PROGRESS`, or `PENDING_CHECKER` (`core-back/engine/compliance/OperatorCaseSink.ts`). The engine opens cases for `LATE_SUCCESS`, `CONFLICT`, expiring attempts, and other flow findings.

Operator resolution is a maker action: `POST /admin/operator-cases/:id/resolve` creates an `OPERATOR_CASE` approval and sets the case to `PENDING_CHECKER`; the approval executes `MARK_SUCCEEDED`, `MARK_FAILED`, or `CLOSE_CASE`. Bulk inquiry schedules a persisted `GatewayInquirySchedule` after eligibility checks (case state, attempt status, terminal state, gateway status-check support). Cancellation, run-now, and retry update the schedule and the attempt's `nextCheckAt`; the poll worker owns execution and schedule reconciliation.

### 3.11 Tipping-off and confidentiality

`core-back/engine/compliance/tippingOff.ts` rejects non-`INTERNAL` notification templates whose subject or body references AML variables, redacts AML-like payload keys for non-`INTERNAL` classes, and renders templates. The notification worker calls `assertNoTippingOff` before delivery, so a template that would tip off a merchant is recorded as a delivery failure (retried up to the cap) rather than sent.

AML reads are gated by `hasConfidentialAmlAccess`: `COMPLIANCE`/`MLRO` roles pass, or a principal with `aml:read`/`aml:write` passes. Every `/admin/aml/*` route calls `assertConfidential`. Reporting submission/acknowledgement additionally calls `assertReportingAuthority`. This gate is not applied to the generic `/admin/approvals/:id` route, so a principal with `approval:check` can approve an `AML_CASE` without confidential AML access.

## 4. Contracts and invariants

1. Maker and checker must be different users. The database has `approval_requests_checker_not_maker_insert` plus an update trigger; the application also checks.
2. `SYSTEM_AUTOMATION` can be a maker (for dispute drafts) but can never be a checker, ratifier, or human actor.
3. An approval can only execute from `DRAFT`/`PENDING_REVIEW` in the admin route, must not be expired, and a base-versioned approval must match the subject's current version or fail with `BASE_VERSION_MISMATCH`.
4. A rejection requires a reason and never executes.
5. A successful approval must execute its subject atomically with the state change where the handler supports it. Adjustments are queued; the job uses the checker recorded on the approval and never invents one.
6. AML release/void is the only writer for an `AML_HOLD` attempt. The expiry sweeper and customer cancel exclude held attempts.
7. A chargeback execution requires a finance checker; a chargeback without a known outcome or above the negative-balance ceiling is held, not posted.
8. A refund cannot exceed the unrefunded settled amount. A repeated refund is idempotent through the adjustment state and `(refType, refId)`.
9. `PROVISIONAL` reporting rules can create internal drafts but can never produce a live filing; submission requires `APPROVED` and a `CONFIRMED` rule.
10. Non-`INTERNAL` notification templates cannot reference AML variables.
11. AML data is restricted to confidential roles at the `/aml/*` routes; support cannot read it.

## 5. Data / API / config / deployment surface

### Schema

- `ApprovalRequest` (`approval_requests`): subject type/id, payload diff, mode, base version, expiry, ratification deadline, maker, checker, state, rejection reason, risk note.
- `JoinRequest`, `KybDocument`, `KybRevalidationRequest`, `BeneficialOwner`: onboarding state, documents, owners, screening status, revalidation.
- `AmlScreening`, `AmlScreeningMatch`, `AmlRule`, `AmlCase`: screening results, match dispositions, rule versions, severity/SLA, hold journal entry.
- `Dispute`, `Adjustment`, `CashoutRequest`: intake, drafted/executed adjustments, cash-out state.
- `ReportingRule`, `RegulatoryReport`, `RegulatoryReportSchema`, `RegulatorySchemaDefaultBinding`, `RegulatoryRuleSchemaBinding`, `RegulatoryReportOutput`: thresholds, status, encrypted payload, required formats, schema/template versions, derived XML/XLSX outputs, submission reference, approval.
- `OperatorCase`, `GatewayInquirySchedule`, `DetailChangeLog`, `AuditLog`, and `PlatformSetting` (with approval link and version).

### Admin routes (representative)

- Approvals: `GET /admin/approvals`, `/summary`, `/export`, `/:id`, `POST /:id/approve`, `/:id/reject`.
- Onboarding: `/join-requests` including `submit`, `decide`, `assign`, `request-info`, `checklist`, `screening/retry`, and `/kyb-documents/:id/review`, `request-replacement`, `request-revalidation`.
- AML: `/aml/screenings`, `/aml/matches/:id/disposition`, `/aml/cases`, `/:id/propose`, `/aml/rules`, `/aml/reporting-rules`, `/:id/promote`, `/aml/reports`, `/:id/payload`, `/:id/generate-output`, `/:id/outputs/:format/download`, `/:id/request-approval`, `/:id/submit`, `/:id/acknowledge`, `/aml/report-schemas`, `/:id/compile`, `/:id/simulate`, `/:id/promote`, `/aml/report-schema-defaults`.
- Money, cases, and merchant changes: `/adjustments`, `/cashouts/:id/process`, `/disputes`, `/operator-cases/:id/resolve`, `/gateway-inquiries/:id/*`, `/merchants/:id/propose-edit|suspend|reinstate|close`, `/pending-changes`, `/detail-changes`.

### Platform settings and environment

Settings consumed: `join_request.four_eyes_policy` (policy, owner threshold, volume threshold, high-risk categories), `onboarding.required_documents`, `kyb.refresh_policy`, `screening.watchlist`, `screening.fail_closed`, and `OD-4` (retention). `AUDIT_DATABASE_URL` controls whether audit rows are mirrored to `audit_outbox`; `NOTIFICATION_WEBHOOK_URL` and timeout configure the notification transport; worker flags are described in `core.workers`.

## 6. Operational usage

### Applying a sensitive change

1. The maker calls the domain route (`propose-edit`, `suspend`, `aml/cases/:id/propose`, `operator-cases/:id/resolve`, `aml/reports`, etc.).
2. The route validates the request, creates the approval row, and returns `202` with the approval id.
3. A checker opens `GET /admin/approvals/:id`, reviews the subject context and diff, and calls `POST /admin/approvals/:id/approve` with the optional checklist.
4. The handler executes in the approval transaction. Adjustments are queued and executed by `BackgroundJobWorker`; the response is `202` with a job id.
5. Rejection records a reason and leaves the subject in its pre-approval state, except for audit/lifecycle side effects.

### Onboarding

1. Create the admin-assisted join request, add beneficial owners and KYB documents, then submit.
2. Fix any readiness blockers: required documents, owner threshold/screening, checklist, payout bank, duplicate justification.
3. If four-eyes is required, decide as maker and approve in the approvals queue; otherwise the decide route activates or rejects directly.
4. KYB expiry and periodic revalidation are handled by `KybExpiryWorker`.

### AML case

1. The guard or onboarding service creates the case and, for a platform-held hold, the escrow posting.
2. Compliance proposes `HOLD`/`RELEASE`/`REJECT`/`ESCALATE` through `/aml/cases/:id/propose`.
3. A checker approves. Release/void posts the ledger and finalises the attempt; escalate opens an operator case.
4. A potential screening match is dispositioned directly through `/aml/matches/:id/disposition`; that route is confidential-gated but is not an approval.

### Regulatory report

1. Let `ReportingRuleEvaluator`/`RegulatoryReportWorker` draft the report, or draft one manually through `/aml/reports`.
2. Review the canonical payload and generated outputs; generate/regenerate any missing XML/XLSX output and complete the narrative sections.
3. Submit the DRAFT for approval, approve the `REGULATORY_REPORT` request as a different checker, then file.
4. Submit through `/aml/reports/:id/submit` with the authority reference and filing channel; the route refuses any required output that is not `VALIDATED` against a `CONFIRMED` schema/template. Then acknowledge.

## 7. Status and deviations

### Implemented

- Maker/checker separation at service, route, and database levels; approval queue, summary, export, detail, approve, reject, and checklists.
- Governance execution for join requests, merchants, adjustments, cash-out execution, AML cases, operator cases, regulatory reports/rules, AML rules, commission expiry, velocity deactivation, users, gateway versions, and backup policy.
- Onboarding readiness, KYB review/revalidation, duplicate detection, four-eyes policy, screening provider abstraction, Arabic normalization, L1/L2/L3 screening, AML rule engine, cases, hold escrow, release/void.
- Dispute drafting with system maker and human checker, chargeback outcomes, negative-balance ceiling, regulatory report approval/submission/acknowledgement, operator cases, persisted inquiry schedules.
- Tipping-off template guard, AML payload redaction, and the confidential AML route gate.
- Format-aware regulatory reporting: schema registry/default/rule bindings, encrypted payloads, DRAFT evaluator reports, request-approval/reject/expiry lifecycle, safe XSD compiler and XML validator, server-side XLSX renderer, provisional baseline schemas, output revisions/download hash verification, narrative editing, and per-format filing gates.

### Partial

- **Approval coverage** — several sensitive actions are direct or lack execution handlers. Application-sensitive changes cannot complete through approvals; platform settings bypass approvals; cash-out processing is a direct route; commission-profile creation and velocity-rule creation are direct.
- **Approval lifecycle** — `DRAFT` is largely unused, rejections do not return to `DRAFT`, and emergency ratification records a note but does not run a second execution.
- **Domain checker enforcement** — only merchant payloads get a role-domain check. AML, reports, users, gateway versions, and platform settings do not enforce their intended checker roles in the dispatcher.
- **Detail change log** — descriptive and approved merchant edits are logged; other entities and the `DetailChangeService` redaction/diff pipeline are not fully wired.
- **AML L4** — rule evaluation happens at attempt creation, not at confirmation or in batch analytics. There is no structuring batch job, no rule dry-run, and no 24-hour emergency tightening workflow.
- **Retention** — the worker is opt-in, does not purge AML cases/screenings/KYB documents/regulatory reports, and keeps the ledger.
- **Dispute intake** — manual admin intake is implemented; webhook and statement channels are not wired.
- **Cash-out lifecycle** — `PROCESSING` and `SUBTRACTED` are not used by the execute path.

### Missing / deferred

- `executeApprovalSubject` handlers for `APPLICATION`, `CASHOUT_REQUEST`, and `PLATFORM_SETTING`.
- Approval rows for cash-out processing and platform-setting changes.
- Domain-scoped checker authority (`approvals.domains` equivalent).
- Maker-checker for commission-profile creation/change and velocity-rule creation.
- Deferred/batch AML monitoring and rule dry-run.
- Retention of AML/KYB/reporting evidence by the worker.
- Regulatory authority filing adapters.

### Known bugs / risks

- **Security gap:** the generic approval route is not confidential-gated. A principal with `approval:check` can approve an `AML_CASE` even without `aml:read`/`aml:write`; the seeded `FINANCE` role holds `approval:check`.
- **Security gap:** emergency suspension takes effect immediately by one actor and leaves an approval in `PENDING_REVIEW`; rejecting it records `MERCHANT_EMERGENCY_SUSPENSION_NOT_RATIFIED` but does not undo the suspension. The `ApprovalService` emergency path also executes without a checker, and `ratifyEmergencyRequest` only records a note.
- **Coverage gap:** no FIU-confirmed XSD or CBL XLSX template has been uploaded, so the baseline reporting schemas/templates remain `PROVISIONAL` and filing is blocked by design.
- **Coverage gap:** INC, DOCX/PDF narrative export and external authority filing adapters are deferred.
- **Coverage gap:** an `APPLICATION` approval can be created and listed but cannot be approved; the checker receives `NO_EXECUTABLE_SUBJECT`.
- **Configuration gap:** `PUT /admin/settings` requires `settings:write` and writes directly, despite the design's maker-checker requirement for compliance settings.
- **Seed gap:** the seeded `COMPLIANCE` and `MLRO` users lack `approval:check`, so the documented maker-checker role matrix is not exercised by the default deployment seed.

## 8. Verification and tests

Run the focused suites:

```bash
cd core-back && bun test test/engine/governance.test.ts
cd core-back && bun test test/governance-execution.test.ts
cd core-back && bun test test/approval-queue.test.ts
cd core-back && bun test test/onboarding-four-eyes.test.ts
cd core-back && bun test test/kyb-review.test.ts
cd core-back && bun test test/screening-and-caps.test.ts
cd core-back && bun test test/aml-resolution-finalization.test.ts
cd core-back && bun test test/regulatory-report-lifecycle.test.ts
cd core-back && bun test test/reporting-rule-evaluator.test.ts
cd core-back && bun test test/refund-three-phase.test.ts
cd core-back && bun test test/operator-cases.test.ts
cd core-back && bun test test/gateway-inquiry-schedules.test.ts
```

Coverage highlights:

- `engine/governance.test.ts` / `governance-execution.test.ts` — proposal state, maker/checker separation, JSON Patch base version, emergency ratification, AML release/void, merchant-direct case-only, dispute drafting, chargeback outcomes, cash-out execution/rejection, idempotency, refund caps, operator resolution.
- `onboarding-four-eyes.test.ts`, `kyb-review.test.ts`, `screening-and-caps.test.ts` — policy/risk triggers, expiry/duplicates/payout holder/refresh, L1/L2 screening, provider failure, watch-list invalidation.
- `regulatory-report-lifecycle.test.ts` / `reporting-rule-evaluator.test.ts` — report creation, provisional-rule block, maker/submitter separation, acknowledgement, evaluator idempotency.
- `phase4-onboarding-aml-disputes-recon.test.ts` and `exhaustive/07-workflows/onboarding-and-aml.test.ts` — AML rules, Arabic normalization, tipping-off, dispute dedupe/cap, reconciliation, broader workflows.

Some governance tests use fake clients; database-backed suites require PostgreSQL 18 and are skipped otherwise. Report skipped suites explicitly.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` Part IX (incorporates v4.1 §15–§22).
- `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md` §15 roles/authorities/four-eyes, §16 onboarding/KYB, §17 detail governance, §18 AML, §19 disputes, §20 profitability; `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md` §9 and §13.
- `design/10-fixes/_0001_operator_cases.md` — operator-case inquiry eligibility and bulk behavior.

### Code paths

- Governance: `core-back/engine/governance/{ApprovalService,GovernanceExecution,DetailChangeService}.ts`.
- Compliance and guards: `core-back/engine/compliance/{ReportingRuleEvaluator,tippingOff,OperatorCaseSink}.ts`, `core-back/engine/guards/{AmlRuleEngine,MerchantScreeningService,ScreeningProvider,AttemptGuardPipeline}.ts`.
- Libraries and API: `core-back/lib/{approvalQueue,joinRequestOnboarding,kybReview,merchantOps}.ts`, `core-back/lib/auth/confidentialAccess.ts`, `core-back/api/middleware/makerCheckerGuard.ts`, `core-back/api/internal/{admin,merchant}.ts`.
- Data: `core-back/prisma/schema.prisma`, `core-back/prisma/seed.ts`.

### Generated appendices

`project-design/appendices/schema-catalog.md`, `api-route-matrix.md`, and `test-inventory.md`.

## 10. Change history

- 2026-11-03 — Baseline verification against `5a24f6f+working-tree`: documented approval lifecycle deviations, missing `APPLICATION`/`CASHOUT_REQUEST`/`PLATFORM_SETTING` handlers, direct settings/cash-out/commission/velocity paths, authority and confidentiality gaps, onboarding/KYB, AML layers, disputes, reporting, operator cases, and retention gaps.

## 11. Security hardening (2026-11-05)

- **Cash-out state machine.** Terminal states are immutable. Approve/reject are allowed only from `PENDING` or `PROCESSING`; repeating the same decision is an idempotent skip; the opposite decision returns `409 CASHOUT_STATE_INVALID`. The transition is an atomic conditional `UPDATE`. The journal `refId` is the cash-out id. Approval requires an `ACTIVE` wallet and merchant and a ledger balance check under a `FOR UPDATE` lock on the wallet's shards (`lib/cashoutBalance.ts`; errors `CASHOUT_INSUFFICIENT_BALANCE`, `INSUFFICIENT_BALANCE`, `WALLET_NOT_ACTIVE`, `MERCHANT_NOT_ACTIVE`). `lockGlAccountShardsSorted` now orders by byte order.
- **Cash-out requests.** Merchant creation requires an idempotency key, checks ledger balance minus open cash-outs and records `requestedByUserId` (new columns `cashout_requests.idempotency_key`, unique per merchant, and `requested_by_user_id`). Destination is a typed structure; a KYB `payoutAccountHash`, when present, must match (`403 CASHOUT_DESTINATION_NOT_VERIFIED`), else the request is flagged `payoutVerified:false`. Staff processing requires `cashout:review`.
- **Admin users.** Creators can only grant authorities they hold. New users are always `INVITED` with `isMaker`/`isChecker` false; requested flags go through a `PENDING_REVIEW` approval. `PATCH /users` and `/users/:id` route authority, role, flag and ACTIVE changes through maker-checker (only suspend/disable apply directly). Targets must be staff; no self-edit; `executeUserAuthorityChange` refuses self-approval (`APPROVAL_SELF_CHANGE`). The MFA phone is still chosen at creation.
- **Approvals.** The generic, adjustment and backup-policy approve/reject paths claim the approval with a conditional update inside the transaction.
- **KYB scan.** `KYB_SCANNER_MODE` unset fails closed (everything `PENDING`, not previewable). Active content (HTML/SVG/script, PDF with `/JS` `/OpenAction` `/Launch` `/EmbeddedFile`, MZ/ELF/Mach-O/shebang) is `INFECTED` in every mode; EICAR is always detected; only `KYB_SCANNER_MODE=eicar` (dev/tests) yields `CLEAN`. Content sniffing is not a malware engine; a real scanner is still required.
- **Disputes.** Evidence is accepted only from `OPENED` or `EVIDENCE_REQUESTED` (`DISPUTE_NOT_ACCEPTING_EVIDENCE`).
- **Merchant authorities** and principal separation are described in the API surface part (section 11).
- **Public checkout** BLOCK/HOLD responses omit internal `reasons`; reasons remain in guard audit and AML cases. The AML HOLD escrow is booked after the verified gateway capture and RELEASE requires it (GAP-015, see the gap resolutions below).
- **Tests.** `core-back/test/security-regressions/{h1h2-authz,h3-admin-users-and-approvals,h4-cashout,m9-m12-upload-kyb}`.

## Gap resolutions (2026-11-05)

- **AML escrow and release (GAP-015, RESOLVED with residuals).** `resolveAmlHoldAmounts` looks the escrow up by the case's `holdJournalEntryId` or, when absent, by the `PAYMENT_ATTEMPT` journal entry of the attempt. A `RELEASE` calls it with `requireEscrow` and is refused with `409 AML_HOLD_CAPTURE_NOT_VERIFIED` when there is no held amount (no verified gateway capture, so no `AML_HOLD` escrow). A `REJECT` of a case with no escrow posts nothing (`postingReason` `NO_CAPTURE_NOTHING_TO_VOID`); with an escrow it posts `AML_VOID`. The escrow itself is booked by the engine at capture time (see `core.engine`). Residuals: merchant-direct held attempts have no escrow, and the case row no longer records the escrow entry id.
- **Payout account maker-checker and mandatory hash (GAP-017, RESOLVED).** A cash-out requires a KYB `payoutAccountHash` on the merchant (`403 CASHOUT_PAYOUT_ACCOUNT_NOT_VERIFIED` otherwise) and the destination must hash to it (`403 CASHOUT_DESTINATION_NOT_VERIFIED`); destinations are always stored `payoutVerified: true`, so the unverified-destination path no longer exists. Join-request submit is refused with `409 JOIN_REQUEST_PAYOUT_HASH_REQUIRED` unless the payout details yield a hash. A payout-account change only happens through the maker-checker merchant edit (`propose-edit`): a replacement of `/payoutBankDetailsJson` must carry a bank and an account number or IBAN and a `remove` is refused (`422 PAYOUT_ACCOUNT_HASH_REQUIRED`); `executeMerchantPatch` recomputes `payoutAccountHash` from the approved account on execution and refuses an account that yields no hash.
- **Per-source statement file hash (GAP-018, RESOLVED with a residual).** Migration `20261105130000_statement_unique_source_file_hash` drops the global `reconciliation_runs_file_hash_key` index and creates the unique index `reconciliation_runs_statement_source_id_file_hash_key` on `(statement_source_id, file_hash)` plus a non-unique `reconciliation_runs_file_hash_idx`. The same bytes may now be uploaded for two sources; one source never gets two runs. `findRunByFileHash(tx, fileHash, sourceId)` is source-scoped and the upload handler keeps a defence-in-depth check that a run of another source is never answered as this source's. Residual: the concurrent duplicate-upload race described in the frontmatter gaps.
- **Still open.** GAP-025: KYB scanning is content sniffing plus EICAR only; a real malware scanner is not integrated.

## Governed commerce state changes and intake enforcement (2026-11-06)

**Rule (project invariant: sensitive actions use maker-checker).** Moving an entity to a *more restrictive* state is immediate: it requires a trimmed `reason` of 10-500 characters and writes an audit row. Moving it to a *less restrictive* state, or changing what it may accept, is a maker-checker approval:

| Entity | Immediate (audited) | Approval subject |
| :--- | :--- | :--- |
| Wallet | ACTIVE -> FROZEN (`WALLET_FROZEN`) | `WALLET`: FROZEN -> ACTIVE (`WALLET_UNFROZEN`) |
| Application | ACTIVE -> SUSPENDED, alone (`APPLICATION_SUSPENDED`) | `APPLICATION`: reactivation (`APPLICATION_REACTIVATED`) and any edit of rail whitelist, redirect domains or assigned wallet (`APPLICATION_UPDATED`) |
| POS terminal | ACTIVE -> INACTIVE/BLOCKED, INACTIVE -> BLOCKED (`POS_TERMINAL_STATUS_CHANGED`) | `POS_TERMINAL`: to ACTIVE |
| Payment link | PENDING -> CANCELLED (`PAYMENT_LINK_CANCELLED`, no reactivation) | none |
| Access token | revoke (`ACCESS_TOKEN_REVOKED`, irreversible) | none |

`executeWalletStatusChange`, `executeApplicationChange` and `executePosTerminalStatusChange` (`GovernanceExecution.ts`) are dispatched from `executeApprovalSubject`; each re-validates the entity's current state (the application executor also checks `fromStatus` and `baseUpdatedAt`, wallet ownership/currency/ACTIVE and rail codes), audits in the same transaction and is idempotent. maker != checker is enforced by the existing approval machinery. The three subject types map to the MERCHANT approval domain (`approvalQueue.ts`). Side effect: the pre-existing merchant-side `PATCH /applications/:id` approvals (subject `APPLICATION`) previously had no executor and now execute.

**Enforcement (a freeze that does not freeze would be a defect).** Before this change the checkout intake checked link state and merchant status but not application or wallet status; wallet status was only enforced for cash-outs. `lib/commerceStatus.ts` now raises `409 APPLICATION_NOT_ACTIVE` / `WALLET_NOT_ACTIVE` / `POS_TERMINAL_NOT_ACTIVE` in: `AttemptGuardPipeline.guard` (the choke point for every attempt, via optional `payments.findLinkCommerceStatus`), checkout `ensureLinkUsable` (initiate) and the confirm SUBMIT step, merchant `createLink` (`POST /links` and `/external/links`), POS screen stream connect (an open stream ends at the next minute heartbeat) and POS screen creation. A merchant can no longer lift a BLOCKED terminal through its own `PATCH /pos/terminals/:id` (`409 POS_TERMINAL_BLOCKED`). LIVE traffic requires ACTIVE; SANDBOX additionally tolerates application PENDING/DRAFT and wallet PENDING (the OD-10 sandbox-before-approval flow); SUSPENDED/CLOSED applications and FROZEN/CLOSED wallets are blocked in both. Not gated by design: display-only `GET /pay/:linkKey`, resend/client-event routes, and inbound provider webhooks (already-captured money must still be processed).

**Known limits.** A merchant can still move its own INACTIVE terminal back to ACTIVE (INACTIVE cannot be told apart from a staff-set INACTIVE; only BLOCKED is staff-only). `approvalSubjectContext` (admin.ts) has no case for the three new subjects, so the approvals detail shows the generic payload diff.

## Reporting Studio phases 2-5, incident management and filing adapters (2026-11-10)

The Reporting Studio now covers the full authoring and filing lane in addition to the v26 engine:

- **XLSX template workflow.** A DRAFT schema can upload an `.xlsx` template. `lib/xlsx/template.ts` inspects the zip (20 MB compressed / 100 MB uncompressed / 1,000,000 cells / 100 sheets), rejects `vbaProject.bin`, external links, OLE/embedded objects and `customUI`, and reports sheets and defined names. The visual mapping (`template_binding_json`) binds each workbook-schema column and narrative section to a named range, a data start row, a prototype row and optional total anchors. `renderRegulatoryWorkbook` copies the prototype row style, writes the rows, totals and narrative, and reports `template-range` / `template-binding` / `REQUIRED_SECTION` issues. The generation service decrypts the template with the `reporting-xlsx` context and passes the saved binding, so a preview and a filed output use the same mapping.
- **Rule-schema bindings are maker-checker.** `PUT /aml/reporting-rules/:id/schema-bindings` no longer writes directly: it creates a `REPORTING_RULE_SCHEMA_BINDING` approval (payload contains the bindings and every schema's version/revision/definition/mapping hash), rejects a second pending change, and returns 202. `GovernanceExecution` re-validates the confirmed status, format, authority and report type at execution, replaces the rule bindings in one transaction and audits `REPORTING_RULE_SCHEMA_BINDINGS_UPDATED`. The studio shows the bound schema per rule and submits the change for approval.
- **DOCX narrative output.** `ReportOutputFormat.DOCX` plus the `DocxNarrativeSchema` compiler validate title, sections, required sections and optional tables; `lib/docx/regulatoryDocx.ts` writes a minimal OOXML package (document, styles, content types and relationships) with escaped text and tables. Outputs are encrypted with the `reporting-docx` context and downloaded with the Word content type. The provisional `cbl-incident-docx-v1` baseline is the default for `CBL / INCIDENT / INC / DOCX`.
- **Expanded incidents.** `Incident` is the operational record: severity, category, impact scope, lifecycle timestamps, commander/reporter, affected services/merchants/attempts, regulator notification, postmortem requirement/due date and root cause. Child tables hold the timeline, responders (paging/acknowledgement/release), corrective actions, links to attempts/merchants/rails/gateways/reports/cases and communications. Transitions are forward-only (`DETECTED -> TRIAGED/DECLARED -> CONTAINED -> MONITORING -> RESOLVED -> POSTMORTEM -> CLOSED`); closing requires the postmortem when the incident is SEV1/SEV2, security or data-integrity. `POST /aml/incidents/:id/report` builds the narrative and timeline, then drafts a `REGULATORY_REPORT` through the standard maker-checker path. The admin portal has `/incidents` with Overview, Timeline, Responders, Actions, Communications and Postmortem tabs.
- **External filing adapters.** `external_filing_adapters` stores a name, authority, MANUAL/HTTP kind, status, HTTPS endpoint, an encrypted auth secret, timeout and config; `external_submissions` records each attempt with the request SHA-256, external reference, response code/body and error. `POST /aml/reports/:id/file` re-checks the approval submitter, every required output (generated, VALIDATED, confirmed schema, matching payload hash), dispatches the encrypted artifacts, records the submission and then calls the normal submission gate. The HTTP adapter enforces public HTTPS, no redirect and a timeout; MANUAL remains the default and the existing submit route is unchanged. The admin portal has `/filing-adapters` and the report drawer can file through an active adapter.

## Final reporting/compliance sweep (2026-11-10)

- **Template writes are uniformly validated.** `POST /report-schemas`, schema `PUT`, `POST /template/upload`, `PUT /template` and the template branch of schema updates now all run `analyzeWorkbookTemplate`, reject every reported issue (malformed zip/workbook, macros, external links, OLE, oversized packs, too many sheets/cells) and accept templates only for XLSX schemas. `fflate` filtering aborts decompression as soon as the uncompressed budget would be exceeded instead of allocating the whole archive first. Replacing a template clears the old `template_binding_json` unless the caller supplies a new binding.
- **DOCX is a first-class schema format.** `buildSchemaValidation`, DRAFT schema `PUT`, `simulate` and `clone` now use `parseDocxNarrativeSchema` and `renderRegulatoryDocx`; cloning copies the XLSX template binding. Simulation of a template-backed XLSX schema decrypts the template instead of silently rendering generated mode.
- **Incidents are operationally complete.** List/detail responses resolve commander, reporter, timeline actor, action owner and communication sender names from the referenced users. The list returns server-side summary counts and filters/pagination are forwarded by the edge. Child writes are audited; transitions and postmortem edits lock the incident row; report drafting takes an advisory lock so concurrent requests cannot create two reports. Incident reporting is intentionally allowed from any lifecycle state (the owner decision), with the UI confirmation.
- **Filing adapters are maker-checker.** Create, update and disable produce `FILING_ADAPTER` approvals; the adapter row stays `DISABLED` until a checker applies the encrypted secret/endpoint/status changes. `configJson` rejects secret-looking keys and is redacted on output; HTTP endpoints remain public-HTTPS-only. `POST /reports/:id/file` creates a PENDING submission before dispatch, records failure, blocks duplicate PENDING/SUBMITTED attempts and audits a reconciliation case if the report state cannot be advanced after a successful external send. Manual submissions now record a `MANUAL` `ExternalSubmission` and appear in the same history.

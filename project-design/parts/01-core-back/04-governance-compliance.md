---
id: core.governance
title: Governance and Compliance
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - core-back/engine/governance/ApprovalService.ts
  - core-back/engine/governance/GovernanceExecution.ts
  - core-back/engine/governance/DetailChangeService.ts
  - core-back/engine/compliance/ReportingRuleEvaluator.ts
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
design_sources:
  - design/payment_gateway_final_design-v5.md#part-ix-platform-interfaces-onboarding-governance-compliance-program
  - design/payment-gateway-refined-design-v4.1.md#15
  - design/payment-gateway-refined-design-v4.1.md#16
  - design/payment-gateway-refined-design-v4.1.md#17
  - design/payment-gateway-refined-design-v4.1.md#18
  - design/payment-gateway-refined-design-v4.1.md#19
  - design/payment-gateway-refined-design-v4.1.md#20
  - design/Dynamic-Payment-Gateway-Management-Design-v2.md#9
  - design/Dynamic-Payment-Gateway-Management-Design-v2.md#13
  - design/fixes/_0001_operator_cases.md
tests:
  - core-back/test/engine/governance.test.ts
  - core-back/test/governance-execution.test.ts
  - core-back/test/approval-queue.test.ts
  - core-back/test/onboarding-four-eyes.test.ts
  - core-back/test/kyb-review.test.ts
  - core-back/test/screening-and-caps.test.ts
  - core-back/test/aml-resolution-finalization.test.ts
  - core-back/test/regulatory-report-lifecycle.test.ts
  - core-back/test/reporting-rule-evaluator.test.ts
  - core-back/test/refund-three-phase.test.ts
  - core-back/test/operator-cases.test.ts
  - core-back/test/gateway-inquiry-schedules.test.ts
  - core-back/test/phase4-onboarding-aml-disputes-recon.test.ts
  - core-back/test/exhaustive/07-workflows/onboarding-and-aml.test.ts
gaps:
  - "`executeApprovalSubject` has no handler for `APPLICATION`, `CASHOUT_REQUEST`, or `PLATFORM_SETTING`; an application-sensitive change cannot be executed through the approvals route."
  - "`PUT /admin/settings` writes platform settings directly without an approval request or maker-checker."
  - "Cash-out processing is a direct single-actor route; no `CASHOUT_REQUEST` approval row is created."
  - "The approval lifecycle deviates from the design because proposals go straight to `PENDING_REVIEW`, rejection ends in `REJECTED` rather than returning to `DRAFT`, and emergency ratification does not re-execute through a checker."
  - "Per-domain checker enforcement is incomplete; `approval:check` is not domain-scoped, and AML approvals are not gated by the confidential-AML check."
  - "`DetailChangeService` is not wired into the admin routes; changes are written directly and coverage is narrow."
  - "AML layer L4 deferred/batch monitoring, rule dry-run, and emergency tightening with 24-hour ratification are not implemented."
  - "Retention is opt-in and does not cover AML cases, screenings, KYB documents, or regulatory reports."
  - "Manual regulatory-report payloads are stored as plaintext JSON in `payload_ciphertext`; evaluator-generated reports are encrypted."
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
- rejects expired requests;
- enforces maker ≠ checker;
- adds a join-request admin-assisted maker check and a merchant payload checker-domain check;
- special-cases `BACKUP_POLICY` through the backup daemon;
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
| L6 regulatory reporting | `ReportingRuleEvaluator` creates reports on settlement; manual report drafting, approval, submit, and acknowledge routes exist. Submission is not integrated with an authority adapter. |
| L7 record keeping | Audit rows, rule versions, detail changes, and the retention worker. Retention is opt-in and incomplete for AML evidence. |

Screening is a provider interface (`ScreeningProvider`) with Arabic normalization, name similarity, internal watch-list provider, mock provider, and a cached provider. `MerchantScreeningService` persists `aml_screenings` and `aml_screening_matches` with list versions and input hashes, applies owner screening status, and raises a confirmed-match case only. Potential matches remain in the screening queue for disposition.

The AML rule engine (`core-back/engine/guards/AmlRuleEngine.ts`) supports `SINGLE_AMOUNT`, `CUMULATIVE_WINDOW`, `STRUCTURING`, `RISK_TIER`, `COUNTERPARTY_COUNTRY`, `RAIL`, and `MERCHANT_DIRECT_AMOUNT`; actions are `HOLD`, `FLAG`, `BLOCK`, `CASE_ONLY`. Severity starts at the rule base, correlates with velocity, raises for high merchant tier, volume multiple, another open case, confirmed sanctions, and potential PEP. On a `HOLD`, the guard posts `Dr GATEWAY_CLEARING` / `Cr AML_HOLD` and stores the hold journal entry on the case.

AML case resolution (`GovernanceExecution.ts:1470`):

- `RELEASE` posts `AML_HOLD_AND_RELEASE` release lines, sets attempt `SUCCEEDED`, commits the link slot.
- `REJECT` posts `AML_VOID`, sets attempt `FAILED`, releases the slot.
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

Adjustment execution supports `REFUND` (three phases: claim, gateway refund, finalize), `CHARGEBACK` (won/lost/insufficient), `CORRECTION` (fee variance), `MANUAL_DEBIT`/`CASHOUT_SUBTRACTION` (cash-out template), and `MANUAL_CREDIT` (internal confirmation with zero commission). Chargebacks require a finance checker; a missing dispute outcome or a breach of `negativeBalanceCeiling` holds the adjustment and opens an operator case. Refunds are capped to the unrefunded settled amount and are idempotent on the adjustment id.

### 3.8 Cash-outs

A merchant creates a `CashoutRequest` in `PENDING` with a destination bank snapshot (`core-back/api/internal/merchant.ts:1828`). The admin `POST /admin/cashouts/:id/process` route calls `executeCashout` directly (`core-back/api/internal/admin.ts:14219`). `executeCashout` creates a `CASHOUT_SUBTRACTION` adjustment, posts `CASHOUT` (`Dr MERCHANT_WALLET` / `Cr TREASURY`), sets the request to `COMPLETE`, and writes audit. Rejection creates a rejected adjustment and sets `REJECTED`.

No `CASHOUT_REQUEST` approval row is created and there is no `PENDING -> PROCESSING -> COMPLETE -> SUBTRACTED` transition; `PROCESSING` and `SUBTRACTED` exist in the enum but the execute path writes `COMPLETE` directly on approval. The route requires `cashout:review` or `finance:write`, but one actor can process a request without a recorded second approval.

### 3.9 Regulatory reporting

`ReportingRuleEvaluator` (`core-back/engine/compliance/ReportingRuleEvaluator.ts:130`) evaluates a settled attempt against effective rules. A `CONFIRMED` rule creates a `PENDING_CHECKER` report; a `PROVISIONAL` rule creates a `DRAFT` internal-only report. Evaluation is idempotent per rule and attempt, and the confirmation path calls it after a successful settlement.

Manual report creation (`createRegulatoryReportViaApproval`) creates a `PENDING_CHECKER` report and a `REGULATORY_REPORT` approval in one transaction. Approval sets `APPROVED`; submission is a separate reporting-authority route that requires an `APPROVED` report, enforces maker ≠ submitter when the approval has a maker, and rejects a report linked to a non-`CONFIRMED` rule. Acknowledgement records `ACKNOWLEDGED` or `REJECTED_BY_AUTHORITY` with a reason.

Report payloads generated by the evaluator are encrypted with `VaultContextCipher("reporting-payload")`. Manual report creation stores `JSON.stringify(payload)` directly in `payload_ciphertext` (despite the column name), and the admin read path parses it as plaintext JSON. This is a code gap against the confidentiality intent.

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
- `ReportingRule`, `RegulatoryReport`: thresholds, status, encrypted payload, submission reference, approval.
- `OperatorCase`, `GatewayInquirySchedule`, `DetailChangeLog`, `AuditLog`, and `PlatformSetting` (with approval link and version).

### Admin routes (representative)

- Approvals: `GET /admin/approvals`, `/summary`, `/export`, `/:id`, `POST /:id/approve`, `/:id/reject`.
- Onboarding: `/join-requests` including `submit`, `decide`, `assign`, `request-info`, `checklist`, `screening/retry`, and `/kyb-documents/:id/review`, `request-replacement`, `request-revalidation`.
- AML: `/aml/screenings`, `/aml/matches/:id/disposition`, `/aml/cases`, `/:id/propose`, `/aml/rules`, `/aml/reporting-rules`, `/:id/promote`, `/aml/reports`, `/:id/submit`, `/:id/acknowledge`.
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

1. Let `ReportingRuleEvaluator` create a report on settlement, or draft one manually through `/aml/reports`.
2. Approve the `REGULATORY_REPORT` request.
3. Submit through `/aml/reports/:id/submit` with a submission reference, then acknowledge.

## 7. Status and deviations

### Implemented

- Maker/checker separation at service, route, and database levels; approval queue, summary, export, detail, approve, reject, and checklists.
- Governance execution for join requests, merchants, adjustments, cash-out execution, AML cases, operator cases, regulatory reports/rules, AML rules, commission expiry, velocity deactivation, users, gateway versions, and backup policy.
- Onboarding readiness, KYB review/revalidation, duplicate detection, four-eyes policy, screening provider abstraction, Arabic normalization, L1/L2/L3 screening, AML rule engine, cases, hold escrow, release/void.
- Dispute drafting with system maker and human checker, chargeback outcomes, negative-balance ceiling, regulatory report approval/submission/acknowledgement, operator cases, persisted inquiry schedules.
- Tipping-off template guard, AML payload redaction, and the confidential AML route gate.

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
- **Data gap:** manual regulatory report payloads are written as plaintext JSON in `payload_ciphertext`.
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

- `design/payment_gateway_final_design-v5.md` Part IX (incorporates v4.1 §15–§22).
- `design/payment-gateway-refined-design-v4.1.md` §15 roles/authorities/four-eyes, §16 onboarding/KYB, §17 detail governance, §18 AML, §19 disputes, §20 profitability; `design/Dynamic-Payment-Gateway-Management-Design-v2.md` §9 and §13.
- `design/fixes/_0001_operator_cases.md` — operator-case inquiry eligibility and bulk behavior.

### Code paths

- Governance: `core-back/engine/governance/{ApprovalService,GovernanceExecution,DetailChangeService}.ts`.
- Compliance and guards: `core-back/engine/compliance/{ReportingRuleEvaluator,tippingOff,OperatorCaseSink}.ts`, `core-back/engine/guards/{AmlRuleEngine,MerchantScreeningService,ScreeningProvider,AttemptGuardPipeline}.ts`.
- Libraries and API: `core-back/lib/{approvalQueue,joinRequestOnboarding,kybReview,merchantOps}.ts`, `core-back/lib/auth/confidentialAccess.ts`, `core-back/api/middleware/makerCheckerGuard.ts`, `core-back/api/internal/{admin,merchant}.ts`.
- Data: `core-back/prisma/schema.prisma`, `core-back/prisma/seed.ts`.

### Generated appendices

`project-design/appendices/schema-catalog.md`, `api-route-matrix.md`, and `test-inventory.md`.

## 10. Change history

- 2026-11-03 — Baseline verification against `5a24f6f+working-tree`: documented approval lifecycle deviations, missing `APPLICATION`/`CASHOUT_REQUEST`/`PLATFORM_SETTING` handlers, direct settings/cash-out/commission/velocity paths, authority and confidentiality gaps, onboarding/KYB, AML layers, disputes, reporting, operator cases, and retention gaps.

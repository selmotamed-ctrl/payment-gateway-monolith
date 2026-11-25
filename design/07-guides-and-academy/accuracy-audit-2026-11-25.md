# Guide and Academy accuracy audit — 2026-11-25

Status: completed first and second passes (22 read-only scans); code and content remediation delivered on `guide-accuracy-remediation`. Remaining product decisions are listed below.

## Method

- Scope: all 137 Admin Guide articles, 154 glossary terms, 60 quick answers, 32 situations, 25 safeguard cards, the 31-screen context map, 51 Academy lessons, 102 lesson checks, 224 exam-pool questions and 16 labs.
- Authority: working-tree code and tests; `project-design/parts/**` as the canonical map. `design/**` historical claims and READMEs were not treated as evidence.
- Each finding was classified as `DOC_WRONG`, `CODE_BUG`, `CODE_GAP`, `AMBIGUOUS` or `STALE_REFERENCE`, with severity and file evidence.
- No production database or browser was available. The scans are static; runtime behaviour is inferred from code and existing tests.

## Result

The corpus is structurally sound: links, ids, counts, exam composition and most screen references resolve. The main problem is that the prose describes a stronger control environment than the code enforces.

The raw scans produced roughly 280 findings with heavy overlap. The main clusters are:

1. **AML manual disposition and reporting.** A manually confirmed `TRUE_MATCH` did not open a case or suspend; screening outcomes leaked to applicants; the provisional-report gate could be bypassed; AML rule scope and deferred monitoring were absent.
2. **Maker-checker coverage.** Cash-out, commission profiles, platform settings, credential sets and velocity rules execute with one actor while the guide names a second checker. Approval detail also leaked AML context to Finance.
3. **Money correctness.** Dispute intake posted a reserve without the ceiling check; refunds bypassed the ceiling; settlement sweeps ran for fee-at-source and merchant-direct attempts; `CORRECTION` ignored its target; liquidity metrics used different formulas.
4. **Payment lifecycle.** OTP render dropped the gateway’s attempt/length/expiry values; inquiry could execute a money-moving `VERIFY` step; the grace window was stored but never enforced; case creation/notes/replay and signature-failure alerts were missing.
5. **Gateway lifecycle.** Gateway content hashes collided on the default draft; signer/verifier canonicalisation differed; gateway status progression, canary, normaliser, save-time validation and HIGH_RISK controls were incomplete.
6. **Merchant lifecycle.** Approved merchants’ Live applications stayed `PENDING`; links could use a wallet other than the application wallet; sensitive merchant fields could be self-edited; default roles lacked KYB/merchant authorities.
7. **Deployment/security.** Object GC did not re-check locks/retention; backup-policy checker domain was not enforced; the test-server env exposes a public admin front; every-read auditing, step-up auth, webhook replay and signature alerts were overstated.
8. **Academy.** Several answer keys were wrong (`q-m0-002`, the 60/40 four-eyes example, masked token, expiry-to-draft, report types, SLA hours), and the default role set made some labs impossible.
9. **Structure.** Database/menu/report/context-map counts, deployment steps, glossary entries, safeguard count, context-map aliases and a few screen articles were stale.

## Code fixes delivered in this pass

- `TRUE_MATCH` now opens a confidential AML case, blocks onboarding through readiness, marks an owner `CONFIRMED_MATCH`, and suspends an active merchant.
- Screening outcomes are mapped to neutral `POLICY` for applicants; periodic-screening suspension uses the allowed `AML` code.
- AML approval subject context is gated by the confidential AML authority.
- The provisional reporting gate now requires a confirmed reporting rule or at least one confirmed output; missing rules are rejected.
- Object GC re-checks active locks and retention under a row lock; legal holds and locks serialize with the GC claim.
- Backup-policy execution enforces the `SECURITY_ADMIN`/`FINANCE` checker domain.
- Dispute intake sets the attempt to `DISPUTED`, and the reserve is not posted when it would breach the negative-balance ceiling.
- Refunds are refused before the gateway call when they would breach the ceiling.
- Settlement sweeps skip merchant-direct, internal and fee-at-source attempts.
- `CORRECTION` credits the selected merchant wallet; the legacy fee-accrual target still posts the fee true-up.
- OTP client actions merge the gateway-specific attempt limit, OTP length, cooldown and expiry.
- `VERIFY` flows reject money-moving steps at validation and runtime.
- Live applications are created `ACTIVE` for an approved merchant; onboarding approval activates existing `PENDING` applications.
- A link can only settle to its application’s assigned wallet.
- A merchant cannot self-edit sensitive legal/tax fields after activation or while a join request is under review; a merchant withdraw route returns the request to `DRAFT` for correction and resubmission.
- The dashboard renders the Webhook Inbox Lag tile; the adjustments page consumes `attemptId`/`merchantId`; the Jobs filter includes `REFUND_INQUIRY`; empty journal entries reach the unbalanced tile; the backup alert fallback is 300 s; gate 8 accepts an unlimited `maxAmount`.
- Default staff roles now include the KYB/merchant authorities the documented workflows require; `SECURITY_ADMIN` can check approvals.
- Approval detail and AML case reads are audited.

## Remaining product decisions / feature work

These are intentionally not silently rewritten as if implemented:

- Cash-out second Finance approval (the current maker is the merchant; one staff `cashout:review` action executes).
- Commission-profile, platform-setting, credential-set and velocity-rule maker-checker.
- Stop payouts automatically on ledger drift.
- Confirmation-time/daily AML monitoring and rail-level screening policy.
- Canary percentage/list traffic splitting.
- Generic approval withdraw, merchant re-application linkage and KYB extension by two people.
- Webhook replay and signature-spike alerting.
- Self-service password change and step-up re-authentication.
- OIDC/Google login.
- Retention from relationship end for AML/KYB data.
- POS per-screen token enforcement.
- Gateway status writers and the HIGH_RISK statement/threshold controls.

The Guide/Academy now either describe the current behaviour or explicitly label these as intended/partial. They must not claim them as enforced controls.

## Verification plan

- Core typecheck; targeted DB-free suites for governance, reconciliation, AML, callbacks, step execution and onboarding.
- Admin/merchant/checkout builds and unit tests; Playwright for the changed screens.
- `content:guide`, `content:academy`, `content:sync`, `content:check`, the extractor drift tests and the clarity gate.
- `project-design/build.ts --check`, `check.ts`, `git diff --check`.
- A full DB-backed run and live deployment remain environment-dependent.

## Second pass (same day)

Eight further read-only scans re-read every Guide book and Academy module against the working tree after the first remediation commit. They found residual claims that had been missed, plus a smaller set of code defects and role-wiring gaps:

- **Code defects fixed:** provisional-rule check ran after the filing adapter; four-eyes could be bypassed by selecting `HIGH` risk at decision time; adjustment approval did not enforce a Finance checker at the route; a failed restore-drill check could render as `Passed`; the drill UI did not show the object-storage badge; Gross Volume ignored the currency selector; Security Admin could open credential sets/settings without their read authorities; Finance could not open reconciliation/pricing; sandbox menu routes were hidden from the roles the Guide names; API tokens remained usable after closing a merchant; a join rejection did not require a reason code and note.
- **Code behaviour aligned:** `CONTROLLER` now satisfies the ownership gate; the join-request SLA starts at submission; a batch-net statement line with no local attempt still posts its clearing sweep (merchant-direct/internal/fee-at-source attempts remain excluded); checkout maps the slot error to “Payment in progress”.
- **Content corrected:** join SLA pause/resume, gateway fee visibility, report-catalog filtering, read-only-mirror overclaim, dashboard tile list, role-table approvals, POS token enforcement, approval lifetimes, step-up, client-certificate enforcement, pre-migration backup step, release pruning, backups screen contents, pg-native-only WAL/encryption, cash-out/approval/AML/withdrawal claims, reconciliation severity, adjustment states, refund/dispute ceilings, suspense, merchant-direct zero-commission entries, unmatched 2xx, OTP resend, webhook retry/dedupe, mismatch-policy scope, backup-policy checker, retention basis, credential rotation overlap, `HIGH_RISK`, `COUNTERPARTY_COUNTRY` and controller/ownership wording.
- **Remaining product decisions** are unchanged: cash-out second Finance approval; commission/settings/credential/velocity maker-checker; automatic payout stop on drift; daily AML monitoring; gateway-version canary split; OIDC/step-up/password change; generic approval withdraw; webhook replay/signature-spike alert; relationship-end retention; POS per-screen token.

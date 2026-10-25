Implementation and Acceptance Checklist — Design v4.1
Source: /home/selmotamed/neom/payment-gateway-2/design/final.md  
This is a requirements-only extraction for remediation planning; it does not assess the current implementation.
Markers: INVARIANT = non-negotiable correctness/security constraint; GATE = explicit release-blocking acceptance criterion.
1. Architecture and Domain
-   Implement the four-layer catalog with clear ownership:
- Gateway: technical integration, environments, auth, flows, channels, mappings and amount settings.
- Credential Set: environment-specific secrets, PLATFORM/MERCHANT ownership and settlement target.
- Rail: customer-facing bilingual catalog, forms, currency and capabilities.
- Route: rail/gateway/credential-policy binding with priority, cost, limits, daily cap, health, maintenance and scope.  
(§1.1, §4, §5.1–5.3)
-   Implement dynamic visible-rail resolution on every checkout resolution as the intersection of:
- Application and link whitelists.
- A live, effective commission profile.
- At least one route that is ACTIVE and HEALTHY, within amount and daily-cap limits, outside maintenance, in merchant/application/risk/channel scope, using a VERIFIED credential set.
- Matching rail/link currency and rail.blocked = false.  
(§4)
-   Enforce whitelist semantics: application NULL means all otherwise-eligible rails; an empty array is invalid; a link whitelist may only narrow the application list.  
(§5.7, §17.2)
-   Keep collection mode and confirmation channel independent. Support the specified modes and channels, validate the compatibility matrix at save time, and treat return/browser channels only as hints.  
(§1.1, §3.3)
-   Provide one declarative 10-phase engine and a closed transform library; prohibit arbitrary scripting/eval. Where configuration cannot express an integration, a Native Adapter must use the same registry, engine contract, state machine, inbox, verifier and single Ledger Poster.  
(§1.1, §6, §13 case 78)
-   Make gateway configuration immutable and content-addressed through DRAFT → SANDBOX_VERIFIED → PENDING_APPROVAL → LIVE; support supersession, named rollback and optimistic concurrent editing.  
(§1.1, §5.2, §13 cases 68–70)
-   Implement route ranking/failover, effective-cost or priority/weighted strategies, maintenance windows, DRAINING, per-route health/circuit breaking, rate limits and concurrency caps. In-flight attempts must remain on their pinned route/configuration.  
(§4, §5.3, §11.2, §13 Groups D/F/I)
-   Implement the seven configuration blueprints and validate each enabled rail against the complete integration matrix: forms, auth, amount pipeline, TTL, confirmation paths and evidence level.  
(§3.2, §8)
-   Implement NeomPay as an INTERNAL gateway under the unchanged engine contract:
- Hybrid push/OTP/QR modes; wallet ID format, Luhn check and wallet-type allowlist.
- Native 3-decimal amounts without rounding/scaling.
- mTLS, idempotent state changes, reference lookup, reserve/capture/release, refunds/partials, deterministic errors and ledger export.
- Dynamic QR bound to reference/expiry; self-payment policy defaults to BLOCK.
- Direct Treasury posting under INTERNAL-1, without clearing, fee accrual or settlement sweep.  
(§8 Blueprint 7, §9.4, §13 Group K)
2. Data and Schema
-   Implement the complete 64-table PostgreSQL schema, including all v4.1 amendments:
- A, 18: merchant, identity/user, application/wallet, token, link, POS, GL/journal, commission, velocity/AML, adjustment, cash-out and approval entities.
- B, 6: gateways, versions, environments, auth, settings and credential sets.
- C, 4: assets, rails, fields and routes.
- D, 13: crypto, flows/steps/parameters/outputs, status/error mappings, channels, polling, widgets, redirects, statements and manual instructions.
- E, 10: attempt groups/attempts/steps, inbox, operator cases, reconciliation runs/items, health samples, detail-change and audit logs.
- F, 13: login identities, join requests, KYB documents, beneficial owners, screenings/matches, AML/reporting rules, regulatory reports, disputes, notification templates/outbox and platform settings.  
(§5.1–5.7)
-   Apply global conventions: UUIDv7 primary keys, UTC TIMESTAMPTZ timestamps, created_at/updated_at, NUMERIC(18,4) money, and AES-256-GCM ciphertext formatted keyId:iv:authTag:ciphertext.  
INVARIANT Floating-point monetary types are forbidden.  
(§5, §5.6)
-   Enforce schema-level financial and concurrency constraints:
- INVARIANT For finite-use links: confirmed_count + active_locked_count <= use_count.
- attempt_groups.success_count <= 1.
- Positive journal-line amounts and deferred balanced-entry validation.
- UNIQUE(ref_type, ref_id) on journal entries and unique attempt ledger_entry_id.
- Unique attempt/reference and credential external-merchant identity.
- SELECT … FOR UPDATE protection for attempts, refunds, sweeps and other serialized money operations.  
(§5.1, §5.5, §7.1, §13 cases 41, 63, 66, 97, 100, 110, 113)
-   Pin gateway_version_id, route_id, credential_set_id and commission_profile_id on every attempt; pin rule/version identifiers on AML decisions and preserve effective-dated commercial history.  
(§5.5, §5.6, §7.1, §18.5)
-   Enforce exactly one non-null assigned wallet per application; derive and freeze payment_links.wallet_id at link creation. Wallet balances must be derived from GL checkpoints plus journal lines, never mutable balance columns.  
(§5.7, §17.1–17.2, §20.1)
-   Implement durable, append-only evidence:
- Raw inbound event stored before processing, with unique (channel_id, dedupe_key).
- Redacted immutable outbound step logs.
- Statement file_hash idempotency and dispute (gateway_id, external_dispute_ref) uniqueness.
- Immutable audit/detail-change logs and notification outbox uniqueness by event_id.
- Frozen approved report payloads and append-only corrections.  
(§5.5–5.6, §17.5, §18.9, §19.1)
-   Enforce environment separation: sandbox/live credentials, path tokens and webhook secrets are distinct; sandbox attempts cannot enter the live ledger or financial queries.  
INVARIANT Historical rails/gateways are retired/blocked, not hard-deleted.  
(§5.2, §13 cases 71, 74, 79)
-   Apply confidentiality classes and access restrictions to PII, KYB and AML-CONFIDENTIAL data; encrypt national IDs/documents and mask sensitive values in lists, exports and change logs.  
(§5.6, §17.5, §18.9)
3. Engine, State and Trust
Engine contract and execution
-   Implement all six methods: preInitiate, initiate, confirm, verifyCallback, inquire, and refund, with their specified read-only/money-moving and failure semantics.  
(§6.1)
-   Keep checkout gateway-agnostic by supporting only the five declarative client actions: SHOW_OTP_FORM, HTTP_REDIRECT, RENDER_EMBEDDED, SHOW_QR_OR_CODE, and SHOW_PUSH_OR_TRANSFER.  
(§6.2, §15.7)
-   Implement only the pure, typed §6.3 transform whitelist for numeric/string normalization, canonicalization, time/identity, encoding and cryptography; validate transform pipelines and regex safety at save time.  
(§6.3, §10.2 T-18)
-   Require every HTTP flow step to declare side effect, retry policy, idempotency configuration and point-of-no-return.  
INVARIANT MOVES_MONEY uses retry_policy = NEVER unless idempotency is explicitly supported and contract-proven; timeout, reset, 5xx, extraction failure or unmatched status after the point of no return becomes UNKNOWN, never blind retry or automatic failure.  
(§5.4, §6.1, §7.1, §10.1 safeguard 7)
-   Implement first-match status rules, canonical error classifications and bilingual safe messages. Customer errors and HTTP 429 must not count as gateway breaker failures; missing required money-step output becomes UNKNOWN.  
(§5.4, §13 cases 36, 56–57, 93)
-   Implement Promise-cached consumer construction, single-flight token refresh, atomic persistence of rotating refresh tokens before refresh completion, and chained refresh timers with ±10% jitter.  
(§10.1 safeguards 2–5)
Attempt lifecycle and trusted confirmation
-   Implement all nine state-machine rules and specified terminal/substatus behavior, including realtime SSE/POS publication and durable expires_at/next_check_at workers using FOR UPDATE SKIP LOCKED.  
(§7.1)
-   INVARIANT Reserve link slots atomically in a serializable/row-locked guard. Release reservations only on FAILED, EXPIRED, CANCELLED, or BLOCKED; hold them throughout UNKNOWN. Block competing retries/tabs while an ambiguous attempt exists.  
(§7.1 rules 2, 6; §13 cases 7–8, 13)
-   Calculate expiry as min(gateway_session_ttl, platform_ttl). Default platform ceilings are:
- OTP_PULL: 20 minutes / 1200 seconds.
- REDIRECT: 30 minutes.
- QR_DISPLAY and PUSH_APPROVAL: 15 minutes.
- MANUAL: configured.  
Run inquiry before expiry where supported; retain the inbox for a default 24-hour grace period, indefinitely for no-inquiry rails.  
(§7.1 rule 3, §17.6, OD-7)
-   Implement retryable OTP handling without sending a new SMS: return to AWAITING_CUSTOMER, increment attempts, and fail on attempt 3 by default. Enforce resend cooldown and backend idempotency.  
(§7.1 rule 4, §13 cases 2, 4, 96)
-   INVARIANT Post money only after server-verified confirmation of all five facts: successful status, matching platform reference, settled amount within route tolerance, matching currency, and matching environment. Browser callbacks, return URLs and weak/IP-only/shared-token channels may only trigger inquiry.  
(§1.1 decision 4, §6.1, §12 Gate 6)
-   Verify callbacks using raw bytes, constant-time signature comparison across overlapping active secret versions, CIDR checks, timestamp tolerance—default 300 seconds—and durable deduplication. Weak channels must have must_inquire = true.  
(§5.4, §6.1, §10.2 T-01–T-04)
-   Implement forward-only recovery:
- Never downgrade SUCCEEDED.
- Conflicting trusted signals produce UNKNOWN plus a P1 CONFLICT case with no ledger posting.
- Verified late success may recover FAILED/EXPIRED if the slot remains available; otherwise post to SUSPENSE and auto-draft a refund.
- Success transition and ledger posting share one database transaction.  
(§7.1 rules 5–7, §13 cases 18–20, 41, 97)
4. Ledger and Money
-   Use one Ledger Poster and immutable append-only journal entries/lines.  
INVARIANT Every entry has SUM(DEBIT) = SUM(CREDIT) > 0, posting is idempotent, and no manual mutation of executed entries is permitted; corrections use new Adjustments.  
(§5.1, §7.1 rule 7, §9.3–9.4, §19.4)
-   Continuously verify the §9.2 system invariant with database triggers and a scheduled job:
TREASURY + ΣGATEWAY_CLEARING + ΣCOMMISSION_RECEIVABLE  
= ΣMERCHANT_WALLET + PLATFORM_INCOME − PROVIDER_FEE_EXPENSE − GATEWAY_FEE_EXPENSE + GATEWAY_FEE_ACCRUAL + AML_HOLD + CHARGEBACK_RESERVE + SUSPENSE.
GATE Required integrity is 100%, with 0.0000 LYD unexplained drift; any drift is P1 and freezes automated cash-outs.  
(§9.2, §11.1, RB-04)
-   Implement hierarchical, effective-dated commission resolution (merchant, application, rail) → (merchant, rail) → platform default, deterministic 4-decimal rounding, and the identity net merchant + commission = amount.  
(§5.1, §13 case 46)
-   Support and disclose all fee-bearer models before confirmation:
- MERCHANT_ABSORBS: payer 100, merchant 97, commission 3.
- PAYER_SURCHARGE: payer 103, merchant 100.
- SPLIT 50/50: payer 101.50, merchant 98.50.  
(§9.1)
-   Implement ownership-aware postings:
- Platform-held same-day: Treasury and direct provider-fee deduction.
- T+N: per-gateway/credential/environment clearing, optional fee accrual, statement sweep and fee-variance true-up.
- MERCHANT_DIRECT: no platform cash or merchant-wallet movement; book only commission receivable and subsequent netting/collection.
- Internal NeomPay: direct Treasury, no clearing/fee accrual/sweep.
- AML-held platform funds: escrow without recognizing commission until release; merchant-direct AML produces cases/messaging restrictions, not a fictitious cash hold.  
(§1.1 decisions 7–8, §9.3–9.4, §18.10)
-   Use all 15 worked journal entries as acceptance vectors: confirmation, accrual, sweep, variance, surcharge, direct commission, AML hold/release/void, cash-out, refund, chargeback reserve/won/lost, NeomPay confirmation/refund and insufficient-balance chargeback.  
(§9.3–9.4)
-   Implement mismatch tolerances, SUSPENSE handling, batch-net statement reconciliation, late duplicate refunds, and auto-pause of direct routes when commission receivable exceeds its ceiling.  
(§5.3, §13 cases 25, 32, 38, 41–43, 48)
-   Serialize refunds/chargebacks against the source attempt and enforce executed refunds + chargebacks + new amount <= settled_amount. Unknown upstream refund outcomes keep the Adjustment EXECUTING pending inquiry/reconciliation.  
(§6.1, §13 cases 113, 126)
-   Apply negative-balance policy: default ceiling 0 for new merchants; adjustments above the ceiling do not execute and open a P1 case. Recover permitted negative balances from future settlements, block cash-out, and require approved collection/write-off paths.  
(§19.5, OD-8)
5. Security and Governance
-   Implement and unit-test all 14 engineering safeguards:
 1. Prototype-pollution-safe, non-destructive recursiveSet.
 2. Promise-cached consumer registry.
 3. Single-flight auth refresh.
 4. Jittered chained timers.
 5. Atomic rotating-token persistence.
 6. Per-step abort timeouts: 10s auth/inquire; 15s initiate/confirm/refund.
 7. Strict money-step retry boundary.
 8. Raw-text-first parsing, 2 MB response cap, JSON depth 64, XXE disabled.
 9. Sensitive-key and literal-decrypted-secret redaction.
10. HTTPS-only SSRF/DNS-rebinding defenses, private/loopback/link-local blocking and fixed egress.
11. Cryptographically host-pinned credentials.
12. Distributed Redis InvalidationBus.
13. Destination-correct JSON/XML/URL/header encoding and CR/LF rejection.
14. Final post-substitution URL validation, including host, path integrity and no userinfo.  
(§10.1; Stage 1 exit §14.2)
-   Implement and test every control in the 24-item STRIDE register, including replay/environment isolation, amount tampering, enumeration resistance, OTP pumping, inbox storm handling, self-approval prevention, SSRF/XXE, malicious uploads and duplicate ledger posting.  
(§10.2, §13 Groups B/G)
-   INVARIANT PAN fields are memory-only for one outbound step, immediately wiped, excluded from context/database/logs and subject to PCI review. Hosted capture/SAQ-A remains preferred.  
(§2 conflict 9, §5.3, §12 Gate 10)
-   Make credentials write-only, support overlapping rotation, run credential checks on save/nightly/runtime failure, and remove failing credentials from new routing without disturbing pinned in-flight attempts. Assert credential ownership against the attempt merchant.  
(§5.2, §11.2 RB-05, §13 cases 59–66)
-   Enforce least privilege:
- Empty authorities_map grants no access.
- Unknown authority resource keys are rejected.
- Application scopes and checker-domain restrictions are enforced.
- SUPPORT is read-only and has no AML or money-movement access.
- Platform admin role/authority changes revoke sessions and require a different Security Admin checker.  
(§15.2–15.4)
-   INVARIANT Enforce Maker ≠ Checker in both PostgreSQL and middleware. Apply the complete §15.4 matrix to adjustments, cash-outs, commissions, sensitive merchant/application fields, risk rules, AML resolutions, regulatory reports, onboarding decisions, merchant lifecycle, gateway/credential/route changes, users and compliance settings.  
(§5.1, §15.4)
-   Make approval and execution atomic; an approved-but-unexecuted money/risk decision must not remain hanging. Risk-reducing emergency actions may take immediate effect with ratification; risk-increasing or money-moving actions always require prior approval.  
(§15.4, §18.6)
-   Implement pending changes as JSON Patch against base_version: stale requests return to draft, current values remain effective while pending, makers may withdraw, approvals expire after 7 days by default, and changes affect new attempts only.  
(§17.4)
-   Require immediate emergency suspension/tightening ratification within 24 hours. On timeout, issue P2/MLRO escalation; never auto-reverse the protective action.  
(§15.4, §16.8, §18.5, §13 case 127)
6. Interfaces, Onboarding, Compliance, Disputes and Reporting
Interfaces and administration
-   Deliver the three human interfaces and three machine surfaces with their specified authentication:
- Merchant Portal, anonymous Checkout, MFA-protected Admin Back Office.
- Scoped Merchant API, token-paired POS screens, authenticated inbound callbacks.
- POS idle timeout: 15 minutes.  
(§15.1)
-   Implement the Merchant Portal modules: onboarding, dashboard, wallets, applications, links, POS, payments/disputes, cash-out, developers/tokens, Stage-5 credentials, team, statements/statistics.  
(§15.5)
-   Implement Admin modules for onboarding/KYB, merchants, applications/links, AML and operator cases, disputes/adjustments, cash-outs, commissions/rules, gateways, reconciliation/ledger, profitability/liquidity, users/security and settings.  
(§15.6)
-   INVARIANT Checkout and notifications must use bilingual, non-enumerating, non-tipping-off messages. Customers see generic AML/velocity failures; merchants see their gross, commission and net but never gateway cost, platform margin or another merchant’s data.  
(§15.7, §18.9, §20.1)
-   Provide the eight-step Add-a-Gateway wizard, including credential testing, bilingual field builder, signature test tool, flow builder, channel/polling configuration, statement preview, dry-run/mock tests, rollback selection and Maker-Checker submission.  
(§14.1)
Onboarding and merchant lifecycle
-   Implement landing, verified phone/email/Google registration, business/KYB submission, review, decision, notification and first-login setup, with the complete join-request state machine and only one open request per merchant.  
(§16.1–16.3)
-   Apply onboarding timing and review controls:
- Draft expiry after 30 inactive days.
- Review SLA: 2 business days for LOW/STANDARD and 5 business days for HIGH; information requests and provider outages pause SLA with reason.
- Record all seven reviewer checklist items.
- Reject using enumerated, externally neutralized reason codes.  
(§16.2, §16.5, §13 cases 116, 124)
-   Verify each login identity before use; key Google identities by OIDC sub, never auto-link by email alone, and require existing-account authentication plus a second factor before linking. Implement MFA, anti-enumeration, progressive abuse controls, CAPTCHA, SMS-budget alarms, rotating sessions, remote revocation and fresh authentication for sensitive actions.  
(§16.3)
-   Enforce KYB completeness: category-driven required documents, AV scanning before reviewer access, encrypted immutable files, expiry tracking, duplicate hashes, accepted required documents and cleared/dispositioned owners before kyb_status = VERIFIED. Payout accounts must belong to the merchant or a documented related party.  
(§16.4)
-   Implement configurable join-request four-eyes policy. Under recommended RISK_BASED, require a second reviewer for HIGH risk, non-clear screening, PEP, high-risk category, volume-threshold breach, payout ownership mismatch, previous rejection or duplicate/related indicators; triggered rejections also require four eyes.  
(§16.5, §16.9, OD-2)
-   Make approval atomic across join request, merchant activation/KYB/risk tier, default risk/commercial posture, audit log and notification outbox. PENDING merchants may use sandbox by default but cannot use live credentials, live links or cash-out until ACTIVE.  
(§16.6, OD-10)
-   Implement all specified bilingual notification events through the transactional outbox, including onboarding, suspension/reinstatement, KYB expiry, cash-out, approvals and disputes. Public/merchant templates must reject AML-confidential variables at save time.  
(§5.6, §16.7)
-   Implement merchant lifecycle restrictions for PENDING, ACTIVE, SUSPENDED, REJECTED and CLOSED. Closure requires zero balance, no in-flight attempts, holds, reserves or open disputes.  
(§16.8, §13 case 129)
-   Detect re-applications/related parties using tax/registration IDs, owner national ID, bank account, phone, device fingerprint and document hash; force four-eyes and raise proposed risk one level without automatically rejecting solely on a match.  
(§16.9)
-   Implement KYB refresh:
- Expiry notices at 30 and 7 days.
- Suspension when a required document is expired for more than 30 days, unless approved extension.
- Re-verification: HIGH yearly, STANDARD every 2 years, LOW every 3 years, configurable.
- Event-driven review for owner/legal/bank/category changes and significant volume jumps.  
(§16.10)
AML and regulatory compliance
-   Implement all seven AML layers: onboarding, ongoing/list-update screening, local hot-path posture, deferred transaction monitoring, case management, reporting and retention/governance.  
(§18.1)
-   Integrate a pluggable screening provider for sanctions, PEP, adverse media and internal watchlists. Support sync/async results, list versions, Arabic/Latin normalization and transliteration, reproducible input hashes, score/disposition history and expiring false-positive suppression. Never send documents to the provider.  
(§18.2)
-   INVARIANT Provider failure at onboarding is fail-closed: approval is impossible. The ordinary payment hot path must not wait on a provider; use local cached posture/rules. Where a rail mandates synchronous screening, default timeout is 800 ms, with configured amount-dependent fail-open-and-flag/fail-closed behavior.  
(§18.2, §18.4)
-   Screen merchants, owners/controllers/signatories and available payer identifiers. Default beneficial-owner threshold is 25%, including control-based owners and senior managing official fallback.  
(§18.3, OD-6)
-   Implement versioned/effective-dated rules for all seven specified types and HOLD, FLAG, BLOCK, CASE_ONLY actions. Evaluate cheap rules atomically in the attempt guard, deferred rules at confirmation and pattern analytics daily; aggregate anti-structuring by subject across links/apps/rails. Require rule dry-runs over historical/synthetic traffic before activation.  
(§18.4–18.5)
-   Implement explainable severity escalation and case workflow. Default case SLAs:
- CRITICAL: 4 hours.
- HIGH: 1 business day.
- MEDIUM: 3 business days.
- LOW: 5 business days.  
A case cannot close without rationale and, for holds, a ledger outcome. MLRO approval and ledger resolution must be atomic.  
(§18.6)
-   On confirmed sanctions match, emergency-suspend, freeze cash-out, retain holds and draft an STR. Potential matches block onboarding or cash-out pending disposition; list-update matches restrict cash-out immediately and suspend acceptance only at CRITICAL severity.  
(§18.7)
-   Make regulatory reporting configuration-driven with source references and no hard-coded CBL threshold. Support large-transaction, suspicious-activity and periodic reports, the full approval/submission/acknowledgement workflow, frozen approved payload hashes and linked corrections.  
INVARIANT A PROVISIONAL rule cannot generate a live filing; suspicious activity always requires human review.  
(§18.8)
-   Enforce no tipping-off, AML read auditing, restricted confidential access and configurable retention—default 5 years after relationship end, pending Legal/CBL confirmation. Ledger records without personal data remain after personal-data erasure/anonymization.  
(§18.9, OD-4)
-   Produce the monthly compliance governance pack: screening outcomes/false positives, rule precision, case age/SLA, onboarding decision time, list-update outcomes, filings versus due, emergency ratifications and rule-change approvals.  
(§18.11)
Disputes and financial reporting
-   Intake disputes through verified webhook, statement or manual Finance entry; deduplicate across channels and implement the evidence lifecycle. Missed evidence deadline becomes EXPIRED and is treated as LOST unless rail rules specify otherwise.  
(§19.1–19.2)
-   INVARIANT SYSTEM_AUTOMATION may draft a chargeback Adjustment but can never check, approve or execute it. No wallet or ledger movement occurs before a human FINANCE checker approves; execution and reserve posting are atomic.  
(§19.3; WS-D exit §14.3)
-   Implement WON, LOST, AML-held and wrong-adjustment outcomes exactly as §19.4; link prior refunds to prevent double repayment.  
(§19.4, §13 case 126)
-   Derive every financial figure exclusively from journal lines/checkpoints. Closed periods must be reproducible by as_of, content-hash snapshotted, and heavy reads must use materialized views/read replica without contending with posting.  
(§20.1)
-   Implement ledger-defined gross commission, realized/accrued gateway cost, net revenue, chargeback losses, refund contra-revenue, net contribution and commission receivable. Commission on AML-held funds is recognized only upon release.  
(§20.2)
-   Implement liquidity panels for invariant drift, Treasury cover, clearing age, cash-out forecast, holds/reserves and receivables/negative balances, with the specified alerts.  
(§20.4)
-   Implement merchant volume, quality, mix, risk, cash and monthly statement views.  
GATE Statements reconcile exactly to wallet journal lines, and each closing balance equals the next statement’s opening balance.  
(§20.5)
7. Operations and SLOs
- Instrument and enforce these exact SLOs:  
(§11.1)
Metric	Acceptance target	Required response
Attempt initiation availability	99.9% valid states, excluding upstream gateway faults	Freeze non-essential gateway rollouts when monthly error budget burn is >50%
OTP confirmation latency on synchronous rails	p95 < 4.0s to terminal state	Investigate gateway latency/consumer contention
Webhook processing lag	p95 < 30.0s, received_at to processed_at	Scale inbox workers; inspect dedupe locks
UNKNOWN resolution	95% within 24 hours	Escalate through RB-03, prioritize by amount
Statement reconciliation freshness	99% ingested within 4 hours of availability	Alert Finance; inspect SFTP/parser
Ledger invariant integrity	100%, 0.0000 LYD unexplained drift	Immediate P1; freeze automated payouts
-   Keep webhook receiving lightweight: durable insert before processing, idempotent acknowledgement in <10 ms, bounded asynchronous workers and per-route concurrency controls. Early events retry correlation for 60 seconds before alerting.  
(§10.2 T-14, §13 cases 15, 24, 104)
-   Implement operator queues and SLAs for UNKNOWN, HELD, CONFLICT, MISMATCH, LATE_SUCCESS, MANUAL_REVIEW and UNMATCHED_STATEMENT, including bulk inquiry and Maker-Checker resolution.  
(§5.5, §11.2, §20.6)
-   Operationalize all five runbooks:
- RB-01: breaker, route hiding/failover and half-open credential probes.
- RB-02: partner-confirmed signature/IP changes, overlapping rotation and raw-inbox replay.
- RB-03: bulk inquiry, statement/operator resolution for no-inquiry rails.
- RB-04: immediate payout halt, re-ingest/matching, variance and approved corrections.
- RB-05: failing credentials removed from ranker, in-flight pinning and merchant/platform rotation.  
(§11.2)
-   Monitor clock/NTP, parser schema drift, statement encodings, route health, alias probes, inbox lag, approval age and compliance/join-request SLAs. Propagate cache invalidation across nodes in <1 second, while initiation still checks PostgreSQL state.  
(§13 cases 99–115, §20.6)
-   Run the NeomPay ledger-export/Treasury equality check daily; any drift invokes RB-04, stops affected automated payouts and permits only approved Adjustment corrections.  
(§8 Blueprint 7, §13 case 140)
8. Testing and Go-Live
Per-gateway release gates
-   GATE No gateway version may become LIVE without all 12 gates:  
(§12)
 1. Maker-Checker approval with distinct users.
 2. Green 15-scenario sandbox suite.
 3. Green amount-scale/precision/rounding contract test.
 4. Green reference charset/length/uniqueness contract test.
 5. Green inbound/outbound signature tests against captured real samples.
 6. Enforced must_inquire on hint/IP-only/shared-token channels.
 7. Named rollback_version_id.
 8. Previewed route limits, commission profile and statement parser.
 9. VERIFIED evidence, explicit signed HIGH_RISK executive acceptance, or—for INTERNAL rails—green staging contract suite.
10. Passed PCI scope review for every PAN field.
11. Configured canary percentage or merchant allowlist.
12. Wired route alerts and runbooks.
-   The 15 scenarios must cover: happy path; wrong OTP then success; expired OTP; insufficient funds; customer limit; cancel; confirm 5xx → UNKNOWN; confirm timeout → UNKNOWN; malformed response → UNKNOWN; duplicate webhook; out-of-order webhook; late webhook after expiry; amount mismatch; 3-decimal rounding; and cross-environment webhook rejection.  
(§12 Gate 2)
-   Include exact amount/crypto vectors, including Moamalat 10.50 LYD → "10500", 2-decimal NEAREST 76.255 → "76.26", NeomPay 10.505 → "10.505", Moamalat hex-key HMAC, DPay timestamp/raw-body HMAC and Plutu sorted-values HMAC.  
(§6.4, §8, §12 Gates 3–5)
-   Build traceable automated acceptance coverage for all 140 deterministic edge cases, grouped as lifecycle 1–14, trust 15–31, money 32–48, routing 49–58, credentials 59–67, configuration 68–79, security 80–90, UX 91–98, cluster/concurrency 99–115, onboarding/compliance/disputes 116–130 and NeomPay 131–140.  
(§13)
-   Provide Mock Gateway chaos testing, crash/restart and duplicate-delivery tests, fixed historical timezone vectors, canary/rollback drills and monthly multi-node chaos drills.  
(§1.1 decision 10, §13 case 99, §14.2 Stage 6)
Platform compliance go-live gates
- GATE Do not accept live merchants until all seven readiness conditions pass:  
(§18.12)
1. Contracted/integrated screening provider and passing Arabic-name tests.
2. Written CBL reporting requirements with CONFIRMED rules, or signed management approval for internal-only mode.
3. Named MLRO and separate Compliance analyst, with MFA and recorded training.
4. Approved high-risk categories, owner threshold, risk-tier definitions and join-request four-eyes policy.
5. Approved retention and KYB data-protection basis.
6. Successful tabletop covering onboarding hit → hold → case → Checker decision → ledger → report draft, without tipping-off leakage.
7. Initial AML rules dry-run against realistic synthetic traffic.
9. Delivery Phases and Exit Criteria
Phase	Required scope	[GATE] Exit criteria
Stage 1 — Core foundations and ledger	64-table schema, engine, transforms/crypto, safeguards, state/slot handling, inbox, Ledger Poster, Maker-Checker, Mock Gateway	Mock end-to-end payment posts a balanced entry; continuous invariant green; all 14 safeguards unit-tested. (§14.2)
Stage 2 — OTP and redirect rails	OTP/redirect, velocity/AML guard, Test Console, test runner; DPay, Plutu, MyPay, T-LYNC, Sadad, Edfali	First aggregator and first direct OTP route pass all 12 gates and process canary live traffic. (§14.2)
Stage 3 — Embedded, push, QR and POS	Widgets, QR/push/pay-code/deep-link/hybrid, realtime POS; Moamalat, LYPay, OnePay, MobiCash, Yussor, Sahara, MPGS 3DS2	Moamalat card and LYPay/OnePay POS QR live with mandatory server inquiry. (§14.2)
Stage 4 — Reconciliation, fees and refunds	Statement ingestion, accrual/true-ups, approved refund/void, breakers, SLO/runbooks	Two full T+N reconciliation cycles close with 0.0000 LYD unexplained drift. (§14.2)
Stage 5 — Merchant-owned and manual rails	Merchant Direct credentials, receivables/netting, manual/agent rails	First merchant-direct merchant completes payment and full commission-netting cycle. (§14.2)
Stage 6 — Scale and native adapters	Native Adapter framework, remaining verified partner profiles, multi-node invalidation, monthly chaos	Operations onboards a new gateway through the wizard in <4 hours with zero code deployment. (§14.2)
Additional mandatory parallel workstream exits:
- WS-A Identity/Onboarding, Stages 1–2: test merchant completes registration → KYB → approval → first sandbox payment; every transition has audit and notification evidence.  
(§14.3)
- WS-B Compliance, Stages 2 and 4: seeded sanctions subject blocked; threshold rule opens hold/case; provisional reporting rule proven unable to file live.  
(§14.3)
- WS-C Interfaces/Reporting, Stages 3–4: closed-day profit equals relevant journal lines; merchants cannot see gateway cost.  
(§14.3)
- WS-D Disputes, Stage 4: simulated dispute creates a DRAFT Adjustment; no money moves before Checker approval.  
(§14.3)
- WS-E NeomPay, Stage 2: staging contract suite green and daily cross-ledger equality green for two consecutive weeks. NeomPay is recommended as the first production rail, subject to OD-5.  
(§14.3)
10. Management Decisions, Dependencies and Scope Boundaries
Management decisions required
The defaults below are design-recommended baselines, not evidence that management has decided. Record the decision and owner by the stated deadline. (§21)
ID	Decision and recommended default	Needed before / owner
OD-1	CBL reporting thresholds, formats, deadlines, receiving unit and merchant-direct reportability; default internal-only, rules PROVISIONAL	Compliance readiness / Stage 4; Compliance/Legal
OD-2	Join-request second checker; default RISK_BASED	Stage 1 exit; Management
OD-3	Screening provider; select on Arabic matching, coverage, latency, residency and price	Readiness / Stage 2; Compliance/Engineering
OD-4	KYB/AML/audit retention; default 5 years, subject to CBL confirmation	Stage 1; Legal
OD-5	NeomPay contract ownership and first-rail decision; default NeomPay first	Stage 2; NeomPay lead/Engineering
OD-6	Owner threshold and high-risk categories; default 25% plus documented list	Stage 1; Compliance
OD-7	Mode TTL ceilings; default OTP 20m, redirect 30m, QR/push 15m	Stage 2; Product
OD-8	Negative-balance ceiling/recovery; default 0, raised by Maker-Checker	Stage 4; Finance/Risk
OD-9	Emergency suspension authority/window; default Operator or Compliance, ratified by MLRO/different Compliance within 24h	Stage 2; Compliance
OD-10	Sandbox for PENDING merchants; default allowed	Stage 2; Product
OD-11	Named MLRO, analysts and finance checkers; at least one MLRO and separate Compliance analyst	Before live launch; Management
Explicit assumptions
- Base currency is LYD; multi-currency settlement is limited to the specified international card rails. (§22)
- One legal entity owns Treasury, platform income and platform-held clearing accounts. (§22)
- Regulatory content is design intent, not legal advice; counsel/regulator confirmation is required before launch. (§22)
- Merchant-direct settlement arrives in Stage 5; until then merchants settle through the platform. (§22)
- SMS and email use third-party transactional providers behind the outbox; provider choice does not alter the data model. (§22)
External dependencies
- Obtain official partner documentation, captured contract samples, sandbox/live credentials, callback/IP/signature details, inquiry capabilities and statement formats for enabled external gateways. Unverified profiles require Gate-9 treatment before production. (§3.1–3.2, §12 Gate 9)
- Obtain written CBL/Legal determination of reporting obligations, thresholds, formats, deadlines, receiving channel/unit and merchant-direct scope; reporting output adapters remain pending that specification. (§18.8, OD-1)
- Contract and integrate the AML screening provider, including Arabic-name capability and list-update/re-screening support. (§18.2, OD-3)
- Secure the NeomPay team’s authoritative contract and named owner. Its documented endpoint paths are currently illustrative placeholders; staging must prove all seven required capabilities, wallet-type code table, mTLS and ledger export. (§8 Blueprint 7, OD-5)
- Provision transactional SMS/email, Google OIDC, encrypted document storage and malware scanning, statement SFTP/API/upload sources, card acquirer/3DS access and required infrastructure such as PostgreSQL, Redis, fixed egress, NTP and reporting read capacity. (§5–§6, §15–§18, §20, §22)
- Complete PCI scope review for PAN rails; card-scheme certification and the formal PCI-DSS assessment remain separate operational projects. (§12 Gate 10, §22)
Out of scope or explicitly unresolved
- Out of scope: tax/VAT treatment and commission invoicing/accounting entries. (§22)
- Out of scope: the card-scheme certification and PCI-DSS assessment process itself. (§22)
- Out of scope: customer-support ticketing/chat beyond read-only Support and field history. (§22)
- Out of scope: merchant mobile applications; specified surfaces are Merchant Portal and API. (§22)
- Unresolved until OD-1: live CBL filing parameters and merchant-direct reportability. Internal-only detection/hold/record mode is permitted by documented management decision; provisional rules cannot file. (§18.8)
- Unresolved until partner evidence arrives: production behavior of UNVERIFIED/PARTIAL gateway profiles; do not treat modeled matrix entries as verified contracts. (§3.1–3.2)
- Unresolved NeomPay configuration: authoritative endpoint paths, proposed mode TTLs and the authoritative wallet-type table must be confirmed through the internal contract and Gates 5/9. (§8 Blueprint 7)
- Future requirement, not presently designed: genuine multi-wallet/split-settlement selection would require a new deterministic application_wallet_rules model; the one-wallet constraint must not simply be relaxed. (§17.2)
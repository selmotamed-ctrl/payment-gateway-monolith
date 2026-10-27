# **MASTER ARCHITECTURE & TECHNICAL SPECIFICATION · VERSION 4.1 (ULTIMATE CONSOLIDATED EDITION — RESTORED & EXTENDED)**

# **Unified Dynamic Payment Gateway & Payment Links Platform**

**Subtitle:** One zero-code gateway engine for every rail: four-layer catalog, 10-phase declarative flow engine, a trusted confirmation layer, and an ownership-aware double-entry ledger — consolidated and hardened from all four predecessor specifications (Design v2, Master Architecture Spec, Unified Engineering Specification, and Master Design v3.0) into a single definitive production blueprint. **v4.1** additionally restores, from the original management proposal, merchant onboarding, the AML & compliance program, interface and role governance, the automated dispute workflow, platform profitability reporting and the NeomPay first-party rail (see §2.1).

Author: Platform Engineering Group  
**Date:** October 2026 · Libya (Central Bank of Libya Compliant) & International Switches  
Coverage: Moamalat (NPG) · LYPay (CBL Instant Payment) · Numo Pay · Sadad (Almadar) · Libyana · Edfali / Edfaa Li (BCD) · MobiCash (Masarat) · Tadawul / T-LYNC · OnePay · Yussor Pay (NCB) · Sahara Pay · Masrefy Pay (Jumhouria Bank) · Hawelli (Zaho) · GPay Libya & Google Pay · Visa / Mastercard (MPGS / 3DS2) · Evo Pay · NeomPay (first-party wallet) · Aggregators (DPay, Plutu, MyPay)

## **Contents**

- **PART I: FOUNDATIONS**
    - 1. Executive Summary and Architectural Vision
    - 2. Source Design Comparison and Consolidation Register
    - 3. Research Foundation: The Libyan & International Gateway Landscape
- **PART II: PLATFORM CORE & DATA MODEL**
    - 4. Core Domain Concepts: The Four-Layer Catalog & Visible Rails Formula
    - 5. Complete MySQL / MariaDB Database Schema (51 Core Tables Across 5 Groups, plus 13 v4.1 Tables in Group F)
- **PART III: THE UNIVERSAL RAIL ENGINE**
    - 6. Engine Contract, Client Actions, Auth Registry, Transforms & Crypto Engine
- **PART IV: COLLECTION MODES, STATE MACHINE & BLUEPRINTS**
    - 7. The Attempt Lifecycle State Machine and Slot Reservation Invariant
    - 8. Seven Production Configuration Blueprints
- **PART V: TRUST, VERIFICATION AND THE DOUBLE-ENTRY LEDGER**
    - 9. Money, Fee Bearers, Ownership Models & 10 Worked Journal Entries
- **PART VI: GOVERNANCE, SECURITY, THREAT MODEL & OPERATIONS**
    - 10. Fourteen Engineering Safeguards & STRIDE Threat Model
    - 11. Service-Level Objectives (SLOs), Incident Runbooks & DR Replay
- **PART VII: QUALITY, TESTING AND THE 140-CASE EDGE-CASE MASTER CATALOG**
    - 12. The Twelve Go-Live Gates
    - 13. The Complete 140-Entry Edge-Case Master Catalog
- **PART VIII: ADMIN WIZARD, API SURFACE & DELIVERY ROADMAP**
    - 14. The 8-Step Admin "Add-a-Gateway" Wizard & 6-Stage Delivery Plan
- **PART IX: PLATFORM INTERFACES, ONBOARDING, GOVERNANCE & COMPLIANCE PROGRAM (v4.1)**
    - 15. Actors, Interfaces, Roles & the Four-Eyes Matrix
    - 16. Merchant Onboarding & Join Request Flow
    - 17. Applications, Wallets & Detail Governance
    - 18. AML & Compliance Program
    - 19. Disputes, Chargebacks & Automated Drafting
    - 20. Platform Profitability, Liquidity & Statistics
- **PART X: MANAGEMENT DECISIONS, ASSUMPTIONS & TRACEABILITY (v4.1)**
    - 21. Management Decisions Requested
    - 22. Assumptions & Out-of-Scope Items
    - Appendix A: Traceability from the Original Proposal to v4.1
    - Appendix B: Glossary of Terms Introduced or Clarified in v4.1

# **PART I: FOUNDATIONS**

## **1\. Executive Summary and Architectural Vision**

This specification is the single, authoritative, consolidated design for the **Unified Dynamic Payment Gateway & Payment Links Platform**: the system that lets a merchant publish a payment link, integrate via API, or take a payment at a Point of Sale (POS), and lets the platform collect that payment through any gateway in the Libyan market or through an international card scheme without writing a line of gateway-specific code per integration.

An operator adds a gateway from the Admin Back Office dashboard by describing:

1. How to authenticate (`GatewayAuth` & `ApiConsumer` registry),  
2. What the customer must enter (`RailField` compiled to cached Zod validators),  
3. Which HTTP calls start, pre-validate, confirm, inquire, cancel, and refund a payment (`Flow` & `FlowStep` stacks across 10 phases),  
4. How the result arrives (`ConfirmationChannel` across 7 trust-ranked channels),  
5. How gateway status and error codes map to canonical platform statuses (`StatusRule` & `ErrorMap`), and  
6. How the money settles (`CredentialSet` ownership & `GLAccount` clearing/treasury routing).

Where declarative configuration genuinely cannot express a gateway (proprietary binary protocols, bespoke hardware encryption, or non-standard multi-leg 3-D Secure exchanges), a **Native Adapter** plugs into the same registry under the exact same contract, state machine, inbox, verifier, and single Ledger Poster.

### **1.1 The Twelve Headline Architectural Decisions**

1. **Four Layers Instead of One:**  
   * **Gateway:** One technical integration with one external system (environments, base URLs, auth, flows, channels, status/error mappings, amount settings).  
   * **Credential Set:** Whose account and secrets (`PLATFORM` or `MERCHANT`), per environment (`SANDBOX` or `LIVE`), with an explicit settlement target (`PLATFORM_CLEARING`, `MERCHANT_DIRECT`, `PROVIDER_HELD`).  
   * **Rail:** What the customer sees and chooses at checkout (e.g., Edfali, Sadad, LYPay, Visa/Mastercard), owning the customer form, bilingual labels, logo, currency, and capability flags.  
   * **Route:** The binding of a Rail to a Gateway through a Credential Set, carrying priority, cost model, min/max limits, daily cap, circuit-breaker health, maintenance windows, and merchant/app/channel/risk-tier scope.  
2. **Collection Mode and Confirmation Channel Are Independent Axes:**  
   * **Axis A (Collection Mode):** What the customer does (`OTP_PULL`, `REDIRECT`, `EMBEDDED`, `PUSH_APPROVAL`, `QR_DISPLAY`, `PAY_CODE`, `DEEP_LINK`, `MANUAL`, `HYBRID`).  
   * **Axis B (Confirmation Channel):** How the platform learns the result (`SYNC_RESPONSE`, `WEBHOOK`, `INQUIRY / POLL`, `RETURN_URL`, `BROWSER_CALLBACK`, `STATEMENT`, `OPERATOR_CONFIRMATION`). Any mode combines with any valid channel ordered by trust.  
3. **A Declarative 10-Phase Flow Engine with a Closed Transform Library and Native Escape Hatch:**  
   * Supports 10 lifecycle phases (`CREDENTIAL_CHECK`, `PRE_INITIATE`, `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, `REFUND`, `VOID`, `CAPTURE`, `SETTLEMENT_FETCH`) and a closed library of pure, typed, save-time-validated transform operations (§6.3) (`TransformPipe[]`). Zero arbitrary scripting (`eval` is strictly prohibited).  
4. **Browser Events and Return URLs Are Never Trusted:**  
   * Money is posted to the ledger **only** after server-verified confirmation confirming all five facts: status \= success, our reference matches, settled amount matches within route rounding tolerance, currency matches, and environment matches. Widget callbacks (`completeCallback`) and redirect `return_url` hits are untrusted doorbells that only trigger `VERIFY` (inquiry).  
5. **Immutable, Versioned Configuration with In-Flight Attempt Pinning:**  
   * Every gateway or rail edit drafts a new immutable `gateway_versions` snapshot (`DRAFT` \-\> `SANDBOX_VERIFIED` \-\> `PENDING_APPROVAL` \-\> `LIVE`). Every `payment_attempts` row pins `gateway_version_id`, `route_id`, `credential_set_id`, and `commission_profile_id` at creation so in-flight payments are never mutated by mid-day admin edits.  
6. **Uncertain Outcomes Become `UNKNOWN` and Are Never Retried Blindly:**  
   * A timeout, connection reset, HTTP 5xx, or extraction failure on a `MOVES_MONEY` step transitions the attempt to `UNKNOWN`, holds the single-use link slot reservation (`active_locked_count`), and triggers automated background inquiry/polling, statement reconciliation, or Maker-Checker operator resolution.  
7. **Ownership-Aware Double-Entry Ledger Rooted in Physical Reality:**  
   * Platform-held settlement posts through per-gateway `GATEWAY_CLEARING` accounts with optional `GATEWAY_FEE_ACCRUAL` and T+N bank sweep true-ups into `TREASURY`. Merchant-owned accounts (`MERCHANT_DIRECT`) never touch platform cash or merchant wallets; they book only platform commission into `COMMISSION_RECEIVABLE` (collected via wallet netting, invoice, or card-on-file).  
8. **Four-Layer Risk & Commercial Governance:**  
   * Field-level `detail_change_logs`, CBL-compliant KYB/AML screening with automatic `AML_HOLD` escrow and correlated velocity-AML escalation, atomic sliding-window Velocity Rules, and versioned Commission Profiles with three fee-bearer models (`MERCHANT_ABSORBS`, `PAYER_SURCHARGE`, `SPLIT`).  
9. **Fourteen Code-Level Engineering Safeguards & STRIDE Threat Mitigation:**  
   * Prototype-pollution-safe `recursiveSet`, Promise-cached consumer registry, single-flight token refresh, chained `setTimeout` with jitter, rotating refresh-token DB persistence, `AbortController` timeouts, strict confirm retry boundaries, raw-text-first parsing, multi-layer literal secret redaction, DNS-rebinding/SSRF protection, host-pinned credentials, distributed `InvalidationBus`, destination-aware template encoding, and final-URL re-validation.  
10. **Nothing Goes Live Untested (12 Go-Live Gates):**  
    * Mandatory dry-run simulation, contract tests for amount scaling/rounding and signature canonicalization against captured real samples, 15-scenario automated test suite per rail, built-in Mock Gateway chaos testing, and canary rollouts.
11. **A Complete Merchant Lifecycle and Compliance Program (v4.1):**  
    * Join Request onboarding with KYB documents and beneficial-owner screening; a pluggable screening-provider integration point; a declarative, versioned AML rule engine; case management under Maker-Checker; configuration-driven CBL reporting that never hard-codes a threshold; role-based interfaces with an explicit four-eyes action matrix (§15–§18).  
12. **First-Party Rails, Disputes and Ledger-Derived Reporting (v4.1):**  
    * NeomPay is an `INTERNAL` rail under the same engine contract; chargebacks are drafted automatically but authorized only by a human checker; platform profit, liquidity and merchant statistics are computed exclusively from `journal_lines` (§19–§20, Blueprint 7).

### **1.2 Platform Scope at a Glance**

| Attribute | Specification |
| :---- | :---- |
| **Document Status** | Final Production Blueprint v4.1 (v4.0 consolidation of Design v2, Master Spec DOCX, Unified Spec and v3.0, **plus** restored and extended content from the original management proposal) |
| **Target Jurisdiction** | Libya (Central Bank of Libya E-Payment Regulations 2022, Circulars 10/2017 & 7/2020) & International Switches |
| **Base Currency** | LYD as `DECIMAL(18,4)` (3-decimal Dirham precision; integer minor units \* 1000 & 2-decimal pipes supported; floats forbidden) |
| **Security Governance** | Strict Maker-Checker (Four-Eyes) on all sensitive mutations; AES-256-GCM at rest (`keyId:iv:authTag:ciphertext`) |
| **Covered Gateways (20)** | Moamalat NPG, LYPay, Numo Pay, Sadad, Libyana, Edfali/Edfaa Li, MobiCash, Tadawul/T-LYNC, OnePay, Yussor Pay, Sahara Pay, Masrefy Pay, Hawelli, GPay Libya, Google Pay, Visa/MC (MPGS/3DS2), Evo Pay, NeomPay (first-party), plus Aggregators (DPay, Plutu, MyPay) |
| **Channels** | Single/Multi-Use Payment Links, Hosted Checkout UI, POS Terminals & Realtime WebSocket/SSE Cashier Screens, Merchant API |
| **Scale of Specification** | 64 MySQL / MariaDB Tables (51 core + 13 identity / compliance / dispute / configuration), 10 Engine Phases, 6-Method Engine Contract, Closed Transform Library, 14 Safeguards, 24 STRIDE Threats, 140 Edge Cases, 7 Blueprints, 12 Go-Live Gates |

## **2\. Source Design Comparison and Consolidation Register**

This v4.0 blueprint unifies all four predecessor documents, resolving every structural and naming conflict in favor of the most rigorous engineering mechanism:

| \# | Conflict Across Predecessor Designs | Authoritative Resolution in v4.0 |
| :---- | :---- | :---- |
| **1** | Single `rails` table (Master DOCX) vs. 3-layer `Gateway/Rail/Route` (Unified Spec) vs. 4-layer `Gateway/CredentialSet/Rail/Route` (Design v2 & v3) | **Four-layer model adopted.** `rails` holds customer-facing catalog & forms; `gateways` holds technical integrations; `credential_sets` holds ownership & secrets; `rail_routes` binds them with priority, cost, health, and scope. |
| **2** | 5 Phases (`PRE_INITIATE`, `INITIATE`, `CONFIRM`, `INQUIRE`, `REFUND`) vs. 9 Phases (`CREDENTIAL_CHECK`, `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, `REFUND`, `VOID`, `CAPTURE`, `SETTLEMENT_FETCH`) | **Unified 10-Phase model.** Combines `PRE_INITIATE` (for bill/subscriber lookup and fee locking before OTP) with all 9 operational phases. `CONFIRM`/`SUBMIT` and `INQUIRE`/`VERIFY` are unified cleanly. |
| **3** | `CONFIRMING` / `CONFIRMED` states (DOCX) vs. `AUTHORIZING` / `VERIFYING` / `SUCCEEDED` (v2/v3) | **13-State Machine with Substatuses \+ Slot Reservation (`active_locked_count`).** Uses `AUTHORIZING` (money step in flight), `VERIFYING` (inquiry/poll in progress), and `SUCCEEDED` (terminal ledger-posted state), while retaining atomic `active_locked_count` slot reservation on `payment_links`. |
| **4** | `DIRECT_SYNC` as a separate interaction mode (DOCX) vs. orthogonal Mode \+ Channel axes (v2/v3) | **Two-Axis Separation wins.** Synchronous completion is expressed via `SYNC_RESPONSE` on Axis B combined with `OTP_PULL` or `QR_DISPLAY` on Axis A. |
| **5** | Fee booked at settlement (v1/Unified) vs. Fee Accrual at confirmation with true-up at settlement (v2/v3) | **Per-route configurable Fee Accrual.** Supports immediate booking to `GATEWAY_FEE_ACCRUAL` at confirmation with variance true-up to `GATEWAY_FEE_EXPENSE` at settlement, plus `MERCHANT_ABSORBS`, `PAYER_SURCHARGE`, and `SPLIT` bearer modes. |
| **6** | AML Hold on platform-held vs. merchant-direct accounts | **Ownership-aware AML hold.** Platform-held funds escrow into `AML_HOLD` GL account; merchant-direct payments (where platform holds no cash) block completion messaging, flag the merchant, and open an operational `aml_cases` investigation. |
| **7** | DPay rounding: whole dinars (Unified Spec) vs. 2-decimal `76.255 -> 76.26` (Design v2/v3) | **Per-gateway configurable Amount Pipeline (`amount_scale`, `amount_precision`, `amount_rounding`)** verified by mandatory pre-launch contract tests and backed by per-route mismatch tolerance policies. |
| **8** | Flat 20-minute session TTL vs. gateway-specific TTL | **`expires_at = min(gateway_session_ttl, platform_ttl)`** (e.g., 10 min for Moamalat/Sadad, 15 min for MobiCash/DPay) with a configurable post-expiry inbox grace window (default 24h; indefinite for no-inquiry rails). |
| **9** | PAN handling: strictly hosted-only vs. Libyan 7/9-digit card OTP input | **Hosted capture preferred (`SAQ-A`); memory-only `PAN` field sensitivity** permitted for Libyan transaction-card OTP rails (MobiCash 7-digit, OnePay 9-digit), wiped immediately after the step and gated by a mandatory PCI review. |
| **10** | API Path Styles (`/links/{key}` vs. `/v1/pay/{linkKey}`) | **Canonical `/v1/` REST \+ SSE surface:** `/v1/pay/{linkKey}` for checkout, `/v1/callbacks/...` and `/inbound/{gateway}/{env}/{token}` for webhooks, `/v1/merchant/...` for merchants, and `/admin/v1/...` for back office. |

### **2.1 v4.1 Restoration & Extension Register**

Version 4.0 consolidated four engineering specifications, but in doing so it dropped several elements of the original management proposal (*"Payment Gateway Platform: Architecture & Design — A Proposal for Management and Partners"*). Version 4.1 keeps **everything in v4.0** and restores or extends the following. Nothing in v4.0 has been removed; where v4.1 changes a v4.0 definition, the change is listed below and marked in the text as **(v4.1)**.

| \# | Gap or inconsistency in v4.0 | v4.1 Resolution | Where |
| :---- | :---- | :---- | :---- |
| **R1** | No merchant onboarding workflow: the Join Request entity, landing page, registration (phone / email / Google), admin review, and approval/rejection notification were reduced to `merchants.status = PENDING` and `kyb_status`. | Full onboarding journey, `join_requests` state machine, KYB document model, notification events, merchant lifecycle states, re-application and duplicate detection. | §16, §5.6 |
| **R2** | AML reduced to holds and cases; no sanctions / PEP / adverse-media screening, no beneficial-owner screening, no per-transaction screening design, no CBL reporting scoping. | Complete AML & Compliance Program: screening-provider integration point, subjects, hot-path vs deferred screening, rules engine, case lifecycle, regulatory reporting (LTR / STR), confidentiality, retention, compliance readiness checklist. | §18, §5.6 |
| **R3** | No description of the three interfaces, roles, and what each can do. | Interface catalogue, role and authority model, four-eyes action matrix, Merchant Portal and Admin Back Office capability maps. | §15 |
| **R4** | **NeomPay**, the original's reference rail and Neom-held Treasury, is absent from the 19-gateway catalogue. | NeomPay added as Gateway #20 (kind `INTERNAL`), Blueprint 7, ledger posting rules, edge cases 131–140. | §3.2, §8, §9.4, §13 Group K |
| **R5** | Maker-checker coverage for **Application** fields (rail whitelist, wallet binding, redirect-domain allowlist) was not stated. | Field-classification matrix for Merchant, Application, Wallet, User and Token fields; pending-change semantics. | §17.3–17.4 |
| **R6** | The original's open question — *should Join Request approval require a second checker?* — disappeared without a decision. | Configurable `join_request.four_eyes_policy` (`ALWAYS` / `RISK_BASED` / `NEVER`), default `RISK_BASED`; flagged as a management decision. | §16.5, OD-2 |
| **R7** | The original's instruction to scope regulatory reporting thresholds against CBL requirements *before the schema is locked* was lost. | Config-driven `reporting_rules` with `PROVISIONAL` / `CONFIRMED` status; no threshold is hard-coded; open item tracked. | §18.8, OD-1 |
| **R8** | No platform-profitability monitoring or merchant statistics. | Ledger-derived profitability, liquidity and merchant statistics model with definitions and reference queries. | §20 |
| **R9** | Chargeback *auto-draft* (rail dispute → proposed Adjustment → human approval) was only implied. | `disputes` entity, system principal that may draft but never approve, evidence deadlines, ledger outcomes for WON / LOST. | §19 |
| **R10** | Original allowed an Application to default to "all wallets"; v4.0 enforces one wallet per application without recording the decision. | Decision recorded: exactly one wallet per application; `rail_whitelist IS NULL` means "all rails". | §17.2 |
| **R11** | Original capped OTP confirmation at 20 minutes; v4.0's `min(gateway TTL, platform TTL)` rule did not say what the platform ceiling is. | Platform ceiling for `OTP_PULL` defaults to **20 minutes**, preserving the original bound; gateway TTL can only shorten it. | §7.1 Rule 3 (clarified in §17.6) |
| **R12** | Internal count inconsistencies: schema stated as "42 tables" (the tables enumerated in §5.1–5.5 total **51**), transform library stated as 30 and 32 operations in different places. | Counts corrected to the enumerated reality (51 existing + 13 new = **64 tables**); the transform library is referred to by its definition in §6.3 rather than a hard-coded count. | §1.2, §5, §6.3 |
| **R13** | Velocity and AML rule edits had no stated approval path although they change risk posture. | All `velocity_rules` and `aml_rules` changes route through maker-checker; emergency tightening permitted with post-hoc ratification. | §15.4, §18.6 |
| **R14** | No explicit policy for a merchant wallet that cannot cover a chargeback or refund. | `negative_balance_ceiling` policy and recovery rules. | §19.5 |
| **R15** | Original's two explicit management questions (AML reporting scoping, Join Request maker-checker scope) had no home. | Consolidated Management Decisions register. | Part X |


## **3\. Research Foundation: The Libyan & International Gateway Landscape**

### **3.1 Market, Regulatory, and Operational Context (Verified to October 2026\)**

* **Market Scale (CBL 2025/2026 Data):** 4.29 million mobile-banking subscribers (200.7M transactions worth 313.6B LYD), \~165,300 POS terminals (288.6M operations), \~5.5 million payment cards, 186,800 e-wallets, and 18.3M instant-payment transactions (108.7B LYD) across **LYPay** and **OnePay**.  
* **Regulatory Framework:** Governed by the National Payments Council's **E-Payment Services Regulation (August 2022\)**, **CBL Circular 10/2017** (mobile payment rules), and **CBL Circular 7/2020** (contracting e-payment companies).  
* **Resilience Imperative:** Historical disruptions (such as the October 2025 nationwide e-payment outage and June 2026 CBL infrastructure isolation) prove that multi-route failover, circuit breakers, durable timers, and statement reconciliation are mandatory for survival.  
* **Evidence Grading Model:**  
  * `VERIFIED (PUBLIC-SDK / OFFICIAL-DOCS)`: Confirmed via official API docs (e.g., CBL LYPay DevPortal, DPay, Plutu, MyPay, T-LYNC) or production open-source SDKs (Moamalat Node/Laravel/Odoo/Flutter).  
  * `PARTIAL (VENDOR-PAGE)`: Confirmed on bank/operator pages or via aggregator wrappers, but direct operator contract specs require partner onboarding.  
  * `UNVERIFIED`: Modeled from app-store listings and comparable switches; ship with an `UNVERIFIED` badge in the catalog and are **blocked from production by Go-Live Gate 9** until partner docs and sandbox credentials arrive.
  * `INTERNAL (FIRST-PARTY)` **(v4.1)**: The counterparty is the operator's own system (NeomPay). There is no third-party documentation to grade; Go-Live Gate 9 is satisfied by a green contract suite against the operator's staging environment and a named owner of the integration contract.

### **3.2 Complete 20-Gateway Technical Integration Matrix**

| \# | Gateway / Operator | Collection Mode(s) (Axis A) | Customer Form Inputs | Auth & Crypto Signing | Amount & Session Quirks | Confirmation Path (Axis B) & Status Check | Evidence Level |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| **1** | **Moamalat NPG** (National Switch / PaySky) | `EMBEDDED (Lightbox) or REDIRECT` | None on our page (Card PAN, Expiry, PIN in Lightbox) | `MID`, `TID` \+ `SecureHash` via `HMAC-SHA256` (**Hex-decoded** `MerchantSecretKey`; sorted `k=v&...`; `HEX_UPPER` / `HEX_LOWER`) | **Dirhams integer (LYD \* 1000), e.g., 10.50 LYD \-\> "10500". TrxDateTime as YYYYMMDDHHmm (Africa/Tripoli). \~10m TTL** | JS completeCallback (hint) \+ IP-allowlisted Webhook (ActionCode \== "00") \+ mandatory FilterTransactions / GetTransactionStatus Inquiry | `VERIFIED (PUBLIC-SDK)` |
| **2** | **LYPay** (CBL Instant Payment, Moamalat-operated) | `QR_DISPLAY (NUMO EMVCo TLV QR) or PUSH_APPROVAL` | Customer alias / IBAN context or None (QR scan) | `TOKEN_ENDPOINT` (OAuth2 Bearer via `/api/v1/auth/token` on CBL DevPortal) | LYD 3-decimal precision. Ceilings: 20k LYD P2P, 100k LYD Merchant. 5s sync confirm window | Sync confirm within 5s (Confirmed/Declined), else Processing \-\> HMAC Webhook (transaction\_status\_update, transaction\_credit\_notice) \+ Enquiry API | `VERIFIED (OFFICIAL-DOCS)` |
| **3** | **Numo Pay** (Moamalat Financial Services) | `EMBEDDED (PayButton SDK), PUSH_APPROVAL or QR_DISPLAY` | None on our page (handled in Numo modal/app) | `MID`, `TID` \+ Hex-key `HMAC-SHA256` over canonical sorted fields | Dirhams integer (LYD \* 1000\) | Signed callback \+ server-to-server verification endpoint (direct online API unconfirmed) | `UNVERIFIED / VENDOR-PAGE` |
| **4** | **Sadad** (Almadar Aljadeed) | `OTP_PULL (2-Step)` | `customer_mobile` (`^091[0-9]{7}$`), `birth_year` (`YYYY`), optional category | `PERMANENT_TOKEN` (Bearer \+ `X-API-KEY`) or `REFRESH_TOKEN` / `USERNAME_PASSWORD` | LYD 2-decimal string (XXX.XX); JSON or multipart/form-data. 10-minute session TTL | Step 1 /verify sends 6-digit SMS OTP & returns process\_id; Step 2 /confirm sends process\_id \+ code \+ invoice\_no \-\> transaction\_id. No inquiry on DPay | `VERIFIED (PUBLIC-SDK)` |
| **5** | **Libyana Pay** (Libyana Mobile) | `OTP_PULL or REDIRECT` | `customer_mobile` (`^09[24][0-9]{7}$`) | Bearer / Basic / Merchant API Key \+ IP Allowlist | LYD 2-decimal or minor units | Step 1 triggers SMS confirmation code; Step 2 submits otp \+ session\_id | `PARTIAL / UNVERIFIED` |
| **6** | **Edfali / Edfaa Li** (BCD Bank) | `OTP_PULL (2-Step)` | `customer_mobile` (`^09[0-9]{8}$`), 4-digit SMS code | Bearer \+ `X-API-KEY` (via Plutu/DPay) or direct SOAP/REST `USERNAME_PASSWORD` | LYD 2-decimal (XXX.XX); multipart/form-data, XML/SOAP, or JSON | Step 1 /verify registers invoice & sends 4-digit SMS code (process\_id); Step 2 /confirm settles (transaction\_id). No status inquiry endpoint \-\> Statement reconciliation mandatory | `VERIFIED (PUBLIC-SDK)` |
| **7** | **MobiCash** (Wahda Bank / Masarat) | `OTP_PULL or QR_DISPLAY` | `card_number` (7-digit MobiCash transaction card ID) or mobile | `PERMANENT_TOKEN` (Merchant API Key) or OAuth2 | LYD 2-decimal (XXX.XX). 15-minute session TTL | Step 1 opens payment\_uuid & sends OTP; Step 2 confirms payment\_uuid \+ otp \-\> bank\_reference. No inquiry on DPay | `VERIFIED (PUBLIC-SDK)` |
| **8** | **Tadawul / T-LYNC** (TDSP) | `REDIRECT (Hosted Checkout) or OTP_PULL` | Optional phone/email on initiate; card/wallet entered on T-LYNC | `API_KEY` / `REQUEST_SIGNATURE` (`store_id` \+ `store_token` \+ HMAC header) \+ IP Allowlist | LYD 2-decimal. Rejects duplicate custom\_ref with HTTP 422 | Customer GET return (hint) \+ IP-restricted POST callback (hint) \+ mandatory POST /receipt/transaction inquiry | `VERIFIED (OFFICIAL-DOCS)` |
| **9** | **OnePay** (CBL Cross-Bank Instant Payment) | `QR_DISPLAY (EMVCo QR), PAY_CODE, or OTP_PULL` | `card_number` (9-digit cross-bank routing code) or None (QR) | `MUTUAL_TLS` (mTLS) / Bearer \+ `HMAC-SHA256` payload signature | LYD 2-decimal (XXX.XX); CBL ceilings updated Feb 2026 | Issuing bank SMS OTP confirm or interoperable QR scan \-\> async Webhook \+ Inquiry / Statement | `PARTIAL (VENDOR-PAGE)` |
| **10** | **Yussor Pay** (NCB / Masarat / MobiMal) | `HYBRID (OTP_PULL, PAY_CODE, QR_DISPLAY)` | 7-digit NCB Pay ID / phone or SMS purchase code / MobiMal QR | Merchant API Key / `USERNAME_PASSWORD` token refresh | LYD 2-decimal (XXX.XX); Bronze/Silver/Gold tier limits | Sync confirm \+ Status Check available (via DPay) | `VERIFIED (PUBLIC-SDK)` |
| **11** | **Sahara Pay** (Sahara Bank / Masarat) | `HYBRID (OTP_PULL, QR_DISPLAY, PAY_CODE)` | 7-digit Sahara Pay ID or 9-digit OnePay / phone | Merchant API Key / Bearer via Masarat switch | LYD 2-decimal (XXX.XX); accepts OnePay & LYPay networks | Sync confirm \+ Status Check available (via DPay) | `VERIFIED (PUBLIC-SDK)` |
| **12** | **Masrefy Pay** (Jumhouria Bank / Masarat) | `OTP_PULL or QR_DISPLAY` | Card/account ID \+ SMS OTP | Via DPay Bearer API Token | LYD 2-decimal (XXX.XX), 15-minute session TTL | Sync confirm \+ Status Check available (via DPay) | `PARTIAL` |
| **13** | **Hawelli** (Zaho / FikraTech) | `HYBRID (PUSH_APPROVAL, QR_DISPLAY, DEEP_LINK, OTP_PULL)` | `customer_mobile` (`+2189xxxxxxxx`) or None (QR/Deep Link) | Bearer (`REFRESH_TOKEN` / `PERMANENT_TOKEN`) \+ HMAC Webhook Secret | LYD 2-decimal (XXX.XX) | Push approval or QR in Hawelli wallet \-\> signed Webhook or poll | `UNVERIFIED` |
| **14** | **GPay Libya** (Libya Guide IT, Permit 204/2023) | `PUSH_APPROVAL or QR_DISPLAY` | `wallet_phone` / gateway number | Signed request (`HMAC` or `RSA`) \+ API Key | LYD 2-decimal (XXX.XX) | Payment request \-\> user accepts/rejects in app \-\> signed callback \+ status API | `UNVERIFIED / VENDOR-PAGE` |
| **15** | **Google Pay** (Tokenized Card Sheet) | `EMBEDDED -> INITIATE` | JS Token Sheet in browser | Encrypted payment token passed to underlying Acquirer Card Rail | Multi-currency (LYD, USD, EUR) | Settled via underlying MPGS / Moamalat card rail inquiry | `VERIFIED` |
| **16** | **Visa / Mastercard** (MPGS / 3DS2) | `REDIRECT (Hosted Checkout) or EMBEDDED (Hosted Session)` | None on our server (`PCI-DSS SAQ-A`) | `BASIC` (`merchant.<ID>:<apiPassword>`) \+ `X-Notification-Secret` / HMAC | 2-decimal (XXX.XX) \+ explicit currency (LYD, USD, EUR) | 3DS2 challenge \-\> Return URL \+ Webhook \-\> mandatory GET /order/{id} Inquiry | `VERIFIED (PUBLIC-SDK)` |
| **17** | **Evo Pay** (`evowallet.net`, Benghazi) | `QR_DISPLAY or PUSH_APPROVAL` | None for QR or Wallet Account ID | Bearer / API Key \+ Signature Header | Nested JSON transAmount: {amount, currency} | `POST Payment -> Webhook + GET Payment inquiry (payment.status == "Captured"). Distinct from EVO Payments Intl` | `UNVERIFIED` |
| **18** | **DPay Aggregator** (DITS) | `REDIRECT (Hosted) or per-method OTP_PULL / EMBEDDED` | Per underlying rail (`pay_method` parameter) | `PERMANENT_TOKEN` (Bearer). **Supports `Idempotency-Key` header** on session open | Observing 2-decimal (76.255 \-\> 76.26) & whole-dinar rounding. 10m/15m TTLs. Merchant-owned direct settlement supported | 6 HMAC-signed webhook events (timestamp.raw\_body, 5m tolerance, 5 retries: 1m, 5m, 15m, 1h) \+ per-rail get inquiry (4 of 7 rails) | `VERIFIED (OFFICIAL-DOCS)` |
| **19** | **Plutu & MyPay Aggregators** | Plutu: OTP\_PULL & REDIRECT  MyPay: REDIRECT (8 aliases) | Plutu: mobile \+ birth\_year  MyPay: hosted selection | Plutu: `API_KEY` \+ `Access-Token` \+ `Secret-Key`  MyPay: `TOKEN_ENDPOINT` (JWT 600s; HTTP 409 on body change) | 2-decimal LYD strings; Plutu sandbox has strict hourly caps | Plutu: SORTED\_VALUES\_HASH callback (uppercase HMAC)  MyPay: X-MYPAY-SIGNATURE raw-body HMAC (5 retries: 10s-10m). Neither has public inquiry | `VERIFIED (OFFICIAL-DOCS)` |
| **20** | **NeomPay** (first-party wallet platform; Neom-managed Treasury) | `PUSH_APPROVAL, OTP_PULL or QR_DISPLAY` (`HYBRID`) | `wallet_id` (`^NP-[0-9]{12}$`, Luhn check digit, wallet-type allow-list) or None (QR / push) | `MUTUAL_TLS` service-to-service (no third-party credentials) | LYD 3-decimal native (`amount_scale 1`, `precision 3`, no rounding); proposed TTL 10 min push / 5 min QR | `SYNC_RESPONSE` (authoritative over mutual TLS) + idempotent `inquire` by `our_reference`; native refund / void / partial refund; posts directly to `TREASURY` (Ledger Rule INTERNAL-1) | `INTERNAL (FIRST-PARTY)` |

### **3.3 Mode-by-Channel Compatibility Matrix**

| Collection Mode (Axis A) | SYNC\_RESPONSE | WEBHOOK | INQUIRY / POLL | RETURN\_URL | BROWSER\_CALLBACK | STATEMENT | OPERATOR |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| **`OTP_PULL`** | **Y** | C | **Y** | \- | \- | **Y** | C |
| **`REDIRECT`** | \- | **Y** | **Y** | **Y (hint only)** | \- | **Y** | C |
| **`EMBEDDED`** | \- | **Y** | **Y** | \- | **Y (hint only)** | **Y** | C |
| **`PUSH_APPROVAL`** | \- | **Y** | **Y** | \- | \- | **Y** | C |
| **`QR_DISPLAY`** | C (LYPay 5s) | **Y** | **Y** | \- | \- | **Y** | C |
| **`PAY_CODE`** | \- | **Y** | C | \- | \- | **Y** | C |
| **`DEEP_LINK`** | \- | **Y** | **Y** | \- | C (hint only) | **Y** | C |
| **`MANUAL`** | \- | \- | \- | \- | \- | **Y** | **Y** |
| **`HYBRID`** | Per sub-mode | Per sub-mode | Per sub-mode | Per sub-mode | Per sub-mode | **Y** | C |

*(Legend: **Y** \= Supported out of the box; **C** \= Conditional on capability probe or security review; **\-** \= Rejected at save-time validation. Hint-only channels never post money alone.)*

# **PART II: PLATFORM CORE & DATA MODEL**

## **4\. Core Domain Concepts: The Four-Layer Catalog & Visible Rails Formula**

1. **Layer 1 — Gateway (`gateways`):** Represents one technical integration with one external system. Holds `code`, `name`, `operator`, `country`, `aliases[]`, `kind` (`DIRECT`, `AGGREGATOR`, `NATIVE_ADAPTER`, `INTERNAL`), `verification_state` (`VERIFIED`, `UNVERIFIED`), and `risk_class` (`NORMAL`, `HIGH_RISK`).  
2. **Layer 2 — Credential Set (`credential_sets`):** Holds the encrypted identifiers and secrets for one Gateway in one Environment (`SANDBOX` or `LIVE`). Defines `owner_type` (`PLATFORM` or `MERCHANT`) and `settlement_target` (`PLATFORM_CLEARING`, `MERCHANT_DIRECT`, `PROVIDER_HELD`). Secrets are write-only (replaceable, never readable back).  
3. **Layer 3 — Rail (`rails`):** Represents what the customer sees at checkout (e.g., `edfali`, `sadad`, `lypay`, `moamalat_card`). Owns `rail_fields` (the bilingual customer input form), display limits, currency, and capabilities (`refund`, `partial_refund`, `void`, `capture`, `recurring`, `refund_window_days`).  
4. **Layer 4 — Route (`rail_routes`):** Binds a `Rail` to a `Gateway` with a `credential_policy` (`PLATFORM`, `MERCHANT_REQUIRED`, `MERCHANT_OR_PLATFORM`), `priority`, `cost_model`, `min_amount`, `max_amount`, `daily_cap_amount`, `status` (`ACTIVE`, `PAUSED`, `DRAINING`), `health_state` (`HEALTHY`, `DEGRADED`, `OPEN_BREAKER`), `maintenance_windows`, and `scope` (`merchant_ids`, `application_ids`, `risk_tiers`, `channels`: `WEB`, `API`, `POS`).

### **The Visible Rails Resolution Formula**

Evaluated dynamically on every `GET /v1/pay/{linkKey}` request:visible\_rails \=

    application.rail\_whitelist

  INTERSECT link.rail\_whitelist

  INTERSECT rails\_with\_live\_commission\_profile(merchant\_id, application\_id, link.amount)

  INTERSECT rails\_with\_at\_least\_one\_route\_where(

        route.status \== 'ACTIVE'

    AND route.health\_state \== 'HEALTHY'

    AND route.min\_amount \<= link.amount \<= route.max\_amount

    AND (route.daily\_processed\_amount \+ link.amount) \<= route.daily\_cap\_amount

    AND NOW() NOT IN route.maintenance\_windows

    AND route.in\_scope(merchant\_id, application\_id, merchant.risk\_tier, channel)

    AND route.credential\_set.status \== 'VERIFIED'

    AND rail.currency \== link.currency

    AND rail.blocked \== false

  )

## **5\. Complete MySQL / MariaDB Database Schema (51 Core Tables Across 5 Groups, plus 13 v4.1 Tables in Group F)**

All tables include id VARCHAR(191) PRIMARY KEY holding a UUIDv7 string (uuid(7)), created\_at DATETIME(3) NOT NULL DEFAULT CURRENT\_TIMESTAMP(3), and updated\_at DATETIME(3) NOT NULL DEFAULT CURRENT\_TIMESTAMP(3). All monetary columns use DECIMAL(18,4) — floating-point types (FLOAT, DOUBLE) are strictly banned. All ciphertexts use AES-256-GCM formatted as `keyId:iv:authTag:ciphertext`.

> **Database engine note.** This design was originally written against PostgreSQL and the platform has since been migrated to **MySQL 8.0+ / MariaDB 10.6+**. The implementation is already converted: `core-back/prisma/schema.prisma` declares `provider = "mysql"`, the connection is made through `@prisma/adapter-mariadb` on top of the `mariadb` driver package, and the initial migration `core-back/prisma/migrations/20261027000000_init/migration.sql` is plain MySQL / MariaDB DDL. The type mapping below therefore follows the MySQL / MariaDB rules: `String` → `VARCHAR(191)` (free-form content declared `@db.Text`), `Bytes` → `BLOB` (the inbound webhook body is `@db.LongBlob`), `Json` → `JSON` (`LONGTEXT` + a JSON validity check), money → `DECIMAL(18,4)`, Prisma enums → native `ENUM` columns, and there are no native array columns (`TEXT[]` / `UUID[]` are stored as `JSON` arrays). The remaining PostgreSQL references in this document are deliberate historical notes about the pre-migration state.

### **5.1 Group A: Platform, Commercial, Risk, Governance & Double-Entry Ledger Entities (18 Tables)**

*(v4.1: column and enumeration amendments to the tables in Groups A–E are consolidated in §5.7. The table counts in the Group headings below were corrected from v4.0 to match the tables actually enumerated.)*

| Table Name | Key Columns & Types | Domain Rules, Constraints & Notes |
| :---- | :---- | :---- |
| **`merchants`** | `legal_name`, `trade_name`, `tax_id`, `registration_no`, `business_category`, `status` (`PENDING\|ACTIVE\|SUSPENDED`), `kyb_status` (`UNVERIFIED\|PENDING\|VERIFIED\|REJECTED`), `risk_tier` (`LOW\|STANDARD\|HIGH`), `commission_receivable_ceiling DECIMAL(18,4)`, `payout_bank_details_json JSON` | Owns applications, wallets, users, and merchant-owned credential sets. Edits to `payout_bank_details_json`, `kyb_status`, or `risk_tier` require Maker-Checker approval and log to `detail_change_logs`. |
| **`users`** | `merchant_id UUID NULL`, `email`, `phone`, `password_hash`, `role` (`GATEWAY_ADMIN\|SECURITY_ADMIN\|FINANCE\|OPERATOR\|MERCHANT_ADMIN`), `authorities_map JSON`, `app_scope_ids JSON`, `is_maker BOOL`, `is_checker BOOL`, `mfa_secret_ciphertext TEXT`, `status` | Zero access by default if `authorities_map` is empty. One user can never act as both Maker and Checker on the same `approval_requests` row. |
| **`applications`** | `merchant_id UUID FK`, `name`, `business_use_description`, `expected_monthly_volume DECIMAL(18,4)`, `assigned_wallet_id UUID FK`, `rail_whitelist JSON`, `redirect_domain_allowlist JSON`, `status` | Enforces single-wallet-per-application to eliminate settlement ambiguity. `redirect_domain_allowlist` prevents open redirects on payment links. |
| **`wallets`** | `merchant_id UUID FK`, `gl_account_id UUID FK UNIQUE`, `currency CHAR(3) DEFAULT 'LYD'`, `status` | Merchant settlement wallet. Balance is never stored as a mutable column; it is derived strictly from the linked `gl_accounts` row. |
| **`access_tokens`** | `merchant_id UUID FK`, `application_id UUID FK`, `name`, `token_hash CHAR(64)`, `last_four CHAR(4)`, `scopes JSON`, `ip_whitelist_enabled BOOL`, `revoked_at DATETIME(3)`, `last_used_at DATETIME(3)` | Format: `pg_live_` \+ 32 random base64url bytes. Plaintext shown once at creation and never stored. |
| **`access_token_ips`** | `token_id UUID FK`, `cidr VARCHAR(191)` | Child table enforcing IP CIDR restrictions on Merchant API bearer tokens. |
| **`payment_links`** | `key VARCHAR(191) UNIQUE`, `application_id UUID FK`, `wallet_id UUID FK`, `amount DECIMAL(18,4)`, `currency CHAR(3)`, `fee_bearer` (`MERCHANT_ABSORBS\|PAYER_SURCHARGE\|SPLIT`), `split_ratio_json JSON`, `infinite_use BOOL`, `use_count INT`, `confirmed_count INT DEFAULT 0`, `active_locked_count INT DEFAULT 0`, `redirect_url TEXT NULL`, `rail_whitelist JSON`, `state` (`PENDING\|COMPLETED\|EXPIRED\|CANCELLED`), `expires_at DATETIME(3)` | `redirect_url` allowed only when `infinite_use = false AND use_count = 1`. Slot reservation invariant: `confirmed_count + active_locked_count <= use_count` (when `infinite_use = false`). |
| **`pos_terminals`** | `application_id UUID FK`, `name`, `location`, `status` | Physical or logical Point-of-Sale terminal belonging to a merchant application. |
| **`pos_screens`** | `pos_id UUID FK`, `screen_code VARCHAR(191) UNIQUE`, `auth_token_hash CHAR(64)`, `realtime_room_id TEXT`, `last_active_at DATETIME(3)` | Paired customer-facing/cashier display joining a WebSocket/SSE room with a 15-minute idle timeout. |
| **`gl_accounts`** | `account_type` (`TREASURY\|GATEWAY_CLEARING\|MERCHANT_WALLET\|PLATFORM_INCOME\|PROVIDER_FEE_EXPENSE\|GATEWAY_FEE_ACCRUAL\|COMMISSION_RECEIVABLE\|AML_HOLD\|CHARGEBACK_RESERVE\|SUSPENSE`), `owner_id UUID NULL`, `gateway_id UUID NULL`, `credential_set_id UUID NULL`, `env TEXT NULL`, `currency CHAR(3)`, `last_checkpoint_id UUID NULL`, `checkpoint_balance DECIMAL(18,4) DEFAULT 0`, `checkpoint_at DATETIME(3)` | One `GATEWAY_CLEARING` account per `(gateway_id, env, credential_set_id)`. Live balance \= `checkpoint_balance + SUM(journal_lines since last_checkpoint_id)`. |
| **`journal_entries`** | `ref_type` (`PAYMENT_ATTEMPT\|ADJUSTMENT\|AML_RELEASE\|SETTLEMENT_SWEEP\|FEE_VARIANCE\|COMMISSION_NETTING`), `ref_id UUID`, `description TEXT`, `created_at DATETIME(3)` | Immutable append-only header. **`UNIQUE(ref_type, ref_id)`** guarantees idempotent single posting per payment attempt or adjustment. |
| **`journal_lines`** | `entry_id UUID FK`, `gl_account_id UUID FK`, `direction` (`DEBIT\|CREDIT`), `amount DECIMAL(18,4) CHECK (amount > 0)` | Immutable append-only lines. The `CHECK` constraint `journal_lines_amount_positive` plus the ledger trigger enforce `SUM(DEBIT) == SUM(CREDIT) > 0` per `entry_id`. |
| **`commission_profiles`** | `merchant_id UUID NULL`, `application_id UUID NULL`, `rail_code TEXT`, `calc_type` (`FLAT\|PERCENTAGE\|TIERED\|HYBRID`), `flat_fee DECIMAL(18,4)`, `percentage_rate DECIMAL(8,6)`, `tiers_json JSON`, `min_fee DECIMAL(18,4)`, `max_fee DECIMAL(18,4)`, `fee_bearer_default TEXT`, `rounding_mode TEXT`, `effective_from DATETIME(3)`, `effective_to DATETIME(3) NULL`, `version INT`, `approval_request_id UUID FK` | Hierarchical resolution: `(merchant, app, rail)` \-\> `(merchant, rail)` \-\> `(platform_default, rail)`. Effective-dated so historical journal entries never mutate. |
| **`velocity_rules`** | `scope_type` (`END_CLIENT_IP\|END_CLIENT_PHONE\|END_CLIENT_CARD\|MERCHANT\|APPLICATION\|RAIL\|LINK`), `scope_value TEXT NULL`, `window_seconds INT`, `max_count INT`, `max_amount DECIMAL(18,4)`, `action` (`REJECT\|FLAG`), `active BOOL` | Evaluated atomically inside the attempt-creation guard transaction. `REJECT` creates a terminal `BLOCKED` attempt for audit. |
| **`aml_cases`** | `subject_type` (`MERCHANT\|END_CLIENT\|PAYMENT_ATTEMPT`), `subject_id UUID`, `trigger_reason TEXT`, `severity` (`LOW\|MEDIUM\|HIGH\|CRITICAL`), `hold_journal_entry_id UUID NULL`, `status` (`OPEN\|PENDING_CHECKER\|RELEASED\|REJECTED_VOID`), `reviewer_notes TEXT` | Correlated escalation: if a payment hits both a `FLAG` velocity rule and an AML threshold, `severity` escalates to `CRITICAL` automatically. |
| **`adjustments`** | `type` (`CHARGEBACK\|REFUND\|MANUAL_CREDIT\|MANUAL_DEBIT\|CORRECTION\|CASHOUT_SUBTRACTION`), `target_gl_account_id UUID FK`, `source_attempt_id UUID NULL FK`, `amount DECIMAL(18,4)`, `reverse_commission BOOL`, `reason TEXT`, `external_dispute_ref TEXT NULL`, `provider_refund_ref TEXT NULL`, `state` (`DRAFT\|PENDING_REVIEW\|APPROVED\|EXECUTING\|EXECUTED\|REJECTED`), `journal_entry_id UUID NULL FK` | Generalizes all non-standard money movements. `EXECUTING` holds automated API refunds while the gateway `REFUND` flow is in flight or `UNKNOWN`. |
| **`cashout_requests` & `approval_requests`** | `cashout_requests`: `merchant_id`, `wallet_id`, `amount`, `destination_bank_json`, `state` (`PENDING\|REJECTED\|PROCESSING\|COMPLETE\|SUBTRACTED`), `adjustment_id`.  `approval_requests`: `subject_type`, `subject_id`, `payload_diff_json`, `maker_user_id`, `checker_user_id`, `state`, `rejection_reason`, `risk_acceptance_note` | Maker ≠ Checker (`checker_user_id <> maker_user_id`) is enforced by the `approval_requests_checker_not_maker` `BEFORE INSERT` trigger — MariaDB forbids a `CHECK` constraint on a column that participates in a foreign key — **and** by the application-level check in `ApprovalService` and the `makerCheckerGuard` middleware. |

### **5.2 Group B: Gateway Catalog, Environments, Auth & Credentials (6 Tables)**

| Table Name | Key Columns & Types | Purpose & Behavior |
| :---- | :---- | :---- |
| **`gateways`** | `code VARCHAR(191) UNIQUE`, `name TEXT`, `operator TEXT`, `country CHAR(2) DEFAULT 'LY'`, `aliases JSON`, `kind` (`DIRECT\|AGGREGATOR\|NATIVE_ADAPTER\|INTERNAL`), `status` (`DRAFT\|SANDBOX_VERIFIED\|PENDING_APPROVAL\|LIVE\|SUSPENDED\|RETIRED`), `active_version_id UUID NULL`, `verification_state` (`VERIFIED\|UNVERIFIED`), `risk_class` (`NORMAL\|HIGH_RISK`) | Top-level integration registry. `aliases` resolves spelling collisions (`Edfali`, `Edfaa Li`, `Adfali`). `HIGH_RISK` flags gateways lacking both webhook signatures and inquiry APIs. |
| **`gateway_versions`** | `gateway_id UUID FK`, `version_number INT`, `snapshot_ciphertext TEXT`, `content_hash CHAR(64)`, `state` (`DRAFT\|SANDBOX_VERIFIED\|PENDING_APPROVAL\|LIVE\|SUPERSEDED\|ROLLED_BACK`), `created_by UUID FK`, `approval_request_id UUID NULL FK`, `change_note TEXT`, `rollback_version_id UUID NULL FK` | Immutable, content-addressed snapshot of all Group B-D configs for a gateway. Attempts pin `gateway_version_id` at creation. |
| **`gateway_environments`** | `gateway_version_id UUID FK`, `env` (`SANDBOX\|LIVE`), `base_urls JSON` (`api`, `checkout`, `inquiry`), `allowed_hosts JSON`, `inbound_ip_allowlist JSON`, `outbound_egress_ips JSON`, `enabled BOOL` | Sandbox and Live never share credentials, path tokens, webhook secrets, or ledger postings. `allowed_hosts` pins credential hostnames (Safeguard 11). |
| **`gateway_auth`** | `gateway_version_id UUID FK`, `env TEXT`, `method` (`NONE\|API_KEY\|PERMANENT_TOKEN\|TOKEN_ENDPOINT\|REFRESH_TOKEN\|USERNAME_PASSWORD\|BASIC\|REQUEST_SIGNATURE\|OAUTH2_CLIENT_CREDENTIALS\|MUTUAL_TLS`), `auth_apply` (`HEADER\|QUERY\|BODY`), `refresh_config_json JSON` | Defines transport authentication per environment, including `refresh_url`, `refresh_period_ms`, `access_token_selector`, and `new_refresh_token_selector`. |
| **`gateway_settings`** | `gateway_version_id UUID FK`, `amount_scale INT` (`1\|100\|1000`), `amount_precision INT` (`0\|2\|3`), `amount_rounding` (`NONE\|NEAREST\|UP\|DOWN`), `amount_format` (`STRING_DECIMAL\|INTEGER_MINOR_UNITS\|NUMBER`), `reference_format JSON` (`charset`, `max_length`, `prefix`), `session_ttl_seconds INT`, `otp_ttl_seconds INT`, `otp_resend_cooldown_seconds INT`, `max_otp_attempts INT DEFAULT 3`, `supports_status_check BOOL`, `status_check_min_age_seconds INT`, `supports_idempotency_key BOOL`, `supports_cancel BOOL`, `rate_limit_per_second INT`, `concurrency_cap INT`, `timeout_ms INT DEFAULT 15000`, `max_response_bytes INT DEFAULT 2097152`, `gateway_timezone TEXT DEFAULT 'Africa/Tripoli'` | Gateway-wide operational and monetary parameters. The amount pipeline (`scale`, `precision`, `rounding`, `format`) is verified by pre-launch contract tests. |
| **`credential_sets`** | `gateway_id UUID FK`, `env` (`SANDBOX\|LIVE`), `owner_type` (`PLATFORM\|MERCHANT`), `owner_merchant_id UUID NULL FK`, `external_merchant_id TEXT NULL`, `settlement_target` (`PLATFORM_CLEARING\|MERCHANT_DIRECT\|PROVIDER_HELD`), `entries_ciphertext JSON` (`key`, `type`, `value`, `is_secret`, `secret_version`, `valid_from`, `valid_to`), `mtls_cert_ciphertext TEXT NULL`, `status` (`UNTESTED\|VERIFIED\|FAILING\|REVOKED`), `last_verified_at DATETIME(3)`, `expires_at DATETIME(3) NULL` | Supports overlapping `secret_version` entries for zero-downtime webhook/API key rotation. `UNIQUE(gateway_id, env, external_merchant_id)` prevents two merchants from registering the same gateway account (Edge Case 63). |

### **5.3 Group C: Customer-Facing Catalog (4 Tables)**

| Table Name | Key Columns & Types | Purpose & Behavior |
| :---- | :---- | :---- |
| **`assets`** | `name TEXT UNIQUE`, `mime` (`image/png\|image/svg+xml`), `size_bytes INT`, `storage_key TEXT`, `sha256 CHAR(64)` | Stores gateway/rail logos. SVGs are sanitized on upload (scripts/event handlers stripped) and served with `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`. |
| **`rails`** | `code VARCHAR(191) UNIQUE`, `name_ar TEXT`, `name_en TEXT`, `logo_asset_id UUID FK`, `collection_mode` (`OTP_PULL\|REDIRECT\|EMBEDDED\|PUSH_APPROVAL\|QR_DISPLAY\|PAY_CODE\|DEEP_LINK\|MANUAL\|HYBRID`), `sub_modes JSON`, `currency CHAR(3) DEFAULT 'LYD'`, `min_amount DECIMAL(18,4)`, `max_amount DECIMAL(18,4)`, `display_order INT`, `blocked BOOL DEFAULT false`, `capabilities JSON` (`refund`, `partial_refund`, `void`, `capture`, `recurring`), `refund_window_days INT`, `instructions_ar TEXT`, `instructions_en TEXT` | Customer-facing payment method. Never hard-deleted once referenced by any attempt; operators use `blocked = true`. |
| **`rail_fields`** | `rail_id UUID FK`, `key TEXT`, `type` (`phone\|number\|string\|otp\|birth_year\|card_number\|pan\|from_list`), `label_ar TEXT`, `label_en TEXT`, `placeholder_ar TEXT`, `placeholder_en TEXT`, `regex TEXT`, `min_length INT`, `max_length INT`, `min_val DECIMAL`, `max_val DECIMAL`, `options_json JSON`, `required BOOL`, `order_index INT`, `sensitivity` (`NORMAL\|SENSITIVE\|PAN`), `normalizer JSON` (`arabic_digits_to_ascii`, `phone_style`) | Compiled into cached backend Zod schemas and serialized to checkout UI. `PAN` fields are memory-only for the single outbound call and wiped immediately. |
| **`rail_routes`** | `rail_id UUID FK`, `gateway_id UUID FK`, `credential_policy` (`PLATFORM\|MERCHANT_REQUIRED\|MERCHANT_OR_PLATFORM`), `priority INT`, `routing_strategy` (`EFFECTIVE_COST\|STRICT_PRIORITY\|WEIGHTED`), `weight INT DEFAULT 100`, `cost_model JSON` (`calc_type`, `flat`, `percent`, `min`, `max`, `bearer`, `accrue_fee_at_confirm`), `mismatch_policy JSON` (`tolerance_amount`, `underpay_action`, `overpay_action`), `min_amount DECIMAL(18,4)`, `max_amount DECIMAL(18,4)`, `daily_cap_amount DECIMAL(18,4)`, `status` (`ACTIVE\|PAUSED\|DRAINING`), `health_state` (`HEALTHY\|DEGRADED\|OPEN_BREAKER`), `maintenance_windows JSON`, `scope JSON` (`merchant_ids`, `application_ids`, `risk_tiers`, `channels`) | `UNIQUE(rail_id, gateway_id, credential_policy)`. The unit of routing, failover, circuit breaking, and fee calculation. |

### **5.4 Group D: Declarative Flow Engine, Crypto, Channels & Mappings (13 Tables)**

| Table Name | Key Columns & Types | Purpose & Behavior |
| :---- | :---- | :---- |
| **`crypto_profiles`** | `gateway_version_id UUID FK`, `name TEXT`, `purpose` (`OUTBOUND_SIGN\|INBOUND_VERIFY`), `algorithm` (`HMAC_SHA256\|HMAC_SHA512\|RSA_SHA256\|SHA256`), `secret_key_ref TEXT`, `secret_key_encoding` (`UTF8\|HEX\|BASE64`), `canonicalization_mode` (`SORTED_KEY_VALUE_AMP\|SORTED_VALUES_HASH\|TEMPLATE_STRING\|JSON_CANONICAL\|RAW_BODY\|TIMESTAMP_DOT_RAW_BODY`), `template_string TEXT NULL`, `included_fields JSON`, `excluded_fields JSON`, `output_encoding` (`HEX_LOWER\|HEX_UPPER\|BASE64`) | Declarative signing and verification recipes covering Moamalat Hex-HMAC, DPay `timestamp.body`, Plutu sorted-values callback hash, MyPay raw-body HMAC, MPGS, and RSA. |
| **`flows`** | `gateway_version_id UUID FK`, `rail_id UUID NULL FK`, `sub_mode TEXT NULL`, `phase` (`CREDENTIAL_CHECK\|PRE_INITIATE\|INITIATE\|SUBMIT\|VERIFY\|CANCEL\|REFUND\|VOID\|CAPTURE\|SETTLEMENT_FETCH`) | Ordered step stack per lifecycle phase. |
| **`flow_steps`** | `flow_id UUID FK`, `order_index INT`, `type` (`HTTP\|COMPUTE\|RENDER\|WAIT\|ASSERT\|BRANCH`), `method TEXT`, `url_template TEXT`, `content_type` (`application/json\|application/x-www-form-urlencoded\|multipart/form-data\|application/xml\|text/xml\|text/plain`), `xml_template TEXT NULL`, `timeout_ms INT`, `success_check JSON`, `side_effect` (`READ_ONLY\|SENDS_NOTIFICATION\|MOVES_MONEY`), `retry_policy` (`SAFE\|SAFE_WITH_COOLDOWN\|NEVER`), `idempotency_config JSON` (`mode`: `NONE\|HEADER\|BODY_FIELD`, `key_name`, `source_template`), `point_of_no_return BOOL` | Every HTTP step declares `side_effect`, `retry_policy`, `idempotency_config`, and `point_of_no_return`. Save-time validator forbids `MOVES_MONEY` with `retry_policy != NEVER` (unless idempotency key is supported and proven). |
| **`step_parameters`** | `step_id UUID FK`, `place` (`HEADERS\|QUERY\|PATH\|BODY\|FORM\|MULTIPART\|XML`), `key TEXT` (dot-path), `source` (`GATEWAY_META\|ROUTE_META\|CREDENTIAL\|ATTEMPT\|CUSTOMER_FIELD\|STATE\|PREVIOUS_RESPONSE\|URLS\|CLIENT_CONTEXT\|CONSTANT\|NOW\|RANDOM\|COMPUTED\|CRYPTO_SIGNATURE`), `selector TEXT NULL`, `constant_value TEXT NULL`, `crypto_profile_id UUID NULL FK`, `transforms JSON` | Ordered `TransformPipe[]` validated for type safety on save. |
| **`step_outputs`** | `step_id UUID FK`, `name TEXT`, `selector TEXT`, `transforms JSON`, `store_as` (`STATE\|PUBLIC\|SETTLED_AMOUNT\|PROVIDER_FEE\|PROVIDER_REF\|NETWORK_REF`), `required BOOL` | `PUBLIC` outputs reach the browser; `STATE` outputs are encrypted in `payment_attempts.context_ciphertext`; missing `required` output on `MOVES_MONEY` triggers `UNKNOWN`. |
| **`status_rules`** | `gateway_version_id UUID FK`, `phase TEXT`, `order_index INT`, `selector TEXT`, `op` (`equals\|not_equals\|in\|exists\|matches`), `value_json JSON`, `canonical_status` (`AWAITING_CUSTOMER\|VERIFYING\|SUCCEEDED\|FAILED\|UNKNOWN`), `canonical_substatus TEXT NULL`, `canonical_error TEXT NULL` | First match wins. No match on a `MOVES_MONEY` step defaults to `UNKNOWN`. |
| **`error_maps`** | `gateway_version_id UUID FK`, `gateway_code TEXT`, `canonical_error TEXT`, `classification` (`RETRYABLE_OTP\|TERMINAL_DECLINE\|LIMIT_EXCEEDED\|GATEWAY_FAULT\|AMBIGUOUS`), `retryable BOOL`, `counts_toward_lockout BOOL`, `counts_toward_breaker BOOL`, `customer_message_ar TEXT`, `customer_message_en TEXT`, `operator_hint TEXT` | Distinguishes customer errors (`RETRYABLE_OTP`, `LIMIT_EXCEEDED`) from gateway faults so customer mistakes never trip circuit breakers. |
| **`confirmation_channels`** | `gateway_version_id UUID FK`, `route_id UUID NULL FK`, `type` (`WEBHOOK\|RETURN_URL\|BROWSER_CALLBACK\|POLL\|STATEMENT\|OPERATOR`), `path_token TEXT UNIQUE`, `crypto_profile_id UUID NULL FK`, `verify_method` (`HMAC_BODY\|HASH_FIELDS\|SORTED_VALUES_HASH\|RSA\|SHARED_TOKEN\|IP_ONLY\|NONE_PLUS_INQUIRY`), `signature_header TEXT NULL`, `timestamp_selector TEXT NULL`, `timestamp_tolerance_sec INT DEFAULT 300`, `ip_allowlist JSON`, `body_format` (`JSON\|FORM\|XML`), `correlation_selector TEXT`, `dedupe_key_selector TEXT NULL`, `event_map JSON`, `must_inquire BOOL`, `ack_status INT DEFAULT 200`, `ack_body_template TEXT` | Weak methods (`SHARED_TOKEN`, `IP_ONLY`, `RETURN_URL`, `BROWSER_CALLBACK`) enforce `must_inquire = true` at save time. |
| **`poll_policies`** | `route_id UUID FK`, `first_after_seconds INT DEFAULT 5`, `backoff_seconds JSON`, `max_duration_seconds INT DEFAULT 900`, `stop_on_states JSON` | Background polling schedule for asynchronous rails. |
| **`widget_definitions`** | `route_id UUID FK`, `kind` (`LIGHTBOX\|IFRAME\|SDK_WEBVIEW\|NATIVE_ANDROID`), `sdk_driver TEXT`, `script_urls JSON`, `script_sri_hashes JSON`, `config_template JSON`, `callbacks_map JSON`, `allowed_origins JSON`, `iframe_sandbox_attrs JSON`, `csp_additions TEXT` | Requires `SECURITY_ADMIN` Maker-Checker approval for any `script_urls` or `csp_additions` change. |
| **`redirect_definitions`** | `route_id UUID FK`, `method` (`GET\|POST_FORM`), `url_source_output TEXT`, `form_fields_output TEXT NULL`, `target` (`SAME_WINDOW\|NEW_TAB\|TOP_FRAME`), `return_method_expected` (`GET\|POST`), `return_params_map JSON` | Declarative HTTP redirect or auto-submitted POST form builder. |
| **`statement_sources` & `manual_instructions`** | `statement_sources`: `gateway_id`, `type` (`API\|SFTP\|UPLOAD`), `schedule_cron`, `parser_config JSON` (`format`: `CSV\|XLSX\|JSON`, `encoding`, `delimiter`, `header_row`, `columns_map`, `date_format`, `timezone`, `supports_batch_net`), `settlement_lag_days INT`, `dedupe_key_template`.  `manual_instructions`: `rail_id`, `instructions_ar`, `instructions_en`, `destination_account_template`, `reference_format`, `proof_upload_allowed BOOL`, `operator_sla_minutes INT`, `auto_expiry_minutes INT` | Makes T+N bank/gateway statement reconciliation and manual transfer rails 100% configuration-driven. |

### **5.5 Group E: Runtime Execution, Audit & Reconciliation Entities (10 Tables)**

| Table Name | Key Columns & Types | Purpose & Behavior |
| :---- | :---- | :---- |
| **`attempt_groups`** | `link_id UUID FK`, `customer_fingerprint CHAR(64)`, `success_count INT DEFAULT 0 CHECK (success_count <= 1)` | Groups all retries and rail switches by one customer on one link. Enforces at most one `SUCCEEDED` attempt per group. |
| **`payment_attempts`** | `reference VARCHAR(191) UNIQUE`, `idempotency_key TEXT`, `link_id UUID FK`, `attempt_group_id UUID FK`, `application_id UUID FK`, `merchant_id UUID FK`, `rail_id UUID FK`, `route_id UUID FK`, `credential_set_id UUID FK`, `gateway_version_id UUID FK`, `commission_profile_id UUID FK`, `env` (`SANDBOX\|LIVE`), `mode TEXT`, `sub_mode TEXT NULL`, `status` (`CREATED\|INITIATING\|AWAITING_CUSTOMER\|AUTHORIZING\|VERIFYING\|UNKNOWN\|SUCCEEDED\|FAILED\|EXPIRED\|CANCELLED\|BLOCKED\|PARTIALLY_REFUNDED\|REFUNDED\|DISPUTED`), `substatus TEXT NULL`, `gateway_reference TEXT`, `provider_reference TEXT NULL`, `network_reference TEXT NULL`, `requested_amount DECIMAL(18,4)`, `surcharge_amount DECIMAL(18,4) DEFAULT 0`, `total_charged_amount DECIMAL(18,4)`, `gateway_amount_wire TEXT`, `settled_amount DECIMAL(18,4) NULL`, `gateway_fee_amount DECIMAL(18,4) NULL`, `platform_commission_amount DECIMAL(18,4)`, `net_merchant_amount DECIMAL(18,4)`, `fee_bearer TEXT`, `currency CHAR(3)`, `customer_fields_masked JSON`, `context_ciphertext TEXT`, `otp_attempts INT DEFAULT 0`, `last_otp_sent_at DATETIME(3) NULL`, `client_ip TEXT`, `user_agent TEXT`, `expires_at DATETIME(3)`, `grace_expires_at DATETIME(3)`, `next_check_at DATETIME(3) NULL`, `ledger_entry_id UUID NULL FK UNIQUE`, `terminal_at DATETIME(3) NULL` | The unified runtime payment record (merging `PaymentLog` and `PaymentAttempt`). Pins `gateway_version_id`, `route_id`, `credential_set_id`, and `commission_profile_id`. `UNIQUE(ledger_entry_id)` prevents double ledger posting. |
| **`attempt_step_logs`** | `attempt_id UUID FK`, `gateway_version_id UUID FK`, `phase TEXT`, `step_id UUID FK`, `step_order INT`, `redacted_request_json JSON`, `redacted_response_text TEXT`, `http_status INT`, `duration_ms INT`, `outcome TEXT`, `created_at DATETIME(3)` | Immutable forensic log of every outbound HTTP call. Preserves raw text for `UNKNOWN` debugging; scrubbed by multi-layer secret redactor prior to insert. |
| **`inbound_events`** | `channel_id UUID FK`, `gateway_id UUID FK`, `env TEXT`, `raw_body_bytes LONGBLOB`, `redacted_headers_json JSON`, `source_ip TEXT`, `verified BOOL`, `verification_error TEXT NULL`, `dedupe_key CHAR(64)`, `attempt_id UUID NULL FK`, `received_at DATETIME(3)`, `processed_at DATETIME(3) NULL`, `processing_result TEXT` | Durable webhook inbox stored **before** any processing and never deleted. `UNIQUE(channel_id, dedupe_key)` absorbs replays and retries. |
| **`operator_cases`** | `attempt_id UUID NULL FK`, `reconciliation_item_id UUID NULL FK`, `kind` (`UNKNOWN\|HELD\|CONFLICT\|MISMATCH\|LATE_SUCCESS\|MANUAL_REVIEW\|UNMATCHED_STATEMENT`), `priority` (`P1\|P2\|P3`), `sla_due_at DATETIME(3)`, `state` (`OPEN\|IN_PROGRESS\|PENDING_CHECKER\|RESOLVED`), `assignee_user_id UUID NULL FK`, `resolution_notes TEXT`, `approval_request_id UUID NULL FK` | Operational queue with SLA timers for human-in-the-loop exception handling under Maker-Checker. |
| **`reconciliation_runs` & `reconciliation_items`** | `runs`: `statement_source_id`, `window_start`, `window_end`, `file_hash CHAR(64) UNIQUE`, `stats_json`.  `items`: `run_id`, `attempt_id NULL`, `our_reference`, `provider_reference`, `batch_reference NULL`, `statement_amount DECIMAL(18,4)`, `statement_fee DECIMAL(18,4)`, `result` (`MATCHED\|AMOUNT_MISMATCH\|MISSING_AT_GATEWAY\|MISSING_LOCALLY\|DUPLICATE`), `operator_case_id NULL` | `file_hash UNIQUE` makes manual or SFTP statement uploads idempotent. |
| **`gateway_health_samples`** | `route_id UUID FK`, `window_start DATETIME(3)`, `definitive_failures INT`, `ambiguous_unknowns INT`, `rate_limits_429 INT`, `successes INT`, `p50_ms INT`, `p95_ms INT`, `p99_ms INT` | Rolling telemetry driving the per-route circuit breaker. |
| **`detail_change_logs` & `audit_log`** | `detail_change_logs`: `actor_id`, `entity_type`, `entity_id`, `field_name`, `old_value`, `new_value`, `created_at`.  `audit_log`: `actor_id`, `role`, `action`, `entity_type`, `entity_id`, `before_json`, `after_json`, `approval_request_id NULL`, `created_at` | Immutable audit trail across all merchant, application, and admin actions. |

### **5.6 Group F: Identity, Onboarding, Compliance, Disputes & Configuration Entities (13 Tables) (v4.1)**

All Group F tables follow the global conventions stated at the top of §5 (UUIDv7 keys, `created_at` / `updated_at`, `DECIMAL(18,4)` money, AES-256-GCM ciphertexts). Tables holding personal or compliance data are listed with their confidentiality class (`PII`, `KYB`, `AML-CONFIDENTIAL`); access to `AML-CONFIDENTIAL` data is restricted to the `COMPLIANCE`, `MLRO` and `SECURITY_ADMIN` roles (see §15.2) and is never exposed to merchants or support staff.

| Table Name | Key Columns & Types | Purpose & Behavior |
| :---- | :---- | :---- |
| **`user_identities`** | `user_id UUID FK`, `kind` (`PHONE\|EMAIL\|GOOGLE`), `identifier_normalized TEXT`, `provider_subject TEXT NULL`, `verified_at DATETIME(3) NULL`, `is_primary BOOL`, `last_used_at DATETIME(3)` | `PII`. One user may link several login identities. `UNIQUE(kind, identifier_normalized)`; for `GOOGLE`, `UNIQUE(provider_subject)` (the OIDC `sub`, never the mutable e-mail alone). Phone numbers are normalized with `phone_normalize(E164)`; e-mails are lower-cased. An identity is usable for login only after `verified_at` is set. |
| **`join_requests`** | `merchant_id UUID FK`, `submitted_by_user_id UUID FK`, `status` (`DRAFT\|SUBMITTED\|IN_REVIEW\|INFO_REQUESTED\|PENDING_CHECKER\|APPROVED\|REJECTED\|WITHDRAWN\|EXPIRED`), `onboarding_channel` (`SELF_SERVICE\|ADMIN_ASSISTED`), `submitted_at`, `assigned_reviewer_id UUID NULL FK`, `sla_due_at DATETIME(3)`, `screening_id UUID NULL FK`, `proposed_risk_tier` (`LOW\|STANDARD\|HIGH`), `four_eyes_required BOOL`, `four_eyes_reasons JSON`, `decision` (`APPROVED\|REJECTED`) `NULL`, `decision_reason_code TEXT NULL`, `decision_notes TEXT NULL`, `info_request_json JSON NULL`, `resubmission_of_id UUID NULL FK`, `approval_request_id UUID NULL FK` | `KYB`. The auditable record of one onboarding attempt (§16.2). A merchant may have several over time (rejected, then corrected and resubmitted); only one may be open. `decision_reason_code` is an enumerated code; free-text notes are internal and never sent to the applicant. |
| **`kyb_documents`** | `merchant_id UUID FK`, `join_request_id UUID NULL FK`, `subject_type` (`MERCHANT\|BENEFICIAL_OWNER`), `subject_id UUID`, `doc_type` (`COMMERCIAL_REGISTRY\|TAX_CERTIFICATE\|ARTICLES_OF_ASSOCIATION\|OWNER_ID\|SIGNATORY_ID\|PROOF_OF_ADDRESS\|BANK_LETTER\|SECTOR_LICENSE\|OTHER`), `storage_key TEXT`, `sha256 CHAR(64)`, `mime TEXT`, `size_bytes INT`, `av_status` (`PENDING\|CLEAN\|INFECTED`), `status` (`UPLOADED\|ACCEPTED\|REJECTED\|EXPIRED`), `reviewed_by UUID NULL FK`, `reviewed_at`, `expires_on DATE NULL`, `rejection_reason_code TEXT NULL` | `KYB`. Encrypted object storage, malware-scanned before any reviewer can open it. `sha256` is indexed across merchants: the same file submitted by two unrelated merchants raises a duplicate-document flag (Edge Case 120). Documents are never overwritten; a replacement is a new row. |
| **`beneficial_owners`** | `merchant_id UUID FK`, `full_name_ar TEXT`, `full_name_en TEXT NULL`, `national_id_ciphertext TEXT`, `date_of_birth DATE`, `nationality CHAR(2)`, `ownership_percent DECIMAL(5,2) NULL`, `role` (`OWNER\|DIRECTOR\|SIGNATORY\|CONTROLLER`), `pep_declared BOOL`, `screening_status` (`NOT_SCREENED\|CLEAR\|POTENTIAL_MATCH\|CONFIRMED_MATCH`), `active BOOL`, `valid_from`, `valid_to NULL` | `PII`, `KYB`. Persons who own at least `aml.owner_threshold_percent` (default 25%) or exercise control (§18.3). Adding or changing an owner after approval is a sensitive edit (Maker-Checker) and triggers re-screening. History is preserved via `valid_from` / `valid_to`. |
| **`aml_screenings`** | `subject_type` (`MERCHANT\|BENEFICIAL_OWNER\|END_CLIENT\|PAYMENT_ATTEMPT`), `subject_id UUID`, `trigger` (`ONBOARDING\|PERIODIC\|LIST_UPDATE\|OWNER_CHANGE\|TRANSACTION\|MANUAL`), `provider_code TEXT`, `provider_request_ref TEXT NULL`, `list_versions_json JSON`, `input_hash CHAR(64)`, `result` (`CLEAR\|POTENTIAL_MATCH\|CONFIRMED_MATCH\|ERROR`), `match_count INT`, `highest_score DECIMAL(5,2) NULL`, `requested_at`, `completed_at NULL` | `AML-CONFIDENTIAL`. One screening event against one subject. `list_versions_json` records exactly which list versions were checked, so a past decision can be reproduced. `input_hash` lets identical inputs be answered from cache without calling the provider. |
| **`aml_screening_matches`** | `screening_id UUID FK`, `list_type` (`SANCTIONS\|PEP\|ADVERSE_MEDIA\|INTERNAL_WATCHLIST`), `list_name TEXT`, `list_entry_ref TEXT`, `matched_name TEXT`, `score DECIMAL(5,2)`, `attributes_json JSON`, `disposition` (`UNREVIEWED\|FALSE_POSITIVE\|TRUE_MATCH\|ESCALATED`), `disposition_by UUID NULL FK`, `disposition_notes TEXT NULL`, `suppress_future BOOL DEFAULT false`, `suppress_until DATE NULL` | `AML-CONFIDENTIAL`. Each candidate hit. A reviewer-confirmed false positive may set `suppress_future` so the same subject / list-entry pair does not reopen on every periodic re-screen; suppression expires at `suppress_until` and is revoked automatically if the subject's identifying data changes. |
| **`aml_rules`** | `code VARCHAR(191) UNIQUE`, `name TEXT`, `rule_type` (`SINGLE_AMOUNT\|CUMULATIVE_WINDOW\|STRUCTURING\|RISK_TIER\|COUNTERPARTY_COUNTRY\|RAIL\|MERCHANT_DIRECT_AMOUNT`), `scope JSON` (`merchant_ids`, `application_ids`, `rail_codes`, `risk_tiers`, `channels`), `params JSON`, `action` (`HOLD\|FLAG\|BLOCK\|CASE_ONLY`), `base_severity` (`LOW\|MEDIUM\|HIGH\|CRITICAL`), `active BOOL`, `version INT`, `effective_from`, `effective_to NULL`, `approval_request_id UUID FK` | Declarative, versioned, effective-dated AML rule set (§18.5). Evaluated in the attempt-creation guard (cheap rules) and at confirmation (deferred rules). Every change is Maker-Checker; the version used for a decision is stored on the resulting `aml_cases` row. |
| **`reporting_rules`** | `authority TEXT DEFAULT 'CBL'`, `report_type` (`LARGE_TRANSACTION\|SUSPICIOUS_ACTIVITY\|PERIODIC_RETURN`), `threshold_amount DECIMAL(18,4) NULL`, `window_seconds INT NULL`, `currency CHAR(3) DEFAULT 'LYD'`, `conditions JSON`, `source_reference TEXT`, `status` (`PROVISIONAL\|CONFIRMED`), `effective_from`, `effective_to NULL`, `approval_request_id UUID FK` | Makes jurisdiction-specific reporting **configuration, not code** (§18.8). A trigger on `regulatory_reports` rejects any production report generated from a rule whose `status` is `PROVISIONAL`: a provisional rule can never produce a live regulatory filing. `source_reference` cites the circular or written CBL instruction that justifies the value. |
| **`regulatory_reports`** | `report_type` (`LARGE_TRANSACTION\|SUSPICIOUS_ACTIVITY\|PERIODIC_RETURN`), `authority TEXT`, `subject_type TEXT`, `subject_id UUID`, `aml_case_id UUID NULL FK`, `period_start NULL`, `period_end NULL`, `status` (`DRAFT\|PENDING_CHECKER\|APPROVED\|SUBMITTED\|ACKNOWLEDGED\|REJECTED_BY_AUTHORITY`), `payload_ciphertext TEXT`, `payload_sha256 CHAR(64)`, `submission_ref TEXT NULL`, `submitted_at NULL`, `confidential BOOL DEFAULT true`, `approval_request_id UUID NULL FK` | `AML-CONFIDENTIAL`. The immutable record of what was reported, when, and by whom. The payload is frozen at `APPROVED`; a correction is a new report that references the original. Existence of an `SUSPICIOUS_ACTIVITY` report is never disclosed to the subject (§18.9). |
| **`disputes`** | `attempt_id UUID FK`, `gateway_id UUID FK`, `rail_id UUID FK`, `external_dispute_ref TEXT`, `source` (`WEBHOOK\|STATEMENT\|MANUAL`), `reason_code TEXT NULL`, `amount DECIMAL(18,4)`, `currency CHAR(3)`, `status` (`OPENED\|EVIDENCE_REQUESTED\|EVIDENCE_SUBMITTED\|WON\|LOST\|EXPIRED\|WITHDRAWN`), `opened_at`, `evidence_due_at DATETIME(3) NULL`, `outcome_at NULL`, `adjustment_id UUID NULL FK`, `evidence_json JSON NULL` | The rail-reported dispute that drives a chargeback `Adjustment` (§19). `UNIQUE(gateway_id, external_dispute_ref)` makes webhook replays and statement re-imports idempotent. |
| **`notification_templates`** | `code TEXT`, `channel` (`SMS\|EMAIL\|IN_APP`), `lang` (`ar\|en`), `subject_template TEXT NULL`, `body_template TEXT`, `confidentiality_class` (`PUBLIC\|MERCHANT\|INTERNAL`), `version INT`, `active BOOL` | `UNIQUE(code, channel, lang, version)`. Bilingual templates for every event in §16.7. A template whose class is `MERCHANT` or `PUBLIC` may not reference any `AML-CONFIDENTIAL` variable (enforced at save time). |
| **`notifications`** | `event_id UUID UNIQUE`, `recipient_user_id UUID NULL FK`, `recipient_merchant_id UUID NULL FK`, `address_masked TEXT`, `address_ciphertext TEXT`, `template_code TEXT`, `channel TEXT`, `lang TEXT`, `payload_json JSON`, `status` (`QUEUED\|SENT\|DELIVERED\|FAILED\|SUPPRESSED`), `provider_message_id TEXT NULL`, `attempts INT DEFAULT 0`, `next_attempt_at NULL` | Transactional outbox for SMS / e-mail / in-app messages. Rows are written in the same database transaction as the business event that causes them, so a notification is never lost or duplicated (`UNIQUE(event_id)`), and a failed provider call is retried by a worker. |
| **`platform_settings`** | `key TEXT`, `scope TEXT DEFAULT 'PLATFORM'`, `value_json JSON`, `version INT`, `effective_from`, `approval_request_id UUID NULL FK` | Versioned, effective-dated platform configuration (for example `join_request.four_eyes_policy`, `aml.owner_threshold_percent`, `retention.kyb_years`, `self_payment_policy`). Changes to compliance-relevant keys are Maker-Checker; the active value is cached with `InvalidationBus` eviction (Safeguard 12). |

### **5.7 Amendments to Existing Tables (Groups A–E) (v4.1)**

The following column and enumeration changes are applied to the v4.0 tables. They are listed here rather than inline so that every v4.1 delta is reviewable in one place.

| Table | Amendment | Reason |
| :---- | :---- | :---- |
| **`merchants`** | `status` gains `REJECTED` and `CLOSED` (now `PENDING\|ACTIVE\|SUSPENDED\|REJECTED\|CLOSED`). New columns: `onboarding_channel`, `country CHAR(2)`, `contact_phone`, `contact_email`, `activated_at`, `suspended_at`, `suspension_reason_code`, `closed_at`, `negative_balance_ceiling DECIMAL(18,4) DEFAULT 0`. | Lifecycle (§16.8), chargeback recovery (§19.5). |
| **`users`** | `role` gains `COMPLIANCE`, `MLRO`, `SUPPORT`, `MERCHANT_STAFF`, `MERCHANT_CASHIER` (now `GATEWAY_ADMIN\|SECURITY_ADMIN\|FINANCE\|OPERATOR\|COMPLIANCE\|MLRO\|SUPPORT\|MERCHANT_ADMIN\|MERCHANT_STAFF\|MERCHANT_CASHIER`). `mfa_required BOOL DEFAULT true` for all roles except `MERCHANT_CASHIER`. | Role model (§15.2). |
| **`applications`** | `assigned_wallet_id` is `NOT NULL`. `rail_whitelist` semantics: `NULL` = all rails (subject to commission coverage and route availability); an empty array is rejected at save time. `assigned_wallet_id`, `rail_whitelist` and `redirect_domain_allowlist` are classified **sensitive** (Maker-Checker). | Records the one-wallet decision (§17.2) and closes the maker-checker gap (§17.3). |
| **`payment_links`** | `wallet_id` is always populated and is derived from the application's `assigned_wallet_id` at creation; it is immutable afterwards. | The original's "walletId optional if the app has exactly one wallet" is now always true. |
| **`aml_cases`** | `status` gains `IN_REVIEW`, `FROZEN`, `ESCALATED_STR` (now `OPEN\|IN_REVIEW\|PENDING_CHECKER\|RELEASED\|REJECTED_VOID\|FROZEN\|ESCALATED_STR`). New columns: `screening_id`, `rule_id`, `rule_version INT`, `severity_inputs_json JSON`, `sla_due_at`, `assigned_reviewer_id`, `regulatory_report_id`, `confidential BOOL DEFAULT true`. | Case lifecycle and reportability (§18.6). |
| **`velocity_rules`** | New columns `version INT`, `effective_from`, `effective_to`, `approval_request_id`. | Rule changes become Maker-Checker and reproducible (R13). |
| **`approval_requests`** | New columns `mode` (`STANDARD\|EMERGENCY_RATIFICATION`), `expires_at DATETIME(3)`, `base_version INT NULL`, `ratify_due_at NULL`. | Pending-change semantics (§17.4) and emergency suspension (§16.8). |
| **`adjustments`** | New columns `dispute_id UUID NULL FK`, `drafted_by_system BOOL DEFAULT false`. | Chargeback auto-draft (§19.3). |
| **`journal_entries`** | `ref_type` gains `AML_VOID` and `DISPUTE_OUTCOME`. | Entries 11 and 12 (§9.4). |
| **`detail_change_logs`** | New columns `merchant_id` (indexed), `approval_request_id NULL`, `source` (`PORTAL\|ADMIN\|API\|SYSTEM`), `request_id TEXT`, `client_ip TEXT NULL`. | Support can answer "what did this field used to say" per merchant in one query (§17.5). |
| **`gateways`** | `kind` gains `INTERNAL` (now `DIRECT\|AGGREGATOR\|NATIVE_ADAPTER\|INTERNAL`). | NeomPay (Blueprint 7). |
| **`rail_fields`** | `type` gains `wallet_id`; new column `checksum` (`NONE\|LUHN`). | NeomPay wallet ID validation. The checksum is a built-in validator compiled into the field's Zod schema, so the closed transform library (§6.3) is unchanged. |

**Table count (v4.1).** The tables enumerated in §5.1–5.5 total 51 (Group A 18, B 6, C 4, D 13, E 10); Group F adds 13, for a total of **64 tables**. v4.0 stated "42"; that figure did not match its own table list.


# **PART III: THE UNIVERSAL RAIL ENGINE**

## **6\. Engine Contract, Client Actions, Auth Registry, Transforms & Crypto Engine**

### **6.1 The Six-Method Universal Engine Contract (`DynamicRailEngine`)**

| Method | Execution Contract & Safety Rules |
| :---- | :---- |
| **`preInitiate(attempt, formData)`** | Optional pre-flight phase. Executes `PRE_INITIATE` flow stack (`READ_ONLY`) to validate subscriber eligibility, fetch bill details, or lock an upstream exchange/fee quote before dispatching an OTP. |
| **`initiate(attempt, formData)`** | Validates `formData` against the rail's compiled Zod schema (after applying `normalizer`), runs the `INITIATE` flow stack (or `COMPUTE` step for zero-HTTP embedded widgets like Moamalat Lightbox), stores `STATE` outputs in `context_ciphertext`, and returns a declarative `ClientAction` payload containing only `PUBLIC` outputs. |
| **`confirm(attempt, evidence)`** | Executes the `SUBMIT` (`CONFIRM`) stack using OTP input, signed callback data, or redirect evidence. Marks `point_of_no_return = true`, `side_effect = MOVES_MONEY`, `retry_policy = NEVER`. Verifies all 5 trusted-success facts and invokes the `LedgerPoster` in the same DB transaction on `SUCCEEDED`. |
| **`verifyCallback(channel, rawReq)`** | Executes constant-time signature verification across all active `secret_version` entries, checks IP CIDR allowlist and timestamp replay window (`timestamp_tolerance_sec`), computes `dedupe_key`, correlates `attempt_id`, and triggers `inquire(attempt)` when `must_inquire == true`. |
| **`inquire(attempt)`** | Executes the `VERIFY` (`INQUIRE`) read-only stack to poll authoritative status at the gateway. Used for `must_inquire` channels, `UNKNOWN` resolution, pre-expiry checks, and operator on-demand checks. |
| **`refund(attempt, amount, adjId)`** | Executes the `REFUND` (or `VOID` if pre-settlement) stack when a Maker-Checker refund `Adjustment` is approved. If timeout/5xx occurs, keeps Adjustment in `EXECUTING` and schedules reconciliation. |

### **6.2 The Five Declarative `ClientAction` Renderers**

The checkout frontend contains zero gateway-specific logic; it renders strictly from these five declarative payloads:

1. **`SHOW_OTP_FORM`:** `{ otp_length, max_attempts, resend_cooldown_seconds, expires_at, masked_phone }`  
2. **`HTTP_REDIRECT`:** `{ method: 'GET' | 'POST_FORM', url, form_fields, target, return_token }`  
3. **`RENDER_EMBEDDED`:** `{ sdk_driver, script_urls, script_sri_hashes, config, allowed_origins, iframe_sandbox }`  
4. **`SHOW_QR_OR_CODE`:** `{ qr_payload, pay_code, instructions_ar, instructions_en, expires_at, deep_link_url }`  
5. **`SHOW_PUSH_OR_TRANSFER`:** `{ wallet_hint, destination_account, payment_reference, instructions_ar, instructions_en, proof_upload_allowed, expires_at, cancel_supported }`

### **6.3 The Closed Transform Library (`TransformPipe[]` — Pure Operations)**

| Category | Whitelisted Operations |
| :---- | :---- |
| **Numeric & Amount** | `scale(factor)` / `MUL_INT(factor)`, `DIV_DECIMAL(divisor, places)`, `round(mode: NONE\|NEAREST\|UP\|DOWN)`, `format_decimal(places)`, `to_int`, `to_number`, `to_string` |
| **String & Normalization** | `concat`, `template`, `lowercase`, `uppercase`, `trim`, `pad_left(length, char)`, `pad_right(length, char)`, `substring(start, end)`, `mask(visible_start, visible_end)`, `prepend(secret_ref)`, `arabic_digits_to_ascii`, `phone_normalize(style: LOCAL_09\|INTL_218\|E164)` |
| **Canonicalization** | `sort_keys`, `values_only`, `join_pairs(kv_sep, pair_sep)` |
| **Time & Identity** | `format_date(pattern, timezone)`, `epoch_seconds`, `epoch_millis`, `uuid`, `numeric_random(length)` |
| **Encoding & Escaping** | `base64_encode`, `hex_lower`, `hex_upper`, `url_encode`, `json_encode`, `xml_escape` |
| **Cryptographic** | `sha256`, `sha512`, `hmac_sha256(key_ref, key_encoding: utf8\|hex\|base64)`, `hmac_sha512(key_ref, key_encoding)`, `rsa_sha256_sign(key_ref)` |

### **6.4 Worked Cryptographic Signing Profiles**

\# 1\. Moamalat NPG Outbound Lightbox & Inquiry Signer (Hex-decoded Secret Key \+ Sorted Key=Value)

name: MOAMALAT\_SECURE\_HASH

purpose: OUTBOUND\_SIGN

algorithm: HMAC\_SHA256

secret\_key\_ref: CREDENTIAL.MerchantSecretKey

secret\_key\_encoding: HEX            \# CRITICAL: Hex string decoded to raw binary bytes before HMAC

canonicalization\_mode: SORTED\_KEY\_VALUE\_AMP

output\_encoding: HEX\_UPPER

fields:

  Amount:            ATTEMPT.total\_charged\_amount \|\> scale(1000) \|\> to\_int \|\> to\_string

  DateTimeLocalTrxn: NOW \|\> format\_date('YYYYMMDDHHmm', 'Africa/Tripoli')

  MerchantId:        CREDENTIAL.MID

  MerchantReference: ATTEMPT.gateway\_reference

  TerminalId:        CREDENTIAL.TID

\# 2\. DPay Inbound Webhook Verifier (Timestamp \+ Dot \+ Raw Body Bytes)

name: DPAY\_WEBHOOK\_VERIFY

purpose: INBOUND\_VERIFY

algorithm: HMAC\_SHA256

secret\_key\_ref: CREDENTIAL.webhook\_secret

secret\_key\_encoding: UTF8

canonicalization\_mode: TIMESTAMP\_DOT\_RAW\_BODY   \# Signs "\<timestamp\_header\>.\<raw\_body\_bytes\>"

timestamp\_header: X-DPay-Timestamp

timestamp\_tolerance\_sec: 300

\# 3\. Plutu Card Services Inbound Callback Verifier (Sorted Values with Prepend Secret)

name: PLUTU\_CALLBACK\_HASH

purpose: INBOUND\_VERIFY

algorithm: HMAC\_SHA256

secret\_key\_ref: CREDENTIAL.secret\_key

secret\_key\_encoding: UTF8

canonicalization\_mode: SORTED\_VALUES\_HASH       \# Removes 'hashed' key, sorts remaining keys, joins values

output\_encoding: HEX\_UPPER

excluded\_fields: \['hashed'\]

# **PART IV: COLLECTION MODES, STATE MACHINE & BLUEPRINTS**

## **7\. The Attempt Lifecycle State Machine and Slot Reservation Invariant**

### **7.1 The Nine Governing State Machine Rules**

1. **Pinned Configuration:** `gateway_version_id`, `route_id`, `credential_set_id`, and `commission_profile_id` are locked on `payment_attempts` at creation.  
2. **Atomic Slot Reservation (`active_locked_count`):** Inside the `SERIALIZABLE` / `SELECT ... FOR UPDATE` initiation guard transaction on `payment_links`, creating an attempt increments `active_locked_count`. For single-use links (`use_count = 1`), `confirmed_count + active_locked_count <= 1` prevents any second tab, device, or concurrent payer from starting a competing payment. The reservation is released **only** on terminal `FAILED`, `EXPIRED`, `CANCELLED`, or `BLOCKED` states, and is **strictly held through `UNKNOWN`**.  
3. **Effective Expiry (`min` TTL) \+ Grace Window:** `expires_at = min(gateway_session_ttl, platform_ttl)` **(v4.1: the platform ceiling for `OTP_PULL` is 20 minutes, preserving the original proposal's bound; see §17.6)**. When `NOW() > expires_at`, the sweeper runs `inquire(attempt)` first (if supported) before transitioning to `EXPIRED`. `grace_expires_at` (default \+24h; indefinite for no-inquiry rails) keeps the webhook inbox open for late settlements.  
4. **Retryable OTP vs. Terminal Decline:** If `SUBMIT` returns a gateway code mapped to `RETRYABLE_OTP` (e.g., mistyped SMS code) and `otp_attempts < max_otp_attempts` (default 3), `otp_attempts` increments and the attempt returns to `AWAITING_CUSTOMER (OTP_REQUIRED)` without sending a new SMS. On attempt \#3, it transitions to `FAILED`.  
5. **Forward-Only Motion:** `SUCCEEDED` is never downgraded by a later failure or expiry event. Conflicting trusted signals (e.g., verified webhook says `PAID`, inquiry says `FAILED`) freeze the attempt in `UNKNOWN` and open a `P1` `CONFLICT` operator case.  
6. **Late Success Recovery:** A verified confirmation arriving after `EXPIRED` or `FAILED` transitions the attempt to `SUCCEEDED`, posts the ledger entry (if the link slot is still available), and raises a `P2` alert. If the single-use link was already paid by another attempt in the meantime, funds route to `SUSPENSE` and auto-draft a refund `Adjustment`.  
7. **Atomic Ledger Posting:** Transitioning to `SUCCEEDED` and inserting `journal_entries` \+ `journal_lines` occur in the **exact same database transaction**, guarded by `UNIQUE(ref_type, ref_id)` on `journal_entries` and `UNIQUE(ledger_entry_id)` on `payment_attempts`.  
8. **Durable Database Timers:** `expires_at` and `next_check_at` are indexed `DATETIME(3)` columns polled by stateless multi-instance workers using `SELECT ... FOR UPDATE SKIP LOCKED`. `SKIP LOCKED` requires **MySQL 8.0+ / MariaDB 10.6+**; the terminal transitions are additionally guarded by a conditional `UPDATE ... WHERE terminal_at IS NULL`, so a terminal state is applied **at most once** even when two cluster nodes claim the same row.  
9. **Realtime Streaming:** Every state transition broadcasts to the checkout SSE stream (`GET /v1/pay/{linkKey}/logs/{logId}/status`) and the paired POS WebSocket room.

## **8\. Seven Production Configuration Blueprints**

### **Blueprint 1: Edfali & Sadad (Two-Step `OTP_PULL` with `RETRYABLE_OTP`)**

* **Mode:** `OTP_PULL` \| **Fields:** `customer_mobile` (`^09[0-9]{8}$`, `SENSITIVE`), `birth_year` (Sadad only, `1925..2012`, `SENSITIVE`), `otp` (`4..6` digits).  
* **`INITIATE` Step 1:** `POST {api}/verify` (`side_effect: SENDS_NOTIFICATION`, `retry: SAFE_WITH_COOLDOWN`). Body: `mobile_number`, `birth_year`, `amount` (`FORMAT_DECIMAL(2)`). Extracts `result.process_id -> STATE.process_id`. ClientAction: `SHOW_OTP_FORM`.  
* **`SUBMIT` Step 1:** `POST {api}/confirm` (`side_effect: MOVES_MONEY`, `retry: NEVER`, `point_of_no_return: true`). Body: `process_id <- STATE.process_id`, `code <- CUSTOMER_FIELD.otp`, `amount <- ATTEMPT.total_charged_amount`, `invoice_no <- ATTEMPT.gateway_reference`.  
* **Confirmation Channels:** `[SYNC_RESPONSE, STATEMENT]` (plus `INQUIRY` where aggregator supports it).

### **Blueprint 2: Moamalat National Switch (`EMBEDDED` Lightbox \+ Hex-HMAC \+ Mandatory Inquiry)**

* **Mode:** `EMBEDDED` \| **Fields:** `[]` (PAN entered inside Lightbox iframe).  
* **`INITIATE` Step 1 (`COMPUTE`):** Computes `AmountTrxn` (`scale(1000) |> to_int`), `MerchantReference` (10-digit numeric), `TrxDateTime` (`YYYYMMDDHHmm`, `Africa/Tripoli`), and `SecureHash` (`MOAMALAT_SECURE_HASH`). Outputs all as `PUBLIC`. ClientAction: `RENDER_EMBEDDED` (`MOAMALAT_LIGHTBOX_V2`).  
* **`VERIFY` Step 1 (`HTTP`):** `POST {inquiry}/FilterTransactions` (`READ_ONLY`, `retry: SAFE`) with `MID`, `TID`, `MerchantReference`, and `SecureHash`. Asserts `Approved == true`, `ActionCode == "00"`, and `AmountTrxn / 1000 == ATTEMPT.total_charged_amount`.  
* **Confirmation Channels:** `BROWSER_CALLBACK` (hint, `must_inquire: true`), `WEBHOOK` from Moamalat CIDR allowlist (`must_inquire: true`), `POLL`.

### **Blueprint 3: CBL LYPay Instant Payment (`QR_DISPLAY` / Push with 5s Sync Window \+ Webhook \+ Enquiry)**

* **Mode:** `QR_DISPLAY` / `PUSH_APPROVAL` \| **Auth:** `TOKEN_ENDPOINT` (Bearer via `/api/v1/auth/token`).  
* **`INITIATE` Step 1:** `POST /api/v1/payments/funds-transfers` (`SENDS_NOTIFICATION`). Extracts `transfer_uuid -> STATE`, EMVCo TLV QR \-\> `PUBLIC`.  
* **`SUBMIT` Step 1:** `POST /api/v1/payments/funds-transfers/{uuid}/confirm` (`MOVES_MONEY`, `retry: NEVER`, `point_of_no_return: true`). If response within 5s is `Confirmed`, transitions to `SUCCEEDED`; if `Processing`, transitions to `VERIFYING`.  
* **`VERIFY` Step 1:** `GET /api/v1/payments/funds-transfers/enquiry?merchantRef={ATTEMPT.gateway_reference}`.  
* **Confirmation Channels:** `SYNC_RESPONSE`, `WEBHOOK` (`transaction_status_update`, `transaction_credit_notice`, HMAC-signed), `POLL`.

### **Blueprint 4: MyPay & Tadawul T-LYNC (`REDIRECT` Hosted Checkout \+ Signed Webhook \+ Receipt Inquiry)**

* **Mode:** `REDIRECT` \| **Auth:** `TOKEN_ENDPOINT` (MyPay 600s JWT) or `API_KEY` (T-LYNC `store_id` \+ `store_token`).  
* **`INITIATE` Step 1:** `POST {api}/payment/create` with `amount`, `custom_ref <- ATTEMPT.gateway_reference`, `frontend_url <- URLS.return_url`, `backend_url <- URLS.callback_url`. Extracts `redirect_url -> PUBLIC`.  
* **`VERIFY` Step 1 (T-LYNC):** `POST {api}/receipt/transaction` with `store_id` and `custom_ref`.  
* **Confirmation Channels:** `WEBHOOK` (`X-MYPAY-SIGNATURE` raw body HMAC or T-LYNC IP allowlist with `must_inquire: true`), `RETURN_URL` (hint only, triggers `VERIFY`), `POLL`.

### **Blueprint 5: MobiCash, OnePay, Yussor Pay & Sahara Pay (`HYBRID` Card OTP / Pay Code / EMVCo QR)**

* **Mode:** `HYBRID` (`sub_modes: ['OTP_PULL', 'QR_DISPLAY', 'PAY_CODE']`).  
* **Fields (`OTP_PULL`):** `card_number` (7-digit MobiCash/Yussor/Sahara ID or 9-digit OnePay cross-bank code, marked `sensitivity: PAN` — memory-only, never logged or persisted).  
* **`INITIATE` & `SUBMIT`:** Opens `payment_uuid` (15-minute TTL) or generates dynamic QR/SMS Pay Code; confirms via OTP or polls `VERIFY` / `WEBHOOK` / `STATEMENT`.

### **Blueprint 6: Visa / Mastercard MPGS 3DS2 & Evo Pay (`EMBEDDED` / `REDIRECT` Multi-Currency & Nested JSON)**

* **MPGS:** `BASIC` auth (`merchant.<MID>:<apiPassword>`), creates Hosted Checkout Session (`PCI-DSS SAQ-A`), handles 3DS2 challenge, verifies `X-Notification-Secret` webhook, and runs mandatory `GET /order/{reference}` inquiry verifying `result == "SUCCESS"` and `status == "CAPTURED"`.  
* **Evo Pay:** Uses `recursiveSet` dot-paths `transAmount.amount`, `transAmount.currency`, and `merchantTransInfo.merchantTransID` to generate dynamic QR and polls `GET Payment` for `payment.status == "Captured"`.

### **Blueprint 7: NeomPay First-Party Wallet Rail (`INTERNAL` Gateway · `PUSH_APPROVAL` / `OTP_PULL` / `QR_DISPLAY`)**

> **Scope note.** The original proposal defined NeomPay as *a rail like any other*: "nothing in the core flow needs to know or care that a transaction settled through NeomPay specifically." v4.1 keeps that principle. The only structural difference is that the "external system" is the platform operator's own wallet ledger, so the gateway is registered with `kind = INTERNAL`. The engine contract, state machine, guard pipeline, inbox, verifier and single `LedgerPoster` are unchanged. **Endpoint paths below are illustrative placeholders**; the authoritative contract is owned by the NeomPay team and is verified by Go-Live Gates 5 and 9 before the route can go `LIVE`.

* **Gateway:** `code = neompay`, `kind = INTERNAL`, `risk_class = NORMAL`, one environment pair (`SANDBOX` against NeomPay staging, `LIVE` against NeomPay production). `allowed_hosts` pinned to NeomPay service hostnames only (Safeguard 11).
* **Rail & Modes:** `neompay_wallet` with `collection_mode = HYBRID`; `sub_modes = [PUSH_APPROVAL, OTP_PULL, QR_DISPLAY]`. `PUSH_APPROVAL` sends an approval request to the payer's NeomPay app; `OTP_PULL` asks for the wallet ID plus a one-time code; `QR_DISPLAY` renders a dynamic QR that the NeomPay app scans.
* **Fields:** `wallet_id` (type `wallet_id`, `regex ^NP-[0-9]{12}$`, `checksum = LUHN`, `SENSITIVE`) shaped per the NeomPay Wallet ID specification (`NP-TTSSSSSSSSSC`: 2-digit wallet-type code, 9-digit permuted sequence, 1 check digit). Payer wallet types that may pay are an allow-list in `rail_fields.options_json` taken from the NeomPay wallet-type code table. `otp` (`4..6` digits) for the `OTP_PULL` sub-mode only. QR and push sub-modes have no customer fields on our page.
* **Auth:** `MUTUAL_TLS` service-to-service (or `REQUEST_SIGNATURE` over a private network if co-deployed). `CredentialSet`: `owner_type = PLATFORM`, `settlement_target = PLATFORM_CLEARING` (see Ledger Rule INTERNAL-1 below). No third-party credentials exist, so credential-theft and merchant-credential edge cases do not apply.
* **Amount pipeline:** `amount_scale = 1`, `amount_precision = 3`, `amount_rounding = NONE`, `amount_format = STRING_DECIMAL`. Contract test: `10.505 LYD -> "10.505"` (no rounding, no scaling).
* **Session TTLs (proposed defaults):** `PUSH_APPROVAL` 10 min, `QR_DISPLAY` 5 min, `OTP_PULL` 10 min; all bounded by the platform ceiling in §7.1 Rule 3.
* **`INITIATE` (push):** `POST {api}/payments/requests` (`side_effect: SENDS_NOTIFICATION`, `retry: SAFE`, idempotency key `ATTEMPT.gateway_reference`). Extracts `request_id -> STATE.request_id`. ClientAction: `SHOW_PUSH_OR_TRANSFER` with a masked `wallet_hint`.
* **`INITIATE` (QR):** `COMPUTE` step builds the dynamic QR payload bound to `ATTEMPT.gateway_reference` and `expires_at` (a static reusable QR is rejected at save time, Edge Case 107). ClientAction: `SHOW_QR_OR_CODE`.
* **`SUBMIT` (OTP variant):** `POST {api}/payments/{request_id}/confirm` with `side_effect: MOVES_MONEY`. Because NeomPay natively supports idempotency keys and this is **proven by the contract suite**, the save-time validator may accept `retry: SAFE` with `idempotency_config: { mode: HEADER, key_name: "Idempotency-Key", source_template: "ATTEMPT.gateway_reference" }`. This is the one case where a `MOVES_MONEY` step is retried, and only because the platform controls both ends.
* **`VERIFY`:** `GET {api}/payments/by-reference/{our_reference}` (`READ_ONLY`, `retry: SAFE`). Asserts all five trusted-success facts (status, reference, amount, currency, environment).
* **Confirmation channels:** `[SYNC_RESPONSE, POLL]` plus an optional internal `WEBHOOK` event. `SYNC_RESPONSE` over mutually authenticated TLS is treated as authoritative, but money is still posted only after the five-fact check.
* **Refund / Void / Capture:** native. `refund` supports partial amounts; `void` is available before capture. `refund_window_days` is a platform policy (default unlimited).
* **Reconciliation:** `StatementSource.type = API` pulls a NeomPay ledger export so that "Σ NeomPay settlements for the day = platform Treasury inflows attributed to NeomPay" is proven daily (cross-ledger equality), even though there is no external bank statement.
* **Required NeomPay-side capabilities (integration contract):** (1) idempotency key on every state-changing call; (2) lookup by external reference; (3) reserve → capture → release semantics so no distributed transaction is needed; (4) refund and partial refund; (5) deterministic, enumerable error codes for `ErrorMap`; (6) mutual-TLS authentication; (7) a ledger export for reconciliation.
* **Anti self-dealing:** if the payer wallet and the merchant belong to the same legal entity (matched by owner identity), the attempt is blocked or flagged per `SELF_PAYMENT_POLICY` (`BLOCK` default), since it can be used to wash volume or manufacture commission (Edge Case 134).
* **Evidence level:** `INTERNAL (FIRST-PARTY)`. Gate 9 is satisfied by a green contract suite against NeomPay staging rather than by third-party documentation.

**Ledger Rule INTERNAL-1 (v4.1).** For `kind = INTERNAL` gateways the payer's debit and the platform Treasury credit happen inside the same operator-controlled ledger, so there is no clearing delay and no external settlement. The `LedgerPoster` therefore debits `TREASURY` directly (no `GATEWAY_CLEARING` leg, no fee accrual, no `SETTLEMENT_SWEEP`). All other posting rules (commission split, AML hold, adjustments, idempotent `UNIQUE(ref_type, ref_id)`) are identical. See Journal Entries 13 and 14.


# **PART V: TRUST, VERIFICATION AND THE DOUBLE-ENTRY LEDGER**

## **9\. Money, Fee Bearers, Ownership Models & 15 Worked Journal Entries (§9.3–§9.4)**

### **9.1 The Three Fee Bearer Models (Example: 100.0000 LYD Link, 3.0000 LYD Platform Commission, 0.8000 LYD Gateway Fee)**

| Fee Bearer Mode | Payer Charged (total\_charged\_amount) | Merchant Credited (net\_merchant\_amount) | Platform Gross / Net Revenue | Checkout UX Display Contract |
| :---- | :---- | :---- | :---- | :---- |
| **`MERCHANT_ABSORBS` (Default)** | `100.0000 LYD` | `97.0000 LYD` | `3.0000 LYD gross / 2.2000 LYD net` | Shows `Total: 100.00 LYD` |
| **`PAYER_SURCHARGE`** | `103.0000 LYD` | `100.0000 LYD` | `3.0000 LYD gross / 2.2000 LYD net` | Shows `100.00 LYD + 3.00 LYD Service Fee = 103.00 LYD` prior to confirm |
| **`SPLIT` (50/50 Custom)** | `101.5000 LYD` | `98.5000 LYD` | `3.0000 LYD gross / 2.2000 LYD net` | Shows `100.00 LYD + 1.50 LYD Service Fee = 101.50 LYD` prior to confirm |

### **9.2 The System-Wide Double-Entry Ledger Invariant**

Checked continuously by database triggers and a scheduled verification job:  TREASURY Balance

\+ SUM(GATEWAY\_CLEARING Balances)

\+ SUM(COMMISSION\_RECEIVABLE Balances)

\==

  SUM(MERCHANT\_WALLET Balances)

\+ PLATFORM\_INCOME Balance

\- PROVIDER\_FEE\_EXPENSE Balance

\- GATEWAY\_FEE\_EXPENSE Balance

\+ GATEWAY\_FEE\_ACCRUAL Balance

\+ AML\_HOLD Balance

\+ CHARGEBACK\_RESERVE Balance

\+ SUSPENSE Balance

#### **9.2.1 Database-Level Enforcement of the Domain Invariants (MySQL / MariaDB)**

Four domain invariants are enforced at the database layer, but not in the same way:

| Invariant | Enforcement |
| :---- | :---- |
| `journal_lines.amount > 0` | `CHECK` constraint `journal_lines_amount_positive` |
| `attempt_groups.success_count <= 1` | `CHECK` constraint `attempt_groups_single_success` |
| `payment_links` slot reservation (`infinite_use = true OR confirmed_count + active_locked_count <= use_count`) | `CHECK` constraint `payment_links_slot_reservation_invariant` |
| `approval_requests.checker_user_id <> maker_user_id` | `BEFORE INSERT` trigger `approval_requests_checker_not_maker` |

MariaDB **forbids a `CHECK` constraint on a column that participates in a foreign key**, and `approval_requests.checker_user_id` / `maker_user_id` are both foreign keys into `users`. The Maker ≠ Checker invariant is therefore enforced by a `BEFORE INSERT` trigger on `approval_requests` that raises `SIGNAL SQLSTATE '45000'` (`checker_user_id must differ from maker_user_id`), **in addition to** the application-level check in `ApprovalService` and the `makerCheckerGuard` middleware. The other three domain checks remain plain `CHECK` constraints.

### **9.3 Ten Worked Double-Entry Journal Entries**

| \# | Business Event | Debits (Dr) | Credits (Cr) |
| :---- | :---- | :---- | :---- |
| **1** | **Platform-Held Confirmation (Same-Day Direct Settlement, Fee Deducted at Source):** 100 LYD, 3% commission, 1 LYD provider fee | `Dr TREASURY` `99.0000`  `Dr PROVIDER_FEE_EXPENSE` `1.0000` | `Cr MERCHANT_WALLET (M)` `97.0000`  `Cr PLATFORM_INCOME` `3.0000` |
| **2** | **Platform-Held Confirmation with Fee Accrual (T+N Settlement):** 100 LYD, 3% commission, 0.80 LYD accrued gateway fee | `Dr GATEWAY_CLEARING (G)` `100.0000`  `Dr GATEWAY_FEE_EXPENSE` `0.8000` | `Cr MERCHANT_WALLET (M)` `97.0000`  `Cr PLATFORM_INCOME` `3.0000`  `Cr GATEWAY_FEE_ACCRUAL` `0.8000` |
| **3** | **T+N Bank Statement Settlement Sweep:** Statement shows 99.20 LYD net settled to bank | `Dr TREASURY` `99.2000`  `Dr GATEWAY_FEE_ACCRUAL` `0.8000` | `Cr GATEWAY_CLEARING (G)` `100.0000` |
| **4** | **Settlement Fee Variance True-Up:** Statement fee was 0.90 LYD instead of accrued 0.80 LYD | `Dr GATEWAY_FEE_EXPENSE` `0.1000` | `Cr GATEWAY_FEE_ACCRUAL` `0.1000` |
| **5** | **Confirmed Payment with Payer Surcharge:** 100 LYD link \+ 3 LYD surcharge \= 103 LYD charged, 0.80 LYD gateway fee accrued | `Dr GATEWAY_CLEARING (G)` `103.0000`  `Dr GATEWAY_FEE_EXPENSE` `0.8000` | `Cr MERCHANT_WALLET (M)` `100.0000`  `Cr PLATFORM_INCOME` `3.0000`  `Cr GATEWAY_FEE_ACCRUAL` `0.8000` |
| **6** | **Merchant-Owned Direct Settlement (`MERCHANT_DIRECT`):** 100 LYD paid directly to merchant's DPay/bank account; 3 LYD commission booked & later netted | **At Confirm:** `Dr COMMISSION_RECEIVABLE (M)` `3.0000`  **At Netting:** `Dr MERCHANT_WALLET (M)` `3.0000` | **At Confirm:** `Cr PLATFORM_INCOME` `3.0000`  **At Netting:** `Cr COMMISSION_RECEIVABLE (M)` `3.0000` |
| **7** | **AML Threshold Hold on Confirmation & Subsequent Checker Release:** 100 LYD flagged payment | **At Confirm:** `Dr GATEWAY_CLEARING` `100.0000`  **At Release:** `Dr AML_HOLD` `100.0000` | **At Confirm:** `Cr AML_HOLD` `100.0000`  **At Release:** `Cr MERCHANT_WALLET` `97.0000`, `Cr PLATFORM_INCOME` `3.0000` |
| **8** | **Merchant Cash-Out Executed & Subtracted:** 100 LYD payout wired to merchant bank | `Dr MERCHANT_WALLET (M)` `100.0000` | `Cr TREASURY` `100.0000` |
| **9** | **Full Refund Executed (Commission Reversed):** 100 LYD refund via Maker-Checker Adjustment | `Dr MERCHANT_WALLET (M)` `97.0000`  `Dr PLATFORM_INCOME` `3.0000` | `Cr TREASURY` (or `GATEWAY_CLEARING`) `100.0000` |
| **10** | **Chargeback Escrowed & Subsequently Lost:** 100 LYD dispute raised by switch, then settled | **At Dispute:** `Dr MERCHANT_WALLET` `97.0000`, `Dr PLATFORM_INCOME` `3.0000`  **If Lost:** `Dr CHARGEBACK_RESERVE` `100.0000` | **At Dispute:** `Cr CHARGEBACK_RESERVE` `100.0000`  **If Lost:** `Cr TREASURY` `100.0000` |

### **9.4 Additional Worked Journal Entries (v4.1)**

These five entries complete the scenarios introduced by the AML program (§18), the dispute workflow (§19) and the NeomPay rail (Blueprint 7). All amounts use the same convention as §9.3 (100.0000 LYD link, 3% platform commission). Every entry is subject to the same constraints: balanced debits and credits enforced by the ledger trigger, `UNIQUE(ref_type, ref_id)` for idempotency, and the system-wide invariant in §9.2.

| \# | Business Event | Debits (Dr) | Credits (Cr) |
| :---- | :---- | :---- | :---- |
| **11** | **AML Hold Voided, Funds Returned to Payer** (`ref_type = AML_VOID`): a 100 LYD payment previously escrowed per Entry 7 is resolved `REJECTED_VOID` by Checker and refunded through the rail's `REFUND` flow. No commission was ever recognized, so none is reversed. | `Dr AML_HOLD` `100.0000` | `Cr TREASURY` (or `GATEWAY_CLEARING`) `100.0000` |
| **12** | **Chargeback Won** (`ref_type = DISPUTE_OUTCOME`): the reserve created in Entry 10 is released because the dispute was decided in the merchant's favour. | `Dr CHARGEBACK_RESERVE` `100.0000` | `Cr MERCHANT_WALLET (M)` `97.0000`  `Cr PLATFORM_INCOME` `3.0000` |
| **13** | **NeomPay Confirmation** (Ledger Rule INTERNAL-1): 100 LYD paid from a NeomPay wallet, 3% commission, no provider fee, no clearing leg. | `Dr TREASURY` `100.0000` | `Cr MERCHANT_WALLET (M)` `97.0000`  `Cr PLATFORM_INCOME` `3.0000` |
| **14** | **NeomPay Full Refund** (Maker-Checker Adjustment, commission reversed): 100 LYD returned to the payer's NeomPay wallet. | `Dr MERCHANT_WALLET (M)` `97.0000`  `Dr PLATFORM_INCOME` `3.0000` | `Cr TREASURY` `100.0000` |
| **15** | **Chargeback Against an Insufficient Merchant Wallet:** merchant wallet holds 40 LYD when a 100 LYD chargeback is approved (97 merchant share + 3 commission reversed). The wallet is allowed to go negative up to `negative_balance_ceiling` (§19.5). | `Dr MERCHANT_WALLET (M)` `97.0000`  `Dr PLATFORM_INCOME` `3.0000` | `Cr CHARGEBACK_RESERVE` `100.0000` |

**Reading Entry 15.** The wallet balance moves from `+40.0000` to `-57.0000`. In the §9.2 invariant a negative wallet balance is simply a negative term on the right-hand side, which is arithmetically identical to a receivable from the merchant; the invariant continues to hold without any special account. The negative balance is recovered by netting against future settlements and is reported on the merchant statement as "amount owed to platform".


# **PART VI: GOVERNANCE, SECURITY, THREAT MODEL & OPERATIONS**

## **10\. Fourteen Engineering Safeguards & STRIDE Threat Model**

### **10.1 The 14 Code-Level Engineering Safeguards**

1. **Non-Destructive `recursiveSet` with Prototype-Pollution Guard:** Rejects `__proto__`, `constructor`, and `prototype`; clones path arrays; preserves sibling keys (`transAmount.amount` \+ `transAmount.currency`).  
2. **Synchronous Promise-Cached Consumer Registry:** Stores initialization Promise in memory before awaiting DB to prevent duplicate consumer construction or timer leaks under concurrent bursts.  
3. **Single-Flight Auth Token Refresh:** Concurrent 401/403 responses share one in-flight `refreshToken()` Promise so parallel payments never stampede a gateway's token endpoint.  
4. **Chained `setTimeout` with \+/-10% Jitter:** Replaces `setInterval` to avoid cluster-wide refresh storms; retains last valid token on refresh error and schedules accelerated retry.  
5. **Atomic Rotating Refresh-Token Persistence:** Encrypts and persists `new_refresh_token_selector` to the MySQL / MariaDB database **before** resolving the refresh Promise so server restarts never lose OAuth2 sessions.  
6. **Per-Step `AbortController` Timeouts:** Enforces `step.timeout_ms` (10s auth/inquire, 15s initiate/confirm/refund) on every outbound socket.  
7. **Strict Retry Boundary on Money Steps:** `MOVES_MONEY` steps never auto-retry on timeout, socket reset, or 5xx; they transition immediately to `UNKNOWN`.  
8. **Raw-Text-First Response Reader:** Reads `response.text()` before attempting JSON/XML parsing; caps responses at `max_response_bytes` (2 MB) and JSON depth at 64; disables XML DTD/external entities (XXE-safe).  
9. **Multi-Layer Literal Secret Redaction:** Scrubs sensitive key names (`Authorization`, `X-API-KEY`, `password`, `otp`, `cvv`, `pan`) **and** performs literal string replacement of all decrypted secrets before writing any log or audit row.  
10. **SSRF & DNS-Rebinding Protection:** Enforces `https://`, custom DNS lookup blocking private/loopback/link-local IPv4 & IPv6 (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`), disables auto-redirects (or re-validates every hop), and routes via fixed egress IPs.  
11. **Host-Pinned Secret Credentials:** Secrets in `credential_sets` are cryptographically bound to `gateway_environments.allowed_hosts`; changing a step URL to an external host fails credential resolution at request build time.  
12. **Distributed `InvalidationBus`:** Broadcasts config, validator, and credential invalidations across cluster nodes via Redis Pub/Sub within seconds.  
13. **Destination-Correct Template Encoding:** Serializes JSON values via encoder, XML-escapes XML placeholders, URL-encodes query/path segments, and rejects `CR`/`LF` in headers.  
14. **Post-Substitution Final URL Re-Validation:** Re-parses the final URL after parameter substitution to confirm scheme, host allowlist, single path segment integrity, and zero `userinfo`.

### **10.2 Complete 24-Item STRIDE Threat Register**

| ID | STRIDE | Threat Scenario | Engineered Controls |
| :---- | :---- | :---- | :---- |
| **T-01** | Spoofing | Forged webhook claims payment success | Unguessable `path_token` \+ constant-time HMAC/RSA \+ CIDR allowlist \+ `must_inquire` on weak channels |
| **T-02** | Spoofing | Replay of captured valid webhook | `timestamp_tolerance_sec` (300s) \+ `UNIQUE(channel_id, dedupe_key)` in durable `inbound_events` inbox |
| **T-03** | Spoofing | Sandbox webhook replayed against Live | Separate `path_token` and secrets per `env`; environment match enforced in Trusted Success |
| **T-04** | Tampering | Customer manipulates `return_url` query params | Return URL parameters ignored for state decisions; used solely as a hint to trigger `inquire(attempt)` |
| **T-05** | Tampering | Payer modifies `AmountTrxn` in browser DevTools | Server derives amount from `payment_links.amount`; Lightbox `SecureHash` signed server-side; inquiry verifies settled amount |
| **T-06** | Tampering | Spoofed JS `completeCallback` via browser console | `/client-event` is an untrusted hint that only transitions to `VERIFYING` and triggers server `VERIFY` |
| **T-07** | Repudiation | Merchant or admin denies changing payout bank or route | Immutable `detail_change_logs` and `audit_log` with before/after diffs and `approval_request_id` |
| **T-08** | Info Disclosure | Gateway secrets leaked via logs or config exports | Multi-layer literal redactor (Safeguard 9); write-only secrets; config exports omit secrets by construction |
| **T-09** | Info Disclosure | Card PAN persisted in database or logs | `PAN` sensitivity fields held in memory only for single step, wiped immediately, never written to DB/logs |
| **T-10** | Info Disclosure | Subscriber account enumeration via OTP error messages | Uniform bilingual error messages and identical lockout responses whether account exists or not |
| **T-11** | Info Disclosure | Wallet existence probing via push requests | Constant-time uniform response on `PUSH_APPROVAL` initiation |
| **T-12** | Denial of Service | SMS OTP pumping drains merchant/gateway SMS budget | Sliding-window velocity limits per phone, IP, link, rail, carrier prefix \+ resend cooldowns |
| **T-13** | Denial of Service | Hostile/oversized gateway response exhausts memory | 2 MB response cap, 64 JSON depth cap, `AbortController` timeouts, raw-text-first reader |
| **T-14** | Denial of Service | Webhook retry storm during gateway incident | Sub-10ms synchronous inbox insert \+ immediate HTTP ack; asynchronous worker processing |
| **T-15** | Elevation of Priv | Insider approves their own config or adjustment | `approval_requests_checker_not_maker` `BEFORE INSERT` trigger (MariaDB forbids a `CHECK` constraint on a column that participates in a foreign key) \+ `ApprovalService` \+ API middleware enforcement |
| **T-16** | Elevation of Priv | Admin points flow URL to requestbin to steal secrets | Host-pinned credentials (Safeguard 11\) \+ Maker-Checker on `gateway_versions` |
| **T-17** | Spoofing (SSRF) | Admin/merchant URL targets internal metadata/VPC | HTTPS-only \+ custom DNS hook blocking private IPv4/IPv6 ranges (Safeguard 10\) |
| **T-18** | Tampering | Customer input breaks out of JSON/XML/Header template | Destination-aware encoding (Safeguard 13\) \+ `CR`/`LF` rejection \+ RE2 non-backtracking regexes |
| **T-19** | Tampering | Prototype pollution via dot-path parameter keys | `recursiveSet` explicitly rejects `__proto__`, `constructor`, `prototype` (Safeguard 1\) |
| **T-20** | Tampering | XML External Entity (XXE) attack on SOAP responses | XML parser configured with DTDs and external entities strictly disabled |
| **T-21** | Spoofing | Malicious file uploaded as `MANUAL` transfer proof | Strict MIME/size validation, malware scan, served from isolated domain with `nosniff`, never trusted without Checker |
| **T-22** | Repudiation | Duplicate ledger credit on race between return & webhook | `SELECT ... FOR UPDATE` on attempt \+ `UNIQUE(ref_type, ref_id)` on `journal_entries` \+ `UNIQUE(ledger_entry_id)` |
| **T-23** | Denial of Service | Leaked inbound webhook `path_token` | Zero-downtime `path_token` rotation; signature verification still blocks unsigned traffic |
| **T-24** | Elevation of Priv | Flow step attempts to read another gateway's credentials | Compile-time binding of credential resolver strictly to the route's own `credential_set_id` |

## **11\. Service-Level Objectives (SLOs), Incident Runbooks & DR Replay**

### **11.1 Service-Level Objectives & Error Budgets**

| SLO Metric | Target | Error Budget Policy |
| :---- | :---- | :---- |
| **Attempt Initiation Availability** | **99.9%** of `POST /v1/pay/{linkKey}/initiate` calls return a valid state (excluding upstream gateway faults) | Freeze non-essential gateway rollouts if monthly budget burns \> 50% |
| **OTP Confirmation Latency** | **p95 \< 4.0s** from `POST /confirm` to terminal state on `SYNC_RESPONSE` rails | Investigate gateway latency vs. consumer pool contention |
| **Webhook Processing Lag** | **p95 \< 30.0s** from `inbound_events.received_at` to `processed_at` | Auto-scale inbox workers; inspect dedupe lock contention |
| **`UNKNOWN` Resolution Time** | **95% resolved within 24 hours** | Escalate to Partner Support via `RB-03`; prioritize by amount |
| **Statement Reconciliation Freshness** | **99% ingested within 4 hours** of statement availability | Alert Finance Duty; verify SFTP/parser column mapping |
| **Ledger Invariant Integrity** | **100.0%** (`0.0000 LYD` unexplained drift) | **Immediate P1:** freeze automated cash-out payouts (`RB-04`) |

### **11.2 Five Operational Incident Runbooks**

* **`RB-01` (Gateway Outage):** Circuit breaker opens automatically after N consecutive gateway faults, hiding the route and failing over new attempts to the next healthy route (e.g., direct \-\> aggregator). Half-open `CREDENTIAL_CHECK` probes test recovery.  
* **`RB-02` (Gateway Signature or Sender IP Change):** Triggered by signature-failure spike or valid signature from unlisted IP. Confirm with partner, add new overlapping `secret_version` or CIDR under Maker-Checker, and replay captured `inbound_events` from the inbox.  
* **`RB-03` (`UNKNOWN` Backlog):** Trigger bulk `inquire(attempt)` across affected routes. For no-inquiry rails (Edfali, MobiCash, Sadad on aggregators), keep customer UI on *"Confirming your payment"* and resolve via next statement ingest or Maker-Checker operator case.  
* **`RB-04` (Reconciliation or Clearing Drift):** Automated payouts halt immediately. Re-run statement ingest, inspect `MISSING_AT_GATEWAY`, `MISSING_LOCALLY`, and `AMOUNT_MISMATCH` items, post fee variances to `GATEWAY_FEE_EXPENSE`, and resolve unmatched items via Maker-Checker Adjustments before resuming payouts.  
* **`RB-05` (Credential Expiry or Token Refresh Failure):** Route is automatically removed from ranker on `FAILING` credential status; in-flight attempts finish on pinned credentials; rotate secret or alert merchant for `MERCHANT_DIRECT` sets.

# **PART VII: QUALITY, TESTING AND THE 140-CASE EDGE-CASE MASTER CATALOG**

## **12\. The Twelve Go-Live Gates**

No `gateway_versions` row can transition to `LIVE` without passing all 12 gates:

1. **Maker-Checker Approval** (`checker_user_id != maker_user_id`).  
2. **15-Scenario Sandbox Suite Green** (Happy path, wrong OTP \-\> retry success, expired OTP, insufficient funds, customer limit hit, cancel, 5xx on confirm \-\> `UNKNOWN`, timeout on confirm \-\> `UNKNOWN`, malformed response \-\> `UNKNOWN`, duplicate webhook, out-of-order webhook, late webhook after expiry, amount mismatch, 3-decimal rounding case, cross-environment webhook rejection).  
3. **Amount Pipeline Contract Test Green** (e.g., `10.50 LYD -> "10500"` for Moamalat; `76.255 -> "76.26"` for 2-decimal NEAREST).  
4. **Reference Format Contract Test Green** (charset, length, and uniqueness verified).  
5. **Cryptographic Signature Contract Test Green** against captured real outbound and inbound samples.  
6. **Channel Verification Strength Enforced** (`must_inquire = true` on all hint/IP-only/shared-token channels).  
7. **Named Rollback Version (`rollback_version_id`) Set.**  
8. **Route Limits, Commission Profile, and Statement Parser Previewed.**  
9. **Evidence Level `VERIFIED`** (or explicit `HIGH_RISK` executive risk acceptance signed; or, for `INTERNAL (FIRST-PARTY)` rails such as NeomPay, a green contract suite against the operator's staging environment **(v4.1)**).  
10. **PCI Scope Review Passed** for any rail with a `PAN`\-typed field.  
11. **Canary Traffic Plan Configured** (percentage or merchant allowlist).  
12. **Route Alerts and Runbooks Wired.**

## **13\. The Complete 140-Entry Edge-Case Master Catalog**

### **Group A: Lifecycle and Timing (Cases 1–14)**

| \# | Edge-Case Scenario | Deterministic Platform Resolution | Sev |
| :---- | :---- | :---- | :---- |
| **1** | Customer closes browser after OTP sent or mid-redirect | Attempt stays pending; page resumes from server state via attempt token; `inquire()` runs at expiry before declaring `EXPIRED`. | Med |
| **2** | Reload or back button on OTP screen | UI reads state from server; no second `INITIATE`; resend obeys `otp_resend_cooldown_seconds` and cap. | Low |
| **3** | Gateway session expires before platform TTL (10m/15m) | `expires_at = min(gateway_session_ttl, platform_ttl)`; countdown shown; late submit rejected locally. | Med |
| **4** | Repeated wrong OTP vs. brute-force attack | `RETRYABLE_OTP` increments `otp_attempts` up to `max_otp_attempts` (3) in `AWAITING_CUSTOMER`, then transitions to `FAILED`. | Med |
| **5** | Correct OTP entered, but `SUBMIT` (`CONFIRM`) call times out | Transitions to `UNKNOWN` (never `FAILED`); same OTP is never resubmitted; slot reservation held; background reconciler polls `VERIFY` or statement. | High |
| **6** | Server restart or pod crash during active attempt | Durable `expires_at` and `next_check_at` in the MySQL / MariaDB database; stateless workers resume with `FOR UPDATE SKIP LOCKED` (requires MySQL 8.0+ / MariaDB 10.6+). | High |
| **7** | Two browser tabs or devices open the same single-use link | Atomic `active_locked_count` reservation inside guard transaction; second tab sees *"Payment in progress"*. | Med |
| **8** | Customer clicks retry while previous attempt is `UNKNOWN` | Slot reservation remains held through `UNKNOWN`; retry blocked server-side until `UNKNOWN` resolves. | High |
| **9** | Customer switches rail mid-flow (e.g., Edfali to Moamalat Card) | Old attempt cancelled via `CANCEL` flow (or watched until expiry); new attempt joins same `attempt_group_id` (`success_count <= 1`). | Med |
| **10** | Customer approves push or scans QR after `EXPIRED` | Inbox stays open during `grace_expires_at`; verified late success transitions `EXPIRED -> SUCCEEDED` (or routes to refund if link already paid) and alerts ops. | High |
| **11** | Clock skew and timezone differences (`Africa/Tripoli` vs. UTC) | All DB timestamps UTC; `format_date` uses explicit `gateway_timezone`; webhook timestamps checked within `timestamp_tolerance_sec` (300s). | Med |
| **12** | Link expires between checkout page load and form submit | `POST /initiate` re-verifies link `expires_at` inside serializable guard transaction and returns `LINK_NOT_AVAILABLE`. | Low |
| **13** | Multi-use link reaches `use_count` while attempts are in flight | `confirmed_count + active_locked_count < use_count` enforced at initiation; any excess late settlement routes to `SUSPENSE` \+ refund adjustment. | High |
| **14** | POS screen hits 15-minute idle timeout while QR is pending | Attempt continues server-side; POS screen resyncs on reconnect; cashier can query by reference. | Low |

### **Group B: Confirmation and Trust (Cases 15–31)**

| \# | Edge-Case Scenario | Deterministic Platform Resolution | Sev |
| :---- | :---- | :---- | :---- |
| **15** | Webhook arrives before `INITIATE` DB transaction commits | Stored in `inbound_events` inbox immediately; async worker retries correlation for 60s before opening an alert. | Med |
| **16** | Webhook arrives for an unknown reference | Stored in inbox with `attempt_id = NULL`; no state effect; volume spike alerts ops. | Low |
| **17** | Duplicate webhooks delivered by gateway | Absorbed by `UNIQUE(channel_id, dedupe_key)` and `UNIQUE(ref_type, ref_id)` on `journal_entries`; returns idempotent 200 OK. | High |
| **18** | Out-of-order events (`PAID` webhook followed by late `PENDING`) | State machine is strictly forward-only; `SUCCEEDED` can never be downgraded. | High |
| **19** | Verified success arrives after attempt was marked `FAILED` | Transitions `FAILED -> SUCCEEDED` (or refund pipeline if link satisfied) and triggers `P2` alert. | High |
| **20** | Verified webhook says `SUCCESS`, but `VERIFY` inquiry says `FAILED` | Conflicting trusted signals: nothing posted to ledger, attempt parked in `UNKNOWN`, `P1` `CONFLICT` operator case opened. | High |
| **21** | Moamalat Lightbox JS `completeCallback` fires, but no server webhook/inquiry | Treated as hint only; attempt stays `VERIFYING` with backoff polling, then transitions to `UNKNOWN` if unconfirmed. | Med |
| **22** | Attacker sends forged webhook claiming payment success | Blocked by `path_token`, IP CIDR allowlist, constant-time HMAC/RSA verification, and `must_inquire`. | High |
| **23** | Attacker replays a captured valid webhook hours later | Rejected by `timestamp_tolerance_sec` (300s) and 7-day `dedupe_key` hash in `inbound_events`. | High |
| **24** | Gateway retries webhook aggressively due to slow processing | Receiver stores raw event in `inbound_events` and returns `ack_body_template` in \< 10ms before async processing. | Med |
| **25** | Valid webhook signature, but settled amount or currency differs | Evaluated against route `mismatch_policy`; held in `SUSPENSE` above tolerance. | High |
| **26** | Sandbox webhook sent to Live endpoint (or vice versa) | Separate `path_token` and secrets per environment; rejected with `P2` security alert. | Med |
| **27** | Gateway silently changes signature field order or algorithm | Signature-failure spike alert fires (`RB-02`); raw bytes preserved in `inbound_events` for lossless replay once new `crypto_profile` is approved. | High |
| **28** | Customer tampers with `return_url` query string (`?status=success`) | Return parameters are ignored for confirmation decisions; they only trigger `inquire(attempt)`. | Med |
| **29** | Callback arrives as `application/x-www-form-urlencoded`, XML, or non-UTF8 | Channel `body_format` and charset normalizer parse fields while preserving `raw_body_bytes` for HMAC check. | Med |
| **30** | Callback source IP masked by reverse proxy or changed by provider | Real IP resolved through trusted proxy hops only; valid signature from unlisted IP triggers `RB-02` alert. | Med |
| **31** | Gateway offers neither webhook signature nor inquiry API | Flagged `HIGH_RISK`; requires executive risk acceptance, mandatory statement reconciliation, and operator approval above threshold. | High |

### **Group C: Money, Amounts, Fees and Ledger (Cases 32–48)**

| \# | Edge-Case Scenario | Deterministic Platform Resolution | Sev |
| :---- | :---- | :---- | :---- |
| **32** | Settled amount differs from requested (aggregator rounding or fee) | Stored in `settled_amount`; governed by route `mismatch_policy` (`HOLD_FOR_REVIEW` above tolerance). | High |
| **33** | Amount scale bug (`1000x` too high or low on Moamalat Dirhams) | Prevented by `amount_scale` config, sanity bound check against `link.amount`, and mandatory Go-Live Gate 3 contract test. | High |
| **34** | Rail currency differs from Payment Link currency | Visible-rails formula hides any rail where `rail.currency != link.currency`. | Med |
| **35** | Customer-borne fee (`PAYER_SURCHARGE` or `SPLIT`) | Surcharge calculated from `CommissionProfile`, displayed before confirmation, and booked per Section 9.1. | Med |
| **36** | Customer hits personal CBL/wallet ceiling (LYPay 20k, MobiMal tier) | Mapped to canonical `LIMIT_EXCEEDED`; customer prompted to pick another rail; **excluded from circuit-breaker failure count**. | Low |
| **37** | Gateway changes min/max transaction limits | Enforced on `rail_routes` plus optional capability-probe limit sync. | Med |
| **38** | Partial payment or overpayment received | Held in `SUSPENSE` under `mismatch_policy`; resolved via Maker-Checker `Adjustment`. | Med |
| **39** | Refund requested after `refund_window_days` or on no-refund rail | Blocked by `rails.capabilities` check; requires manual external refund \+ Maker-Checker `Adjustment` with `provider_refund_ref` evidence. | Med |
| **40** | Upstream gateway initiates a chargeback/dispute | Webhook/statement auto-drafts a `CHARGEBACK` Adjustment; upon Checker approval, debits Wallet/Income and credits `CHARGEBACK_RESERVE`. | High |
| **41** | Second payment succeeds on a single-use link (late settlement race) | `attempt_groups.success_count` detects duplicate; second funds post to `SUSPENSE` and auto-queue refund \+ operator alert. | High |
| **42** | Bank/gateway statement has missing or extra lines | Reconciliation job flags `MISSING_AT_GATEWAY` or `MISSING_LOCALLY`, opens operator cases, and halts automated payouts on drift. | High |
| **43** | Gateway settles in T+N net batches (gross minus fees and refunds) | `statement_sources` parser supports batch net lines, matching batch reference and reconciling constituent attempts. | Med |
| **44** | Gateway changes its upstream fee rate mid-month | Route `cost_model` is effective-dated; actual fee from statement posts difference to `GATEWAY_FEE_EXPENSE` as fee variance. | Low |
| **45** | 3-decimal LYD link (`76.255`) paid on a 2-decimal gateway (`76.26`) | `gateway_amount_wire` stores `"76.26"`; rounding direction pinned by contract test; 0.005 variance handled by route tolerance rule. | High |
| **46** | Percentage commission calculation leaves sub-0.0001 remainder | Deterministic `DECIMAL(18,4)` rounding rule in `CommissionProfile` ensures `net_merchant_amount + platform_commission_amount == amount`. | Low |
| **47** | Statement uploaded in Windows-1256 Arabic encoding or custom CSV delimiter | `statement_sources.parser_config` specifies encoding, delimiter, decimal separator, and date format, verified in Test Console preview. | Med |
| **48** | Merchant on `MERCHANT_DIRECT` fails to pay platform commission receivable | When `COMMISSION_RECEIVABLE` exceeds `commission_receivable_ceiling`, merchant's direct routes auto-pause and balance nets against any platform-held wallet. | Med |

### **Group D: Routing, Failover and Availability (Cases 49–58)**

| \# | Edge-Case Scenario | Deterministic Platform Resolution | Sev |
| :---- | :---- | :---- | :---- |
| **49** | Primary gateway down at `INITIATE` (connection refused / 5xx before send) | Classified as definitive pre-point-of-no-return failure; engine transparently fails over to next ranked healthy route for that rail. | Med |
| **50** | Gateway slow or flapping | Per-step `AbortController` timeouts \+ rolling `gateway_health_samples` transition route to `DEGRADED` then `OPEN_BREAKER`. | Med |
| **51** | Scheduled bank or switch maintenance window | `rail_routes.maintenance_windows` hides the route proactively during the window. | Low |
| **52** | Gateway retired, merged, or migrated to a new switch operator | Route set to `DRAINING` (in-flight attempts finish, new traffic routes elsewhere), then `RETIRED` preserving all historical references. | Med |
| **53** | The sole route for a rail opens its circuit breaker | Rail disappears from `visible_rails` at checkout automatically; payment links remain valid on other rails; `P1/P2` alert fires. | Med |
| **54** | Aggregator (e.g., DPay) is down while direct bank gateway is up | Per-route circuit breaker isolates the aggregator route; direct route on the same rail continues serving traffic. | Med |
| **55** | Both aggregator and direct routes active; customer retries across both | Both attempts share `attempt_group_id`; first to confirm wins; if both settle, duplicate-payment refund pipeline handles the second. | High |
| **56** | Gateway rate-limits platform (`HTTP 429`) | Outbound rate limiter \+ concurrency cap per route; `READ_ONLY` steps back off and retry; `429` does not trip the circuit breaker. | Med |
| **57** | Gateway changes JSON response structure after a 200 OK debit | Missing required `step_outputs` selector on `MOVES_MONEY` transitions attempt to `UNKNOWN` (never `FAILED`), preserves raw text in `attempt_step_logs`, and pages on-call. | High |
| **58** | Route hits its `daily_cap_amount` | Ranker excludes the route for the remainder of the day and shifts traffic to the next active route. | Low |

### **Group E: Credentials and Account Ownership (Cases 59–67)**

| \# | Edge-Case Scenario | Deterministic Platform Resolution | Sev |
| :---- | :---- | :---- | :---- |
| **59** | Merchant enters invalid API credentials in Merchant Portal | `CREDENTIAL_CHECK` flow runs on save; credential set remains `UNTESTED`/`FAILING` and cannot route live traffic. | Low |
| **60** | Merchant credentials expire or are revoked by the gateway | Nightly `CREDENTIAL_CHECK` and runtime auth errors mark set `FAILING`, hide its routes, alert merchant/ops, and let in-flight attempts finish. | Med |
| **61** | Zero-downtime rotation of webhook or API secrets | `credential_sets` stores multiple active `secret_version` entries; verifier checks all active versions in constant time during the overlap window. | Med |
| **62** | OAuth2 token refresh fails transiently at gateway | Single-flight refresh retains current valid token if unexpired, schedules jittered retry, and alerts on repeated failures (`RB-05`). | Med |
| **63** | Two merchants attempt to register the same gateway merchant ID | Blocked by `UNIQUE(gateway_id, env, external_merchant_id)` on `credential_sets` and flagged for compliance review. | Med |
| **64** | Merchant migrates from `MERCHANT_DIRECT` to `PLATFORM_CLEARING` | New `credential_sets` and `rail_routes` row activated via Maker-Checker; in-flight attempts finish on pinned set; historical ledger untouched. | Low |
| **65** | Merchant suspended while payments are in flight | New attempts blocked by Guard 2; in-flight confirmed payments post to `AML_HOLD` / `SUSPENSE` per compliance policy. | Med |
| **66** | Misconfiguration attempts to use Merchant A's credentials for Merchant B | Prevented by `rail_routes.scope` check in Ranker **and** hard assertion `credential_set.owner_merchant_id == attempt.merchant_id` in Orchestrator. | High |
| **67** | `MERCHANT_DIRECT` payment triggers an AML threshold hit | Platform holds no cash for direct settlement: blocks completion screen, flags merchant, and opens operational `aml_cases` ticket for CBL reporting. | High |

### **Group F: Configuration, Versioning and Operations (Cases 68–79)**

| \# | Edge-Case Scenario | Deterministic Platform Resolution | Sev |
| :---- | :---- | :---- | :---- |
| **68** | Admin edits a gateway flow while 50 users are entering OTPs | Every `payment_attempts` row pins `gateway_version_id` at creation; all 50 in-flight attempts finish on the exact version they started with. | High |
| **69** | Defective gateway version promoted to `LIVE` | Gated by 12 Go-Live Gates \+ Canary rollout; one-click rollback restores `rollback_version_id` and broadcasts on `InvalidationBus`. | High |
| **70** | Two admins edit the same gateway concurrently | Optimistic concurrency on `gateway_versions.version_number`; each saves an independent draft snapshot. | Low |
| **71** | Sandbox test traffic accidentally routed to Live ledger | Structural separation: `env = SANDBOX` attempts are rejected by `LedgerPoster` and excluded from all wallet/financial queries. | High |
| **72** | Gateway rejects reference format (e.g., T-LYNC 422 on duplicate, Moamalat numeric) | Per-gateway `reference_format` generator enforces charset/length and checks `UNIQUE(reference)` before sending. | Med |
| **73** | Gateway brand name collision (Sadad Libya vs. KSA; Evo Wallet vs. EVO Payments) | `gateways` stores `code`, `operator`, `country`, and `aliases[]`, displayed prominently in the Admin Wizard. | Low |
| **74** | Exported gateway template imported into another environment | Exports omit all secrets by construction; imported version lands as `DRAFT` / `UNVERIFIED` requiring secret entry and `CREDENTIAL_CHECK`. | Med |
| **75** | Maker user is unavailable or leaves company while approval is pending | Any authorized Maker can supersede the draft, and any eligible Checker (`checker_user_id != maker_user_id`) can review; self-approval is impossible. | Low |
| **76** | Admin inspects step logs or exports config containing sensitive tokens | Multi-layer redactor scrubs secret field names and literal decrypted secret strings at write time. | High |
| **77** | Backlog of `UNKNOWN` attempts accumulates during switch instability | Operator Queue tracks SLA timers, supports bulk `inquire()`, and pages duty officer via `RB-03` when age exceeds threshold. | Med |
| **78** | Migrating legacy hard-coded gateway classes into the dynamic platform | Legacy classes wrap as `kind = NATIVE_ADAPTER` behind the 6-method contract, sharing the state machine, inbox, and `LedgerPoster`. | Low |
| **79** | Operator tries to delete a rail or gateway with historical attempts | Hard deletion blocked by FK constraints; gateway transitions to `RETIRED` and rail to `blocked = true`. | Low |

### **Group G: Security and Abuse (Cases 80–90)**

| \# | Edge-Case Scenario | Deterministic Platform Resolution | Sev |
| :---- | :---- | :---- | :---- |
| **80** | Client POSTs modified `amount` or `currency` in `/initiate` or `/confirm` | Client request schemas have no amount field; amount is read exclusively from `payment_links.amount`. | High |
| **81** | Payer enters 7/9-digit card number on OTP rail | Field marked `sensitivity: PAN`; held in memory only for the single step, excluded from `context_ciphertext` and logs, gated by PCI review. | High |
| **82** | Attacker probes registered phone numbers via OTP error differences | ErrorMap normalizes subscriber-not-found and account-locked responses into a generic bilingual message. | Med |
| **83** | SMS OTP pumping attack across thousands of numbers | Atomic sliding-window velocity rules per IP, link, rail, and carrier prefix \+ resend cooldowns block the flood. | High |
| **84** | Open redirect via `payment_links.redirect_url` or clickjacking on checkout | `redirect_url` validated against `applications.redirect_domain_allowlist`; checkout serves `CSP: frame-ancestors 'none'`. | Med |
| **85** | Malicious/compromised gateway returns 100 MB payload or XML bomb | Outbound client enforces `max_response_bytes` (2 MB), JSON depth \<= 64, and disables XML DTD/external entities. | Med |
| **86** | Customer inputs `"}}<script>` or `\r\nX-Injected:` into form field | Destination-correct encoding (JSON serializer, `xml_escape`, URL percent-encoding) and `CR`/`LF` rejection (Safeguard 13). | High |
| **87** | SSRF or DNS-rebinding attack via configured gateway URL | Custom DNS hook resolves and blocks private/loopback/link-local IPv4/IPv6 ranges at connection time (Safeguard 10). | High |
| **88** | Inbound webhook `path_token` leaked in third-party logs | Rotate `path_token` with overlapping validity; cryptographic signature verification still blocks unauthorized callers. | Med |
| **89** | Compromised admin account attempts to reroute payouts or secrets | All credential, route, commission, and payout bank edits require four-eyes Maker-Checker approval and emit P2 security alerts. | High |
| **90** | Payer uploads executable or malware disguised as `MANUAL` transfer receipt | Strict magic-byte MIME check (`image/png`, `image/jpeg`, `application/pdf`), size cap, antivirus scan, isolated object storage with `nosniff`. | Med |

### **Group H: Customer Experience and Channels (Cases 91–98)**

| \# | Edge-Case Scenario | Deterministic Platform Resolution | Sev |
| :---- | :---- | :---- | :---- |
| **91** | Customer types Arabic-Indic digits (`٠٩١٢٣٤٥٦٧٨`) or `+218` phone prefix | `rail_fields.normalizer` converts Arabic-Indic digits to ASCII and normalizes phone format (`09xxxxxxxx` / `2189xxxxxxxx`) before validation. | Low |
| **92** | In-app browser (Instagram/Facebook WebView) blocks Moamalat popup/script | Checkout JS detects WebView restrictions and falls back to a `REDIRECT` route on the same rail or prompts *"Open in system browser"*. | Med |
| **93** | Gateway returns raw Arabic/English technical error string | `ErrorMap` translates mapped codes to polished bilingual messages; unmapped codes show a safe generic message and log the raw code. | Low |
| **94** | Customer clicks `DEEP_LINK` button on desktop or without wallet app installed | Checkout UI renders QR code / Pay Code alongside the deep link and falls back gracefully if app launch fails. | Low |
| **95** | Cashier cancels a pending QR payment on POS terminal | Triggers `CANCEL` flow at gateway (if `supports_cancel = true`), marks attempt `CANCELLED`, releases link reservation, and keeps inbox open for late settlement races. | Low |
| **96** | Slow upstream SMS delivery causes customer to click submit/resend repeatedly | UI disables button with live countdown; backend enforces idempotency key and `otp_resend_cooldown_seconds`. | Med |
| **97** | Gateway confirms success, but MySQL / MariaDB ledger insert encounters a transient lock/error | Because status transition to `SUCCEEDED` and `LedgerPoster` share one DB transaction, attempt remains in `VERIFYING` and worker retries posting idempotently. | High |
| **98** | Merchant webhook/notification emitted twice on retry | Outbound merchant notifications are triggered strictly from the committed `journal_entries` outbox with a unique `event_id`. | Low |

### **Group I: Multi-Instance Cluster, Time, Concurrency & Drift (Cases 99–115)**

| \# | Edge-Case Scenario | Deterministic Platform Resolution | Sev |
| :---- | :---- | :---- | :---- |
| **99** | DST or timezone database update shifts gateway local timestamp formatting | `format_date` uses IANA tzdata (`Africa/Tripoli`); contract tests assert two fixed historical instants per gateway version. | Med |
| **100** | Duplicate webhook redelivered across a worker pod restart (after DB commit, before HTTP ack) | `inbound_events` dedupe key and `UNIQUE(ref_type, ref_id)` on `journal_entries` guarantee zero double-posting across restarts. | High |
| **101** | Finance approves a `REFUND` adjustment while customer starts a new attempt on a multi-use link | Refund `Adjustment` locks and references the specific `source_attempt_id`, operating independently of new attempts on the link. | Med |
| **102** | Gateway silently reorders or renames columns in daily CSV/XLSX settlement statement | `statement_sources` parser validates header row against required column map; halts ingest and fires `P2` alert on schema drift. | Med |
| **103** | Route paused or credential rotated on Node A while Node B serves checkout traffic | `InvalidationBus` (Redis Pub/Sub) evicts Node B caches in \< 1s; attempt initiation always verifies route/version state against the MySQL / MariaDB database. | Med |
| **104** | Gateway incident unleashes 10,000 webhook retries in 60 seconds | Inbox receiver performs lightweight insert \+ ack; bounded worker queue drains `inbound_events` with per-route concurrency caps. | Med |
| **105** | POS tablet loses Wi-Fi/cellular connectivity mid-payment | Attempt completes server-side; on reconnect, POS screen replays missed state from `/v1/pay/{linkKey}/logs/{logId}/status`. | Low |
| **106** | Clock drift between platform cluster and gateway exceeds tolerance | NTP sync monitored via alert; inbound timestamp rejection triggers `RB-02` while preserving raw event in `inbound_events` for replay. | Med |
| **107** | Admin accidentally configures a static reusable QR code across attempts | Save-time validator requires QR/Pay-Code `INITIATE` flows to bind `ATTEMPT.gateway_reference` or dynamic session output. | High |
| **108** | Rolling deployment runs two application versions simultaneously | Both app versions execute the attempt's pinned `gateway_version_id` snapshot using the deterministic closed transform library. | Med |
| **109** | Route set to `DRAINING` or Credential Set marked `REVOKED` with attempts in flight | Pinned `route_id` and `credential_set_id` allow in-flight `AWAITING_CUSTOMER` / `VERIFYING` attempts to finish; only new attempts re-rank. | Med |
| **110** | Automated settlement sweep runs at the exact moment a late payment confirms | Row-level locking on the `gl_accounts` checkpoint and explicit `reconciliation_items` matching serialize the sweep cleanly. | High |
| **111** | Merchant edits `payout_bank_details_json` while a `cashout_requests` row is `PROCESSING` | `cashout_requests` snapshots `destination_bank_json` at request creation; subsequent edits require Maker-Checker and apply only to future payouts. | Med |
| **112** | Aggregator (e.g., MyPay/DPay) renames an underlying payment method alias | Nightly `CREDENTIAL_CHECK` capability probe detects missing alias, marks route `DEGRADED`, and alerts integration engineering. | Med |
| **113** | Two partial refund Adjustments approved concurrently for the same attempt | Execution serializes via `SELECT ... FOR UPDATE` on `payment_attempts` and asserts `SUM(executed_refunds) + new_refund <= settled_amount`. | High |
| **114** | Gateway returns a non-unique `provider_reference` across two different attempts | Correlation prioritizes `our_reference` (`gateway_reference`); `provider_reference`\-only correlation scopes by `(gateway_id, env, amount, active_window)` and flags collisions to `operator_cases`. | Med |
| **115** | Prolonged power/internet outage across a merchant's physical store POS fleet | All state and timers reside on the server; expired POS links release reservations cleanly; settled payments credit the merchant wallet regardless of screen connectivity. | Low |

### **Group J: Onboarding, Identity, Compliance & Disputes (Cases 116–130) (v4.1)**

| \# | Edge-Case Scenario | Deterministic Platform Resolution | Sev |
| :---- | :---- | :---- | :---- |
| **116** | Applicant abandons a `DRAFT` join request after uploading documents | Draft moves to `EXPIRED` after 30 inactive days; uploaded documents remain encrypted, are excluded from reviewer queues, and are purged by the retention job; the applicant can start a new request. | Low |
| **117** | A Google sign-in presents an e-mail identical to an existing password-based account | No auto-link. The user must authenticate to the existing account with a second factor before the Google `sub` is attached; otherwise a separate identity is created and flagged by duplicate detection. | High |
| **118** | A rejected applicant re-applies under a new trade name, phone number and e-mail | Duplicate detection matches tax ID, registration number, owner national ID, payout bank account, device fingerprint or document hash; the request is forced to four-eyes, risk tier is raised one level, and prior records are shown to the reviewer. | High |
| **119** | An admin-assisted onboarding is prepared by the same operator who is assigned to decide it | The person who prepared the request on behalf of the applicant is recorded as maker and is barred from the deciding-reviewer and checker roles for that request. | Med |
| **120** | The same KYB document hash appears under two unrelated merchants | Both requests receive a `DUPLICATE_DOCUMENT` flag; reviewers must justify acceptance; repeated reuse across merchants opens an AML case against the submitting identities. | Med |
| **121** | Beneficial owners are added or changed between submission and decision | A new screening is triggered for the changed owner; the request returns to `IN_REVIEW`; any pending approval is invalidated and must be re-submitted. | Med |
| **122** | Arabic name variants (diacritics, transliterations) cause a missed sanctions hit or a flood of false positives | Names are normalized and sent in Arabic and Latin forms; score thresholds are tuned against a fixed Arabic test set required by the compliance readiness checklist; reviewers see scores and may suppress confirmed false positives with an expiry. | High |
| **123** | A watch-list update creates a new match on an already-active merchant | A `LIST_UPDATE` screening opens a case, restricts cash-out immediately, and keeps payment acceptance unless severity is `CRITICAL`, in which case the merchant is emergency-suspended and ratified within 24 h. | High |
| **124** | The screening provider is unavailable during onboarding | The screening result is `ERROR`; approval is impossible (fail-closed); the request stays `IN_REVIEW`, retries run with backoff, the SLA is paused with reason `PROVIDER_OUTAGE`, and the incident is visible on the compliance dashboard. | Med |
| **125** | A merchant splits one large sale across several links, applications or rails to stay under an AML threshold | Rules aggregate by subject (merchant, beneficial owner, payer identifier) over the window, not by link or application; the `STRUCTURING` rule flags many payments clustered just under the threshold and opens a case. | High |
| **126** | A voluntary refund was issued and a chargeback arrives later for the same payment | The dispute is linked to the refund; execution asserts `SUM(executed refunds) + chargeback <= settled_amount` under `SELECT ... FOR UPDATE` (as in Edge Case 113); the chargeback Adjustment is capped to the not-yet-returned amount. | High |
| **127** | An emergency suspension is never ratified within 24 hours | A P2 alert and an escalation to `MLRO` fire; the suspension stays in force (fail-safe); it is never auto-reversed; the request remains open until ratified or replaced by a standard reinstatement approval. | Med |
| **128** | A dispute webhook is replayed, or a statement containing the same chargeback is re-imported | `UNIQUE(gateway_id, external_dispute_ref)` and the inbox dedupe key absorb the duplicate; no second Adjustment is drafted. | Med |
| **129** | An AML hold is approved for release while the merchant is `SUSPENDED` or requesting closure | The ledger resolution executes regardless of merchant state (accounting is independent of lifecycle); closure is refused while any hold, reserve, open dispute or non-zero balance exists. | Med |
| **130** | Support staff or a merchant asks why an account was restricted for AML reasons | The response is the generic notice; AML data is not exposed to `SUPPORT` or merchants; the request itself is logged; there is no tipping-off. | High |

### **Group K: NeomPay & Internal Rails (Cases 131–140) (v4.1)**

| \# | Edge-Case Scenario | Deterministic Platform Resolution | Sev |
| :---- | :---- | :---- | :---- |
| **131** | The entered NeomPay wallet ID fails the check-digit test or has an unknown type code | Rejected at field validation with a generic bilingual message; no call is made to NeomPay; the failure counts toward per-IP velocity so the check cannot be used to enumerate wallets. | Low |
| **132** | The payer's wallet is frozen, closed or restricted in NeomPay | `ErrorMap` classifies as `TERMINAL_DECLINE` with a generic customer message; it does not count toward the circuit breaker (a customer condition, not a gateway fault). | Low |
| **133** | The NeomPay ledger times out or is unavailable | On a `MOVES_MONEY` step the attempt becomes `UNKNOWN` and holds the link slot; idempotent retry and `inquire(attempt)` resolve it; the route moves to `DEGRADED` / `OPEN_BREAKER` and other rails remain offered. | High |
| **134** | The payer wallet belongs to the same legal entity as the merchant (self-payment) | `SELF_PAYMENT_POLICY` (default `BLOCK`) creates a terminal `BLOCKED` attempt; alternative `FLAG_AND_ALLOW` opens an AML case; prevents wash volume and artificial commission. | High |
| **135** | NeomPay captured the payer's funds but the platform crashed before committing the journal entry | On restart the sweeper runs `inquire(attempt)`, finds a captured payment, and posts the entry idempotently; `UNIQUE(ref_type, ref_id)` prevents a second posting; the daily cross-ledger check would expose any miss. | High |
| **136** | The payer approves a push request after the attempt has expired | NeomPay-side request TTL equals the attempt's `expires_at`; a late capture is rejected. If a capture slipped through, State Machine Rule 6 (late-success recovery) applies, with funds in `SUSPENSE` and an auto-drafted refund if the link slot is gone. | Med |
| **137** | The customer double-taps the OTP submit button or the browser retries the request | The deterministic `Idempotency-Key` (`gateway_reference`) returns the same result; at most one debit occurs; the second request is a read of the first. | Med |
| **138** | The payer wallet's type is not allowed to pay merchants | The type-code allow-list on the rail field rejects it at validation with a neutral message; no money moves. | Low |
| **139** | A refund is approved but the payer's NeomPay wallet has since been closed | The `REFUND` step fails; the Adjustment stays `EXECUTING` and an operator case opens; `FINANCE` may complete the return by another channel with evidence under Maker-Checker, or, after the policy period, reclassify the funds to `SUSPENSE` as unclaimed. | Med |
| **140** | The daily cross-ledger equality check (NeomPay ledger export versus Treasury inflows from NeomPay) shows drift | Runbook `RB-04` applies: automated payouts of NeomPay-sourced funds halt, a `MISMATCH` operator case is opened, and the daily job is re-run; no manual ledger edits are allowed; the correction is a Maker-Checker Adjustment. | High |


# **PART VIII: ADMIN WIZARD, API SURFACE & DELIVERY ROADMAP**

## **14\. The 8-Step Admin "Add-a-Gateway" Wizard & 6-Stage Delivery Plan**

### **14.1 The 8-Step Zero-Code Admin Wizard**

1. **Step 1 — Gateway Identity & Basics:** Configure `code`, `name`, `operator`, `country`, `aliases[]`, `kind` (`DIRECT`, `AGGREGATOR`, `NATIVE_ADAPTER`, `INTERNAL`), `verification_state`, and `risk_class`.  
2. **Step 2 — Environments, Auth & Credential Sets:** Configure `SANDBOX` and `LIVE` base URLs, `allowed_hosts`, `inbound_ip_allowlist`, `GatewayAuth`, and write-only `CredentialSet` (`PLATFORM` vs. `MERCHANT` ownership, `settlement_target`). Run live `CREDENTIAL_CHECK`.  
3. **Step 3 — Customer Catalog (`Rail` & `RailField` Builder):** Drag-and-drop bilingual (AR/EN) form builder with regexes, ranges, `arabic_digits_to_ascii` / `phone_normalize` normalizers, and `NORMAL` / `SENSITIVE` / `PAN` sensitivity badges.  
4. **Step 4 — Cryptographic Profiles:** Configure outbound signing and inbound verification profiles (`HMAC_SHA256`, `HEX` key decoding, `SORTED_KEY_VALUE_AMP`, `TIMESTAMP_DOT_RAW_BODY`, `SORTED_VALUES_HASH`, `RSA`) with an interactive **Test Signature Verifier** against partner documentation samples.  
5. **Step 5 — Multi-Phase Flow Builder:** Visual step builder for all 10 phases (`CREDENTIAL_CHECK`, `PRE_INITIATE`, `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, `REFUND`, `VOID`, `CAPTURE`, `SETTLEMENT_FETCH`) with `TransformPipe[]`, `side_effect`, `retry_policy`, `idempotency_config`, and `point_of_no_return`.  
6. **Step 6 — Client Action, Confirmation Channels & Polling:** Configure `ClientAction`, `WidgetDefinition` / `RedirectDefinition`, `ConfirmationChannel` trust rules (`must_inquire`), and `PollPolicy`.  
7. **Step 7 — Status Rules, Error Map, Limits, Fees & Statement Parser:** Map gateway codes to canonical statuses and bilingual messages; configure `amount_scale`, `amount_precision`, `amount_rounding`, route cost models, mismatch tolerances, and `StatementSource` CSV/XLSX/JSON column mappings with live file preview.  
8. **Step 8 — Dry-Run Simulator, 15-Scenario Sandbox Suite & Maker-Checker Submission:** Inspect compiled requests, run the automated scenario suite and contract tests against Sandbox/Mock Gateway, set `rollback_version_id`, and submit `gateway_versions` for Checker approval.

### **14.2 Six-Stage Production Delivery Plan**

| Stage | Scope & Deliverables | Exit Criteria (Go-Live Gate Verification) |
| :---- | :---- | :---- |
| **Stage 1: Core Foundations & Ledger** | MySQL / MariaDB schema (64 tables, §5), `DynamicRailEngine` core, 14 safeguards, `ApiConsumer` registry, `TransformPipe[]`, `CryptoProfile` engine, 13-state machine with `active_locked_count`, `inbound_events` inbox, `LedgerPoster` with `GATEWAY_CLEARING`, Maker-Checker engine, and Mock Gateway. | Mock Gateway end-to-end payment posts balanced journal entry; continuous ledger invariant check green; 14 safeguards unit-tested. |
| **Stage 2: OTP & Redirect Rails** | `OTP_PULL` and `REDIRECT` playbooks, pre-flight guard pipeline (Velocity \+ AML), Test Console, and 15-scenario test runner. Onboard **DPay**, **Plutu**, **MyPay**, **T-LYNC**, **Sadad**, and **Edfali**. | First aggregator route and first direct OTP rail pass all 12 Go-Live Gates and process canary live traffic. |
| **Stage 3: Embedded, Push, QR & POS Realtime** | `EMBEDDED` (`WidgetDefinition`), `QR_DISPLAY`, `PUSH_APPROVAL`, `PAY_CODE`, `DEEP_LINK`, `HYBRID`, and WebSocket/SSE POS Screen rooms. Onboard **Moamalat Lightbox**, **LYPay**, **OnePay**, **MobiCash**, **Yussor Pay**, **Sahara Pay**, and **Visa/MC (MPGS 3DS2)**. | Moamalat Lightbox card rail and LYPay/OnePay POS QR rails live with mandatory server inquiry verification. |
| **Stage 4: Reconciliation, Fee Accrual & Refunds** | `StatementSource` CSV/XLSX/JSON ingestion, `GATEWAY_FEE_ACCRUAL` true-ups, automated `REFUND`/`VOID` flows via Maker-Checker `Adjustments`, per-route circuit breakers, and SLO/Alert dashboards (`RB-01` to `RB-05`). | Two full T+N bank/gateway statement reconciliation cycles close with `0.0000 LYD` unexplained drift. |
| **Stage 5: Merchant-Owned Credentials & Manual Rails** | Self-service Merchant Portal `CredentialSet` setup (`MERCHANT_DIRECT`), `COMMISSION_RECEIVABLE` accounting and netting, and `MANUAL` bank-transfer/agent rails with operator confirmation. | First `MERCHANT_DIRECT` merchant completes full payment and commission-netting cycle. |
| **Stage 6: Scale, Native Adapters & Chaos Drills** | `NATIVE_ADAPTER` registration framework, remaining partner profiles (**Numo Pay, GPay, Hawelli, Evo Pay, Libyana**) promoted from `UNVERIFIED` as docs arrive, multi-node Redis `InvalidationBus`, and monthly chaos drills. | New gateway onboarded by Operations via the 8-step Wizard in \< 4 hours with zero code deployment. |

### **14.3 v4.1 Delivery Plan Addendum**

The restored and new capabilities are mapped onto the six existing stages as parallel workstreams. Stage exit criteria in §14.2 remain in force; the additions below are *additional* exit criteria.

| Workstream | Placed in | Scope | Additional Exit Criteria |
| :---- | :---- | :---- | :---- |
| **WS-A Identity & Onboarding** | Stage 1 (backend) and Stage 2 (portal UI) | `user_identities`, `join_requests`, `kyb_documents`, `beneficial_owners`, notification outbox, merchant lifecycle states, Merchant Portal registration and onboarding screens, Admin join-request queue. | A test merchant completes registration → KYB → approval → first sandbox payment; every transition has an `audit_log` row and a notification. |
| **WS-B Compliance Program** | Stage 2 (hot-path rules, case management), Stage 4 (reporting, periodic re-screening) | `ScreeningProvider` adapter, `aml_screenings`, `aml_rules`, extended `aml_cases`, `reporting_rules`, `regulatory_reports`, retention jobs. | Seeded sanctions test subject is blocked at onboarding; a threshold rule opens a hold and a case; a `PROVISIONAL` reporting rule is proven unable to produce a live report. |
| **WS-C Interfaces & Reporting** | Stage 3 (portal modules), Stage 4 (profitability and liquidity views) | Role and authority enforcement, Merchant Portal modules, Admin Back Office modules, ledger-derived statistics (§20). | Profit figures for a closed day equal the sum of the relevant `journal_lines`; merchants cannot see gateway cost. |
| **WS-D Disputes** | Stage 4 | `disputes`, system drafting principal, evidence deadlines, WON / LOST ledger outcomes. | A simulated rail dispute produces a `DRAFT` Adjustment; no money moves until a Checker approves. |
| **WS-E NeomPay Rail** | Stage 2 (recommended as the first production rail) | Blueprint 7, `INTERNAL` gateway kind, Ledger Rule INTERNAL-1, NeomPay-side contract (Blueprint 7). | Contract suite green against NeomPay staging; daily cross-ledger equality check green for two consecutive weeks. *Rationale:* NeomPay has no external dependency or partner onboarding delay, so it is the quickest rail to prove the end-to-end engine with real money. |

---

# **PART IX: PLATFORM INTERFACES, ONBOARDING, GOVERNANCE & COMPLIANCE PROGRAM (v4.1)**

*Part IX restores the operational and organizational layer of the original proposal that v4.0's engineering focus omitted. It builds on, and never contradicts, the engine, ledger and security design in Parts I–VIII.*

## **15\. Actors, Interfaces, Roles & the Four-Eyes Matrix**

### **15.1 The Interface Catalogue**

The platform presents three human-facing interfaces and three machine-facing surfaces. Every interface serves one distinct set of users with one core job.

| Interface | Users | Authentication | Core Job | Surface |
| :---- | :---- | :---- | :---- | :---- |
| **Merchant Portal** | Merchants, merchant staff, cashiers | Phone / e-mail / Google identity (`user_identities`) + MFA | Onboard; manage Applications, Wallets, Users, Tokens; create Payment Links; run POS; request cash-out; view balance, statements and statistics; set up `MERCHANT_DIRECT` credentials | Web app over `/v1/merchant/...` |
| **End-Client Checkout** | Anonymous payers | None; the link key is the capability; per-IP and per-link rate limits | Resolve a link, pick a rail, pay, see a receipt or be redirected | `/v1/pay/{linkKey}` and its SSE stream |
| **Admin Back Office** | Platform operators acting as makers and checkers | Username / password + mandatory MFA; optional IP allowlist; short sessions | Review join requests and KYB; AML and dispute cases; commission and detail changes; cash-outs and adjustments; gateway configuration; suspend or edit merchants; monitor profit and liquidity | `/admin/v1/...` |
| **Merchant API** | Merchant servers | Bearer `access_tokens` (`pg_live_` prefix), optional IP CIDR allowlist, scoped | Create and query Payment Links and attempts using the same field set as the portal | `/v1/merchant/...` |
| **POS Screens** | Cashier and customer-facing displays | Per-screen token; 15-minute idle timeout | Realtime display of the current link and payment state | WebSocket / SSE room |
| **Inbound Callbacks** | External gateways | Signatures, IP allowlists, path tokens (§6, `confirmation_channels`) | Deliver authenticated payment, dispute and statement events | `/v1/callbacks/...`, `/inbound/{gateway}/{env}/{token}` |

### **15.2 The Role Model (v4.1)**

`users.role` is a coarse classification; actual permissions come from `authorities_map` (§15.3). An empty `authorities_map` grants **no access**, regardless of role. Roles marked ● may act as **Maker**, ○ as **Checker**, subject to the per-user flags `is_maker` and `is_checker` and to the rule that no user may be both on the same `approval_requests` row.

| Role | Scope | Typical Duties | Maker | Checker |
| :---- | :---- | :---- | :---: | :---: |
| `GATEWAY_ADMIN` | Platform | Configure gateways, rails, routes, flows; propose `gateway_versions` | ● |  |
| `SECURITY_ADMIN` | Platform | Approve gateway versions, widget script / CSP changes, user and authority changes, credential changes; rotate secrets | ● | ○ |
| `FINANCE` | Platform | Cash-outs, adjustments, refunds, reconciliation, commission proposals, profit and liquidity views | ● | ○ |
| `OPERATOR` | Platform | Operator cases (`UNKNOWN`, `LATE_SUCCESS`, `MISMATCH`), join request first review, merchant support actions | ● |  |
| `COMPLIANCE` | Platform | KYB and AML review, screening dispositions, AML case proposals, STR drafting | ● |  |
| `MLRO` | Platform | Final approval of AML case resolutions and regulatory reports; ratifies emergency suspensions | ○ | ○ |
| `SUPPORT` | Platform | Read-only access to merchant records, field-history (`detail_change_logs`), attempt status; **no** AML data, **no** money movement | — | — |
| `MERCHANT_ADMIN` | One merchant | Full merchant self-service; manages staff and tokens; requests cash-out | ● (own-merchant changes that require approval) | — |
| `MERCHANT_STAFF` | One merchant, optionally scoped by `app_scope_ids` | Create links, view payments and statistics according to authorities | — | — |
| `MERCHANT_CASHIER` | One merchant / one POS | Operate assigned POS screens only | — | — |

`MLRO` stands for the Money Laundering Reporting Officer, the senior compliance function that owns suspicious-activity decisions. The role is defined so that AML and reporting decisions have a *distinct* second reviewer from the compliance analyst who prepared them.

### **15.3 The Authorities Catalogue**

`authorities_map` is a JSON map of resource → permitted actions. The catalogue below is the closed set of resources; unknown keys are rejected at save time.

| Domain | Resource keys (actions) |
| :---- | :---- |
| **Merchant side** | `links` (`create`, `read`, `cancel`) · `payments` (`read`, `export`) · `wallets` (`read`) · `cashout` (`request`, `read`) · `applications` (`read`, `edit_descriptive`, `propose_sensitive`) · `pos` (`manage`, `operate`) · `tokens` (`create`, `revoke`, `read`) · `credentials` (`manage`) · `users` (`manage`) · `stats` (`read`) · `statements` (`read`, `export`) |
| **Admin side** | `joinrequests` (`review`, `decide`) · `kyb` (`review`) · `merchants` (`read`, `edit_descriptive`, `propose_sensitive`, `suspend`, `reinstate`) · `commission` (`propose`) · `velocity` (`propose`) · `adjustments` (`propose`) · `cashout` (`process`) · `reconciliation` (`run`, `resolve`) · `gateways` (`edit`, `submit`) · `aml` (`review`, `propose`, `read_confidential`) · `reports` (`draft`) · `profit` (`read`) · `liquidity` (`read`) · `support` (`read_merchant`) · `users_admin` (`propose`) |
| **Checker-only** | `approvals` (`approve`, `reject`) with an additional `domains` list restricting *which kinds* of request a checker may decide (for example a `FINANCE` checker cannot approve an `AML_CASE`). |

### **15.4 The Four-Eyes Action Matrix**

The single `approval_requests` wrapper (state machine: `DRAFT → PENDING_REVIEW → APPROVED → EXECUTED`, or `REJECTED` back to `DRAFT`) governs every action below. The **Maker ≠ Checker** rule is enforced by the `approval_requests_checker_not_maker` `BEFORE INSERT` trigger (MariaDB forbids a `CHECK` constraint on a column that participates in a foreign key, so the database-level guarantee is a trigger raising `SIGNAL SQLSTATE '45000'`), by the application-level check in `ApprovalService`, and again in the `makerCheckerGuard` middleware, regardless of what the client sends.

| Action | Typical Maker | Required Checker | Execution Effect (atomic with approval) |
| :---- | :---- | :---- | :---- |
| Adjustment: chargeback, refund, manual credit/debit, correction | `FINANCE`, `OPERATOR`, or the system drafting principal (§19.3) | `FINANCE` (different user) | Journal Entry posted; Adjustment `EXECUTED` |
| Cash-out `COMPLETE → SUBTRACTED` | `FINANCE` | `FINANCE` (different user) | `CASHOUT_SUBTRACTION` Adjustment posted |
| Commission Profile create / change | `FINANCE` | `FINANCE` or `SECURITY_ADMIN` | New effective-dated version activated |
| Sensitive Merchant fields (payout bank details, tax ID, registration no., business category, risk tier, KYB status override, commission-receivable ceiling) | `OPERATOR`, `COMPLIANCE`, or `MERCHANT_ADMIN` (request) | `COMPLIANCE` or `FINANCE` by field domain | Field updated; `detail_change_logs` row linked to the approval |
| Sensitive Application fields (assigned wallet, rail whitelist, redirect-domain allowlist) | `MERCHANT_ADMIN` or `OPERATOR` | `OPERATOR` (different user) or `COMPLIANCE` for risk-relevant changes | Field updated; takes effect for **new** attempts only |
| `velocity_rules` and `aml_rules` changes (R13) | `COMPLIANCE`, `FINANCE` | `MLRO` for AML rules; `SECURITY_ADMIN` or `FINANCE` for velocity rules | New rule version activated. *Emergency tightening* may be activated immediately and ratified within 24 h; *loosening* never bypasses review |
| AML case resolution (release / void / freeze) | `COMPLIANCE` | `MLRO` | Release or void Journal Entry posted |
| Regulatory report submission (LTR / STR) | `COMPLIANCE` | `MLRO` | Report frozen and marked `SUBMITTED` |
| Join Request decision | `OPERATOR` or `COMPLIANCE` | Per `join_request.four_eyes_policy` (§16.5) | Merchant activated or rejected; notification sent |
| Merchant suspension | `OPERATOR`, `COMPLIANCE` | **Emergency path:** immediate effect, ratified within 24 h by `MLRO` or `COMPLIANCE` (different user) | Merchant `SUSPENDED`; ratification closes the request |
| Merchant reinstatement | `OPERATOR`, `COMPLIANCE` | `COMPLIANCE` or `MLRO` (different user), **never** emergency | Merchant `ACTIVE` |
| `gateway_versions` going `LIVE`; credential, route and payout-bank edits | `GATEWAY_ADMIN` | `SECURITY_ADMIN` | Version promoted; P2 security alert (Edge Case 89) |
| Admin user, role and authority changes | `SECURITY_ADMIN` | A different `SECURITY_ADMIN` | Authorities updated; sessions revoked |
| `platform_settings` compliance keys | `COMPLIANCE`, `FINANCE` | `MLRO` or `SECURITY_ADMIN` | New setting version effective |

**Asymmetry principle.** Actions that *reduce* risk (suspending a merchant, tightening a rule, pausing a route) may take effect immediately with post-hoc ratification, because delay is the hazard. Actions that *increase* risk or move money (reinstating, loosening, releasing, paying out) always require prior four-eyes approval.

### **15.5 Merchant Portal Capability Map**

| Module | Capabilities | Key Data Sources | Required Authority |
| :---- | :---- | :---- | :---- |
| **Onboarding** | Register, complete business profile, upload KYB documents and owner details, respond to information requests, track status | `user_identities`, `join_requests`, `kyb_documents`, `beneficial_owners` | (self, pre-approval) |
| **Dashboard** | Balance (derived from the wallet's `gl_accounts` row), pending cash-outs, today's volume, success rate, recent payments | `wallets`, `journal_lines`, `payment_attempts` | `stats.read`, `wallets.read` |
| **Wallets** | Create wallets, view balance and statement per wallet | `wallets`, `gl_accounts` | `wallets.read`, `applications.propose_sensitive` |
| **Applications** | Create, edit descriptive fields, propose sensitive changes (wallet, rail whitelist, redirect domains) | `applications`, `approval_requests` | per §17.3 |
| **Payment Links** | Create (single or multi-use, redirect URL, amount, optional rail whitelist), cancel, copy / QR, view attempts | `payment_links`, `payment_attempts` | `links.*` |
| **POS** | Manage terminals and screens, pair screens, view live state | `pos_terminals`, `pos_screens` | `pos.manage`, `pos.operate` |
| **Payments & Disputes** | Search and export payments; see each payment's gross, **commission**, net (never gateway cost); view disputes and respond with evidence where the rail allows | `payment_attempts`, `disputes` | `payments.read`, `payments.export` |
| **Cash-out** | Request payout to the verified bank account; see state `PENDING → PROCESSING → COMPLETE → SUBTRACTED` | `cashout_requests` | `cashout.request` |
| **Developers** | Create and revoke API tokens (IP allowlist, scopes); view webhook / notification delivery log | `access_tokens`, `access_token_ips` | `tokens.*` |
| **Credentials (Stage 5)** | Enter and test `MERCHANT_DIRECT` gateway credentials (write-only secrets, `CREDENTIAL_CHECK` on save) | `credential_sets` | `credentials.manage` |
| **Team** | Invite staff and cashiers, assign authorities and application scope | `users` | `users.manage` |
| **Statements & Statistics** | Monthly statements, CSV / PDF export, rail mix, average ticket, refund and dispute rate | derived views (§20.5) | `statements.*`, `stats.read` |

### **15.6 Admin Back Office Capability Map**

| Module | Capabilities | Notes |
| :---- | :---- | :---- |
| **Join Requests & KYB** | Queue with SLA timers, document viewer, checklist, screening result, decision, information request | §16 |
| **Merchants** | Search, view, suspend, reinstate, propose sensitive edits; field history | Support sees descriptive data and history only |
| **Applications & Links** | Inspect configuration and links; propose sensitive application edits | Maker-Checker per §15.4 |
| **AML & Cases** | Screening results, rule hits, case queue with severity and SLA, dispositions, resolutions, report drafting | `AML-CONFIDENTIAL`; `COMPLIANCE`, `MLRO` only |
| **Operator Cases** | `UNKNOWN`, `HELD`, `CONFLICT`, `MISMATCH`, `LATE_SUCCESS`, `UNMATCHED_STATEMENT` queue | v4.0 `operator_cases` |
| **Disputes & Adjustments** | Dispute queue with evidence deadlines; propose, review and approve adjustments | §19 |
| **Cash-outs** | Pending queue, bank-detail snapshot, process, complete, subtract | `FINANCE` |
| **Commission & Rules** | Commission profiles, velocity rules, AML rules; version history and effective dates | Maker-Checker |
| **Gateways & Rails** | 8-step Add-a-Gateway wizard, versions, routes, health, circuit breakers | §14.1 |
| **Reconciliation & Ledger** | Statement ingest, matching, drift, invariant status, trial balance | §9.2, §20.4 |
| **Profitability & Liquidity** | Revenue, cost, net, chargeback losses, Treasury cover, aging of clearing balances | §20 |
| **Users & Security** | Admin users, roles, authorities, sessions, audit-log search | `SECURITY_ADMIN` |
| **Settings** | `platform_settings` with version history | Maker-Checker for compliance keys |

### **15.7 End-Client Checkout Contract**

The checkout contains no gateway-specific logic (§6.2). It resolves a link, applies the visible-rails formula (§4), renders the chosen rail's declarative `ClientAction`, and finishes with a receipt or a redirect. User-visible error states are bilingual, never reveal internal reasons for AML or velocity blocks (the customer sees only a generic "cannot process this payment" message while the attempt records the precise `BLOCKED` reason for audit), and never confirm whether a phone number or wallet exists (Edge Case 82).

---

## **16\. Merchant Onboarding & Join Request Flow**

### **16.1 The Journey**

| Stage | What Happens | System Records |
| :---- | :---- | :---- |
| **1. Landing** | Public landing page with product description, pricing summary and a "Start Now" call to action; existing merchants log in from the same page. | — |
| **2. Register / Log in** | Applicant registers with phone, e-mail or Google (§16.3). A `users` row (`MERCHANT_ADMIN`) and a `user_identities` row are created; verification is required before continuing. | `users`, `user_identities`, `audit_log` |
| **3. Business profile & KYB** | Applicant completes legal name, trade name, registration number, tax ID, business category, expected volume, contact details; uploads documents; declares beneficial owners and signatories. | `merchants` (`PENDING`, `kyb_status = PENDING`), `kyb_documents`, `beneficial_owners` |
| **4. Submission** | Applicant submits. A `join_request` moves `DRAFT → SUBMITTED`; an SLA timer starts; the initial AML screen is queued. | `join_requests`, `aml_screenings` |
| **5. Review** | Reviewer checks identity, KYB documents and screening result against a checklist (§16.5). The reviewer may request more information, which pauses the SLA clock. | `join_requests` (`IN_REVIEW`, `INFO_REQUESTED`) |
| **6. Decision** | Approve or reject, with a four-eyes step where policy requires (§16.5). | `join_requests`, `approval_requests` |
| **7. Notification** | The applicant is notified by SMS and/or e-mail in their language (§16.7). | `notifications` |
| **8. First login & setup** | Approved merchants log in from the same landing page, then create Wallets, Applications and Payment Links (§17). Live traffic is enabled only for `ACTIVE` merchants. | `merchants` (`ACTIVE`), `audit_log` |

### **16.2 The `join_requests` State Machine**

```
DRAFT ──submit──▶ SUBMITTED ──assign──▶ IN_REVIEW ──┬─approve (no four-eyes)──▶ APPROVED
  │                    │                    ▲  │     ├─approve (four-eyes)────▶ PENDING_CHECKER ──┬─▶ APPROVED
  │                    │                    │  │     │                                            └─▶ IN_REVIEW (checker returns)
  │                    │                    │  │     ├─reject─────────────────▶ REJECTED
  │                    │            applicant│  ▼     └─request info───────────▶ INFO_REQUESTED ──applicant responds──▶ IN_REVIEW
  │                    │             responds│  INFO_REQUESTED
  │                    └──────withdraw───────┴──────────────────────────────▶ WITHDRAWN
  └── inactive 30 days ────────────────────────────────────────────────────▶ EXPIRED
```

Rules:

1. Only **one open** `join_request` (not `APPROVED`, `REJECTED`, `WITHDRAWN` or `EXPIRED`) may exist per merchant.
2. `INFO_REQUESTED` **pauses** the SLA clock; `sla_due_at` is recomputed when the applicant responds. The default review SLA is 2 business days for `LOW` / `STANDARD` proposed risk and 5 business days for `HIGH`.
3. The applicant sees only the status and the *requested information*; internal reviewer notes and AML results are never exposed (§18.9).
4. A rejection carries an enumerated `decision_reason_code` (for example `INCOMPLETE_DOCUMENTS`, `UNVERIFIABLE_BUSINESS`, `PROHIBITED_ACTIVITY`, `POLICY`). Codes that would reveal a screening outcome are mapped to the neutral code `POLICY` in applicant-facing messages.
5. A rejected applicant may submit a **new** `join_request` (with `resubmission_of_id` set) only after correcting the cause; the duplicate-detection rules in §16.9 apply.
6. Approval executes atomically (§16.6) together with its `approval_requests` row when four-eyes is required.

### **16.3 Registration & Authentication**

* **Identity types:** phone (SMS OTP), e-mail (verification link or code) and Google (OpenID Connect). One user can link several identities; each must be verified before use. The Google `sub` claim, not the e-mail address, is the stable key.
* **Account linking safety:** a Google identity is linked to an existing account only after the user proves control of that account with a second factor. E-mail address equality alone never auto-links accounts (account-takeover risk, Edge Case 117).
* **MFA:** mandatory for `MERCHANT_ADMIN` and all platform roles; strongly recommended for staff. A phone OTP counts as a second factor only when the primary identity is not the same phone.
* **Anti-enumeration:** registration and login responses are identical whether or not an identity exists, and OTP error messages are normalized (Edge Case 82).
* **Abuse controls:** per-IP, per-device-fingerprint and per-identity rate limits; progressive delays; CAPTCHA after repeated failures; SMS pumping protection through per-prefix limits and a daily SMS budget alarm.
* **Session security:** short-lived access tokens, rotating refresh tokens, session list with remote revoke, forced re-authentication before sensitive actions (payout bank change, token creation, cash-out request).

### **16.4 KYB Data & Documents**

* **Business data:** legal name, trade name, registration number, tax ID, business category (from a controlled list that carries a default risk weight), registered address, contact details, expected monthly volume, website or sales channel description.
* **Required documents (configurable per business category):** commercial registry certificate, tax certificate, articles of association (for companies), identification of each beneficial owner and authorized signatory, proof of address, bank letter confirming the payout account, and a sector licence where the activity is regulated.
* **Document controls:** type and size limits, antivirus scan before reviewer access, content-hash storage (`sha256`), encrypted storage, never overwritten, expiry dates tracked (`expires_on`). A document reused by an unrelated merchant raises a duplicate flag.
* **Per-document status:** `UPLOADED → ACCEPTED | REJECTED | EXPIRED`. `merchants.kyb_status` becomes `VERIFIED` only when every *required* document is `ACCEPTED` and every beneficial owner is screened and cleared or dispositioned.
* **Payout account ownership:** the bank account named in `payout_bank_details_json` must be in the merchant's legal name (or an explicitly documented related party); a mismatch routes the request to `FOUR-EYES` regardless of policy.

### **16.5 Review Workflow & the Join Request Four-Eyes Decision**

**Reviewer checklist (all items must be recorded):** (1) applicant identity verified; (2) business existence and registration verified against documents; (3) beneficial owners identified at the configured threshold; (4) initial AML screen result reviewed (`CLEAR`, `POTENTIAL_MATCH` dispositioned, or `CONFIRMED_MATCH`); (5) business category and expected volume consistent with the described activity; (6) payout account ownership verified; (7) proposed `risk_tier` assigned.

**Management decision restored from the original proposal.** The original noted that Join Request approval *"as an admin action, is arguably already two-party — worth a management decision on whether it needs a second checker."* v4.1 does not hard-code the answer. It provides a platform setting:

| `join_request.four_eyes_policy` | Behaviour |
| :---- | :---- |
| `ALWAYS` | Every approval and rejection requires a second reviewer. Highest control, slowest onboarding. |
| `RISK_BASED` **(recommended default)** | A second reviewer is required if **any** trigger applies: proposed `risk_tier = HIGH`; screening result is not `CLEAR`; any beneficial owner is a declared or detected PEP; business category is on the high-risk list; expected monthly volume exceeds `join_request.volume_threshold`; payout account ownership mismatch; the applicant was previously rejected. Otherwise a single authorized reviewer may decide. |
| `NEVER` | A single reviewer decides. Lowest control; **not recommended** for a regulated payment platform. |

`four_eyes_reasons` records which triggers fired. **Rejections of `RISK_BASED` triggered requests are also four-eyes** (a wrongful rejection of a clean applicant is a commercial risk; a wrongful approval is a compliance risk). The setting is a Maker-Checker `platform_settings` key; see **OD-2** in Part X.

### **16.6 What Approval Does (Atomic)**

Within a single database transaction: (1) `join_requests.status = APPROVED`; (2) `merchants.status = ACTIVE`, `kyb_status = VERIFIED`, `risk_tier` set, `activated_at` set; (3) default velocity and AML posture for the tier applies automatically (no per-merchant rows are required); (4) the platform-default commission profile is already effective, so rails are offerable as soon as an Application exists (the visible-rails formula still requires a live profile for the rail); (5) `audit_log` rows written; (6) the approval notification is inserted into the `notifications` outbox. If any step fails the whole transaction rolls back and the request stays in its previous state.

**Sandbox before approval.** A `PENDING` merchant may use the `SANDBOX` environment (to build an integration while waiting) when `onboarding.sandbox_before_approval = true` (default `true`). `LIVE` credentials, live links and cash-out are impossible until `ACTIVE`.

### **16.7 Notification Events**

All notifications are bilingual (`ar` / `en`), sent through the transactional outbox (`notifications`), and use templates whose `confidentiality_class` forbids AML variables.

| Event Code | Trigger | Channel | Content Restriction |
| :---- | :---- | :---- | :---- |
| `ONB_VERIFY_IDENTITY` | Registration | SMS / e-mail | One-time code or link only |
| `ONB_SUBMITTED` | Join request submitted | In-app, e-mail | Confirmation and expected SLA |
| `ONB_INFO_REQUESTED` | Reviewer requests information | SMS, e-mail, in-app | The specific items requested; nothing about screening |
| `ONB_APPROVED` | Approval executed | SMS, e-mail | Welcome and next steps |
| `ONB_REJECTED` | Rejection executed | SMS, e-mail | Neutral reason code; resubmission guidance |
| `MERCHANT_SUSPENDED` | Suspension | SMS, e-mail | Generic notice with support contact; **no reason detail** when the cause is AML |
| `MERCHANT_REINSTATED` | Reinstatement | SMS, e-mail | Confirmation |
| `KYB_DOC_EXPIRING` | 30 / 7 days before document expiry | E-mail, in-app | Document type and date |
| `CASHOUT_STATE` | Cash-out state change | In-app, e-mail | State and amount |
| `APPROVAL_PENDING` | Approval waiting for a checker | In-app (admin) | Subject type only |
| `DISPUTE_OPENED` | Dispute created | E-mail, in-app | Amount, deadline, instructions to respond |

### **16.8 Merchant Lifecycle States**

| State | Entered When | New Attempts | In-Flight Attempts | Cash-out | API Tokens / POS | Wallet Balance |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| **`PENDING`** | Registration | Blocked on `LIVE`; allowed on `SANDBOX` (setting) | n/a | Blocked | `SANDBOX` only | None |
| **`ACTIVE`** | Approval | Allowed | Normal | Allowed | Allowed | Normal |
| **`SUSPENDED`** | Emergency or standard suspension (reason codes: `AML`, `FRAUD`, `KYB_EXPIRED`, `COMMISSION_CEILING`, `MERCHANT_REQUEST`, `OTHER`) | Blocked by Guard 2 | Confirmed payments post to `AML_HOLD` or `SUSPENSE` per compliance policy (Edge Case 65); pending ones finish on pinned configuration | Blocked | Tokens return a generic error; POS screens show a neutral message | Retained; frozen for payout |
| **`REJECTED`** | Join request rejected | Blocked | n/a | n/a | None | None |
| **`CLOSED`** | Merchant request or platform decision after zero balance and no open disputes | Blocked | Must be zero | Final payout then blocked | Revoked | Zero required; closure refused otherwise |

**Emergency suspension** takes effect immediately by a single authorized user and creates an `approval_requests` row with `mode = EMERGENCY_RATIFICATION` and `ratify_due_at = now() + 24 h`. If it is not ratified or revoked in time, a P2 alert fires; the suspension itself stays in force until a decision is taken (fail-safe, not fail-open).

### **16.9 Re-Application & Duplicate Detection**

On every submission the platform checks for an existing or previous merchant with the same **tax ID, registration number, beneficial-owner national ID, payout bank account, phone, device fingerprint or KYB document hash**. A match does not block automatically; it adds `four_eyes_reasons = ['DUPLICATE_OR_RELATED']`, attaches the related records to the reviewer's view, and raises the proposed risk tier one level. Related-party links are retained after rejection so that a rejected applicant cannot trivially reapply under a new name (Edge Case 118).

### **16.10 Periodic KYB Refresh**

* Documents with an `expires_on` date generate `KYB_DOC_EXPIRING` notices and move to `EXPIRED` on the date; a merchant with a required document expired for more than 30 days moves to `SUSPENDED` (`KYB_EXPIRED`) unless extended by Maker-Checker.
* Re-verification cadence by tier: `HIGH` yearly, `STANDARD` every 2 years, `LOW` every 3 years (configurable).
* Event-driven refresh: a change of owner, legal name, payout account, business category, or a significant volume jump (more than the configured multiple of `expected_monthly_volume`) opens a `MANUAL_REVIEW` operator case and triggers re-screening (§18.4).

---

## **17\. Applications, Wallets & Detail Governance**

### **17.1 Entity Relationships**

```
Merchant ─┬─ Users (roles, authorities, optional app scope)
          ├─ Wallets ───────────── gl_accounts (balance derived)
          ├─ Applications ─(exactly one assigned wallet)─┬─ Payment Links ─▶ Payment Attempts ─▶ Journal Entries
          │                                              ├─ POS Terminals ─▶ POS Screens
          │                                              └─ Access Tokens (+ IP allowlist)
          └─ Credential Sets (MERCHANT_DIRECT only)
```

### **17.2 Wallet Binding & Rail Whitelist: Recorded Decisions**

1. **Exactly one wallet per application** (`applications.assigned_wallet_id NOT NULL`). The original proposal allowed an application to default to "all wallets"; that created routing ambiguity (which wallet does a link settle to?) and was already neutralized in the original's own UI rule. v4.1 enforces the rule in the **schema**, so no code path, API client or future UI can create an ambiguous settlement target. Many applications may share one wallet. If a genuine multi-wallet requirement appears later (for example split settlement), it is introduced as an explicit `application_wallet_rules` table with deterministic selection; the single-wallet constraint is not relaxed.
2. **`payment_links.wallet_id` is derived** from the application at creation and immutable thereafter.
3. **Rail whitelist:** `applications.rail_whitelist IS NULL` means *all rails*, subject to the visible-rails formula (§4): commission coverage, route availability, limits and scope still apply. An explicit list narrows the set. An **empty list is rejected** at save time (it would silently disable payments).
4. **Link-level whitelist** can only narrow the application's list. A link whitelist containing a rail outside the application's list is rejected at link creation.

### **17.3 Field Classification Matrix**

*Descriptive* fields are edited directly and recorded in `detail_change_logs`. *Sensitive* fields change money flow, compliance posture, or attack surface and therefore route through Maker-Checker (§15.4). A pending change leaves the current value in force until `EXECUTED`.

| Entity | Field | Class | Edit Path |
| :---- | :---- | :---- | :---- |
| **Merchant** | `trade_name`, display name, logo, support contact | Descriptive | Direct |
| | `contact_phone`, `contact_email` | Descriptive + re-verification | Direct after OTP / link verification of the new value |
| | `legal_name`, `tax_id`, `registration_no`, `business_category` | **Sensitive** | Maker-Checker; may reopen KYB |
| | `payout_bank_details_json` | **Sensitive** | Maker-Checker; snapshot rule for in-flight cash-outs (Edge Case 111) |
| | `risk_tier`, `kyb_status` (manual override), `commission_receivable_ceiling`, `negative_balance_ceiling` | **Sensitive** | Maker-Checker |
| | `status` | **Sensitive** | Lifecycle workflow (§16.8) |
| **Application** | `name`, `business_use_description` | Descriptive | Direct; a large rewrite flags the application for review |
| | `expected_monthly_volume` | Descriptive with guard | Direct; an increase above the configured multiple opens a `MANUAL_REVIEW` case |
| | `assigned_wallet_id` | **Sensitive** | Maker-Checker |
| | `rail_whitelist` | **Sensitive** | Maker-Checker |
| | `redirect_domain_allowlist` | **Sensitive** | Maker-Checker (open-redirect and phishing risk) |
| | `status` (pause / resume) | Descriptive for *pause*; **Sensitive** for *resume* after platform pause | Direct / Maker-Checker |
| **Wallet** | `status` | **Sensitive** | Maker-Checker; `currency` is immutable |
| **User** | name, language, notification preferences | Descriptive | Direct |
| | role, `authorities_map`, `app_scope_ids`, `is_maker`, `is_checker` | **Sensitive** (platform users); logged self-service (merchant users managed by `MERCHANT_ADMIN`) | Maker-Checker for platform users |
| **Access Token** | create, revoke | Logged action | Direct; revoke is immediate; creation requires fresh re-authentication |
| | `ip_whitelist_enabled`, CIDR list | Logged; disabling the allowlist is **Sensitive** | Direct to add; Maker-Checker to disable |
| **POS** | terminal and screen names, location | Descriptive | Direct |

### **17.4 Pending-Change Semantics**

* The `approval_requests.payload_diff_json` stores a JSON-Patch against the entity at `base_version`. If the entity changed since (`base_version` mismatch), the request is invalidated and returned to `DRAFT` with a clear reason rather than silently overwriting a newer edit.
* A pending change is visible to its maker as "awaiting approval"; the current value stays active. A maker may withdraw before a checker acts.
* Pending approvals expire after `expires_at` (default 7 days) and return to `DRAFT`.
* Changes take effect for **new** attempts only. In-flight attempts keep their pinned configuration (State Machine Rule 1).
* A checker sees the diff, the maker's reason, and the field classification, and must record a decision reason on rejection.

### **17.5 Detail-Change Log Semantics**

`detail_change_logs` records **every** edit (descriptive and sensitive) with actor, time, entity, field, old value and new value, plus (v4.1) `merchant_id`, `source` (`PORTAL`, `ADMIN`, `API`, `SYSTEM`), request ID, client IP and, when applicable, the `approval_request_id`. It is independent of the approval log so that Support can answer "what did this field used to say?" without reading approval records. Sensitive values that are secrets or national identifiers are stored as ciphertext and shown masked. The table is append-only and covered by the retention policy in §18.9.

### **17.6 Time Limits Restored from the Original**

The original proposal stated that a payment log must be "under 20 minutes old" when an OTP is confirmed. v4.0's `expires_at = min(gateway_session_ttl, platform_ttl)` (State Machine Rule 3) generalizes this. v4.1 fixes the **platform ceiling** for `OTP_PULL` at **20 minutes** (setting `attempt.platform_ttl_seconds.OTP_PULL = 1200`), so the original bound is preserved and a gateway with a shorter TTL (10 minutes for Sadad, for example) can only tighten it. Other modes use their own platform ceilings (`REDIRECT` 30 minutes, `QR_DISPLAY` and `PUSH_APPROVAL` 15 minutes, `MANUAL` as configured).


---

## **18\. AML & Compliance Program**

v4.0 provides the *mechanics* of AML: the `AML_HOLD` account, `aml_cases`, correlated severity escalation, and ownership-aware holds. It does not describe the *program* that decides who and what gets held. This section restores the original proposal's screening and reporting scope and adds the operating model around it. It is written to be **jurisdiction-configurable**: no threshold, list or report format is hard-coded, because the original proposal explicitly warned against assuming reporting thresholds before they are confirmed with the Central Bank of Libya (CBL).

### **18.1 The Seven Layers**

| Layer | Purpose | When It Runs | Primary Artifacts |
| :---- | :---- | :---- | :---- |
| **L1 Onboarding screening** | Is this business or any of its owners sanctioned, a PEP, or subject to adverse media? | At join-request submission; re-run on owner change | `aml_screenings`, `aml_screening_matches` |
| **L2 Ongoing screening** | Has anything changed since approval? | Periodic (by risk tier) and on every watch-list update | `aml_screenings` (`PERIODIC`, `LIST_UPDATE`) |
| **L3 Transaction-time posture check** | Is this merchant or payer currently allowed to transact? | Hot path, inside the attempt-creation guard | `aml_rules` (cheap rules), cached watch-list, velocity |
| **L4 Transaction monitoring** | Do patterns or amounts breach thresholds? | At confirmation and in periodic batch analytics | `aml_rules` (deferred rules), `AML_HOLD` postings |
| **L5 Case management** | Review, decide, and document | Continuous | `aml_cases`, `operator_cases`, Maker-Checker |
| **L6 Regulatory reporting** | Report what the law requires | When a rule or a case requires it | `reporting_rules`, `regulatory_reports` |
| **L7 Record keeping & governance** | Prove what was done and why | Continuous | `audit_log`, retention policy, rule versioning |

### **18.2 The Screening Provider Integration Point**

Screening is a **provider integration point, not an in-house build** (as the original proposed). The platform defines one interface; one or more providers implement it. The choice of provider is a management decision (**OD-3**).

```
interface ScreeningProvider {
  screenSubject(subject: ScreeningSubject, options): Promise<ScreeningResult>;   // sync or async
  getResult(providerRequestRef): Promise<ScreeningResult>;                        // for async providers
  listVersions(): Promise<ListVersion[]>;                                         // which lists/versions are active
  subscribeListUpdates?(callbackUrl): Promise<void>;                              // optional push of list changes
  capabilities(): { lists: ('SANCTIONS'|'PEP'|'ADVERSE_MEDIA')[], arabicNameMatching: boolean, batchRescreen: boolean }
}
```

* **Lists covered (configurable):** international sanctions lists applicable to the operator, national or CBL-issued lists, PEP lists, adverse-media sources, and an **internal watch-list** maintained by the compliance team (for example previously offboarded merchants or confirmed fraud identifiers).
* **Arabic names.** Libyan names appear in Arabic script with several transliterations. The adapter must (1) normalize Arabic (diacritics, alef / hamza / ya variants, `arabic_digits_to_ascii`), (2) send both the Arabic and the best transliteration when the provider supports it, and (3) record the match score. Matching quality for Arabic is a **selection criterion** for the provider, and a go-live test uses a fixed set of Arabic-name test cases (Edge Case 122).
* **Provider failure policy:** if the provider is unavailable at onboarding, the screening result is `ERROR` and the join request **cannot be approved** (fail-closed). On the transaction hot path the platform never blocks on a provider call; it uses the locally cached watch-list (§18.4).
* **Reproducibility:** every screening stores `list_versions_json` and `input_hash`, so a past decision can be replayed against exactly the lists that were in force.
* **Data minimization:** only the fields required for matching are sent (name, date of birth, nationality, identifier). Documents are never sent to a screening provider.

### **18.3 Screening Subjects**

| Subject | Data Screened | Trigger |
| :---- | :---- | :---- |
| **Merchant (legal entity)** | Legal name, trade name, registration number, country, activity | Onboarding, periodic, list update, name change |
| **Beneficial owner / controller / signatory** | Full name (Arabic and Latin), date of birth, nationality, national ID, declared PEP status | Onboarding, owner change, periodic, list update |
| **End client (payer)** | Phone number, wallet ID, card BIN or alias where the rail exposes it, device and IP fingerprint, and a payer name **only where the rail returns one** | Transaction time (cached watch-list); deeper screening where the rail or jurisdiction requires it |
| **Payment attempt** | Amount, rail, merchant risk tier, cumulative behaviour | Rule engine (§18.5) |

**Beneficial-owner identification.** A beneficial owner is any natural person who holds at least `aml.owner_threshold_percent` (default 25%, **OD-6**) of ownership or voting rights, **or** otherwise exercises control (director, managing partner, authorized signatory). If no one reaches the threshold, the senior managing official is recorded as the controller and the reason is documented.

### **18.4 Transaction-Time Screening Without Hurting the Hot Path**

The original called for screening each payment-log creation against merchant and end-client posture "and, where the rail or jurisdiction requires it, a per-transaction screen." The payment hot path has a strict latency and availability budget (SLOs, §11), so v4.1 splits the work:

1. **Synchronous, local, cheap (inside the guard transaction):** merchant status and risk tier; velocity rules (`velocity_rules`); the local **watch-list hash set** (normalized phone, wallet ID, card alias, device fingerprint, IP range) refreshed from the provider and the internal watch-list; `aml_rules` of type `SINGLE_AMOUNT`, `RISK_TIER`, `RAIL`, `COUNTERPARTY_COUNTRY`, and `CUMULATIVE_WINDOW` evaluated against recent-window counters. A hard match on the watch-list creates a terminal `BLOCKED` attempt with an internal reason (the customer sees a generic message).
2. **Deferred, at or after confirmation:** name-based provider screening of the payer where a name is available, structuring detection, and pattern rules. A hit converts the posting into an `AML_HOLD` posting *for platform-held funds* (Entry 7) or an operational case for `MERCHANT_DIRECT` funds (Edge Case 67).
3. **Batch analytics (daily):** structuring, fan-in / fan-out, dormant-then-active, rapid in-out patterns, and merchant behaviour versus declared `expected_monthly_volume`. Findings open `aml_cases` with severity from §18.6.

A rail that **requires** a synchronous per-transaction screen (a regulatory condition recorded on the rail) uses the provider with a strict timeout (default 800 ms) and a fail policy configured per rail: `FAIL_CLOSED` (block) or `FAIL_OPEN_AND_FLAG` (proceed, open a case). The default is `FAIL_OPEN_AND_FLAG` for amounts below the rail's screening threshold and `FAIL_CLOSED` above it.

### **18.5 The AML Rule Engine (`aml_rules`)**

Rules are declarative, versioned and effective-dated. The version in force is stored on the resulting case.

| `rule_type` | What It Detects | Typical `params` | Typical `action` |
| :---- | :---- | :---- | :---- |
| `SINGLE_AMOUNT` | One payment above an amount | `{ "min_amount": ..., "currency": "LYD" }` | `HOLD` |
| `CUMULATIVE_WINDOW` | Sum or count per subject in a rolling window | `{ "window_seconds": ..., "max_amount": ..., "max_count": ... }` | `HOLD` / `FLAG` |
| `STRUCTURING` | Many payments just below a threshold | `{ "threshold": ..., "band_percent": 10, "min_count": ..., "window_seconds": ... }` | `FLAG` then `CASE_ONLY` |
| `RISK_TIER` | Any payment for a tier above a lower amount | `{ "tier": "HIGH", "min_amount": ... }` | `HOLD` |
| `COUNTERPARTY_COUNTRY` | Cross-border exposure on international card rails | `{ "countries": [...], "mode": "ALLOW"/"DENY" }` | `BLOCK` / `FLAG` |
| `RAIL` | Rail-specific limits (for example a rail with no inquiry API) | `{ "rail_codes": [...], "min_amount": ... }` | `FLAG` |
| `MERCHANT_DIRECT_AMOUNT` | Threshold hits where the platform holds no cash | `{ "min_amount": ... }` | `CASE_ONLY` (Edge Case 67) |

**Actions.** `HOLD` posts to `AML_HOLD` and opens a case; `FLAG` lets the payment proceed and opens a review case; `BLOCK` creates a terminal `BLOCKED` attempt; `CASE_ONLY` opens a case without touching money.

**Change control.** All rule changes are Maker-Checker with `MLRO` as checker. *Tightening* in an emergency may be activated immediately and ratified within 24 hours; *loosening* never bypasses review. A rule dry-run mode replays the last N days of attempts against a proposed rule and reports how many holds and cases it would have produced, so an overly noisy rule is caught before activation.

**Anti-structuring and anti-evasion.** Rules evaluate by **subject** (merchant, beneficial owner, payer identifier) rather than only by link or application, so splitting one large sale across links, applications or rails does not evade a threshold (Edge Case 125).

### **18.6 Case Management & Severity**

**Lifecycle:** `OPEN → IN_REVIEW → PENDING_CHECKER → RELEASED | REJECTED_VOID | FROZEN | ESCALATED_STR`.

1. A rule hit, screening match, correlated event or analyst referral creates the case with a computed severity and an SLA.
2. A `COMPLIANCE` analyst (maker) investigates, records notes, and proposes a resolution: **release**, **void and return**, **freeze**, or **escalate to suspicious-activity report**.
3. An `MLRO` (checker, never the same person) approves. Only then does the ledger move: release posts the Entry 7 release lines; void posts Entry 11; freeze changes only the case state and leaves funds in `AML_HOLD`; STR escalation creates a `regulatory_reports` draft (§18.8).
4. Resolution and ledger posting are atomic with the approval (the original's Maker-Checker rule: an approved-but-unexecuted request must never hang).

**Severity computation.** Severity starts from the rule's `base_severity` and is raised by the following inputs (stored in `severity_inputs_json` so the result is explainable):

| Input | Effect |
| :---- | :---- |
| Velocity `FLAG` and an AML rule hit on the same payment | Raise to `CRITICAL` (the correlated escalation from the original proposal) |
| Screening `CONFIRMED_MATCH` on a sanctions list | `CRITICAL`, merchant auto-restricted (§18.7) |
| Screening `POTENTIAL_MATCH` on a PEP list | At least `HIGH` |
| Merchant `risk_tier = HIGH` | One level up |
| Amount more than N times the merchant's declared monthly volume | One level up |
| Same subject has another open case | One level up |
| Merchant-direct funds (platform holds no cash) | No change in severity; action is `CASE_ONLY` |

**SLAs (defaults):** `CRITICAL` 4 hours, `HIGH` 1 business day, `MEDIUM` 3 business days, `LOW` 5 business days. SLA breaches raise alerts and appear on the compliance dashboard. A case cannot be closed without a recorded rationale and, for holds, a ledger outcome.

### **18.7 Restricting a Merchant on Screening Outcomes**

* **`CONFIRMED_MATCH` (sanctions):** the merchant is immediately placed in `SUSPENDED` via the emergency path (§16.8), cash-out is frozen, held funds stay in `AML_HOLD`, and an STR draft is created. No further processing occurs until the `MLRO` decides.
* **`POTENTIAL_MATCH`:** the reviewer dispositions each match (`FALSE_POSITIVE`, `TRUE_MATCH`, `ESCALATED`). Until dispositioned, the merchant cannot be approved (onboarding) or has cash-out held (ongoing). A false positive may set `suppress_future` with an expiry.
* **List update producing a new match on an active merchant:** a `LIST_UPDATE` screening runs against all active subjects; a new match opens a case, restricts cash-out immediately, and leaves payment acceptance in place unless severity is `CRITICAL` (Edge Case 123).

### **18.8 Regulatory Reporting (Configuration, Not Code)**

The original proposal recommended scoping large-transaction reporting against CBL's actual requirements *before the schema is locked*, rather than assuming a threshold. v4.1 honours that by making every reporting parameter data.

* **`reporting_rules`** define, per authority and report type, the trigger (amount threshold, window, conditions), the **source reference** (the circular or written instruction that justifies it) and a `status` of `PROVISIONAL` or `CONFIRMED`. A trigger prevents any live report from being generated from a `PROVISIONAL` rule.
* **Report types:** `LARGE_TRANSACTION` (rule-driven, may be fully automated up to the draft stage), `SUSPICIOUS_ACTIVITY` (case-driven, always human-reviewed), `PERIODIC_RETURN` (scheduled aggregates).
* **Workflow:** `DRAFT` (system or analyst) → `PENDING_CHECKER` → `APPROVED` (payload frozen, hash stored) → `SUBMITTED` (to the authority by the agreed channel) → `ACKNOWLEDGED` or `REJECTED_BY_AUTHORITY` (corrected by a new linked report). Submission is a Maker-Checker action (`COMPLIANCE` → `MLRO`).
* **Output formats and channel** are adapters (file export, portal upload, API) configured once the authority's specification is known.
* **Open items (OD-1):** the CBL reporting thresholds, report formats, filing deadlines, the receiving unit, and whether `MERCHANT_DIRECT` volumes are reportable by the platform. Until these are confirmed, the corresponding rules stay `PROVISIONAL` and the platform operates in **internal-only reporting mode**: it can detect, hold and record, but cannot file.

### **18.9 Confidentiality, Tipping-Off, Retention & Access**

* **No tipping-off.** The existence of a suspicious-activity case or report is never disclosed to the subject. Merchant-facing and customer-facing messages for AML outcomes are generic (`MERCHANT_SUSPENDED`, "cannot process this payment") and templates of class `MERCHANT` or `PUBLIC` cannot reference AML variables.
* **Access control.** `AML-CONFIDENTIAL` tables and screens are limited to `COMPLIANCE`, `MLRO` and `SECURITY_ADMIN` (audit). `SUPPORT` sees only that a merchant is `SUSPENDED`, never why. Every read of an AML case is logged.
* **Retention.** KYB records, screening records, cases, reports and the audit trail are retained for a configurable period (default **5 years after the end of the relationship**, **OD-4** to be confirmed against CBL requirements); deletion requests do not override a regulatory retention period. After expiry, personal data is erased or irreversibly anonymized while ledger entries (which contain no personal data) remain.
* **Immutability.** Frozen report payloads, screening results and case decisions are append-only; corrections are new records.
* **Data protection.** National IDs and document contents are encrypted with AES-256-GCM, access-logged, and masked in lists and exports.

### **18.10 Interaction with Other Controls**

| Control | Interaction |
| :---- | :---- |
| **Velocity (`velocity_rules`, §5.1)** | A `FLAG`-severity velocity hit plus any AML hit escalates the case to `CRITICAL`. Velocity never creates money movements; AML holds do. |
| **Maker-Checker** | All rule changes, case resolutions, reports and suspensions use the approval wrapper (§15.4). |
| **Ledger** | Holds, releases and voids are the only money effects of AML (Entries 7 and 11). `AML_HOLD` participates in the §9.2 invariant. |
| **Commission** | Commission on held funds is **not recognized** until release (Entry 7 credits `PLATFORM_INCOME` only at release), so profitability reports do not overstate revenue (§20.2). |
| **Disputes** | A chargeback on a held payment is processed against the hold (void and return) rather than the merchant wallet. |
| **Merchant-direct** | Platform holds no cash, so AML produces a case, a block on completion messaging and a flag, never a posting (Edge Case 67). |

### **18.11 Compliance Metrics & Governance**

Monthly governance pack for `MLRO` and management: screenings by result and false-positive rate; rule hit counts and precision (holds that ended in `RELEASED` versus `REJECTED_VOID` / STR); case ageing and SLA breaches; time-to-decision for join requests; list-update re-screen outcomes; reports filed versus due; open emergency ratifications; rule changes and who approved them. A rule whose precision falls below a configured floor is flagged for retuning, so the program stays effective without drowning reviewers in noise.

### **18.12 Compliance Readiness Checklist (Platform Go-Live)**

Independent of the per-gateway Go-Live Gates (§12), the platform itself must not accept live merchants until all of the following are true.

1. A screening provider is contracted and integrated; Arabic-name test cases pass (§18.2).
2. CBL reporting thresholds, formats, deadlines and receiving channel are confirmed in writing, and the corresponding `reporting_rules` are `CONFIRMED` (or management has signed a documented decision to operate in internal-only mode).
3. A named `MLRO` and at least one separate `COMPLIANCE` analyst exist, with MFA and recorded training.
4. The high-risk business-category list, beneficial-owner threshold, risk-tier definitions and `join_request.four_eyes_policy` are approved.
5. Retention periods and the data-protection basis for KYB documents are approved.
6. A tabletop exercise proves the end-to-end path: onboarding hit → hold → case → Checker decision → ledger posting → report draft, with no tipping-off leakage.
7. The initial `aml_rules` set has been dry-run against realistic synthetic traffic.


---

## **19\. Disputes, Chargebacks & Automated Drafting**

v4.0 defines the `adjustments` table (with `CHARGEBACK`, `external_dispute_ref`, `reverse_commission`), the `DISPUTED` attempt status, the `CHARGEBACK_RESERVE` account and Journal Entry 10. The original proposal also specified the *workflow*: a chargeback originates from a rail-reported dispute, is **proposed as an Adjustment automatically**, and still requires a human checker before any money moves — "the automation drafts it, a human authorizes the money movement." This section restores that workflow in full.

### **19.1 Dispute Intake Channels**

| Channel | How It Arrives | Handling |
| :---- | :---- | :---- |
| **Rail webhook** | A verified `confirmation_channels` event whose `event_map` maps to the canonical event `DISPUTE_OPENED` (for example a card-scheme chargeback notification) | Signature verified, inbox-first, deduplicated; creates or updates a `disputes` row |
| **Statement** | A settlement statement line or reconciliation item flagged as a chargeback or reversal | Matched to the attempt via `our_reference` / `provider_reference`; creates a `disputes` row with `source = STATEMENT` |
| **Manual** | `FINANCE` enters a dispute received through a provider portal or e-mail | Creates a `disputes` row with `source = MANUAL` and the supporting reference; still drafts the Adjustment through the same path |

`UNIQUE(gateway_id, external_dispute_ref)` guarantees that a replayed webhook or re-imported statement never creates a second dispute or a second Adjustment (Edge Case 128).

### **19.2 The Dispute Lifecycle**

`OPENED → EVIDENCE_REQUESTED → EVIDENCE_SUBMITTED → WON | LOST | EXPIRED | WITHDRAWN`

* On `OPENED` the underlying attempt moves to `DISPUTED` (it is not rolled back; `SUCCEEDED` is never downgraded, State Machine Rule 5).
* `evidence_due_at` starts an SLA timer. If the merchant or `FINANCE` has not submitted evidence by the due date, the dispute moves to `EXPIRED`, which is treated as `LOST` unless the rail's rules say otherwise.
* On `WON` or `LOST` the dispute resolves the linked Adjustment as described in §19.4.
* A refund issued voluntarily before or during a dispute is linked to the dispute so that the same money is never returned twice (Edge Case 126).

### **19.3 Automated Drafting with a Human Authorizer**

1. A `disputes` row is created (webhook, statement or manual).
2. A **system drafting principal** (`SYSTEM_AUTOMATION`, a non-human service identity) creates an Adjustment with `type = CHARGEBACK`, `state = DRAFT → PENDING_REVIEW`, `drafted_by_system = true`, the `source_attempt_id`, the `external_dispute_ref`, and `reverse_commission` taken from the rail's policy (default: commission is reversed; configurable per rail and per merchant).
3. An approval request is created with the system principal as **maker**. The system principal is **never eligible as a checker** and can never move a request from `APPROVED` to `EXECUTED`; only the approval workflow does, after a human `FINANCE` checker approves.
4. Until a human approves, **no money moves** and the merchant wallet is untouched. A P2 operator case is raised if the request is still pending a configured time before `evidence_due_at`.
5. On approval the Adjustment executes atomically with the reserve posting (Entry 10, first leg).

This preserves the original principle exactly: automation reduces latency and omissions; it never authorizes the money movement.

### **19.4 Ledger Outcomes**

| Stage | Journal Entry | Notes |
| :---- | :---- | :---- |
| Dispute approved for reserve | Entry 10, first leg: `Dr MERCHANT_WALLET 97`, `Dr PLATFORM_INCOME 3`, `Cr CHARGEBACK_RESERVE 100` | Commission reversal follows `reverse_commission` |
| Dispute **LOST** | Entry 10, second leg: `Dr CHARGEBACK_RESERVE 100`, `Cr TREASURY 100` (funds go to the payer or scheme) | Final; Adjustment immutable |
| Dispute **WON** | Entry 12: `Dr CHARGEBACK_RESERVE 100`, `Cr MERCHANT_WALLET 97`, `Cr PLATFORM_INCOME 3` | Reserve released to the original parties |
| Dispute on an **AML-held** payment | Entry 11 (void and return) instead of touching the wallet | Funds never reached the merchant wallet |
| Wrong adjustment | A new offsetting Adjustment | Executed Adjustments are never edited (append-only ledger) |

### **19.5 Insufficient Merchant Balance & Recovery**

A chargeback or refund can exceed the merchant wallet's balance. v4.1 defines the policy explicitly (**OD-8** for the default ceiling):

1. The Adjustment still posts in full (Entry 15). The wallet may go negative **up to `merchants.negative_balance_ceiling`** (default `0` for new merchants, raised per merchant by Maker-Checker as trust grows).
2. If the posting would breach the ceiling, the Adjustment does **not** execute; an operator case (`P1`) opens, the merchant is notified of the shortfall, and `FINANCE` chooses: collect (invoice, card-on-file), net against pending cash-outs, or suspend the merchant (§16.8).
3. A negative balance is recovered by **netting against future settlements**: every confirmed payment credit first reduces the negative balance. It is reported on the merchant statement as "amount owed to platform".
4. A merchant with a negative balance cannot request cash-out. Suspension and closure are blocked until the balance returns to zero or is written off by a Maker-Checker `MANUAL_DEBIT` / `CORRECTION` Adjustment.

---

## **20\. Platform Profitability, Liquidity & Statistics**

The original proposal gave the Admin Back Office the job of **monitoring platform profit**. v4.0 supplies the accounts but no definitions. This section defines every figure from the ledger so that reports cannot drift from the books.

### **20.1 Principles**

1. **Single source of truth.** Every financial figure is computed from `journal_lines` (and the accounts' checkpoints). There are no mutable "total" counters. A report that disagrees with the ledger is a bug in the report.
2. **Reproducible.** A closed day or month is a deterministic query over an `as_of` timestamp; closed periods are snapshotted with a content hash so exports and statements are stable.
3. **Cheap to read.** Heavy reports use materialized views refreshed on a schedule from a read replica; they never contend with the posting path.
4. **Least disclosure.** Merchants see their own gross, **commission** and net; they never see gateway cost, platform margin, or other merchants' data.

### **20.2 Profit Definitions**

| Measure | Definition (ledger source) | Recognition Note |
| :---- | :---- | :---- |
| **Gross commission revenue** | Σ credits to `PLATFORM_INCOME` minus Σ debits to `PLATFORM_INCOME` (reversals) in the period | Commission on `AML_HOLD` funds is recognized only at release (Entry 7) |
| **Gateway cost (realized)** | Σ `PROVIDER_FEE_EXPENSE` + Σ `GATEWAY_FEE_EXPENSE` net of variance true-ups | Direct-deduction fees (Entry 1) and accrued fees (Entry 2) are both included |
| **Gateway cost (accrued, unsettled)** | Balance of `GATEWAY_FEE_ACCRUAL` | A liability until the statement sweep (Entry 3); reported separately |
| **Net revenue** | Gross commission revenue − gateway cost (realized) | The figure management normally calls "profit before losses" |
| **Chargeback and dispute losses** | Σ `CHARGEBACK_RESERVE` outflows to `TREASURY` on lost disputes, net of commission reversed | Entry 10 second leg |
| **Refund commission reversed** | Σ debits to `PLATFORM_INCOME` posted by refund Adjustments (Entry 9, 14) | Shown as a contra-revenue line |
| **Net contribution** | Net revenue − chargeback and dispute losses | |
| **Commission receivable** | Balance of `COMMISSION_RECEIVABLE` | `MERCHANT_DIRECT` commission earned but not yet netted (Entry 6) |

### **20.3 Reference Queries**

```sql
-- Daily gross commission and gateway cost, by rail and gateway
SELECT date_trunc('day', je.created_at AT TIME ZONE 'Africa/Tripoli')       AS day,
       pa.rail_id, pa.gateway_version_id,
       SUM(CASE WHEN a.account_type = 'PLATFORM_INCOME'
                THEN CASE jl.direction WHEN 'CREDIT' THEN jl.amount ELSE -jl.amount END END) AS gross_commission,
       SUM(CASE WHEN a.account_type IN ('PROVIDER_FEE_EXPENSE','GATEWAY_FEE_EXPENSE')
                THEN CASE jl.direction WHEN 'DEBIT'  THEN jl.amount ELSE -jl.amount END END) AS gateway_cost
FROM journal_entries je
JOIN journal_lines   jl ON jl.entry_id = je.id
JOIN gl_accounts     a  ON a.id = jl.gl_account_id
LEFT JOIN payment_attempts pa ON je.ref_type = 'PAYMENT_ATTEMPT' AND pa.id = je.ref_id
GROUP BY 1,2,3;

-- Treasury cover ratio at a point in time
SELECT t.balance / NULLIF(o.obligations,0) AS cover_ratio
FROM (SELECT SUM(balance) AS balance FROM account_balances WHERE account_type='TREASURY') t,
     (SELECT SUM(balance) AS obligations FROM account_balances
       WHERE account_type IN ('MERCHANT_WALLET','AML_HOLD','CHARGEBACK_RESERVE')) o;
```

`account_balances` is the standard view `checkpoint_balance + SUM(journal_lines since last_checkpoint_id)` from §5.1 (`gl_accounts`).

### **20.4 Liquidity & Solvency Panel (Admin)**

| Panel | Content | Alert |
| :---- | :---- | :---- |
| **Invariant status** | Latest result and drift of the §9.2 invariant, timestamp of last run | Any non-zero drift: `RB-04`, payouts halt |
| **Treasury cover** | Treasury + clearing balances versus wallet balances + holds + reserves | Cover below configured floor |
| **Clearing ageing** | `GATEWAY_CLEARING` balance per gateway bucketed by age (`T+0`, `T+1`, `T+2`, older), versus the gateway's `settlement_lag_days` | Items older than expected settlement |
| **Cash-out queue** | Pending, processing and completed amounts; forecast of next-day demand versus available Treasury | Demand above available cash |
| **Holds & reserves** | `AML_HOLD` and `CHARGEBACK_RESERVE` balances, oldest item, count by severity | Aged holds beyond SLA |
| **Receivables** | `COMMISSION_RECEIVABLE` and negative merchant balances versus ceilings | Ceiling approached or breached |

### **20.5 Merchant Statistics & Statements**

| View | Measures | Granularity |
| :---- | :---- | :---- |
| **Volume** | Gross volume, commission, net credited, number of payments | Day / week / month; per application, per rail |
| **Quality** | Success rate, `FAILED` / `EXPIRED` / `BLOCKED` counts, average time-to-confirm | Per rail |
| **Mix** | Share by rail and by channel (`WEB`, `API`, `POS`); average and median ticket | Per application |
| **Risk** | Refund rate, dispute rate, chargeback ratio | Rolling 30 / 90 days |
| **Cash** | Wallet balance, pending cash-outs, payout history, negative-balance status | Per wallet |
| **Statements** | Monthly statement per wallet: opening balance, credits (gross, commission, net), adjustments, cash-outs, closing balance; CSV and PDF; period snapshot with hash | Monthly |

Merchant statements reconcile exactly to the wallet's `journal_lines`; the closing balance of one statement is the opening balance of the next.

### **20.6 Admin Operational Metrics**

Alongside financial views, the Back Office exposes operational health: attempts by state, `UNKNOWN` backlog and age, route health and open circuit breakers, webhook inbox lag, reconciliation match rates, approval-queue ageing per checker role, join-request SLA, and AML SLA. These come from `payment_attempts`, `gateway_health_samples`, `inbound_events`, `operator_cases`, `approval_requests` and `aml_cases`, feeding the SLO dashboards and runbooks in §11.


---

# **PART X: MANAGEMENT DECISIONS, ASSUMPTIONS & TRACEABILITY (v4.1)**

## **21\. Management Decisions Requested**

The original proposal closed by inviting feedback on two points before the schema is finalized: the **AML reporting-threshold scoping** and the **maker-checker scope for Join Request approvals**. Those two remain open and are joined by the other decisions that v4.1's additions make necessary. Each decision has a recommended default so that engineering is never blocked; the default is applied until management decides otherwise.

| ID | Decision | Options | Recommended Default | Needed Before | Owner |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **OD-1** | CBL reporting requirements: thresholds, formats, deadlines, receiving unit, whether `MERCHANT_DIRECT` volumes are reportable by the platform | Obtain written CBL instruction; or operate in internal-only mode | Operate in **internal-only mode** (detect, hold, record; no filing) until confirmed; keep rules `PROVISIONAL` | Compliance readiness checklist item 2 / Stage 4 | Compliance / Legal |
| **OD-2** | Join Request approval: is a second checker required? | `ALWAYS` / `RISK_BASED` / `NEVER` | `RISK_BASED` (§16.5) | Stage 1 exit | Management |
| **OD-3** | Screening provider selection | Specialist AML data vendor / regional provider / hybrid with internal watch-list | Selection by Arabic-name matching quality, list coverage, latency, data residency and price | Compliance checklist item 1 / Stage 2 | Compliance, Engineering |
| **OD-4** | Record retention period for KYB, screening, cases, reports, audit | 5 / 7 / 10 years after end of relationship | 5 years, confirmed against CBL requirements | Stage 1 | Legal |
| **OD-5** | NeomPay-side integration contract and ownership; whether NeomPay is the first production rail | NeomPay first / external aggregator first | NeomPay first (§14.3 WS-E) | Stage 2 | NeomPay lead, Engineering |
| **OD-6** | Beneficial-owner threshold and high-risk business-category list | 10% / 25% / other | 25% and a documented category list | Stage 1 | Compliance |
| **OD-7** | Platform TTL ceilings per collection mode | As proposed in §17.6 or adjusted | `OTP_PULL` 20 min, `REDIRECT` 30 min, `QR_DISPLAY` / `PUSH_APPROVAL` 15 min | Stage 2 | Product |
| **OD-8** | Default `negative_balance_ceiling` and recovery method for new merchants | 0 / fixed amount / percentage of trailing volume | `0` for new merchants, raised per merchant by Maker-Checker | Stage 4 | Finance, Risk |
| **OD-9** | Emergency suspension authority and ratification window | Which roles; 12 / 24 / 48 h | `OPERATOR` or `COMPLIANCE`; ratified by `MLRO` or a different `COMPLIANCE` within 24 h | Stage 2 | Compliance |
| **OD-10** | Sandbox access for `PENDING` merchants | Allowed / not allowed | Allowed (`onboarding.sandbox_before_approval = true`) | Stage 2 | Product |
| **OD-11** | Organizational appointments: `MLRO`, compliance analysts, finance checkers | Named individuals | At least one `MLRO` and one separate `COMPLIANCE` analyst before live launch | Compliance checklist item 3 | Management |

## **22\. Assumptions & Out-of-Scope Items**

**Assumptions**

1. The platform operates in **LYD** as its base currency; multi-currency settlement is limited to international card rails as already specified in §3.2.
2. A **single legal entity** (the platform operator) owns the Treasury, the Income account and platform-held clearing accounts.
3. Regulatory statements in this document describe *design intent* and configuration points. They are **not legal advice**; thresholds, definitions (for example beneficial ownership) and filing obligations must be confirmed with qualified counsel and the regulator before launch.
4. Merchant-owned (`MERCHANT_DIRECT`) settlement is delivered in Stage 5; until then all merchants settle through the platform.
5. SMS and e-mail delivery use third-party transactional providers behind the notification outbox; their selection does not affect the data model.

**Out of Scope (tracked, not designed here)**

* Tax treatment and invoicing of platform commission (for example VAT or equivalent) and the resulting accounting entries; to be specified with Finance.
* Card-scheme certification and the PCI-DSS assessment process itself (the design minimizes scope via hosted capture; certification is an operational project).
* Customer-support ticketing and chat tooling beyond the read-only Support role and field-history views.
* Mobile applications for merchants (the Merchant Portal and API are the specified surfaces).

## **Appendix A: Traceability from the Original Proposal to v4.1**

Every section of the original proposal is accounted for. *Preserved* = already in v4.0 unchanged in substance; *Extended* = present in v4.0 and deepened; *Restored* = missing in v4.0 and reinstated in v4.1.

| Original Section | Content | Status | v4.1 Location |
| :---- | :---- | :---- | :---- |
| **Executive Summary** | Four foundational decisions (pluggable rails; double-entry ledger rooted in one Treasury; four control layers; Adjustments + maker-checker) | Extended | §1.1 (decisions 1, 7, 8, 11, 12), §9, §15.4 |
| **1. Overview** | Three-interface platform; every payment lands in Treasury then distributes by journal entry | Restored / Extended | §1, §15.1, §9 |
| **2. Actors & Interfaces** | Merchant Portal, End-Client Interface, Admin Back Office | **Restored** | §15 |
| **3. Rails** | `initiate`, `confirm`, `verifyCallback`, `refund`, `capabilities`; Rail Registry; rail whitelists = Application ∩ Link, filtered by commission and posture | Extended | §4, §6.1 (six-method contract, `capabilities` on `rails`), §3.2 |
| **3. Rails: NeomPay as a rail** | NeomPay implements the same interface as any rail | **Restored** | §3.2 (#20), Blueprint 7, §9.4 |
| **4. Domain model: Merchant** | status, KYB state | Extended | §5.1, §5.7, §16.8 |
| **4. User** | authorities map, scope, maker/checker flags, minimal access by default | Extended | §5.1 `users`, §15.2–15.3 |
| **4. Application** | wallet(s), rail whitelist, business-use details, defaults | Extended (one wallet by schema) | §5.1, §17.2 |
| **4. Wallet** | derived balance (checkpoint) | Preserved | §5.1 `wallets`, `gl_accounts` |
| **4. Payment Link / Payment Log** | link fields and rules; log per attempt | Extended (log merged into `payment_attempts`) | §5.1, §5.5, §7 |
| **4. Journal Entry / Line; Treasury, Income, AML Hold, Chargeback Reserve accounts** | double-entry with invariants | Extended | §5.1 `gl_accounts`, §9.2–9.4 |
| **4. Commission Profile** | scope, rate shapes, min/max, versions | Extended (fee bearers) | §5.1, §9.1 |
| **4. Velocity Rule** | scope, window, count, amount, reject/flag | Extended | §5.1, §18.4, §15.4 |
| **4. AML Case** | subject, reason, status, notes | Extended | §5.1, §5.7, §18.6 |
| **4. Adjustment / Approval Request / Cash-Out / POS / POS Screen** | non-standard money movements, approvals, payouts, POS | Preserved / Extended | §5.1, §15.4, §19 |
| **5. Ledger & Treasury** | rationale, invariant, mechanics, worked examples | Extended | §9, §9.4 |
| **6.1 Merchant Onboarding** | landing, register (phone/email/Google), Join Request, KYB, review, notify, login | **Restored** | §16 |
| **6.2 Applications & Wallets** | create wallets/apps, one wallet per app, detail record, sensitive edits via maker-checker | Restored / Extended | §17 |
| **6.3 Payment Link Creation** | portal or API, same fields | Preserved | §5.1 `payment_links`, §15.1 |
| **6.4 End-Client Payment Flow** | resolve and guard, collect and submit, branch by rail capability, 20-min OTP | Extended | §4, §6, §7, §17.6 |
| **6.5 POS Flow** | POS screen, realtime room, 15-min idle | Preserved | §5.1, §7 Rule 9, §15.5 |
| **7. Merchant & Application Detail Control** | detail records, change log, sensitive vs descriptive | Restored / Extended | §17.3–17.5 |
| **8. AML** | onboarding screening (sanctions, PEP, adverse media, owners), transaction-time screening, holds, case maker-checker, reporting scoping, escalation | **Restored** / Extended | §18 |
| **9. Velocity Control** | scoped rules, atomic with guard, reject/flag, cheap evaluation | Extended | §5.1, §18.4 |
| **10. Commission Control** | hierarchy, rate shapes, versioned, applied at confirmation, maker-checker | Extended | §5.1, §9.1, §15.4 |
| **11. Chargebacks & Adjustments** | Adjustment lifecycle, automatic proposal from rail dispute, immutability | Restored / Extended | §19, §9.3–9.4 |
| **12. Maker-Checker** | single wrapper, scope, state machine, maker ≠ checker at authorization layer, atomic execution, audit | Extended | §15.4, §5.1 `approval_requests`, §12 Gate 1 |
| **Closing: feedback requested** | AML reporting scoping; Join Request four-eyes scope | **Restored** | §21 (OD-1, OD-2) |

## **Appendix B: Glossary of Terms Introduced or Clarified in v4.1**

| Term | Meaning |
| :---- | :---- |
| **AML** | Anti-money-laundering: controls to detect and prevent the use of the platform for laundering proceeds of crime. |
| **KYB** | "Know your business": verification of a merchant's legal existence, ownership and activity. |
| **PEP** | Politically exposed person: an individual with a prominent public function, who carries higher corruption risk. |
| **Beneficial owner** | A natural person who ultimately owns or controls a merchant, at or above the configured ownership threshold or by control. |
| **MLRO** | Money Laundering Reporting Officer: the senior compliance role that approves AML case resolutions and regulatory reports. |
| **STR / LTR** | Suspicious-transaction (or activity) report / large-transaction report, filed with the competent authority per configured `reporting_rules`. |
| **CBL** | Central Bank of Libya. |
| **Tipping-off** | Disclosing, directly or indirectly, to a subject that they are or may be subject to an AML investigation or report. Prohibited by design (§18.9). |
| **Emergency ratification** | An immediate risk-reducing action (suspension, rule tightening) taken by one authorized user and approved afterwards by a second within a fixed window. |
| **`INTERNAL` gateway** | A gateway whose counterparty is the operator's own system (NeomPay). Posts directly to `TREASURY` (Ledger Rule INTERNAL-1). |
| **System drafting principal** | The non-human `SYSTEM_AUTOMATION` identity that may *draft* adjustments but can never approve or execute them. |
| **Negative balance ceiling** | The maximum amount a merchant wallet may go below zero after a chargeback or refund, recovered by netting future settlements. |
| **Provisional rule** | A reporting or AML rule awaiting regulatory confirmation; it may detect and record but cannot generate a live regulatory filing. |

*End of Master Architecture & Technical Specification v4.1.*

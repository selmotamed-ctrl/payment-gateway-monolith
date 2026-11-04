# COMPLETE ZERO-TO-HERO INTERACTIVE GUIDES, EMPLOYEE ACADEMY & MERCHANT API SPECIFICATION (FULL VERBATIM CONTENT & OPENCODE IMPLEMENTATION BLUEPRINT)

**Target Repository:** `selmotamed-ctrl/payment-gateway-monolith`  
**Target Workspaces:** `admin-front` · `merchant-front` · `checkout-front` · `core-back` · `admin-back` · `merchant-back`  
**Target Implementation Agent:** OpenCode (`deepseek 4.1 flash high / max`)  
**Design Mandate:** 100% Verbatim, Zero-Prior-Knowledge Operational Manual, Interactive Simulators, Hands-On Sandbox LMS Academy, Merchant Business Guide, and Developer API Reference — Engineered to Eliminate Human Error.

---

## 0. CRITICAL INSTRUCTIONS FOR OPENCODE (`deepseek 4.1 flash`): DO NOT SUMMARIZE OR PARAPHRASE

Why the previous implementation failed:
1. Previously, the guide and academy were built as short, 2-sentence marketing cards that assumed the reader already knew what a payment switch, a double-entry journal line, an HMAC signature, a slot lock, an `UNKNOWN` state, or a Maker-Checker JSON-Patch diff was.
2. **You (`OpenCode`) MUST NOT summarize, shorten, paraphrase, or omit any text, analogy, table, warning callout, SOP checklist, lab step, or quiz question in this document.**
3. **Modular Content File Architecture (Mandatory):** To prevent single-file token truncation when generating code, you MUST store the verbatim content in dedicated, strictly typed TypeScript data modules before wiring the Vue 3 TSX (`kt-dc`) UI components:
   - `admin-front/src/content/guide/glossaryData.ts` (All 60+ zero-assumption glossary terms in EN & AR)
   - `admin-front/src/content/guide/booksPart1.ts` (Books 1–6 full verbatim text, analogies, tables, and SOP checklists)
   - `admin-front/src/content/guide/booksPart2.ts` (Books 7–12 full verbatim text, runbooks, and edge-case lookups)
   - `admin-front/src/content/academy/modulesTrackA.ts` (Academy Modules 1–4 full verbatim lessons, analogies, labs, and quizzes)
   - `admin-front/src/content/academy/modulesTrackB.ts` (Academy Modules 5–8 full verbatim lessons, analogies, labs, and quizzes)
   - `merchant-front/src/content/guide/merchantOperationsGuide.ts` (Merchant Chapters 1–10 full verbatim text)
   - `merchant-front/src/content/guide/merchantDeveloperApiGuide.ts` (Developer API Chapters 1–8 + full code templates)
4. **Automated Content-Completeness Gate:** Before marking this task complete, `bun test` / `vitest` MUST run `content-completeness.test.ts` (specified in Part V), which programmatically asserts that every book, chapter, lesson, lab, and quiz question exists and meets minimum character/word length thresholds.

---

# PART I: THE ADMIN PORTAL ZERO-TO-HERO INTERACTIVE SYSTEM GUIDE (`admin-front/src/pages/guide/index.tsx`)

## 1. Purpose & UX Architecture of the Admin System Guide

The Admin Interactive System Guide is **not** a marketing overview. It is the **primary operational manual and human-error prevention system** for every employee working inside the payment gateway company. It is written so that a brand-new hire on Day 1—with **zero prior experience in banking, accounting, software engineering, or compliance**—can read from Book 1 to Book 12 and understand every single button, table, status badge, accounting rule, and security boundary in the platform.

### 1.1 Four UI Surfaces of the Admin Guide in `admin-front`

1. **Full-Screen Interactive Manual (`/guide`):**
   - Left navigation tree showing the **Zero-Assumption Glossary**, **12 Comprehensive Books** (broken into scannable sub-chapters), **Interactive Simulators**, and **Role-Based Daily Checklists**.
   - Every chapter renders:
     - **"Plain-English Concept & Real-World Analogy"** box (explaining the concept to a complete beginner),
     - **"How Our System Works Step-by-Step"** diagram and walkthrough,
     - **"Where to Click in the Portal"** navigation breadcrumbs,
     - **"CRITICAL HUMAN ERROR WARNINGS (What Never To Do)"** red alert box,
     - **"Interactive Try-It Widget"** embedded directly inline.
2. **Global `Ctrl+K` / `Cmd+K` Instant Search Palette (`GlobalGuideSearchModal.tsx`):**
   - Accessible from the top app bar on every screen. Searches across all 12 Books, all 60+ Glossary terms, all canonical error codes (`RETRYABLE_OTP`, `LIMIT_EXCEEDED`, `GATEWAY_FAULT`, `AMBIGUOUS`), all 10 GL Account types, all 5 Incident Runbooks (`RB-01` to `RB-05`), and all 140 Edge Cases.
3. **Contextual Slide-Over Help Drawer (`ContextualHelpDrawer.tsx`):**
   - Every page and dialog in `admin-front` has a `"Help & SOP (?)"` button in its header. Clicking it slides open a 560px right-hand drawer pre-loaded to the exact chapter and SOP checklist for that screen **without closing or resetting the form the admin is working on**.
4. **Inline Field & Badge Explainer Popovers (`TermTooltip.tsx`):**
   - Hovering or clicking any technical badge in any table (e.g., `UNKNOWN`, `AML_HOLD`, `DRAINING`, `OPEN_BREAKER`, `PAYER_SURCHARGE`, `MERCHANT_DIRECT`, `SORTED_KEY_VALUE_AMP`) opens a plain-English card explaining what that badge means and what action is required.

---

## 2. Verbatim Content: The Zero-Assumption Foundational Glossary (`glossaryData.ts`)

Every term below MUST be included verbatim in `admin-front/src/content/guide/glossaryData.ts` and searchable via `Ctrl+K`:

| Term | Category | Zero-Assumption Plain-English Definition (For Someone With No Prior Experience) | Real-World Analogy | Fatal Human Error to Avoid |
| :--- | :--- | :--- | :--- | :--- |
| **Payment Gateway (Our Platform)** | Basics | A secure software bridge that sits between a business (Merchant) that wants to get paid and the banks or mobile wallets where customers keep their money. Instead of a store having to sign 20 separate technical contracts with 20 banks, they connect to us once, and we handle all 20 payment methods for them. | Think of us as an international airport terminal: passengers (customers) arrive once, and we route them onto 20 different airlines (banks and wallets) safely. | Never confuse **our platform** with the **upstream bank/switch**. We orchestrate the payment and keep the ledger, while the bank/wallet holds the customer's actual account. |
| **Merchant** | Basics | Any business, store, clinic, university, or company that registers on our platform to collect money from its customers (using Payment Links, a website API, or an in-store POS machine). | A shop owner renting a stall in our digital mall. | Never activate a `PENDING` merchant for live payments before their identity documents (KYB) and compliance checks (AML) are 100% verified. |
| **Payer (End-Client)** | Basics | The everyday customer who clicks a Merchant's Payment Link or stands at a store counter to pay for goods or services. Payers do not create accounts on our portal; they simply open the checkout link and pay. | A shopper standing at the cashier counter with their card or phone wallet. | Never ask a Payer for their card PIN or SMS OTP over phone/WhatsApp support. Support agents never need an OTP to check a payment! |
| **Rail (Payment Method)** | Catalog | What the customer actually sees and clicks on the checkout page to pay—for example, **Edfali**, **Sadad**, **Moamalat Card**, **LYPay QR**, **MobiCash**, or **NeomPay**. A Rail owns the logo, the Arabic/English name, and the input fields the customer fills out (such as their phone number). | The menu item a customer orders at a restaurant ("I want to pay with Sadad"). | Never delete a Rail that has historical payments. If a Rail must be turned off, set `blocked = true` (Active -> Blocked) so historical records stay intact. |
| **Gateway (Upstream Provider)** | Catalog | The external company, bank switch, or aggregator whose server our system talks to behind the scenes to process a Rail. Some Gateways provide just one Rail (e.g., Edfali Direct from BCD Bank), while **Aggregator Gateways** (like DPay, Plutu, or MyPay) provide access to many Rails through one technical connection. | The kitchen supplier that delivers the ingredients for the menu item. You can buy Edfali directly from the farm (BCD Bank) or through a wholesale distributor (Plutu or DPay). | Never assume "Rail" and "Gateway" are 1-to-1. One Rail (like `edfali`) can be connected to three different Gateways (`edfali-direct`, `plutu`, `dpay`) for automatic backup! |
| **Credential Set** | Catalog | The secret keys, usernames, passwords, Merchant IDs (`MID`), and Terminal IDs (`TID`) used to log into a Gateway. A Credential Set belongs either to **our Platform (`PLATFORM`)** or to **a specific Merchant (`MERCHANT`)**, and is strictly separated between testing (`SANDBOX`) and real money (`LIVE`). | The keycard and PIN code used to unlock a specific bank vault door. | Never paste `LIVE` credentials into a `SANDBOX` environment, and never paste real secrets into an external AI chat. Once saved, secrets are write-only and encrypted. |
| **Route (`RailRoute`)** | Catalog | The bridge that connects one **Rail** (e.g., Edfali) to one **Gateway** (e.g., Plutu) using one **Credential Set**, along with its cost, minimum/maximum LYD limits, daily cap, priority, and health status. If a Rail has two Routes and the primary Route goes down, our system automatically switches new payments to the backup Route. | A specific highway between Tripoli and Misrata. If the coastal highway (Route 1) is closed for repairs, cars automatically take the southern highway (Route 2). | Before retiring an active Route, always set it to **`DRAINING`** first (not `PAUSED` immediately) so customers who are currently typing their OTP can finish their payment without failing! |
| **Payment Link** | Checkout | A unique web page (`https://pay.domain.ly/pay/<linkKey>`) created by a Merchant for a specific LYD amount (e.g., `150.000 LYD`). It can be **Single-Use** (`use_count = 1`, for one specific invoice) or **Multi-Use** (for a donation page or fixed-price product). | A digital price tag and invoice that the customer opens on their phone to pay. | Remember that the checkout browser **cannot** change the link's amount. The server always reads the price from the database record of the Payment Link. |
| **Payment Attempt** | Runtime | Every single try a customer makes to pay a Payment Link. If a customer opens a link, tries Sadad, cancels, and then pays with Moamalat Card, there is **1 Payment Link** and **2 Payment Attempts** grouped together in an **Attempt Group**. | Trying to swipe a card at a terminal. The first swipe might fail (Attempt 1), and the second swipe succeeds (Attempt 2), paying the single bill. | At most **one** Payment Attempt in an Attempt Group is allowed to succeed for a single-use link. |
| **Slot Reservation (`active_locked_count`)** | Runtime | When a customer starts paying a Single-Use link, our system immediately "locks" the link's slot so that if the customer opens a second browser tab (or a second person opens the same link), the second tab is blocked with *"Payment in progress"* instead of charging the bill twice. | Putting an "Occupied" lock on a fitting-room door while someone is inside. The lock only opens if they walk out empty-handed (`FAILED`/`CANCELLED`/`EXPIRED`). | If an attempt enters **`UNKNOWN`** state, the slot lock stays **LOCKED** on purpose! Never manually unlock or tell a customer to pay again while an attempt is `UNKNOWN`, or they may be charged twice. |
| **Collection Mode (Axis A)** | Engine | **What the customer physically does** to authorize the payment. There are 9 modes: typing an SMS code (`OTP_PULL`), going to a bank webpage (`REDIRECT`), typing card details in a popup (`EMBEDDED`), approving a notification in their wallet app (`PUSH_APPROVAL`), scanning a barcode (`QR_DISPLAY`), texting a code (`PAY_CODE`), clicking an app button (`DEEP_LINK`), making a bank wire (`MANUAL`), or choosing among several (`HYBRID`). | How you hand over payment in real life: typing a PIN, scanning a barcode, or signing a slip. | Collection Mode only describes what the *customer* does—it is completely separate from how *our server* confirms the money arrived (Confirmation Channel). |
| **Confirmation Channel (Axis B)** | Engine | **How our backend server learns the truth** about whether the payment succeeded. Channels include: the direct reply to our confirm call (`SYNC_RESPONSE`), a signed server-to-server notification from the bank (`WEBHOOK`), our server asking the bank's status API (`INQUIRY / POLL`), a daily bank spreadsheet (`STATEMENT`), or two admins verifying a receipt (`OPERATOR_CONFIRMATION`). | Waiting for the bank's official stamped receipt, rather than just trusting a customer who says "I promise I paid!" | **Golden Rule of Security:** `RETURN_URL` (the customer's browser coming back from a bank page) and `BROWSER_CALLBACK` (JavaScript in the browser saying "Complete!") have **ZERO trust**. They are only "doorbells" that tell our server to ask the bank directly. |
| **Point of No Return (`point_of_no_return`)** | Engine | The exact step in a payment flow where money may actually be taken from the customer's account (for example, submitting the SMS OTP to the bank). Before this point, if a gateway fails, we can safely switch to another route. After this point, we are strictly bound to this gateway. | The moment an airplane passes takeoff decision speed (`V1`). Before `V1`, you can abort on the runway; after `V1`, you cannot slam the brakes. | Never configure a `MOVES_MONEY` step with automatic retries (`retry_policy` must be `NEVER`, unless the gateway proves cryptographic idempotency). Retrying a timed-out money call can charge the customer twice! |
| **`UNKNOWN` Status** | Operations | The safety state a Payment Attempt enters when our server sent a money-moving request (like confirming an OTP), and the bank's server timed out, disconnected, or returned a 500 error. We **do not know yet** whether the bank took the customer's money or not. | Calling someone to wire money and the phone line cuts out right as they say "Okay, I clicked—". You must check your bank statement or call them back before sending the money again! | **NEVER** mark an `UNKNOWN` attempt as `FAILED` without checking with the gateway first (via the **Inquire** button or the next day's **Statement Reconciliation**). Marking a settled `UNKNOWN` payment as `FAILED` releases the link slot and causes double charges or lost money. |
| **Double-Entry Ledger** | Finance | Our accounting book inside the database (`gl_accounts`, `journal_entries`, `journal_lines`). Every time money moves, we never just "edit a number" in a wallet. Instead, we write an unchangeable Journal Entry where total **Debits (`DEBIT`)** equal total **Credits (`CREDIT`)** to four decimal places (`0.0000 LYD`). | A physics conservation law for money: money cannot appear out of thin air or vanish into thin air; every dinar credited to a Merchant Wallet must come from a specific Clearing or Treasury account. | If the **Ledger Invariant Check** ever shows a drift other than `0.0000 LYD`, all automated merchant cash-outs halt immediately (`Runbook RB-04`) until Finance resolves the discrepancy. |
| **`GATEWAY_CLEARING` vs. `TREASURY`** | Finance | When a customer pays `100 LYD` through an external gateway (like Moamalat or Sadad), the cash is not physically in our company bank account yet—the gateway owes it to us and will wire it in 1 to 3 days (`T+N`). So at the moment of payment, we debit **`GATEWAY_CLEARING`** (money the gateway owes us). Days later, when the bank statement confirms the wire arrived, we move it from `GATEWAY_CLEARING` into **`TREASURY`** (actual cash in our bank). | `GATEWAY_CLEARING` is an official IOU slip from the delivery courier; `TREASURY` is the actual cash locked inside your company safe once the courier hands it over. | Never confuse `GATEWAY_CLEARING` with available cash for payouts. Check the **Liquidity & Clearing Ageing** dashboard to ensure `TREASURY` has enough settled cash before processing large merchant cash-outs. |
| **Fee Bearer (`MERCHANT_ABSORBS`, `PAYER_SURCHARGE`, `SPLIT`)** | Finance | Determines who pays our platform commission on a Payment Link. For a `100 LYD` link with `3%` (`3 LYD`) commission:<br>• `MERCHANT_ABSORBS`: Customer pays `100 LYD`, Merchant gets `97 LYD`.<br>• `PAYER_SURCHARGE`: Customer pays `103 LYD`, Merchant gets `100 LYD`.<br>• `SPLIT` (e.g., 50/50): Customer pays `101.50 LYD`, Merchant gets `98.50 LYD`. | Whether a store includes delivery in the item price, charges the customer extra for delivery, or splits the delivery fee 50/50. | When reviewing a refund or dispute, check the attempt's `fee_bearer` and `reverse_commission` policy so you understand why the customer's total charged amount may include a surcharge. |
| **Settlement Target (`PLATFORM_CLEARING` vs. `MERCHANT_DIRECT`)** | Finance | • `PLATFORM_CLEARING`: The payment lands in *our* gateway account, we credit the Merchant's Wallet, and we pay the Merchant later via Cash-Out.<br>• `MERCHANT_DIRECT`: The Merchant plugged in their *own* gateway credentials (e.g., their own DPay account), so the gateway sends the `100 LYD` directly to the Merchant's bank! Our ledger does **not** credit their wallet; instead, we book `3 LYD` into **`COMMISSION_RECEIVABLE`** (money the Merchant owes us for using our software). | `PLATFORM_CLEARING` is when Uber collects the fare on card and pays the driver weekly; `MERCHANT_DIRECT` is when the passenger pays the driver cash, so the driver now owes Uber its 3% service fee. | For `MERCHANT_DIRECT` payments, our company **never holds the principal cash**. Therefore, you cannot refund a `MERCHANT_DIRECT` payment from our Treasury, and an AML alert on a `MERCHANT_DIRECT` payment creates an investigation case (`CASE_ONLY`) rather than an escrow hold. |
| **Maker-Checker (Four-Eyes Rule)** | Governance | Our golden security rule: **no single employee can make a sensitive change or move money alone.** One authorized user (**the Maker**) proposes the action (creating a draft in `approval_requests`), and a **second, different authorized user (`checker_user_id != maker_user_id`)** must inspect the diff and click Approve before it executes. | A bank vault that requires two separate physical keys held by two different managers turned at the same time. | Never share your admin login with a colleague to "quickly approve" your own Maker request. The database trigger, middleware, and audit log track every Maker and Checker, and sharing credentials is a critical security violation. |
| **KYB (Know Your Business) & Beneficial Owner** | Compliance | **KYB** is the process of verifying a Merchant's legal documents (Commercial Registry, Tax Certificate, Articles of Association, Bank Letter) before activating their account. A **Beneficial Owner** is any real human being who ultimately owns **25% or more** of the company (or controls it as a director/signatory). | Checking both a company's business license and the passports of the actual people who own the company behind the scenes. | Watch out for **Duplicate Document Flags (`SHA-256` match)**: if Company B uploads the exact same PDF file hash that Company A uploaded last month, pause and investigate for shell-company fraud (Edge Case 120). |
| **AML, Sanctions, PEP & "No Tipping-Off"** | Compliance | • **AML (Anti-Money Laundering):** Rules and checks that stop criminals from washing illegal money through our gateway.<br>• **Sanctions List:** Official international/CBL blacklists of banned individuals or entities.<br>• **PEP (Politically Exposed Person):** A high-ranking government official, judge, military officer, or their close family/associates (requires higher scrutiny).<br>• **No Tipping-Off:** The strict legal prohibition against telling a Merchant or Customer that they are under AML investigation or that a Suspicious Activity Report (`STR`) was filed. | Airport customs security: if a passenger triggers a watchlist alert, officers politely ask them to wait for a "routine check"—they never announce "You matched our criminal watchlist!" | **NEVER** mention AML, Sanctions, PEP, or Watchlists in an email, SMS, Info Request, or support chat to a merchant or payer. Always use the neutral `POLICY` reason code. |

---

## 3. Verbatim Content: The 12 Books of the Admin Interactive System Guide (`booksPart1.ts` & `booksPart2.ts`)

Every Book below MUST be implemented in full inside `admin-front/src/content/guide/` and rendered with its step-by-step diagrams, tables, SOP checklists, and red error-prevention callouts.

---

### BOOK 1: Welcome to the Platform — How Money, Data, and Security Work From Zero

#### Chapter 1.1: What Does Our Company Actually Do? (From Zero)
When a customer in Tripoli, Benghazi, or Misrata wants to buy something online or in a store—whether a plane ticket, an electronics order, or a clinic bill—they might want to pay using **Sadad** (Almadar), **Edfali** (Bank of Commerce & Development), **Moamalat** (their local debit card on the National Switch), **LYPay / OnePay** (instant bank QR transfer), **MobiCash**, **T-LYNC**, **MyPay**, or **NeomPay**.

For an individual store owner (**Merchant**), integrating all 20 of those systems is nearly impossible: each bank speaks a different computer language, uses different mathematical formulas to sign messages, measures Libyan Dinars differently (some in Dinars `10.50`, some in Dirhams `10500`), and settles money on different schedules.

**Our platform solves this completely:**
1. **One Unified Integration for Merchants:** A Merchant registers once in our **Merchant Portal** (`merchant-front`), passes our legal & compliance checks (**KYB/AML**), and creates a **Payment Link**, connects their website via **API**, or pairs an in-store **POS Screen**.
2. **One Intelligent Checkout for Customers:** When the customer opens the Payment Link in **Checkout** (`checkout-front`), our system automatically calculates which payment methods (**Rails**) are healthy, allowed, and within limits for that exact amount, and shows a clean Arabic/English screen.
3. **One Zero-Code Engine Behind the Scenes:** When the customer clicks a Rail (e.g., *Sadad*), our isolated core engine (**`core-back`**) translates the request into Sadad's exact format, verifies the result from a trusted server channel, and records the accounting movement in our **Double-Entry Ledger**.

#### Chapter 1.2: Why Is Our System Split Into 7 Separate Projects? (The Zero-Trust Model)
If you hear engineers mention `core-back`, `admin-back`, `merchant-back`, or `checkout-back`, here is why our platform is built like a high-security bank rather than a single website:

```text
[ PUBLIC INTERNET ] ──▶ Checkout Website (checkout-front / checkout-back)   ─┐
[ PUBLIC INTERNET ] ──▶ Merchant Portal  (merchant-front / merchant-back)   ─┼──▶ (mTLS 1.3 Certificate Lock) ──▶ [ CORE ENGINE & DATABASE (core-back) ]
[ OFFICE LAN ONLY ] ──▶ Admin Back Office (admin-front / admin-back :8443)  ─┘                                     (Holds All Money, Keys & PostgreSQL 18 database)
```

1. **The Public Edge Servers Hold Zero Secrets and Zero Database Access:**
   - The Checkout server (`checkout-back`) and Merchant server (`merchant-back`) face the public internet so customers and merchants can reach them. Because anything on the public internet can be attacked, those servers **do not have the database password, do not have the database software installed, and do not hold any bank secret keys**.
2. **The Admin Portal (`admin-front` / `admin-back`) Is Local-Network (LAN) Only:**
   - The Admin Back Office you are using right now runs on a private office network port (`:8443`) that is blocked from the public internet at the firewall level.
3. **The Vault (`core-back`) Trusts Nobody Blindly ("The Double-Check Rule"):**
   - Only `core-back` can talk to the PostgreSQL 18 database, decrypt bank credentials (`Vault`), talk to external banks, or write to the financial ledger (`LedgerPoster`).
   - Even when `admin-back` or `checkout-back` sends a message to `core-back` using a cryptographic certificate (**mTLS 1.3**), `core-back` **re-checks everything from scratch**: it verifies your login token, your Multi-Factor Authentication (MFA), your exact permission flags (`authorities_map`), and ensures that the Maker and Checker on an approval are two different human beings.

> **CRITICAL HUMAN ERROR WARNING — NEVER BYPASS NETWORK OR ACCOUNT BOUNDARIES:**
> - Never attempt to expose the Admin Portal (`:8443`) or Core Engine (`:4000`) to the public internet or over an unsecured public proxy.
> - Never share your Admin account or MFA device with another employee. Every click you make records your `user_id`, IP address, and before/after snapshot in the permanent `audit_log`.

---

### BOOK 2: Roles, Authorities & The Four-Eyes (Maker-Checker) Governance Rule

#### Chapter 2.1: Understanding Your Role vs. Your Authorities (`authorities_map`)
In our platform, every employee account has two layers of access control:
1. **Your Role (`UserRole`):** Describes your job function (`GATEWAY_ADMIN`, `SECURITY_ADMIN`, `FINANCE`, `OPERATOR`, `COMPLIANCE`, `MLRO`, `SUPPORT`).
2. **Your Authorities Map (`authorities_map`):** The exact list of actions your account is permitted to perform (for example, `case:read`, `dispute:write`, `gateway:write`, `aml:read_confidential`).
   - **Default-Deny Rule:** If an admin creates a new user account and leaves `authorities_map` empty, that user can see **zero** pages and call **zero** APIs, regardless of their Role title.
   - **Confidentiality Wall (`AML-CONFIDENTIAL`):** Only `COMPLIANCE`, `MLRO` (Money Laundering Reporting Officer), and `SECURITY_ADMIN` (for audit) can view AML screenings, watch-list matches, or Suspicious Activity Reports. `SUPPORT` and `OPERATOR` staff are blocked from seeing AML reasons so they can never accidentally "tip off" a merchant under investigation.

#### Chapter 2.2: How the Four-Eyes (Maker-Checker) System Protects You and the Company
Imagine if a tired Finance officer accidentally typed `100,000 LYD` instead of `1,000 LYD` on a manual adjustment, or if a Gateway Admin accidentally pasted a broken URL into a live bank integration. In a normal system, that mistake would immediately break production or lose money.

In our platform, **every sensitive action is governed by the Four-Eyes (Maker-Checker) rule**:
1. **Step 1 — The Maker Proposes (`DRAFT -> PENDING_REVIEW`):**
   - User A (who has `is_maker = true`) fills out the form (e.g., editing a merchant's payout bank account, proposing a refund, changing a commission rate, or promoting a Gateway Version to `LIVE`).
   - Instead of changing the live database immediately, the system saves an **Approval Request (`approval_requests`)** containing a **JSON-Patch Diff** (a side-by-side comparison of the Old Value vs. the Proposed New Value) and records the entity's current `base_version`.
2. **Step 2 — The Checker Inspects & Decides (`PENDING_REVIEW -> APPROVED -> EXECUTED` or `REJECTED`):**
   - User B (a **different** person with `is_checker = true` in that domain) opens the **Approvals Queue (`/approvals`)**.
   - The system enforces **`checker_user_id != maker_user_id`** at three separate levels: in the UI, in the backend middleware, and in a hard PostgreSQL database trigger (`approval_requests_checker_not_maker`). You **cannot** approve your own request.
   - When the Checker clicks **Approve**, the system verifies that the record hasn't been modified by someone else in the meantime (`base_version` check) and **atomically executes** the change and writes the ledger/audit record in the exact same database transaction.

#### Chapter 2.3: The Asymmetry Rule — Emergency Actions (`EMERGENCY_RATIFICATION`)
What if a merchant is actively committing fraud at 2:00 AM on a Friday, or an AML rule needs to be tightened immediately to stop an attack, and a second Checker is asleep?
- **Actions that REDUCE risk** (Suspending a merchant, tightening a velocity/AML rule, pausing a broken route) are allowed to take effect **immediately** with one authorized person, creating an approval request in **`EMERGENCY_RATIFICATION`** mode with a **24-hour countdown timer (`ratify_due_at`)**.
- Within 24 hours, an `MLRO` or `COMPLIANCE` Checker must review and ratify the emergency suspension. If the 24-hour timer expires without ratification, a `P2` alert pages management—and the merchant **stays suspended** (fail-safe, never fail-open) until a human Checker decides.
- **Actions that INCREASE risk or MOVE money** (Reinstating a suspended merchant, loosening a rule, releasing an AML hold, approving a refund/cash-out, promoting a gateway to `LIVE`) **NEVER** have an emergency bypass; they always wait for a second human Checker prior to execution.

#### Chapter 2.4: Step-by-Step SOP for Checkers Reviewing `/approvals`
Before you ever click **Approve** on any row in `/approvals`, complete this 5-point checklist:
1. **Read the Green/Red JSON Diff Line by Line:** Never approve based only on the summary title. Inspect the exact numbers, account IBANs, URLs, or transform pipes changing in the diff viewer.
2. **Check the Currency & Decimal Scale:** Remember that LYD uses 3 decimals (`100.0000` is One Hundred Dinars). Verify that a Maker did not enter `100000` thinking in Dirhams!
3. **Verify External Evidence:**
   - For a **Bank Account Change (`payout_bank_details_json`)**: Open the merchant's KYB documents and verify the official stamped Bank Letter matches the new IBAN and the merchant's legal name.
   - For a **Manual Refund / Adjustment**: Verify the `provider_refund_ref` or `external_dispute_ref` against the gateway portal or statement.
   - For a **Gateway Version Promotion to `LIVE`**: Verify that all **12 Go-Live Gates** show green badges and a valid `rollback_version_id` is selected.
4. **Check the Chargeback Outcome Selector (When Approving a Dispute Adjustment):** Confirm whether the adjustment is escrowing an opened dispute, releasing a `WON` dispute, or finalizing a `LOST` dispute.
5. **Write a Clear Rejection Reason if Anything Looks Wrong:** If even one field is ambiguous, click **Reject**, type the exact correction needed, and let the Maker submit a clean draft.

---

### BOOK 3: The Four-Layer Payment Catalog (`Gateway` -> `Credential Set` -> `Rail` -> `Route`)

#### Chapter 3.1: Why Do We Separate Gateways, Credential Sets, Rails, and Routes?
New employees often ask: *"Why don't we just have one table called 'Payment Methods'?"*
Here is why our 4-layer design is essential in the Libyan market:
- Suppose **Edfali** is a payment method that customers love.
- We can connect to Edfali **directly** through Bank of Commerce & Development (`Gateway 1: edfali_direct`, which costs us `0.5%`), **or** through the **Plutu Aggregator** (`Gateway 2: plutu`, which costs us `1.2%`), **or** through the **DPay Aggregator** (`Gateway 3: dpay`, which costs us `1.5%`).
- Furthermore, a large supermarket chain might have its **own** direct contract with DPay (`Credential Set: Merchant-Owned`), while 500 smaller stores use **our company's** master contract (`Credential Set: Platform-Owned`).

By separating the 4 layers, the customer at checkout simply sees **one clean "Edfali" button (`Rail`)**, while our engine automatically picks the best, cheapest, healthy **`Route`** and **`Credential Set`** behind the scenes!

```text
Layer 3: RAIL (What the Customer Sees)
  [ Edfali (إدفع لي) ]  ── Owns Logo, Arabic/English Name, Customer Input Form (09xxxxxxxx Phone + OTP)
         │
         ├──▶ Layer 4: ROUTE A (Priority 1, Cost 0.5%, Status: ACTIVE, Health: HEALTHY)
         │       └──▶ Layer 1: GATEWAY (edfali_direct) + Layer 2: CREDENTIAL SET (Platform Master Account)
         │
         ├──▶ Layer 4: ROUTE B (Priority 2, Cost 1.2%, Status: ACTIVE, Health: HEALTHY — Automatic Backup!)
         │       └──▶ Layer 1: GATEWAY (plutu)         + Layer 2: CREDENTIAL SET (Platform Plutu Account)
         │
         └──▶ Layer 4: ROUTE C (Scoped to Supermarket X Only, Settlement: MERCHANT_DIRECT)
                 └──▶ Layer 1: GATEWAY (dpay)          + Layer 2: CREDENTIAL SET (Supermarket X's Own DPay Keys)
```

#### Chapter 3.2: How the "Visible Rails Formula" Decides What Appears at Checkout
When a merchant calls support and asks: *"Why isn't Sadad (or Moamalat Card) showing up on my Payment Link?"*, you do **not** have to guess. Our engine evaluates the **Visible Rails Formula** on every checkout load. A Rail appears **only** if all 10 of these conditions are true:

| # | Check Performed by `VisibleRailsResolver` | Where to Check in Admin Portal if the Rail is Missing | Machine Exclusion Code (Shown in Diagnostics) |
| :--- | :--- | :--- | :--- |
| **1** | Is the Rail unblocked globally? | **Catalog -> Rails (`/rails`)**: Check that `Active/Blocked` is `Active` (`blocked = false`). | `RAIL_BLOCKED` |
| **2** | Does the Rail's currency match the Link's currency? | **Catalog -> Rails**: An `LYD` link only shows `LYD` rails; a `USD` link only shows `USD` rails (like MPGS Visa/MC). | `CURRENCY_MISMATCH` |
| **3** | Is the Rail allowed by the Merchant's Application whitelist? | **Merchants -> Applications**: If `rail_whitelist` is empty/null, all rails are allowed. If specific rails are selected, unlisted rails are hidden. | `EXCLUDED_BY_APP_WHITELIST` |
| **4** | Is the Rail allowed by the Payment Link's whitelist? | **Links Inspector**: Check if the merchant restricted that specific link to certain rails only. | `EXCLUDED_BY_LINK_WHITELIST` |
| **5** | Does a live **Commission Profile** exist for this Rail? | **Finance -> Commission Profiles (`/commission-profiles`)**: Every rail must have an active, effective-dated Commission Profile (either for that merchant/app or a Platform Default) so the system knows how much commission to charge! | `NO_COMMISSION_PROFILE` |
| **6** | Does the Rail have at least one `ACTIVE` and `HEALTHY` Route? | **Catalog -> Routes (`/routes`)**: Check that at least one route for this rail has `Status = ACTIVE` and `Health = HEALTHY` (not `PAUSED`, `DRAINING`, or `OPEN_BREAKER`). | `NO_HEALTHY_ACTIVE_ROUTE` |
| **7** | Is the Link's amount between the Route's `min_amount` and `max_amount`? | **Catalog -> Routes**: If a customer opens a `15,000 LYD` link and Sadad's max per-transaction limit is `2,000 LYD`, Sadad is automatically hidden for that link. | `AMOUNT_BELOW_MINIMUM` / `AMOUNT_ABOVE_MAXIMUM` |
| **8** | Is the Route within its Daily Cap (`daily_cap_amount`)? | **Finance -> Route Caps (`/finance/route-caps`)**: If a route processed `99,800 LYD` today and its daily cap is `100,000 LYD`, a `500 LYD` link will skip that route. | `DAILY_CAP_EXCEEDED` |
| **9** | Is the current time outside the Route's Maintenance Window, and is the Merchant in Scope? | **Catalog -> Routes**: Check `maintenance_windows` and `scope` (`merchant_ids`, `risk_tiers`, `channels`). | `IN_MAINTENANCE_WINDOW` / `OUT_OF_SCOPE` |
| **10** | Does the Route have a `VERIFIED` Credential Set? | **Catalog -> Credential Sets (`/credential-sets`)**: A route cannot process traffic if its credentials are `UNTESTED`, `FAILING`, or `REVOKED`. | `NO_VERIFIED_CREDENTIAL_SET` |

---

### BOOK 4: Collection Modes (Axis A) & Confirmation Channels (Axis B) — Why We Never Trust the Browser

#### Chapter 4.1: Axis A — The 9 Collection Modes (What the Payer Does)
1. **`OTP_PULL` (Two-Step SMS Code — Edfali, Sadad, MobiCash, Libyana, Masrefy):**
   - **Step 1 (`INITIATE`):** Customer types their phone number (and Birth Year for Sadad, or 7-digit Card Number for MobiCash). Our server asks the gateway to send an SMS code (`side_effect = SENDS_NOTIFICATION`). The gateway returns a secret session ID (`process_id`), which we lock inside `context_ciphertext`.
   - **Step 2 (`SUBMIT`):** Customer types the 4-to-6 digit SMS code. Our server sends `process_id + otp + amount + reference` to the gateway (`side_effect = MOVES_MONEY`, `point_of_no_return = true`).
2. **`REDIRECT` (Hosted Checkout Page — T-LYNC, MyPay, DPay Hosted, MPGS 3DS2):**
   - Our server creates a payment session with the gateway, receives a `redirect_url`, and sends the customer's browser to the gateway's website to pay. When finished, the browser returns to our `return_url`.
3. **`EMBEDDED` (In-Page Popup/Iframe — Moamalat National Switch Lightbox, MPGS Hosted Fields):**
   - Our server computes a cryptographic signature (`SecureHash`) over the amount, reference, and timestamp using our secret key, and hands the signed parameters (never the secret key!) to the Moamalat Lightbox script on the checkout page. The customer types their card PAN and PIN directly inside Moamalat's popup.
4. **`PUSH_APPROVAL` (Wallet App Notification — LYPay Push, GPay Libya, Hawelli, Evo Pay, NeomPay Push):**
   - Customer enters their wallet phone/ID. Our server sends a push request to their mobile wallet app. The screen displays a countdown timer while the customer opens their phone app and taps **Approve** or **Reject**.
5. **`QR_DISPLAY` (Dynamic Barcode Scan — CBL LYPay QR, OnePay EMVCo QR, NeomPay QR):**
   - Our server generates a dynamic, single-attempt QR code bound to this attempt's reference and amount. On a store POS screen or web checkout, the customer scans the QR with their banking app.
6. **`PAY_CODE` (SMS / USSD Purchase Code — Yussor Pay Code, OnePay SMS):**
   - Our screen displays a unique reference code and bilingual instructions telling the customer which short-code number to text or dial from their phone.
7. **`DEEP_LINK` (Mobile App Switch — Hawelli, Mobile Wallets):**
   - On a smartphone, tapping **"Open in Wallet App"** launches the installed wallet app directly with the payment pre-filled, automatically falling back to a QR code if the app isn't installed or the customer is on a desktop PC.
8. **`MANUAL` (Bank Wire or Cash Agent Deposit):**
   - Displays transfer instructions and our unique reference code. Money is confirmed only when matched on an uploaded bank statement (`STATEMENT`) or verified by two operators under Maker-Checker (`OPERATOR_CONFIRMATION`).
9. **`HYBRID` (Customer Picks Sub-Mode — Yussor Pay, Sahara Pay, NeomPay):**
   - A single Rail offers multiple sub-modes (e.g., `[OTP_PULL, QR_DISPLAY, PAY_CODE]`) as tabs on the checkout card so the customer can choose whether to scan a QR or type an OTP.

#### Chapter 4.2: Axis B — The 7 Confirmation Channels & The "5 Trusted Facts" Rule
Why do we **never** mark a payment `SUCCEEDED` just because the customer's browser came back to `/return/:token?status=paid` or because the Moamalat Lightbox JavaScript fired `completeCallback()`?
- **Because anyone can press `F12` (Developer Tools) in their web browser**, edit a URL to say `?status=paid&amount=100`, or type `completeCallback()` into the browser console!
- Therefore, in our platform, **`RETURN_URL` and `BROWSER_CALLBACK` have ZERO trust.** When they arrive, our server simply says: *"Thank you for the hint! Now I will call the bank's server directly (`VERIFY` inquiry) to see if you actually paid."*

An attempt transitions to `SUCCEEDED` and credits a Merchant Wallet **ONLY** when a **Server-Trusted Channel** (`SYNC_RESPONSE`, cryptographically verified `WEBHOOK`, server-to-server `INQUIRY / POLL`, `STATEMENT` match, or Maker-Checker `OPERATOR_CONFIRMATION`) proves **all 5 Trusted Success Facts**:
1. **Fact 1 — Canonical Status is `SUCCEEDED`** (e.g., `ActionCode === "00"` or `Approved === true`).
2. **Fact 2 — Reference Matches Ours** (`gateway_reference` matches the exact attempt).
3. **Fact 3 — Settled Amount Matches Expected Total** (`settled_amount` equals `total_charged_amount` within the route's rounding `tolerance_amount`). If the customer paid less or more than expected, the attempt is **HELD in `SUSPENSE`** for operator review—never credited blindly!
4. **Fact 4 — Currency Matches** (`LYD === LYD`).
5. **Fact 5 — Environment Matches** (`LIVE === LIVE`; a `SANDBOX` webhook sent to a `LIVE` endpoint is rejected and triggers a security alert).

---

### BOOK 5: The Universal Flow Engine, `TransformPipe[]` & Cryptographic Signing

#### Chapter 5.1: How Our Engine Talks to Any Bank Without Writing Code
Every Gateway integration in our system is organized into **10 Lifecycle Phases** (`FlowPhase`):
1. **`CREDENTIAL_CHECK`:** A harmless read-only call (like fetching a token or profile) used to test if API keys are valid when saved or during nightly health checks.
2. **`PRE_INITIATE`:** Optional pre-check before sending an OTP (e.g., checking if a phone number is subscribed to the wallet service).
3. **`INITIATE`:** Starts the payment (sends the SMS OTP, creates the redirect URL, generates the QR code, or computes the Lightbox hash).
4. **`SUBMIT` (`CONFIRM`):** The money-moving step where the customer's OTP or confirmation is submitted (`side_effect = MOVES_MONEY`, `point_of_no_return = true`).
5. **`VERIFY` (`INQUIRE`):** A read-only server call where we ask the gateway *"What happened to payment reference X?"* (`side_effect = READ_ONLY`, `retry_policy = SAFE`).
6. **`CANCEL`:** Cancels an unpaid pending request at the gateway if the customer clicks Cancel or switches rails.
7. **`REFUND`:** Returns full or partial money to the customer after a payment has settled.
8. **`VOID`:** Cancels a captured payment on the same day before batch settlement.
9. **`CAPTURE`:** Captures previously pre-authorized card funds.
10. **`SETTLEMENT_FETCH`:** Pulls the daily settlement report or ledger export from the gateway's API.

#### Chapter 5.2: Step Parameters, Dot-Path Selectors & The Closed Transform Library (`TransformPipe[]`)
When configuring an HTTP step in the 8-Step Gateway Wizard, you tell the engine where to get each piece of data (`source`), how to format it (`transforms`), and where to put it (`place: HEADERS | QUERY | PATH | BODY | FORM | MULTIPART | XML` and `key`).

- **How Dot-Path Keys (`recursiveSet`) Work:**
  - If a gateway expects nested JSON like `{"transAmount": {"amount": "100.00", "currency": "LYD"}}`, you simply create two parameters in `BODY`:
    - Key 1: `transAmount.amount` -> Value: `"100.00"`
    - Key 2: `transAmount.currency` -> Value: `"LYD"`
  - Our engine automatically builds the nested JSON object and preserves sibling fields.
- **How `TransformPipe[]` Works (Interactive Transform Sandbox Below):**
  - Transforms are chained left-to-right like an assembly line:
    - **Moamalat Dirham Example:** `ATTEMPT.total_charged_amount` (`10.5000`) -> `scale(1000)` (`10500`) -> `to_int` (`10500`) -> `to_string` (`"10500"`).
    - **DPay 2-Decimal Rounding Example:** `ATTEMPT.total_charged_amount` (`76.2550`) -> `round(NEAREST, 2)` (`76.26`) -> `format_decimal(2)` (`"76.26"`).
    - **Libyan Phone Normalization Example:** `CUSTOMER_FIELD.phone` (`"٠٩١٢٣٤٥٦٧٨"` or `"+218912345678"`) -> `arabic_digits_to_ascii` -> `phone_normalize(LOCAL_09)` -> `"0912345678"`.

#### Chapter 5.3: Understanding the 6 Cryptographic Signing Modes (`CryptoProfile`)
Gateways use cryptographic signatures (HMAC or RSA) so neither side can tamper with the amount or status in transit. Here are the 6 canonicalization modes built into our `CryptoEngine` (which you can test live in the **Crypto Signature Lab** widget):
1. **`SORTED_KEY_VALUE_AMP` (The Moamalat NPG Standard):**
   - Sorts the included fields alphabetically by key name, joins them as `Key1=Val1&Key2=Val2...`, and computes `HMAC-SHA256` using the **`HEX`-decoded** `MerchantSecretKey`, outputting `HEX_UPPER`.
   - *Trap to avoid:* Moamalat provides its secret key as a Hexadecimal string (e.g., `303132...`). In `CryptoProfile`, you **must** set `secret_key_encoding = HEX` (not `UTF8`), otherwise the hash will never match!
2. **`TIMESTAMP_DOT_RAW_BODY` (The DPay Standard):**
   - Reads the timestamp header (`X-DPay-Timestamp`), joins `<timestamp>.<exact_raw_json_bytes>`, and computes `HMAC-SHA256` (`UTF8` key), verifying that the timestamp is within `300 seconds` (5 minutes) to prevent replay attacks.
3. **`SORTED_VALUES_HASH` (The Plutu Callback Standard):**
   - Removes the signature field itself (`excluded_fields: ['hashed']`), sorts the remaining parameter keys alphabetically, concatenates *only their values* together, and computes uppercase `HMAC-SHA256`.
4. **`RAW_BODY` (The MyPay Standard):**
   - Computes `HMAC-SHA256` directly over the raw, unparsed HTTP request body bytes (`Buffer`) and compares it against the `X-MYPAY-SIGNATURE` header.
5. **`TEMPLATE_STRING` & `JSON_CANONICAL`:**
   - Builds a custom pattern (e.g., `{MID}:{reference}:{amount}`) or deterministic key-sorted JSON before signing with HMAC or `RSA_SHA256`.

---

### BOOK 6: The 8-Step "Add-a-Gateway" Wizard & Smart AI Integration Importer

#### Chapter 6.1: Walkthrough of the 8-Step Gateway Wizard (`/gateways/wizard/:id`)
Whenever you integrate a new bank or edit an existing gateway, you work inside a **`DRAFT` Gateway Version** (`gateway_versions`). Editing a draft **never** affects live customers until the version passes all **12 Go-Live Gates** and is approved by a `SECURITY_ADMIN` Checker.

- **Step 1 (Identity & Basics):** Enter `code` (lowercase slug, e.g., `sadad_direct`), `name`, `operator` (`Almadar Aljadid`), `country` (`LY`), `aliases` (`["sadad", "سداد"]`), `kind` (`DIRECT`, `AGGREGATOR`, `NATIVE_ADAPTER`, `INTERNAL`), and `risk_class` (`NORMAL` or `HIGH_RISK`).
- **Step 2 (Environments, Auth & Credentials):** Enter `SANDBOX` and `LIVE` `base_urls` (`https://...` only) and `allowed_hosts` (which cryptographically pins where credentials can be sent—Safeguard 11). Choose the `AuthMethod` (e.g., `PERMANENT_TOKEN`, `TOKEN_ENDPOINT`, `REQUEST_SIGNATURE`, `MUTUAL_TLS`), enter the write-only secrets into the `CredentialSet`, and click **"Run Live Credential Check"**.
- **Step 3 (Customer Form Builder — `Rail` & `RailField`):** Define the bilingual customer inputs (`phone`, `birth_year`, `card_number`, `otp`, `wallet_id`), validation regexes, digit/phone normalizers, and field sensitivity (`NORMAL`, `SENSITIVE`, or `PAN`—which holds 7/9-digit card numbers in memory only for a single call and wipes them immediately).
- **Step 4 (Cryptographic Profiles):** Configure `OUTBOUND_SIGN` and `INBOUND_VERIFY` profiles and paste a real sample from the partner's documentation into the **Interactive Signature Verifier** to prove your recipe matches byte-for-byte.
- **Step 5 (10-Phase Visual Flow Builder):** Add `HTTP`, `COMPUTE`, or `RENDER` steps for `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, and `REFUND`. Remember: any step with `side_effect = MOVES_MONEY` must have `point_of_no_return = true` and `retry_policy = NEVER` (unless idempotency key support is proven).
- **Step 6 (Client Actions, Confirmation Channels & Polling):** Configure how `checkout-front` renders the step (`SHOW_OTP_FORM`, `HTTP_REDIRECT`, `RENDER_EMBEDDED`, `SHOW_QR_OR_CODE`, `SHOW_PUSH_OR_TRANSFER`), configure the webhook `path_token` and verification method (setting `must_inquire = true` on any weak/IP-only channel), and set the background `PollPolicy` backoff (`[5, 10, 20, 40, 60]` seconds).
- **Step 7 (Status Rules, Error Map, Amount Scale & Statement Parser):** Map gateway codes to canonical statuses (`SUCCEEDED`, `FAILED`, `AWAITING_CUSTOMER`, `UNKNOWN`) and Error Classifications (`RETRYABLE_OTP` vs `TERMINAL_DECLINE` vs `LIMIT_EXCEEDED` vs `GATEWAY_FAULT`). Set `amount_scale` (`1`, `100`, `1000`), `amount_precision` (`0`, `2`, `3`), and `amount_rounding`, and map the CSV/XLSX/JSON columns for daily `StatementSource` reconciliation.
- **Step 8 (Dry-Run, 15-Scenario Sandbox Suite, 12 Gates & Maker-Checker Submit):** Run the automated **15-Scenario Suite**, select a `rollback_version_id`, verify all 12 Go-Live Gates are green, and click **Submit for Checker Approval**.

#### Chapter 6.2: Using the Smart AI Integration Importer (`/gateways/ai-import`) Safely
Instead of building all 8 steps by hand from a 40-page bank PDF, you can use our air-gapped **"Bring-Your-Own-AI"** workflow:
1. Click **Download AI Onboarding Transcript** in `/gateways/ai-import`.
2. Open any external AI model (Claude, ChatGPT, Gemini, DeepSeek) in your browser, upload the downloaded transcript + the bank's API PDF, and ask it to generate `integration-spec.json`.
   - **CRITICAL SECRET RULE:** Never give live API keys or HMAC secrets to the external AI! Give the AI only the *names* of the credential fields.
3. Upload `integration-spec.json` into Step 2 of `/gateways/ai-import`. Our backend runs a **4-Layer Verification Pipeline** (Zod Schema -> Semantic/SSRF Guard -> Offline Simulation against embedded `test_vectors` -> Collision Check). If any selector or signature fails against the doc's own sample payloads, click **"Copy AI Repair Prompt"** and paste it back to the AI.
4. Once all 4 layers pass green, enter the real secret values into the password inputs on Step 3 and click **Import as Draft**.

---

### BOOK 7: The 14-State Attempt Lifecycle & Resolving `UNKNOWN`, `CONFLICT`, and `HELD` Cases (`RB-01` to `RB-05`)

#### Chapter 7.1: Complete Map of Every `AttemptStatus` What It Means & What To Do

| Status Badge | Category | Plain-English Meaning | Is the Link Slot Locked (`active_locked_count`)? | What Should an Operator or Support Agent Do? |
| :--- | :--- | :--- | :--- | :--- |
| **`CREATED` / `INITIATING`** | In-Flight | The customer just clicked "Pay" and our server is talking to the gateway to start the session. | **YES (Locked)** | Wait a few seconds; this transitions automatically to `AWAITING_CUSTOMER` or `FAILED`. |
| **`AWAITING_CUSTOMER`** | In-Flight | The customer is currently looking at the OTP box (`OTP_REQUIRED`), the bank redirect page (`REDIRECT_PENDING`), the Moamalat popup (`WIDGET_OPEN`), the QR code (`QR_PENDING`), or their wallet app (`PUSH_PENDING`). | **YES (Locked)** | If the customer is still paying, tell them to complete the screen before the countdown expires. Do not cancel while they are entering their OTP. |
| **`AUTHORIZING`** | In-Flight (Past PNR!) | The customer submitted their OTP/confirmation and our `MOVES_MONEY` request is currently in flight to the bank. | **YES (Locked)** | **Hands off!** Money is moving right now. Never cancel or retry. |
| **`VERIFYING`** | In-Flight | A browser hint, redirect return, or `must_inquire` webhook arrived, and our server is querying the bank (`VERIFY`) to confirm the truth; **or** the payment is paused under an `AML_HOLD` (`substatus = 'AML_HOLD'`). | **YES (Locked)** | Check `substatus`: if `AML_HOLD`, refer to Compliance (`/aml/cases`). Otherwise, `PollWorker` is actively checking with the gateway. |
| **`UNKNOWN`** | **Exception (Requires Action!)** | Our server sent a money-moving call (`SUBMIT`), and the bank timed out, reset the connection, returned HTTP 500/502, or returned an unreadable response—**or** a webhook and inquiry contradicted each other (`CONFLICT`). | **YES (Strictly Held!)** | Follow **Runbook `RB-03`** below! Click **Inquire Now** in `/operator-cases`. If the rail has no inquiry API (like Edfali direct), wait for the next **Statement Reconciliation** or verify with partner support before resolving under Maker-Checker. |
| **`SUCCEEDED`** | Terminal (Paid) | All 5 Trusted Success Facts passed, the Double-Entry Ledger posted in the same transaction, and the Merchant Wallet (or Commission Receivable) was updated. | Slot Committed (`confirmed_count + 1`) | Payment is complete. If the customer needs their money back later, use a Maker-Checker **Refund Adjustment**. |
| **`FAILED`** | Terminal (Unpaid) | The payment definitely failed without taking money (wrong OTP 3 times, insufficient funds, customer limit exceeded, or gateway down before point-of-no-return). | **NO (Released)** | The customer was not charged and the link slot is free; they can safely try again or pick another rail. |
| **`EXPIRED`** | Terminal (Timed Out) | The countdown timer (`expires_at`) ran out, our sweeper ran one final `inquire()` check, and the customer hadn't paid. *(Note: the webhook inbox stays open during `grace_expires_at` in case a late bank notification arrives!)* | **NO (Released)** | If a verified payment notification arrives late during the grace window, the system automatically recovers `EXPIRED -> SUCCEEDED` (or routes to `SUSPENSE` if the link was already paid by another attempt). |
| **`CANCELLED`** | Terminal (Aborted) | The customer or POS cashier clicked Cancel before the point of no return. | **NO (Released)** | Link slot is free for a new attempt. |
| **`BLOCKED`** | Terminal (Risk Guard) | Blocked before calling the bank by a **Velocity Rule** (e.g., too many attempts from one IP/phone), a **Hot-Path AML Watchlist Hit**, or **Self-Payment Prevention** (merchant paying their own link). | **NO (Never Reserved)** | **Do not reveal internal AML reasons to the customer or merchant!** If blocked by Velocity, check `/velocity-rules`; if AML, escalate to `COMPLIANCE`. |
| **`PARTIALLY_REFUNDED` / `REFUNDED`** | Post-Settlement | One or more Maker-Checker Refund Adjustments were approved and executed back to the customer. | Committed | Check `/adjustments` to see the exact refunded amount and `provider_refund_ref`. |
| **`DISPUTED`** | Post-Settlement | The bank or card switch reported a **Chargeback / Dispute** (`disputes`). | Committed | Check `/disputes` and upload merchant evidence before `evidence_due_at`. |

#### Chapter 7.2: Step-by-Step SOP for Operator Cases (`/operator-cases`) & Runbooks `RB-01` to `RB-05`
1. **Resolving an `UNKNOWN` Case (`RB-03`):**
   - **Step 1:** Open `/operator-cases` and click the `UNKNOWN` case to inspect its `attempt_step_logs` (the exact HTTP status, timeout duration, and raw response from the bank).
   - **Step 2:** If the gateway supports status inquiry (`supports_status_check = true`), click **"Inquire Gateway Now"**. If the gateway replies with a definitive paid or unpaid status, the system resolves the attempt automatically!
   - **Step 3:** If the gateway has **no status inquiry API** (such as direct Edfali or certain aggregator OTP rails), **DO NOT GUESS**. Either upload the gateway's daily settlement statement in `/reconciliation` (which automatically matches `our_reference` / `provider_reference`), or obtain written confirmation of the `provider_reference` from the gateway's merchant portal/support desk, then submit a Maker-Checker resolution (`Resolve to SUCCEEDED` with `provider_reference` or `Resolve to FAILED`).
2. **Resolving a `P1 CONFLICT` Case (Webhook Says `PAID`, Inquiry Says `FAILED`):**
   - Neither signal is trusted automatically. Inspect the `inbound_events` raw webhook payload and the `attempt_step_logs` inquiry response. Verify against the official settlement statement before proposing a Maker-Checker resolution.
3. **Resolving a `HELD` / `MISMATCH` Case (Amount Difference Beyond Tolerance):**
   - Occurs when a customer was supposed to pay `100.0000 LYD` and the gateway settled `95.0000 LYD` or `105.0000 LYD`. The funds sit safely in `SUSPENSE`. Finance proposes a Maker-Checker Adjustment to either credit the settled amount or refund the payer.

---

### BOOK 8: Double-Entry Accounting, Clearing Accounts, Fee Bearers & Statement Reconciliation

#### Chapter 8.1: Accounting From Zero — What Are Debits, Credits, and the 10 GL Accounts?
Even if you have never taken an accounting class, you can master our ledger in 5 minutes using one simple rule: **Every time money moves, we write a Journal Entry with at least one Debit (`Dr`, where value flows IN / asset increases) and at least one Credit (`Cr`, where value flows OUT / obligation or income increases), and `SUM(DEBIT)` must ALWAYS equal `SUM(CREDIT)`.**

Here are the **10 General Ledger (`GLAccount`) types** in our platform:

| GL Account Type | Normal Balance | Plain-English Meaning (What Does This Bucket Represent?) |
| :--- | :--- | :--- |
| **1. `TREASURY`** | **Debit (Asset)** | **Real Cash in Our Company Bank Account** (plus instant first-party NeomPay settlements). This is the actual money available to wire out when merchants request a Cash-Out. |
| **2. `GATEWAY_CLEARING`** | **Debit (Asset / Receivable)** | **Money a Gateway Owes Us (`T+N` Pending Settlement).** When a customer pays `100 LYD` via Moamalat or DPay today, the gateway holds that cash for 1–3 days before wiring it to our bank. Each gateway + environment + credential set has its own `GATEWAY_CLEARING` account so we know *exactly* how much each partner owes us at any second! |
| **3. `COMMISSION_RECEIVABLE`** | **Debit (Asset / Receivable)** | **Commission a `MERCHANT_DIRECT` Merchant Owes Us.** When a merchant uses their own gateway credentials, the `100 LYD` goes straight to the merchant's bank, so the merchant owes us our `3 LYD` software commission. |
| **4. `PROVIDER_FEE_EXPENSE` / `GATEWAY_FEE_EXPENSE`** | **Debit (Expense)** | **What the Upstream Bank/Gateway Charged Us** to process the transaction (e.g., `0.80 LYD`). |
| **5. `MERCHANT_WALLET`** | **Credit (Liability)** | **Money We Owe to a Specific Merchant.** Every merchant wallet on the portal is backed 1-to-1 by a `MERCHANT_WALLET` GL account. Its balance is computed directly from the ledger lines. |
| **6. `PLATFORM_INCOME`** | **Credit (Revenue)** | **Our Company's Gross Commission Revenue** earned on confirmed payments (e.g., `3.00 LYD`). |
| **7. `GATEWAY_FEE_ACCRUAL`** | **Credit (Liability)** | **Estimated Gateway Fees Waiting for the Bank Statement.** At the moment a `100 LYD` payment confirms on a T+N gateway, we estimate the gateway will take `0.80 LYD` fee when they wire us the money tomorrow. We hold `0.80 LYD` in `GATEWAY_FEE_ACCRUAL` until tomorrow's statement arrives and clears it. |
| **8. `AML_HOLD`** | **Credit (Escrow Liability)** | **Frozen Money Under Compliance Investigation.** When a payment triggers an AML Hold rule, the money is **not** credited to the Merchant Wallet and **not** counted as Platform Income yet—it sits frozen in `AML_HOLD` until the `MLRO` approves Release or Void. |
| **9. `CHARGEBACK_RESERVE`** | **Credit (Escrow Liability)** | **Disputed Money Escrowed During a Chargeback.** When a customer disputes a payment at their bank, and Finance approves the dispute reserve, we pull the `97 LYD` from the Merchant Wallet and `3 LYD` from Platform Income into `CHARGEBACK_RESERVE` until the dispute is Won or Lost. |
| **10. `SUSPENSE`** | **Credit (Holding Liability)** | **Unmatched or Duplicate Money Awaiting Operator Resolution.** If a single-use link accidentally gets paid twice (because a late webhook arrived after a second attempt already paid the link), the second payment lands in `SUSPENSE` so it never double-credits the merchant and can be cleanly refunded. |

#### Chapter 8.2: Walking Through a Complete Payment & T+1 Bank Sweep (Interactive T-Account Explorer)
Suppose a customer pays a **`100.0000 LYD`** link (`MERCHANT_ABSORBS` fee bearer, `3%` platform commission = `3.0000 LYD`, gateway fee = `0.8000 LYD` accrued):
1. **Moment 1 — Today at 14:05 (Payment Confirms at Gateway):**
   - `Dr GATEWAY_CLEARING (Moamalat)` = **`100.0000 LYD`** *(Moamalat now owes us 100 LYD)*
   - `Dr GATEWAY_FEE_EXPENSE` = **`0.8000 LYD`** *(We record our 0.80 LYD gateway cost)*
   - `Cr MERCHANT_WALLET` = **`97.0000 LYD`** *(Merchant sees +97.0000 LYD in their wallet)*
   - `Cr PLATFORM_INCOME` = **`3.0000 LYD`** *(We earn 3.0000 LYD gross commission)*
   - `Cr GATEWAY_FEE_ACCRUAL` = **`0.8000 LYD`** *(We expect Moamalat to deduct 0.80 LYD before wiring)*
   - *Check:* Total Debits (`100.8000`) == Total Credits (`100.8000`).
2. **Moment 2 — Tomorrow at 10:00 (We Upload Moamalat's CSV Statement in `/reconciliation` Showing `99.2000 LYD` Wired to Our Bank):**
   - `Dr TREASURY` = **`99.2000 LYD`** *(99.20 LYD real cash lands in our bank)*
   - `Dr GATEWAY_FEE_ACCRUAL` = **`0.8000 LYD`** *(Clears the accrued fee liability)*
   - `Cr GATEWAY_CLEARING (Moamalat)` = **`100.0000 LYD`** *(Moamalat's IOU is now 0.0000 LYD!)*
   - *What if Moamalat actually deducted `0.9000 LYD` fee instead of `0.8000 LYD`?* Our `StatementIngestor` automatically posts a **Fee Variance True-Up (Journal Entry 4)** of `0.1000 LYD` to `GATEWAY_FEE_EXPENSE`!

---

### BOOK 9: Merchant Onboarding, KYB Document Verification & Duplicate Detection (`/join-requests`)

#### Chapter 9.1: The Complete Onboarding Lifecycle (`join_requests`)
When a business applies to use our gateway, their application moves through the `join_requests` state machine:
- `DRAFT` (Merchant is still filling out forms) -> `SUBMITTED` (Merchant clicked Submit; L1 AML Screening runs automatically and SLA timer starts) -> `IN_REVIEW` (Assigned to an Operator/Compliance reviewer).
- From `IN_REVIEW`, you have three choices:
  1. **Request Information (`INFO_REQUESTED`):** If a document is blurry, expired, or missing a page, click **Request Info** and specify which item needs replacement. This **pauses the SLA timer** until the merchant responds!
  2. **Approve (`APPROVED` or `PENDING_CHECKER`):** Under our default `RISK_BASED` Four-Eyes policy (`OD-2`), a second Checker is required whenever: (a) proposed risk tier is `HIGH`, (b) AML screening is not `CLEAR`, (c) any owner is a PEP, (d) the business category is high-risk, (e) expected monthly volume exceeds the threshold, (f) the payout bank account name differs from the legal name, or (g) the applicant matched a duplicate/prior rejection flag.
  3. **Reject (`REJECTED`):** Select an official enumerated `decision_reason_code` (`INCOMPLETE_DOCUMENTS`, `UNVERIFIABLE_BUSINESS`, `PROHIBITED_ACTIVITY`, or `POLICY`).

#### Chapter 9.2: The 7-Point KYB Reviewer Checklist (Preventing Onboarding Fraud)
Before approving any Join Request in `/join-requests`, verify every item below:
1. **Check the Duplicate Detection Banner First:** Did the system flag `DUPLICATE_DOCUMENT` (same `sha256` file hash uploaded by another merchant) or `DUPLICATE_OR_RELATED` (matching Tax ID, Registration No., Owner National ID, Bank IBAN, or Phone from a rejected/suspended merchant)? If flagged, inspect the linked merchant record before proceeding.
2. **Verify Antivirus & File Integrity:** Ensure every `kyb_documents` row shows `av_status = CLEAN` and open the preview to confirm it is a genuine, legible document.
3. **Cross-Check Legal Name, Registration No. & Tax Certificate:** The Arabic legal name on the Commercial Registry (`السجل التجاري`) and Tax Certificate (`شهادة السداد الضريبي`) must match `merchants.legal_name` character-for-character, and `expires_on` must be in the future.
4. **Verify Beneficial Owners (The 25% Rule):** Confirm that every natural person owning `>= 25%` (or exercising control as Director/Signatory) is listed in `beneficial_owners` with a valid National ID/Passport and `screening_status = CLEAR` (or a dispositioned false positive).
5. **Verify Payout Bank Account Ownership:** Open the `BANK_LETTER` document and confirm the IBAN belongs to the **merchant's legal entity name** (not a personal account of an unrelated individual).
6. **Verify Business Activity & Volume Plausibility:** Confirm `expected_monthly_volume` is realistic for the declared `business_category`.
7. **Assign the Appropriate `proposed_risk_tier` (`LOW`, `STANDARD`, `HIGH`).**

---

### BOOK 10: The 7-Layer AML & Compliance Program, Screening Dispositions & CBL Reporting (`/aml/*`)

#### Chapter 10.1: How Our 7 AML Layers Work Together
1. **Layer 1 (Onboarding Screening):** Screens the merchant entity and all Beneficial Owners against Sanctions, PEP, Adverse Media, and Internal Watchlists upon Join Request submission. **Fail-Closed Rule:** If the screening provider is down (`result = ERROR`), the system blocks approval (`503 SCREENING_UNAVAILABLE`) until screening succeeds.
2. **Layer 2 (Periodic & List-Update Re-Screening):** Automatically re-screens active merchants when watchlists update or on their tier schedule.
3. **Layer 3 (Hot-Path Transaction Posture Check):** Runs inside the checkout initiation guard in `< 5ms` against local watchlists, merchant status, and fast `aml_rules`.
4. **Layer 4 (Confirmation-Time & Batch Monitoring):** Evaluates `SINGLE_AMOUNT`, `CUMULATIVE_WINDOW` (aggregating across all links/apps of a subject so splitting a sale across 5 links never evades a threshold—Edge Case 125!), `STRUCTURING` (clustering payments just below a threshold), and `MERCHANT_DIRECT_AMOUNT`.
   - **Correlated Escalation Rule:** If a payment triggers both a Velocity `FLAG` rule and an AML rule on the same attempt, case severity automatically escalates to **`CRITICAL`** (4-hour SLA).
5. **Layer 5 (Case Management — `/aml/cases`):** Compliance analysts (`COMPLIANCE`, Maker) investigate and propose **Release (`RELEASED`)**, **Void & Refund to Payer (`REJECTED_VOID`)**, **Freeze (`FROZEN`)**, or **Escalate to STR (`ESCALATED_STR`)**. Only the **`MLRO`** (Checker) can approve the resolution, which atomically posts the `AML_RELEASE` or `AML_VOID` journal entry and finalizes the payment attempt!
6. **Layer 6 (Regulatory Reporting — `/aml/reports`):** Generates `LARGE_TRANSACTION` (LTR), `SUSPICIOUS_ACTIVITY` (STR), and `PERIODIC_RETURN` filings. **Safety Guard (`OD-1`):** A `PROVISIONAL` reporting rule can detect and record internally, but the database refuses to submit a live regulatory filing unless the rule has been promoted to `CONFIRMED` with a written CBL circular reference (`source_reference`).
7. **Layer 7 (No Tipping-Off & 5-Year Retention):** Strictly blocks `AML-CONFIDENTIAL` data from non-compliance staff and merchant notifications, and preserves all audit/ledger records under the 5-year retention policy (`OD-4`).

---

### BOOK 11: Disputes, Chargebacks, Refunds, Cash-Outs & Negative Balance Ceilings

#### Chapter 11.1: How Automated Chargeback Drafting Works (`/disputes` & `/adjustments`)
When an upstream switch (like Moamalat or MPGS) notifies us via webhook or statement that a cardholder disputed a payment:
1. Our system creates a `disputes` row (`UNIQUE(gateway_id, external_dispute_ref)` so duplicate webhooks never draft two chargebacks).
2. If a voluntary refund was already partially issued on that payment earlier, the system automatically caps the chargeback amount to the **unrefunded remainder** (`settled_amount - executed_refunds`, Edge Case 126).
3. The non-human service identity **`SYSTEM_AUTOMATION`** automatically creates a `DRAFT -> PENDING_REVIEW` `CHARGEBACK` Adjustment as the **Maker**.
4. **Human Authorization Required:** `SYSTEM_AUTOMATION` is strictly forbidden from acting as a Checker. No money moves until a human **`FINANCE` Checker** reviews and approves the adjustment in `/approvals`!
5. **What if the Merchant Already Cashed Out Their Wallet?**
   - Each merchant has a `negative_balance_ceiling` (default `0.0000 LYD` for new merchants; adjustable via Maker-Checker).
   - If the chargeback stays within their ceiling, the wallet balance goes negative (Journal Entry 15, e.g., `-57.0000 LYD`), and every future payment the merchant receives automatically nets against that negative balance until it returns to `+0.0000 LYD`!
   - If the chargeback would breach the ceiling, the adjustment is held in `PENDING_REVIEW` and opens a **`P1` Operator Case** so Finance can collect from the merchant or net against pending cash-outs.

#### Chapter 11.2: Safe Refunds (Three-Phase Non-Deadlocking Execution)
When a Finance Checker approves a `REFUND` adjustment on a settled payment:
- **Phase 1 (Claim):** Locks the attempt, verifies that `rail.capabilities.refund` (or `partial_refund`) is supported, verifies `refund_window_days` has not expired, checks `SUM(refunds) + new_refund <= settled_amount`, and sets adjustment state to `EXECUTING`.
- **Phase 2 (Gateway Call):** Executes the gateway's `REFUND` flow over the network with no database lock held open. If the gateway times out, the adjustment safely stays in `EXECUTING` (never double-refunding) until inquiry/reconciliation confirms the outcome.
- **Phase 3 (Finalize):** Once the gateway returns `provider_refund_ref`, posts Journal Entry 9 (or 14 for NeomPay) and marks the adjustment `EXECUTED`.

---

### BOOK 12: Platform Profitability, Liquidity, Solvency & The 12 Go-Live Gates

#### Chapter 12.1: Reading the Profitability & Liquidity Dashboards (`/finance/profitability` & `/finance/liquidity`)
Every number on our Finance dashboards is computed directly from `journal_lines`:
- **Gross Commission Revenue:** Total credits minus debits on `PLATFORM_INCOME` (note: commission on `AML_HOLD` payments is recognized only after the hold is released).
- **Realized Gateway Cost:** Total `PROVIDER_FEE_EXPENSE` + `GATEWAY_FEE_EXPENSE` (including statement fee variance true-ups).
- **Net Revenue:** Gross Commission minus Realized Gateway Cost.
- **Treasury Cover Ratio:** `(TREASURY Balance + GATEWAY_CLEARING Balances) / (MERCHANT_WALLET Balances + AML_HOLD + CHARGEBACK_RESERVE)`.
- **Clearing Ageing Buckets:** Shows how much money sits in `GATEWAY_CLEARING` for `T+0`, `T+1`, `T+2`, and `> settlement_lag_days`. If a gateway has not wired funds past its lag window, follow up with the partner bank before approving large cash-outs.
- **Ledger Invariant Monitor (`/finance/invariant-check`):** Must always read **`0.0000 LYD` drift**. If any drift is detected, automated payouts halt immediately (`Runbook RB-04`).


---

# PART II: THE ADMIN PORTAL A-TO-Z EMPLOYEE ACADEMY & CERTIFICATION LMS (`admin-front/src/pages/academy/index.tsx`)

## 4. LMS Architecture, Role Tracks & Anti-Error Training Design

The Employee Academy (`/academy`) is a full **Learning Management System (LMS)** and **Interactive Operations Flight Simulator** built directly into `admin-front`. Its goal is to take a newly hired employee with **zero background in payments** and train them until they can operate the platform with **zero human error**.

### 4.1 How Employee Progress & Certification Badges Work (`users.academy_progress_json`)

Every employee's progress is persisted in `users.academy_progress_json` via `GET/PUT /api/v1/admin/academy/progress` (and visible to management via `GET /api/v1/admin/academy/progress/overview`):

```ts
export interface EmployeeAcademyProgress {
  completedLessonIds: string[];                 // e.g. ["M1-L1", "M1-L2", "M1-L3", ...]
  completedLabIds: Record<string, {             // e.g. { "LAB-01": { passed: true, attempts: 1, completedAt: "..." } }
    passed: boolean;
    attempts: number;
    mistakesMade: string[];
    completedAt: string;
  }>;
  quizScores: Record<string, {                  // e.g. { "QUIZ-M1": { scorePercent: 100, passed: true, answers: {...} } }
    scorePercent: number;                       // Must score >= 80% (and 100% on critical safety questions) to pass!
    passed: boolean;
    completedAt: string;
  }>;
  earnedBadges: Array<
    | "CERTIFIED_SUPPORT_SPECIALIST"            // Modules 1, 2, 6
    | "CERTIFIED_OPERATIONS_OFFICER"            // Modules 1, 2, 3, 6
    | "CERTIFIED_COMPLIANCE_ANALYST"            // Modules 1, 2, 3, 7
    | "CERTIFIED_FINANCE_CONTROLLER"            // Modules 1, 2, 4, 8
    | "CERTIFIED_GATEWAY_ARCHITECT"             // Modules 1, 2, 5, 6, 8
    | "CERTIFIED_MASTER_OPERATOR"               // All 8 Modules + All 8 Labs + 100% Quiz Mastery
  >;
}
```

### 4.2 Strict Mastery Gate Inside Each Module
In `admin-front/src/pages/academy/index.tsx`, an employee **cannot** simply click "Mark Complete" on a module. To complete each module (`M1` through `M8`), the employee must:
1. Read all **Zero-to-Hero Lesson Tabs** in that module,
2. Complete the **Interactive Hands-On Sandbox Lab** without committing a fatal error (if they commit a fatal error in the simulator—such as marking an `UNKNOWN` payment as `FAILED` without inquiring, or tipping off an AML subject—the simulator triggers a red **"Simulated Production Incident!"** screen explaining the exact real-world damage that mistake would have caused and lets them retry the lab),
3. Score **100% (8 out of 8)** on the module's **Verification Quiz** (with instant feedback explaining why each chosen answer is right or wrong).

---

## 5. Verbatim Content: All 8 Academy Modules, Lessons, Interactive Labs & Quizzes (`modulesTrackA.ts` & `modulesTrackB.ts`)

OpenCode MUST include all 8 modules below verbatim in `admin-front/src/content/academy/`.

---

### MODULE 1 (A–C): Foundations From Zero — How Digital Payments, Links, Slots & Zero-Trust Security Work

#### Lesson M1-L1: The Life of a Payment (Who Are the 4 Players?)
Imagine a customer named **Tariq** wants to pay **`250.000 LYD`** to **Al-Madina Clinic** for a medical checkup.
There are **4 players** in this story:
1. **The Merchant (Al-Madina Clinic):** Uses our **Merchant Portal** to create a digital bill called a **Payment Link** for `250.000 LYD`.
2. **The Payer (Tariq):** Clicks the link on his phone, opening our **Checkout Page**.
3. **Our Platform (The Payment Gateway):** Shows Tariq the available payment methods (**Rails** like Sadad, Edfali, Moamalat Card, LYPay), locks the link so nobody else can pay the same bill at the same time, talks to the bank, and records the accounting entry.
4. **The Upstream Gateway / Bank Switch (e.g., Almadar Sadad or Moamalat National Switch):** The external institution that actually holds Tariq's money and verifies his SMS OTP or card PIN.

#### Lesson M1-L2: Wallets, Applications, Payment Links & The Single-Use Slot Lock
Before a Merchant can create a Payment Link, they set up two building blocks inside their account:
- **A Wallet (`wallets`):** The digital account where the merchant's money accumulates on our platform. Each wallet has a single currency (default `LYD`) and is tied 1-to-1 to a **`MERCHANT_WALLET` General Ledger Account**.
- **An Application (`applications`):** Represents one sales channel of the merchant (for example, *"Clinic Website"*, *"WhatsApp Billing Desk"*, or *"Main Reception POS"*).
  - **Hard Rule:** Every Application is connected to **exactly one Wallet** (`assigned_wallet_id`). Why? So there is never any confusion about which wallet receives the money when a link is paid!

When a customer opens a **Single-Use Payment Link (`use_count = 1`)** and clicks "Pay with Sadad", what stops them from opening the same link on a second phone and paying the same invoice twice?
- **The Atomic Slot Reservation (`active_locked_count`):** The instant Tariq clicks "Pay", our database locks the link row and sets `active_locked_count = 1`.
- Our database enforces the formula: **`confirmed_count + active_locked_count <= use_count`**.
- While Tariq's attempt is in progress (`active_locked_count = 1`), anyone else opening that single-use link sees *"A payment is currently in progress for this link"*.
- The lock is released **only** if Tariq's attempt ends in `FAILED`, `CANCELLED`, or `EXPIRED`. If Tariq's attempt becomes **`UNKNOWN`** (because the bank timed out), the lock stays **HELD** so Tariq cannot accidentally pay twice while we verify with the bank!

#### Lesson M1-L3: Why We Never Trust the Customer's Browser (Zero-Trust Checkout)
In web browsers, customers (or attackers) can change anything on their screen:
- They can modify the URL bar after a redirect to say `?status=success&amount=250.000`.
- They can open the browser's Developer Console (`F12`) and trigger a JavaScript callback like `Lightbox.completeCallback()`.
- They can try to send `"amount": 0.01` in an API request body.

**How our platform defeats all three attacks automatically:**
1. **Checkout Never Accepts Amounts from the Browser:** The `/initiate` and `/confirm` APIs do not even have an `amount` field! `core-back` reads the amount strictly from `payment_links.amount` in the database.
2. **Return URLs and Browser Callbacks Are "Doorbells", Not Proof:** When a browser hits `/return/:token` or `/client-event`, our server transitions the attempt to `VERIFYING` and makes a secure, server-to-server **`VERIFY` (Inquiry)** call directly to the bank's server. Money is posted **only** when the bank's server confirms all **5 Trusted Success Facts** (Status = Success, Our Reference Matches, Settled Amount Matches, Currency Matches, Environment Matches).

#### Interactive Sandbox Lab 1 (`LAB-01`): The Payment & Tamper-Detection Tracer
- **What the Student Sees in the Lab UI:** An interactive 4-column visual simulation showing `[Payer's Browser] -> [checkout-back] -> [core-back + Database] -> [Bank Switch]`.
- **Step 1 Task:** The student clicks **"Start 250.000 LYD Payment"**, observes `active_locked_count` change from `0` to `1`, and must answer what happens when a second browser tab tries to initiate on the same link (*Correct action: Block second tab with `SLOT_RESERVATION_FAILED`*).
- **Step 2 Task (Attack Simulation):** The simulated payer intercepts the browser redirect and changes the URL to `/return/tok_123?status=PAID&amount=250.000` without paying at the bank. The lab asks the student to choose how `core-back` responds:
  - *Option A (Fatal Error):* Mark the attempt `SUCCEEDED` and credit the merchant wallet. *(Triggers red incident screen: "You just credited 250 LYD of fake money from a forged browser URL!")*
  - *Option B (Fatal Error):* Mark the attempt `FAILED` immediately. *(Triggers warning: "A real customer might have paid while their browser query string was stripped!")*
  - *Option C (Correct):* Treat `/return` as an untrusted hint, transition to `VERIFYING`, and run the server-to-server `VERIFY` inquiry against the bank switch.

#### Module 1 Verification Quiz (`QUIZ-M1` — 8 Questions, 100% Required)
1. **Q1:** Why is every Merchant `Application` required by the database schema to have `assigned_wallet_id NOT NULL` (connected to exactly one Wallet)?
   - *A)* To limit merchants to one currency across their entire company.
   - *B)* **Correct:** To eliminate settlement ambiguity so every Payment Link and POS terminal under that Application has a single, deterministic destination Wallet.
   - *C)* Because a Merchant is only allowed to create one Wallet in total.
   - *Explanation:* A Merchant can create multiple Wallets and multiple Applications, but each Application binds to one specific Wallet so the ledger always knows which `MERCHANT_WALLET` GL account to credit.
2. **Q2:** A customer opens a Single-Use Payment Link (`use_count = 1`, `infinite_use = false`), enters their phone number for Sadad, and receives an SMS OTP. At this exact moment, what are `confirmed_count` and `active_locked_count` on the link?
   - *A)* `confirmed_count = 1`, `active_locked_count = 0`
   - *B)* `confirmed_count = 0`, `active_locked_count = 0`
   - *C)* **Correct:** `confirmed_count = 0`, `active_locked_count = 1`
   - *Explanation:* The slot is reserved (`active_locked_count = 1`) at initiation and only moves to `confirmed_count = 1` (releasing `active_locked_count = 0`) when the payment reaches `SUCCEEDED`.
3. **Q3:** While a customer's payment attempt is in `UNKNOWN` status (because the bank timed out during OTP confirmation), what happens to `active_locked_count` on that single-use link?
   - *A)* It is released to `0` so the customer can immediately pay again.
   - *B)* **Correct:** It remains strictly held at `1` until `UNKNOWN` is resolved to either `SUCCEEDED` or `FAILED`.
   - *C)* It increments to `2`.
   - *Explanation:* Releasing the lock while `UNKNOWN` would allow the customer to pay a second time while the first payment might have already succeeded at the bank!
4. **Q4:** Where does `core-back` get the payment amount when a customer initiates a payment from `checkout-front`?
   - *A)* From the JSON body sent by `checkout-front`.
   - *B)* **Correct:** Exclusively from `payment_links.amount` in the database, looked up by `linkKey`.
   - *C)* From a query parameter in the checkout URL.
   - *Explanation:* `checkout-back` and `core-back` never accept amounts or currencies from the client browser (Edge Case 80).
5. **Q5:** When the Moamalat Lightbox JavaScript inside the customer's browser fires `completeCallback()`, what does our server do?
   - *A)* Immediately credits the merchant's wallet.
   - *B)* **Correct:** Treats the browser event as an untrusted hint (`must_inquire = true`), transitions to `VERIFYING`, and calls Moamalat's server-to-server `FilterTransactions` inquiry API.
   - *C)* Ignores the event completely and waits for tomorrow's CSV file.
   - *Explanation:* Browser callbacks can be spoofed via browser developer tools (`T-06`), so they only trigger a server inquiry.
6. **Q6:** Which service in our 7-project architecture is the **only** service that holds the PostgreSQL 18 database connection and `KMS_MASTER_KEY`?
   - *A)* `admin-back`
   - *B)* `checkout-back`
   - *C)* **Correct:** `core-back`
   - *Explanation:* `admin-back`, `merchant-back`, and `checkout-back` have zero database drivers or secrets and communicate with `core-back` over mTLS 1.3.
7. **Q7:** What happens if a compromised `checkout-back` server tries to call `/internal/admin/approvals` on `core-back` using its `CN=checkout-back` mTLS client certificate?
   - *A)* `core-back` allows it because the certificate was signed by our internal CA.
   - *B)* **Correct:** `core-back`'s `mtlsGuard` rejects it immediately with `403 FORBIDDEN_SERVICE_IDENTITY` because `CN=checkout-back` is only allowed on `/internal/checkout/*`.
   - *Explanation:* Each edge service's mTLS certificate Common Name (`CN`) is locked to its own internal route namespace.
8. **Q8:** Which five facts must a trusted server confirmation channel verify before `core-back` moves an attempt to `SUCCEEDED`?
   - *A)* Browser IP, User-Agent, Link Key, Merchant Name, and Timezone.
   - *B)* **Correct:** Status is Success, Our Reference matches, Settled Amount matches within route tolerance, Currency matches, and Environment (`SANDBOX` vs `LIVE`) matches.
   - *C)* Only that HTTP status is `200 OK`.

---

### MODULE 2 (D–F): The Four-Eyes (Maker-Checker) Governance Engine & Field Control

#### Lesson M2-L1: Descriptive vs. Sensitive Fields — What Requires Four Eyes?
Not every edit requires a second person. If a merchant fixes a typo in their store's display trade name, making them wait for a Checker would slow down support. However, if someone changes a merchant's **payout bank IBAN**, **commission rate**, **risk tier**, or **application wallet binding**, a single mistake or malicious insider action could misdirect funds.

Therefore, our platform divides every field into two classes:
1. **Descriptive Fields (Direct Edit + Logged in `detail_change_logs`):**
   - Merchant `trade_name`, display logo, POS terminal name/location, application `name` and `business_use_description`.
   - Takes effect immediately, and writes an unchangeable before/after row in `detail_change_logs` so Support can always see who changed what and when.
2. **Sensitive Fields (Strictly Governed by Maker-Checker `approval_requests`):**
   - **Merchant:** `legal_name`, `tax_id`, `registration_no`, `business_category`, `payout_bank_details_json`, `risk_tier`, `kyb_status`, `commission_receivable_ceiling`, `negative_balance_ceiling`.
   - **Application:** `assigned_wallet_id`, `rail_whitelist`, `redirect_domain_allowlist`.
   - **Platform & Money:** All `adjustments` (refunds, chargebacks, manual credits/debits), `commission_profiles`, `velocity_rules`, `aml_rules`, `aml_cases` resolutions, `regulatory_reports`, `gateway_versions` promotions to `LIVE`, and admin `users` authority changes.

#### Lesson M2-L2: Optimistic Concurrency (`base_version`) & Stale Approvals
What happens if Maker 1 proposes changing a Merchant's `risk_tier` when the Merchant record is at `version = 4` (`base_version = 4`), and before a Checker reviews it, another approved request updates the Merchant to `version = 5`?
- When the Checker clicks **Approve** on Maker 1's request, `ApprovalService` compares `base_version (4)` against the Merchant's current version (`5`).
- Because they no longer match, the system **refuses to overwrite the newer record** and returns the request to `DRAFT` (`BASE_VERSION_MISMATCH`) so the Maker can review the updated record first!

#### Interactive Sandbox Lab 2 (`LAB-02`): The Checker Approval Desk Simulator
- **What the Student Sees:** A simulated `/approvals` queue containing **4 pending requests** with full JSON-Patch diffs and attached evidence documents. The student is logged in as Checker `user_finance_02`:
  - **Case 1:** A `payout_bank_details_json` change for *Tripoli Electronics LLC*, where the attached Bank Letter PDF shows the exact new IBAN under *Tripoli Electronics LLC*'s legal name, submitted by Maker `user_op_01`. *(Correct action: **Approve**).*
  - **Case 2:** A `payout_bank_details_json` change where the new account holder name is a personal name (*"Ahmed Al-abidi"*) that does NOT match the company's legal name or any documented resolution. *(Correct action: **Reject** with reason `BANK_ACCOUNT_HOLDER_MISMATCH`).*
  - **Case 3:** A `REFUND` adjustment of `500.0000 LYD` on an attempt whose `settled_amount` was only `50.0000 LYD` (a `10x` decimal typo by the Maker!). *(Correct action: **Reject** — approving triggers a red incident alert explaining `REFUND_EXCEEDS_SETTLED_AMOUNT`).*
  - **Case 4:** An emergency merchant suspension (`mode = EMERGENCY_RATIFICATION`) triggered 3 hours ago after a confirmed sanctions hit, with full screening evidence attached. *(Correct action: **Approve / Ratify**).*

#### Module 2 Verification Quiz (`QUIZ-M2` — 8 Questions, 100% Required)
1. **Q1:** Where is the `checker_user_id != maker_user_id` (Maker cannot be Checker) rule enforced in our platform?
   - *A)* Only by hiding the Approve button in the frontend UI.
   - *B)* **Correct:** In three layers: the frontend UI, the `makerCheckerGuard` / `ApprovalService` in `core-back`, and the `approval_requests_checker_not_maker` trigger inside PostgreSQL 18.
   - *C)* Only in `admin-back`.
2. **Q2:** While a sensitive edit to `applications.assigned_wallet_id` is in `PENDING_REVIEW` waiting for a Checker, which wallet receives money from payments on that application?
   - *A)* Payments are blocked until the Checker decides.
   - *B)* The proposed new wallet.
   - *C)* **Correct:** The currently active wallet; a pending change never alters live behavior until a Checker approves it (`EXECUTED`), and in-flight attempts always stay pinned to the wallet they started with.
3. **Q3:** What happens if a Merchant edits their `payout_bank_details_json` while a `CashoutRequest` is already in `PROCESSING`?
   - *A)* The in-flight cash-out wires money to the unapproved new bank account.
   - *B)* **Correct:** `cashout_requests` snapshots `destination_bank_json` at creation, so the in-flight payout uses the verified snapshot, while the new bank details require Maker-Checker approval and apply only to future cash-outs (Edge Case 111).
   - *C)* The cash-out is automatically deleted.
4. **Q4:** Which of the following actions is allowed to use the `EMERGENCY_RATIFICATION` path (immediate effect by one authorized person, ratified within 24 hours by a second Checker)?
   - *A)* Reinstating a suspended merchant.
   - *B)* Releasing an `AML_HOLD` to a merchant wallet.
   - *C)* **Correct:** Suspending a merchant or tightening a velocity/AML rule (actions that *reduce* risk).
5. **Q5:** What happens if an `EMERGENCY_RATIFICATION` merchant suspension is NOT ratified within its 24-hour window (`ratify_due_at`)?
   - *A)* The merchant automatically becomes `ACTIVE` again after 24 hours.
   - *B)* **Correct:** A `P2` alert pages `MLRO` and management, and the merchant **remains `SUSPENDED`** (fail-safe, never fail-open) until a Checker formally decides (Edge Case 127).
   - *C)* The merchant record is deleted.
6. **Q6:** Can the automated dispute principal (`SYSTEM_AUTOMATION`) ever approve its own drafted `CHARGEBACK` adjustment?
   - *A)* Yes, if the amount is under 100 LYD.
   - *B)* **Correct:** Never. `SYSTEM_AUTOMATION` can only act as a Maker to draft the adjustment into `PENDING_REVIEW`; a human `FINANCE` Checker must authorize every money movement.
7. **Q7:** Why does `approval_requests` store `base_version` when proposing a JSON-Patch edit to a Merchant or Application?
   - *A)* To compress the JSON payload.
   - *B)* **Correct:** To detect if the record was modified by another action while the approval was pending, preventing a stale approval from silently overwriting newer data.
8. **Q8:** Where should a `SUPPORT` agent look when a merchant asks *"What was our application's redirect domain allowlist set to last month?"*
   - *A)* `inbound_events`
   - *B)* **Correct:** `detail_change_logs` (Field Change History), which records every descriptive and sensitive field change with timestamp, actor, old value, and new value.

---

### MODULE 3 (G–I): Merchant Onboarding, KYB Forensics, Beneficial Owners & Duplicate Detection

#### Lesson M3-L1: Step-by-Step Through the `JoinRequest` Lifecycle
1. **Self-Service vs. Admin-Assisted Onboarding:**
   - Most merchants register themselves (`onboarding_channel = SELF_SERVICE`).
   - Sometimes a sales or operations officer helps a large corporate merchant fill out their onboarding package (`ADMIN_ASSISTED`).
   - **Rule (Edge Case 119):** If an operator prepares an `ADMIN_ASSISTED` join request, the system records that operator as the submitter/maker and **bars them from acting as the deciding reviewer or checker** on that request!
2. **How Document Upload Forensics Work (`kyb_documents`):**
   - **Magic-Byte Inspection:** When a file is uploaded, our server inspects the actual binary header bytes (`%PDF-`, `\x89PNG`, `\xFF\xD8\xFF` for JPEG)—never trusting the `.pdf` or `.png` filename extension alone (`415 UPLOAD_SIGNATURE_MISMATCH`).
   - **Cross-Merchant SHA-256 Hash Indexing:** The system computes a 64-character `sha256` fingerprint of every file. If Merchant B uploads the exact same file that Merchant A uploaded, the reviewer screen lights up with a **`DUPLICATE_DOCUMENT`** warning badge (Edge Case 120).
3. **Beneficial Owners & The 25% Threshold (`beneficial_owners`):**
   - Every natural person who owns **`25%` or more** (`aml.owner_threshold_percent`) or exercises control (`DIRECTOR`, `SIGNATORY`, `CONTROLLER`) must be declared and screened.
   - If a beneficial owner is added or edited *after* the join request was submitted, the system automatically triggers a new AML screening, invalidates any pending approval, and returns the request to `IN_REVIEW` (Edge Case 121).

#### Interactive Sandbox Lab 3 (`LAB-03`): The KYB & Fraud Detection Desk
- **What the Student Sees:** Three submitted `join_requests` in a simulated reviewer console:
  - **Applicant A (*Al-Waha Pharmacy*):** Clean Commercial Registry, valid Tax Certificate, 2 owners (60% / 40%) with `CLEAR` screening, Bank Letter matching *Al-Waha Pharmacy*, `LOW` risk. *(Correct action: Complete 7-point checklist & **Approve**).*
  - **Applicant B (*Desert Star Trading*):** Commercial Registry expired 8 months ago, and the Tax Certificate scan is illegible/blurry. *(Correct action: Click **Request Info (`INFO_REQUESTED`)**, selecting `COMMERCIAL_REGISTRY` and `TAX_CERTIFICATE`, which pauses the SLA timer).*
  - **Applicant C (*Barqa Express Electronics*):** System displays a red `DUPLICATE_DOCUMENT` badge on the Commercial Registry PDF (matching a merchant rejected last week for prohibited activity) and a `DUPLICATE_OR_RELATED` match on the owner's National ID. *(Correct action: **Reject** with code `PROHIBITED_ACTIVITY` / `POLICY` and flag for Compliance).*

#### Module 3 Verification Quiz (`QUIZ-M3` — 8 Questions, 100% Required)
1. **Q1:** What happens to the review SLA timer (`sla_due_at`) when a reviewer moves a Join Request to `INFO_REQUESTED`?
   - *A)* It keeps ticking and breaches SLA if the merchant is slow.
   - *B)* **Correct:** The SLA clock pauses while waiting for the applicant and is recomputed when the applicant submits the requested information.
   - *C)* The Join Request is deleted.
2. **Q2:** Under the default `RISK_BASED` Four-Eyes policy (`OD-2`), which of the following Join Requests requires a **second Checker** (`four_eyes_required = true`)?
   - *A)* A `LOW` risk pharmacy with `CLEAR` screening, no PEP owners, and a matching bank letter.
   - *B)* **Correct:** Any request where proposed risk is `HIGH`, screening is not `CLEAR`, an owner is a PEP, expected volume exceeds the threshold, payout bank ownership differs, or a duplicate/prior-rejection flag fired.
   - *C)* No Join Requests ever require a second Checker.
3. **Q3:** What happens if the AML Screening Provider is temporarily unreachable (`result = ERROR`) when an applicant submits their Join Request?
   - *A)* The system approves the merchant anyway and screens them next month.
   - *B)* **Correct:** The system fails **closed** (`503 SCREENING_UNAVAILABLE`), blocks approval, keeps the request in `IN_REVIEW`, pauses the SLA with `PROVIDER_OUTAGE`, and retries screening with backoff (Edge Case 124).
   - *C)* The system permanently rejects the merchant.
4. **Q4:** An attacker renames a Windows program `malware.exe` to `tax_certificate.pdf` and uploads it as a KYB document. How does our platform stop it?
   - *A)* It only checks that the filename ends in `.pdf`.
   - *B)* **Correct:** Both `merchant-back` and `core-back` inspect the binary magic bytes of the file (`%PDF-`, PNG, JPEG headers), rejecting the upload immediately with `415 UPLOAD_SIGNATURE_MISMATCH`, in addition to size caps, antivirus scanning (`av_status`), and `nosniff` storage.
5. **Q5:** What triggers a `DUPLICATE_DOCUMENT` alert during KYB review (Edge Case 120)?
   - *A)* Two documents having the same filename `registry.pdf`.
   - *B)* **Correct:** Two unrelated merchants uploading files with the exact same `sha256` cryptographic content hash.
6. **Q6:** If an operator helps a merchant prepare an `ADMIN_ASSISTED` Join Request, can that same operator approve the Join Request?
   - *A)* Yes, if the merchant is `LOW` risk.
   - *B)* **Correct:** No. The operator who prepared the request is recorded as the Maker and is barred from acting as the deciding reviewer or Checker (Edge Case 119).
7. **Q7:** When a Join Request is rejected because of a confirmed AML watchlist match, what reason code is sent in the merchant-facing SMS/email notification?
   - *A)* `"Rejected due to CBL AML Watchlist Hit on Owner X"`
   - *B)* **Correct:** The neutral code `POLICY` (never disclosing AML/Sanctions/PEP screening details, enforcing the strict No-Tipping-Off rule).
8. **Q8:** What happens when an active merchant's required KYB document passes its `expires_on` date?
   - *A)* Nothing; KYB documents are only checked once at signup.
   - *B)* **Correct:** The system sends `KYB_DOC_EXPIRING` warnings 30 and 7 days prior, marks the document `EXPIRED` on the date, and automatically suspends the merchant (`KYB_EXPIRED`) if unrenewed past the 30-day grace window.

---

### MODULE 4 (J–L): Double-Entry Accounting From Scratch, Fee Bearers, T+N Clearing & Statement Reconciliation

#### Lesson M4-L1: The 3 Fee Bearers & How Every Dinar Is Accounted For
Let's compare a **`200.0000 LYD`** Payment Link with a **`2.5%` Platform Commission (`5.0000 LYD`)** and a **`1.0000 LYD` Accrued Gateway Fee** across all three `FeeBearer` modes:

| Fee Bearer Mode | What the Customer Sees & Pays (`total_charged_amount`) | What the Merchant Wallet Receives (`net_merchant_amount`) | Our Platform Income (`PLATFORM_INCOME`) | Journal Lines Posted at Confirmation (Template 2 / 5 / 5b) |
| :--- | :--- | :--- | :--- | :--- |
| **`MERCHANT_ABSORBS`** | Pays **`200.0000 LYD`** | Receives **`195.0000 LYD`** | **`5.0000 LYD`** | `Dr GATEWAY_CLEARING 200.0000`<br>`Dr GATEWAY_FEE_EXPENSE 1.0000`<br>`Cr MERCHANT_WALLET 195.0000`<br>`Cr PLATFORM_INCOME 5.0000`<br>`Cr GATEWAY_FEE_ACCRUAL 1.0000` |
| **`PAYER_SURCHARGE`** | Pays **`205.0000 LYD`** (`200 + 5 fee`) | Receives **`200.0000 LYD`** | **`5.0000 LYD`** | `Dr GATEWAY_CLEARING 205.0000`<br>`Dr GATEWAY_FEE_EXPENSE 1.0000`<br>`Cr MERCHANT_WALLET 200.0000`<br>`Cr PLATFORM_INCOME 5.0000`<br>`Cr GATEWAY_FEE_ACCRUAL 1.0000` |
| **`SPLIT` (50/50)** | Pays **`202.5000 LYD`** (`200 + 2.50 fee`) | Receives **`197.5000 LYD`** | **`5.0000 LYD`** | `Dr GATEWAY_CLEARING 202.5000`<br>`Dr GATEWAY_FEE_EXPENSE 1.0000`<br>`Cr MERCHANT_WALLET 197.5000`<br>`Cr PLATFORM_INCOME 5.0000`<br>`Cr GATEWAY_FEE_ACCRUAL 1.0000` |

#### Lesson M4-L2: How Statement Reconciliation (`/reconciliation`) Closes the Loop
When the gateway wires money to our bank account and sends us their daily CSV/XLSX/JSON settlement file, `StatementIngestor` matches every row against `payment_attempts` and assigns one of **5 Reconciliation Results**:
1. **`MATCHED`:** Reference and amount match! Posts the `SETTLEMENT_SWEEP` journal entry (`Dr TREASURY + Dr GATEWAY_FEE_ACCRUAL / Cr GATEWAY_CLEARING`), plus a `FEE_VARIANCE` entry if the gateway's actual fee differed from our accrued estimate.
2. **`AMOUNT_MISMATCH`:** Reference matches, but the gateway statement shows `98.0000 LYD` instead of `100.0000 LYD`. Opens an `AMOUNT_MISMATCH` `OperatorCase`.
3. **`MISSING_AT_GATEWAY`:** Our database says the attempt `SUCCEEDED` 3 days ago, but it is missing from the gateway's settlement statement! Opens a high-priority case to investigate with the partner bank.
4. **`MISSING_LOCALLY`:** The gateway statement says they collected `100.0000 LYD` from a customer (perhaps our server was down when their webhook fired and the attempt was stuck in `UNKNOWN` or `EXPIRED`!). Opens an `OperatorCase` so we can reconcile and credit/refund properly.
5. **`DUPLICATE`:** The same transaction appeared twice on the statement.

#### Interactive Sandbox Lab 4 (`LAB-04`): T-Account Balancing & Statement Reconciliation Lab
- **Part A (Journal Entry Builder):** The student is given 3 business events (1: A `100 LYD` `PAYER_SURCHARGE` confirmation with `3%` commission and `0.80 LYD` accrued fee; 2: The T+1 bank settlement sweep where the gateway actually charged `0.90 LYD` fee; 3: A `100 LYD` `MERCHANT_DIRECT` payment with `3%` commission) and must build the exact Debit and Credit lines until the live balance indicator turns green (`SUM(DEBIT) == SUM(CREDIT)`).
- **Part B (Reconciliation Desk):** The student inspects a 5-row uploaded gateway statement containing 3 `MATCHED` rows, 1 `MISSING_LOCALLY` row (corresponding to a local `UNKNOWN` attempt!), and 1 `AMOUNT_MISMATCH` row, and executes the proper resolution for each.

#### Module 4 Verification Quiz (`QUIZ-M4` — 8 Questions, 100% Required)
1. **Q1:** Why is floating-point math (`Float`, `Double`, `parseFloat`) strictly banned across our entire database and codebase in favor of `DECIMAL(18,4)` / `decimal.js`?
   - *A)* Because `DECIMAL(18,4)` uses less disk space.
   - *B)* **Correct:** Because binary floating-point numbers cannot represent decimal fractions like `0.1 + 0.2` or Libyan Dirham thousandths (`0.005 LYD`) exactly, which would cause penny/dirham drift in the Double-Entry Ledger.
2. **Q2:** When a customer pays `100.0000 LYD` on a `MERCHANT_DIRECT` route (using the merchant's own DPay credentials) with a `3%` platform commission, what journal entry is posted at confirmation?
   - *A)* `Dr TREASURY 100 / Cr MERCHANT_WALLET 97 / Cr PLATFORM_INCOME 3`
   - *B)* **Correct:** `Dr COMMISSION_RECEIVABLE 3.0000 / Cr PLATFORM_INCOME 3.0000` (because the `100 LYD` went directly to the merchant's own bank account and never touched our platform).
3. **Q3:** What happens automatically if a `MERCHANT_DIRECT` merchant's unpaid `COMMISSION_RECEIVABLE` balance exceeds their `commission_receivable_ceiling` (Edge Case 48)?
   - *A)* Their merchant account is permanently deleted.
   - *B)* **Correct:** The guard pipeline automatically pauses their direct routes (`CEILING_EXCEEDED_PAUSE`) and nets the receivable against any platform-held wallet balance until paid.
4. **Q4:** Why does a `neompay` (`kind = INTERNAL`) payment debit `TREASURY` directly at confirmation instead of `GATEWAY_CLEARING` (Ledger Rule INTERNAL-1)?
   - *A)* Because NeomPay does not charge commissions.
   - *B)* **Correct:** Because NeomPay is our first-party internal wallet ledger, so the payer's debit and our Treasury credit happen instantaneously inside our own operator-controlled ledger with zero external bank clearing delay.
5. **Q5:** When an payment is placed on `AML_HOLD` at confirmation (Journal Entry 7), when is the `3.0000 LYD` platform commission credited to `PLATFORM_INCOME`?
   - *A)* Immediately at confirmation.
   - *B)* **Correct:** Only if and when the `MLRO` Checker approves releasing the hold (`AML_RELEASE`). While held, the full `100.0000 LYD` sits in `AML_HOLD` so profitability reports never overstate revenue on frozen funds.
6. **Q6:** What happens if an operator accidentally uploads the exact same daily CSV bank statement file twice in `/reconciliation`?
   - *A)* Every transaction is swept into `TREASURY` twice.
   - *B)* **Correct:** `reconciliation_runs.file_hash` (`UNIQUE` SHA-256 hash of the file) detects the duplicate upload immediately and makes it a harmless no-op.
7. **Q7:** How is a Merchant Wallet's live balance calculated by `CheckpointService`?
   - *A)* By reading a mutable `balance` column on the `wallets` table.
   - *B)* **Correct:** By taking the linked `gl_accounts.checkpoint_balance` and adding `SUM(journal_lines posted after last_checkpoint_id)`.
8. **Q8:** What does the platform do automatically if `/finance/invariant-check` detects even `0.0010 LYD` of unexplained ledger drift?
   - *A)* Ignores it if it is less than 1 Dinar.
   - *B)* **Correct:** Fires a `P1` alert and immediately halts automated merchant cash-out payouts (`Runbook RB-04`) until Finance reconciles the drift.

---

### MODULE 5 (M–P): The Universal Rail Engine, 8-Step Gateway Wizard & Smart AI Importer

#### Lesson M5-L1: Mastering the 8-Step Wizard & Save-Time Safety Guards
When configuring a Gateway Version in `/gateways/wizard/:id`, the save-time validator enforces strict engineering rules so you cannot accidentally build an unsafe integration:
1. **The `MOVES_MONEY` Retry Rule:** Any `FlowStep` with `side_effect = MOVES_MONEY` (such as confirming an OTP in `SUBMIT` or sending a `REFUND`) **must** have `retry_policy = NEVER` (unless `supports_idempotency_key = true` and `idempotency_config` is configured and proven).
2. **The Weak-Channel Inquiry Rule:** Any `ConfirmationChannel` using `RETURN_URL`, `BROWSER_CALLBACK`, `IP_ONLY`, or `SHARED_TOKEN` **must** have `must_inquire = true` (forcing the engine to run the `VERIFY` inquiry flow before trusting the event).
3. **The Host-Pinned Credential Rule (Safeguard 11):** Every URL in `base_urls` and `flow_steps` must use `https://` and its hostname must be listed in `gateway_environments.allowed_hosts`. If someone changes a flow step URL to an unlisted external domain, the engine refuses to attach any secrets from `credential_sets`!
4. **The Unmapped Money-Step Rule:** In `StatusRule`, if a `MOVES_MONEY` step receives a response that matches **none** of your status rules, the engine transitions the attempt to **`UNKNOWN`** (never `FAILED`).

#### Interactive Sandbox Lab 5 (`LAB-05`): Build & Verify a Two-Step OTP Rail + Moamalat Hex-HMAC Profile
- **What the Student Does in the Lab:**
  1. Configures a 2-step `OTP_PULL` flow (`INITIATE` `/verify` extracting `result.process_id -> STATE.process_id`, and `SUBMIT` `/confirm` sending `STATE.process_id + CUSTOMER_FIELD.otp + ATTEMPT.gateway_reference`). If the student leaves `retry_policy = SAFE` on the `SUBMIT` step, the validator catches it and explains why `MOVES_MONEY` requires `retry_policy = NEVER`.
  2. Configures a Moamalat `CryptoProfile`: selects `HMAC_SHA256`, `SORTED_KEY_VALUE_AMP`, `HEX_UPPER`, and switches `secret_key_encoding` from `UTF8` to **`HEX`** so the test vector signature matches the official Moamalat sample!

#### Module 5 Verification Quiz (`QUIZ-M5` — 8 Questions, 100% Required)
1. **Q1:** Why must `secret_key_encoding` be set to `HEX` (not `UTF8`) when configuring a `CryptoProfile` for the Moamalat National Switch?
   - *A)* Because Moamalat uses RSA keys.
   - *B)* **Correct:** Because Moamalat issues its `MerchantSecretKey` as a hexadecimal string that must be decoded into raw binary bytes before computing `HMAC-SHA256`.
2. **Q2:** What transform pipeline converts a `10.5000 LYD` payment link amount into the `"10500"` integer Dirham string expected by Moamalat?
   - *A)* `round(NEAREST, 2) |> format_decimal(2)`
   - *B)* **Correct:** `scale(1000) |> to_int |> to_string`
3. **Q3:** In a 2-step `OTP_PULL` flow (like Edfali or Sadad), `INITIATE` Step 1 receives a `process_id` from the gateway that will be needed later in `SUBMIT` Step 1, but should NOT be exposed to the customer's browser. What should `store_as` be set to on that `StepOutput`?
   - *A)* `PUBLIC`
   - *B)* **Correct:** `STATE` (which encrypts it inside `payment_attempts.context_ciphertext` on the server).
4. **Q4:** When using the **Smart AI Integration Importer (`/gateways/ai-import`)**, what must you NEVER paste into the external AI chat?
   - *A)* The bank's sample JSON responses.
   - *B)* **Correct:** Real `LIVE` API keys, passwords, or HMAC secrets (give the AI only the credential field *names*; enter real secrets in Step 3 inside our portal after upload).
5. **Q5:** What happens if an admin edits a gateway's flows while 40 customers are currently in the middle of paying on that gateway?
   - *A)* Those 40 customers fail immediately.
   - *B)* **Correct:** Every `payment_attempts` row pins `gateway_version_id` at creation, and admin edits always create a new `DRAFT` `GatewayVersion`, so all 40 in-flight attempts finish on the exact version they started with (Edge Case 68).
6. **Q6:** When classifying gateway error codes in `ErrorMap`, why is it critical to classify customer errors (`RETRYABLE_OTP`, `LIMIT_EXCEEDED`, `TERMINAL_DECLINE` for insufficient funds) with `counts_toward_breaker = false`?
   - *A)* So customers don't see an error message.
   - *B)* **Correct:** So that customers typing wrong OTPs or having empty bank accounts never trip the route's Circuit Breaker (`OPEN_BREAKER`) and shut down the rail for everyone else!
7. **Q7:** Can a `StepParameter` on the **first step** (`order_index = 0`) of a flow use `source = PREVIOUS_RESPONSE`?
   - *A)* Yes, it reads the request headers.
   - *B)* **Correct:** No; there is no previous step response on step 0, and the save-time semantic validator rejects it immediately.
8. **Q8:** What sensitivity level must be assigned to a `RailField` that collects a 7-digit MobiCash or 9-digit OnePay transaction card number?
   - *A)* `NORMAL`
   - *B)* **Correct:** `PAN` (which holds the value in memory only for the single outbound call, never writes it to `context_ciphertext` or logs, and requires a PCI scope review—Gate 10).

---

### MODULE 6 (Q–S): Handling `UNKNOWN` Payments, Outages, Circuit Breakers & Runbooks `RB-01`–`RB-05`

#### Lesson M6-L1: Point of No Return & Why `UNKNOWN` Is Our Most Important Safety Net
Let's trace the difference between a failure **before** the Point of No Return (`INITIATE`) and a failure **at or after** the Point of No Return (`SUBMIT`):
- **Case A — Gateway Fails at `INITIATE` (Before Point of No Return):**
  - Customer clicks "Pay with Edfali". Our server tries to call our primary route (`plutu`), and Plutu's server returns `503 Service Unavailable`.
  - Because no OTP was sent and no money could possibly have moved yet, our engine **transparently fails over** within milliseconds to our backup route (`edfali_direct`), sends the OTP through BCD Bank, and the customer never even notices Plutu was down!
- **Case B — Gateway Times Out at `SUBMIT` (At Point of No Return — `MOVES_MONEY`):**
  - Customer received their OTP, typed `482910`, and clicked Confirm. Our server sent the debit call to the bank, and after 15 seconds (`timeout_ms`), the bank hadn't replied.
  - Did the bank take the customer's `250 LYD` right before the connection dropped, or did the request never reach them? **We do not know.**
  - Therefore, our engine moves the attempt to **`UNKNOWN`**, keeps the link slot locked (`active_locked_count = 1`), shows the customer *"We are confirming your payment with the bank—please do not pay again"*, starts background `PollWorker` inquiries, and opens an **`OperatorCase`** in `/operator-cases`.

#### Interactive Sandbox Lab 6 (`LAB-06`): Incident & `UNKNOWN` Queue Simulator
- **What the Student Resolves in the Lab:**
  1. **Ticket 1 (`UNKNOWN` on LYPay — Supports Inquiry):** Student clicks **"Inquire Gateway Now"**, inspects the `VERIFY` response (`status: "Confirmed", provider_ref: "LYP-99201", amount: "250.000"`), and watches the attempt transition to `SUCCEEDED` and post the ledger entry.
  2. **Ticket 2 (`UNKNOWN` on Edfali Direct — No Inquiry API):** The "Inquire" button is disabled because Edfali direct has no inquiry endpoint. The student must upload the daily Edfali CSV statement (or verify the `provider_reference` from the bank statement preview) before proposing a Maker-Checker resolution—if the student tries to click "Force Mark Failed Without Evidence", the simulator blocks them and explains why that could double-charge the customer!
  3. **Ticket 3 (`P1 CONFLICT` on MyPay):** Webhook said `PAID`, but Inquiry returned `FAILED`. The student inspects the raw `inbound_events` log vs `attempt_step_logs`, verifies against the settlement statement that no funds settled, and submits a Maker-Checker resolution to `FAILED`.

#### Module 6 Verification Quiz (`QUIZ-M6` — 8 Questions, 100% Required)
1. **Q1:** When a `MOVES_MONEY` step (`SUBMIT`) times out after 15 seconds, why does the engine NEVER automatically retry the request (unless cryptographic idempotency is proven)?
   - *A)* To save bandwidth.
   - *B)* **Correct:** Because if the first request actually succeeded at the bank right before the connection timed out, sending a second non-idempotent request could debit the customer's bank account twice!
2. **Q2:** How can an operator safely retire an old Route (`RailRoute`) and move traffic to a new Route without dropping customers who are currently typing their OTPs?
   - *A)* Delete the old Route immediately.
   - *B)* **Correct:** Set the old Route's status to **`DRAINING`**, which stops new attempts from picking it while allowing all in-flight pinned attempts to finish cleanly.
3. **Q3:** What happens when the **only** active Route for a Rail opens its Circuit Breaker (`OPEN_BREAKER`) during a bank outage?
   - *A)* All Payment Links on the platform break.
   - *B)* **Correct:** That single Rail is temporarily hidden from checkout by the Visible Rails Formula while all other healthy Rails on the Payment Link continue working normally, and an alert fires (`RB-01` / Edge Case 53).
4. **Q4:** How does a Route in `OPEN_BREAKER` state test whether the upstream bank has recovered?
   - *A)* By sending real customer money calls through it.
   - *B)* **Correct:** By running periodic half-open read-only `CREDENTIAL_CHECK` or `VERIFY` probes; once healthy probes succeed, the breaker closes back to `HEALTHY`.
5. **Q5:** Before `ExpirySweeperWorker` marks an expired `AWAITING_CUSTOMER` or `VERIFYING` attempt as `EXPIRED`, what must it do first (for any gateway where `supports_status_check = true`)?
   - *A)* Delete the attempt logs.
   - *B)* **Correct:** Execute one final `inquire(attempt)` (`VERIFY` flow) to ensure the customer didn't complete the payment in the final seconds before expiry (Edge Case 1).
6. **Q6:** Why does the webhook inbox stay open for `grace_expires_at` (24 hours by default) even *after* an attempt has transitioned to `EXPIRED`?
   - *A)* Because webhooks are only processed once a week.
   - *B)* **Correct:** Because a customer might approve a push notification or scan a QR code just before expiry while the bank's webhook arrives late; the grace window allows verified late-success recovery (`EXPIRED -> SUCCEEDED` or `SUSPENSE` refund if the link was already paid).
7. **Q7:** If a gateway returns HTTP `200 OK` on a `MOVES_MONEY` step, but the gateway silently renamed its JSON field from `result.tx_id` to `data.transactionId` so our required `PROVIDER_REF` output selector finds nothing, what state does the attempt enter (Edge Case 57)?
   - *A)* `FAILED`
   - *B)* **Correct:** `UNKNOWN` (preserving the raw response text in `attempt_step_logs` and alerting engineering so a real debit is never lost).
8. **Q8:** When an inbound webhook arrives from a gateway with a **valid cryptographic HMAC signature**, but from a new IP address that is not in `inbound_ip_allowlist`, what happens (`Runbook RB-02`)?
   - *A)* The system deletes the gateway.
   - *B)* **Correct:** The event is stored in `inbound_events` (`verified = false`), an unlisted-IP security alert fires (`RB-02`), and once Security confirms the new IP with the partner and updates the allowlist under Maker-Checker, the stored event can be replayed losslessly from the inbox.

---

### MODULE 7 (T–V): The 7-Layer AML Program, Arabic Name Matching, Velocity Rules & No Tipping-Off

#### Lesson M7-L1: Dispositioning Screening Matches & The Arabic Name Challenge
When our `ScreeningProvider` checks a Merchant or Beneficial Owner against Sanctions and PEP lists, it normalizes Arabic script (removing diacritics/tashkeel, unifying `أ إ آ ا` to `ا`, `ة` to `ه`, `ى` to `ي`) and checks both Arabic and Latin transliterations.
Every candidate hit in `aml_screening_matches` must be reviewed by a `COMPLIANCE` analyst and given a disposition:
1. **`FALSE_POSITIVE`:** Common name similarity, but Date of Birth, Nationality, or National ID proves it is a different person. You may toggle **`suppress_future = true`** with a `suppress_until` expiry date so periodic re-screens don't re-alert on the exact same list entry—unless the owner's identifying data changes!
2. **`TRUE_MATCH` / `ESCALATED`:** Genuine match on a PEP or Sanctions list. For a Sanctions match, the merchant is immediately restricted (`SUSPENDED` via emergency path), cash-outs are frozen, and an STR draft is opened for the `MLRO`.

#### Lesson M7-L2: The Strict "No Tipping-Off" Law
Under AML law and CBL regulations, **Tipping-Off**—telling a merchant, beneficial owner, or payer (directly or indirectly) that their payment or account is being held for AML suspicion or that a Suspicious Activity Report (`STR`) is being prepared—is a severe legal violation.
- If a merchant contacts Support asking why a payment is taking time to settle or why their account was suspended, Support (`SUPPORT` role) **cannot even see** the `AML-CONFIDENTIAL` tables (`403 Forbidden`), and all merchant-facing messages use neutral operational wording.

#### Interactive Sandbox Lab 7 (`LAB-07`): Compliance & MLRO Investigation Simulator
- **What the Student Resolves in the Lab:**
  1. **Screening Match 1:** Beneficial Owner *"محمد علي المبروك"* born `1994-05-12` (Libyan National ID verified) matches a PEP list entry with a `78%` name score, but the PEP entry was born in `1952` in another country. *(Correct action: Disposition as `FALSE_POSITIVE` with notes comparing DOB and National ID, and set `suppress_future` for 12 months).*
  2. **AML Case 2 (`CRITICAL` Correlated Escalation):** A merchant declared `expected_monthly_volume = 5,000 LYD` (small stationery shop), but today processed 8 rapid payments of `4,900 LYD` each (`39,200 LYD` total in 2 hours) just below the `5,000 LYD` threshold, triggering both a Velocity `FLAG` and the `STRUCTURING` AML rule! *(Correct action: Propose `ESCALATED_STR` / `FROZEN` for `MLRO` Checker approval, and verify that the merchant notification template contains zero mention of AML/Structuring).*

#### Module 7 Verification Quiz (`QUIZ-M7` — 8 Questions, 100% Required)
1. **Q1:** What happens when a single payment attempt triggers **both** a `FLAG` Velocity Rule and an AML Rule?
   - *A)* Only the Velocity Rule is logged.
   - *B)* **Correct:** Correlated escalation automatically raises the `AmlCase` severity to **`CRITICAL`** (4-hour SLA).
2. **Q2:** A merchant tries to evade a `10,000 LYD` `CUMULATIVE_WINDOW` or `STRUCTURING` AML rule by creating 5 separate `2,500 LYD` Payment Links across 2 different Applications. Does this evade our AML engine (Edge Case 125)?
   - *A)* Yes, because rules only check one link at a time.
   - *B)* **Correct:** No. `AmlRuleEngine` aggregates volume by **subject** (Merchant, Beneficial Owner, and Payer identifier) across all links, applications, and rails within the rolling window.
3. **Q3:** When an AML threshold rule triggers on a **`MERCHANT_DIRECT`** payment (where the customer paid into the merchant's own DPay account), what action does the platform take (Edge Case 67)?
   - *A)* Debits the merchant's personal bank account.
   - *B)* **Correct:** Because the platform never held the principal cash, it executes `CASE_ONLY` (blocks the checkout completion receipt, flags the merchant, and opens an operational `AmlCase` for investigation/reporting without posting a fake `AML_HOLD` journal entry).
4. **Q4:** Who is the required **Checker** to approve resolving an `AmlCase` (`RELEASED` or `REJECTED_VOID`) or submitting a `RegulatoryReport`?
   - *A)* Any `SUPPORT` agent.
   - *B)* The same `COMPLIANCE` analyst who investigated the case.
   - *C)* **Correct:** An **`MLRO`** (Money Laundering Reporting Officer, distinct from the Maker).
5. **Q5:** Can a `RegulatoryReport` be transitioned to `SUBMITTED` if its underlying `ReportingRule` has `status = PROVISIONAL` (`OD-1`)?
   - *A)* Yes, at any time.
   - *B)* **Correct:** Never. The platform refuses to generate a live regulatory filing from a `PROVISIONAL` rule until the rule is promoted to `CONFIRMED` with a written CBL circular reference (`source_reference`) via Maker-Checker.
6. **Q6:** Why does the Notification Template Validator block saving any `MERCHANT` or `PUBLIC` template that references `aml_case` or `screening` variables?
   - *A)* Because those variables are too long for SMS.
   - *B)* **Correct:** To structurally prevent accidental **Tipping-Off** of a merchant or payer under AML investigation.
7. **Q7:** When `RetentionWorker` runs to purge expired personal data after the 5-year regulatory retention window (`OD-4`), what happens to `journal_entries` and `journal_lines`?
   - *A)* They are deleted along with the attempts.
   - *B)* **Correct:** `journal_entries` and `journal_lines` (which contain zero PII) are **strictly excluded from retention deletion** so that historical merchant wallet balances and the `0.0000 LYD` ledger invariant never shift!
8. **Q8:** If a confirmed `FALSE_POSITIVE` screening match has `suppress_future = true`, what happens if the merchant later updates that Beneficial Owner's name or National ID?
   - *A)* The suppression stays active forever.
   - *B)* **Correct:** Changing the subject's identifying data (`input_hash` change) automatically revokes the suppression and triggers a fresh screening.

---

### MODULE 8 (W–Z): Disputes, Chargebacks, Refunds, Negative Balance Ceilings & The 12 Go-Live Gates

#### Lesson M8-L1: Voluntary Refunds vs. Subsequent Chargebacks (Preventing Double Loss)
Suppose a customer paid **`100.0000 LYD`** on a card rail. Two days later, the merchant voluntarily refunded **`40.0000 LYD`** to the customer (`PARTIALLY_REFUNDED`). A week later, the customer's bank sends a `100.0000 LYD` **Chargeback (`DISPUTE_OPENED`)** webhook for that same payment!
- If our system blindly drafted a `100.0000 LYD` chargeback adjustment, the merchant would lose `40 + 100 = 140 LYD` on a `100 LYD` sale!
- **How Our Platform Protects the Merchant (Edge Case 126):** When the dispute arrives, our engine locks the attempt (`SELECT ... FOR UPDATE`), sums all `EXECUTED` and `EXECUTING` refunds (`40.0000 LYD`), and automatically caps the drafted `CHARGEBACK` adjustment to the unrefunded remainder (**`60.0000 LYD`**). If the payment was already 100% refunded, it records the dispute with `NO_CHARGEBACK_DRAFTED` and drafts `0.0000 LYD`!

#### Lesson M8-L2: The 12 Go-Live Gates (`GoLiveGateValidator`)
Neither `activateGatewayVersion` (promoting a draft to `LIVE`) nor `rollbackGatewayVersion` (rolling back to a previous version) can execute unless **all 12 Go-Live Gates** pass against persisted `GatewayVersionEvidence`:
1. **Gate 1:** Four-Eyes Maker-Checker Approval (`checker_user_id != maker_user_id`).
2. **Gate 2:** All 15 Automated Sandbox Scenarios Passed Green.
3. **Gate 3:** Amount Pipeline Contract Test Passed (proving `amount_scale`, `amount_precision`, and `amount_rounding` on wire values).
4. **Gate 4:** Reference Format Contract Test Passed (proving charset and max-length rules).
5. **Gate 5:** Cryptographic Signature Contract Test Passed against captured partner vectors.
6. **Gate 6:** Channel Verification Strength Enforced (`must_inquire = true` on all weak/hint channels).
7. **Gate 7:** Named Rollback Version (`rollback_version_id`) Configured.
8. **Gate 8:** Route Limits, Commission Profile, and Statement Parser Preview Verified.
9. **Gate 9:** Evidence Level `VERIFIED` (or signed executive `risk_acceptance_note` for `HIGH_RISK` gateways; or green staging contract suite for `INTERNAL` NeomPay).
10. **Gate 10:** PCI Scope Review Passed for any rail using a `PAN`-typed field.
11. **Gate 11:** Canary Traffic Plan Configured.
12. **Gate 12:** Route Health Alerts & Runbooks Wired.

#### Interactive Sandbox Lab 8 (`LAB-08`): Dispute Cap, Negative Ceiling & 12-Gate Audit Simulator
- **Part A:** Student processes a dispute on a `200.0000 LYD` payment that already had a `50.0000 LYD` partial refund, verifies the system auto-capped the `CHARGEBACK` draft to `150.0000 LYD`, approves the reserve, uploads merchant delivery evidence, and resolves the dispute as `WON` (verifying Journal Entry 12 releases the reserve back to the merchant wallet and platform income).
- **Part B:** Student inspects a `GatewayVersion` promotion request that is failing Gate 6 (`WEBHOOK` with `IP_ONLY` verification has `must_inquire = false`) and Gate 10 (a 7-digit card field is marked `NORMAL` instead of `PAN`), fixes both settings in the wizard preview, re-runs the gate validator to 12/12 green, and completes graduation!

#### Module 8 Final Graduation Quiz (`QUIZ-M8` — 8 Questions, 100% Required)
1. **Q1:** A `100.0000 LYD` payment had a `30.0000 LYD` partial refund executed yesterday. Today, a `100.0000 LYD` chargeback webhook arrives for that same attempt. What amount does `SYSTEM_AUTOMATION` draft for the `CHARGEBACK` adjustment (Edge Case 126)?
   - *A)* `100.0000 LYD`
   - *B)* **Correct:** `70.0000 LYD` (capped to `settled_amount - executed_refunds` so the total returned never exceeds `100.0000 LYD`).
   - *C)* `0.0000 LYD`
2. **Q2:** Why does our Refund execution use **Three Separate Short Phases** (Phase 1: Claim & set `EXECUTING` -> Phase 2: Call gateway over network with NO DB transaction open -> Phase 3: Finalize journal entry & set `EXECUTED`)?
   - *A)* To make the UI spinner last longer.
   - *B)* **Correct:** To prevent holding a PostgreSQL row lock open during a slow external network call (which would deadlock the database) and to ensure that if the gateway times out, the adjustment stays safely in `EXECUTING` without ever double-refunding.
3. **Q3:** A merchant's wallet balance is `20.0000 LYD` and their `negative_balance_ceiling` is `0.0000 LYD`. What happens when a `100.0000 LYD` chargeback adjustment is reviewed?
   - *A)* The wallet goes to `-77.0000 LYD` anyway.
   - *B)* **Correct:** Because `-77.0000 LYD` would breach their `0.0000 LYD` ceiling, the adjustment is held in `PENDING_REVIEW` and opens a `P1` `OperatorCase` for Finance collection/netting.
4. **Q4:** If a merchant has a permitted negative wallet balance of `-50.0000 LYD` (within their `negative_balance_ceiling` of `200.0000 LYD`), what happens when their next customer pays a `100.0000 LYD` link (`net_merchant_amount = 97.0000 LYD`)?
   - *A)* The merchant can immediately cash out `97.0000 LYD`.
   - *B)* **Correct:** The `+97.0000 LYD` credit automatically nets against the `-50.0000 LYD` balance in the same `MERCHANT_WALLET` GL account, bringing their available balance to `+47.0000 LYD`.
5. **Q5:** Does `POST /gateways/:id/rollback` allow an admin to roll back to an untested `DRAFT` version and bypass the 12 Go-Live Gates?
   - *A)* Yes, rollbacks skip all gates.
   - *B)* **Correct:** Never. Rollback is restricted strictly to a previously `LIVE` / `SUPERSEDED` / `ROLLED_BACK` version and enforces the exact same 12 Go-Live Gates inside the transaction.
6. **Q6:** When a customer initiates a NeomPay payment using a NeomPay Wallet ID (`NP-TTSSSSSSSSSC`), what happens if the payer's wallet belongs to the **same legal entity** as the Merchant (Edge Case 134)?
   - *A)* The payment succeeds with zero commission.
   - *B)* **Correct:** The anti-self-dealing guard (`SELF_PAYMENT_POLICY = BLOCK`) blocks the attempt (`SELF_PAYMENT_NOT_ALLOWED`) so merchants cannot wash fake volume or manufacture artificial transactions.
7. **Q7:** What happens if an attempt is currently under an active **`AML_HOLD`** (`substatus = 'AML_HOLD'`) and the customer clicks Cancel or the `ExpirySweeperWorker` runs?
   - *A)* The attempt is cancelled or expired, and a later AML release still credits the merchant.
   - *B)* **Correct:** Both customer cancel and the expiry sweeper strictly refuse to touch an `AML_HOLD` attempt; only the `MLRO`-approved AML Case resolution can transition it (`SUCCEEDED` on release, `FAILED` on void).
8. **Q8:** When a dispute is finally decided in the merchant's favor (`DisputeStatus = WON`), what Journal Entry does the system post (Journal Entry 12)?
   - *A)* `Dr TREASURY / Cr PLATFORM_INCOME`
   - *B)* **Correct:** `Dr CHARGEBACK_RESERVE 100.0000 / Cr MERCHANT_WALLET 97.0000 + Cr PLATFORM_INCOME 3.0000` (releasing the escrowed funds back to the merchant and restoring platform commission).


---

# PART III: THE MERCHANT ZERO-TO-HERO PORTAL & STORE OPERATIONS GUIDE (`merchant-front/src/pages/guide/index.tsx`)

## 6. Architecture & Role-Based Design of the Merchant Guide

When a store owner (`MERCHANT_ADMIN`), store accountant/manager (`MERCHANT_STAFF`), or cashier (`MERCHANT_CASHIER`) logs into `merchant-front`, they should not need any background in software or banking to run their business safely.

The Merchant Guide (`/guide`) includes:
1. **Role Filter Tabs at the Top:**
   - **All Chapters** | **Business Owner (`MERCHANT_ADMIN`)** | **Store Manager / Accountant (`MERCHANT_STAFF`)** | **In-Store Cashier (`MERCHANT_CASHIER`)** | **Developer (`API Integration` -> Part IV)**.
2. **Interactive "First 5 Steps to Get Paid" Progress Banner:**
   - Automatically checks off as the merchant completes: *(1) Pass KYB Verification -> (2) Create Your First LYD Wallet -> (3) Create Your First Application & Connect Wallet -> (4) Create & Share a Payment Link -> (5) Set Up a POS Screen or API Token*.
3. **Interactive Fee Bearer & Net Settlement Calculator Widget (`MerchantFeeCalculator.tsx`):**
   - Uses `decimal.js` (`Decimal(18,4)`) so merchants can type any link price (e.g., `150.000 LYD`), pick a payment method (e.g., Sadad, Edfali, Moamalat Card, LYPay), and toggle between **`MERCHANT_ABSORBS`**, **`PAYER_SURCHARGE`**, and **`SPLIT`** (with a custom percentage slider) to see to the exact Dirham:
     - **What Your Customer Pays at Checkout**
     - **Platform Commission**
     - **Exact Net LYD Credited to Your Wallet**

---

## 7. Verbatim Content: All 10 Chapters of the Merchant Operations Guide (`merchantOperationsGuide.ts`)

OpenCode MUST include all 10 chapters below verbatim inside `merchant-front/src/content/guide/merchantOperationsGuide.ts`:

---

### CHAPTER M-01: Getting Started — Completing Your KYB Onboarding & Activating Live Payments
**Who this is for:** Business Owners (`MERCHANT_ADMIN`)

#### 1. What Is KYB and Why Is It Required?
Before our platform can collect real money (`LIVE` payments) on behalf of your business and wire payouts to your bank account, Central Bank of Libya (CBL) regulations require us to verify your company's legal identity. This process is called **KYB (Know Your Business)**.
- **Can I test the system while waiting for approval?** **Yes!** While your account status is `PENDING`, you can already use our **Sandbox (Testing) Mode** to practice creating links or testing your website integration with fake test money (`SANDBOX` money never touches real bank accounts). Once our review team approves your application, your status changes to **`ACTIVE`** and live customer payments unlock automatically.

#### 2. Step-by-Step Checklist to Get Approved on the First Try
Open **Onboarding (`/onboarding`)** and complete these three tabs carefully:
1. **Tab 1 — Business Profile & Payout Bank Account:**
   - Enter your **Legal Name in Arabic** (`الاسم القانوني`) exactly as printed on your Commercial Registry (`السجل التجاري`), plus your **Trade Name** (the store name customers see at checkout).
   - Enter your **Commercial Registration Number**, **Tax Number**, and **Expected Monthly Sales Volume in LYD**.
   - **Critical Rule for Your Payout Bank IBAN:** The bank account you enter for Cash-Outs **must be a corporate bank account under your company's legal name** (not a personal account belonging to a friend or employee).
2. **Tab 2 — Beneficial Owners & Signatories (The 25% Rule):**
   - You must list every real person who owns **25% or more** of the company (`OWNER`), plus the company's authorized Director or bank Signatory (`DIRECTOR` / `SIGNATORY`).
   - Enter their full Arabic and English names, Date of Birth, Nationality, and National ID / Passport number accurately.
3. **Tab 3 — Required Documents Upload:**
   - Upload clear, uncropped color scans (`PDF`, `PNG`, or `JPEG`—never rename another file type to `.pdf`, as our security scanner checks the binary file signature):
     - **Commercial Registry (`مستخرج السجل التجاري`)** — Must be valid and not expired.
     - **Tax Certificate (`شهادة السداد الضريبي`)** — Must be valid and not expired.
     - **Articles of Association / Chamber of Commerce (`عقد التأسيس / الغرفة التجارية`)**.
     - **National ID or Passport of Each Beneficial Owner & Signatory**.
     - **Official Stamped Bank Letter (`شهادة حساب مصرفي / IBAN`)** confirming your company's IBAN.
- **What if the reviewer asks for more information (`INFO_REQUESTED`)?**
  - You will receive an SMS and email notification telling you which specific document needs to be replaced (for example, if a scan was blurry). Simply log in, upload the clear replacement document, and click **Resubmit**.

---

### CHAPTER M-02: Understanding Wallets & Applications — How Your Store Is Organized
**Who this is for:** Business Owners & Store Managers (`MERCHANT_ADMIN`, `MERCHANT_STAFF`)

#### 1. What Is a Wallet (`Wallets` -> `/wallets`)?
A **Wallet** is your digital safe inside our platform where money from your customers accumulates in real time (`LYD`).
- Can my company have more than one Wallet? **Yes!** For example, if you run a clinic with two branches (*Tripoli Branch* and *Benghazi Branch*), you can create two separate Wallets so each branch's revenue and monthly accounting statements are kept completely separate.
- **How is my Wallet balance calculated?** Your Wallet balance is not just a simple counter; it is calculated directly from our **Double-Entry Financial Ledger**. Every single dinar added or subtracted has an unchangeable receipt line behind it.

#### 2. What Is an Application (`Applications` -> `/applications`)?
An **Application** represents one sales channel where your customers pay you—for example:
- *"Main Online Store Website"*
- *"WhatsApp & Instagram Customer Billing"*
- *"Downtown Showroom POS Counter"*

#### 3. Why Must Every Application Connect to Exactly One Wallet?
When you create an Application, you select **one Assigned Wallet (`assigned_wallet_id`)**.
- This ensures there is **zero confusion** about where money goes: every Payment Link created under *"Downtown Showroom POS Counter"* automatically deposits its money into the exact Wallet assigned to that Application.
- Multiple Applications can share the same Wallet if you want all your sales channels to pool into one balance.

#### 4. Descriptive Edits vs. Sensitive Edits (Why Some Changes Say "Awaiting Approval")
- If you change your Application's **Display Name** or **Description**, it updates immediately.
- If you change a **Sensitive Security Setting**—such as switching which **Wallet** an Application deposits into, changing its **Allowed Payment Methods (`rail_whitelist`)**, or changing its **Allowed Website Redirect Domains (`redirect_domain_allowlist`)**—our system protects your business from account takeover by placing the change in **`PENDING_REVIEW`**. Your current settings keep working safely while our security team verifies the change.

---

### CHAPTER M-03: Creating Single-Use & Multi-Use Payment Links (`/links`)
**Who this is for:** All Merchant Roles

#### 1. Single-Use Links vs. Multi-Use Links — Which One Should You Choose?
When you click **Create Payment Link** in `/links`, you choose how many times the link can be paid:

| Link Type | Settings | Best Used For | How Our System Protects Your Customer |
| :--- | :--- | :--- | :--- |
| **Single-Use Invoice Link** | `infinite_use = OFF`, `use_count = 1` | Sending a specific bill to one customer over WhatsApp, SMS, or email (e.g., *"Order #4092 — 185.000 LYD"*), or redirecting a customer from your website cart. | **Automatic Slot Lock:** As soon as your customer clicks "Pay" and starts typing their OTP, our system locks the link (`active_locked_count = 1`). Even if they accidentally open the link on two phones at once, the second phone sees *"Payment in progress"* so they can never pay the same invoice twice! Once paid, the link status changes to **`COMPLETED`**. |
| **Multi-Use Fixed-Quota Link** | `infinite_use = OFF`, `use_count = N` (e.g., `25`) | Selling a limited batch of items or event seats (e.g., *"25 Workshop Tickets at 50.000 LYD each"*). | Allows up to `25` simultaneous or sequential payments. Once `confirmed_count` reaches `25`, the link automatically closes (`COMPLETED`). |
| **Infinite-Use Link** | `infinite_use = ON` | A permanent payment QR code on a poster, a standard consultation fee, or a donation link. | Never completes after a single payment; stays **`PENDING` (Open)** until you cancel it or its expiration date (`expires_at`) passes. |

#### 2. Setting a Safe Redirect URL (`redirect_url`)
If you are creating a **Single-Use Link** (`use_count = 1`) for your website and want the customer's browser to automatically return to your website's *"Thank You"* page after paying:
1. First, make sure your website domain (e.g., `shop.yourcompany.ly`) is listed in your Application's **Redirect Domain Allowlist** (`/applications`). We require this allowlist so an attacker can never redirect your customers to a fake phishing site!
2. Enter your full `https://` return URL when creating the link.
3. **Important Security Note for Your Website Team:** Never ship an order just because a customer's browser opened your `redirect_url`! Always verify the payment status via our API or Dashboard first (see Part IV).

---

### CHAPTER M-04: How Commissions & Fee Bearers Work (`MERCHANT_ABSORBS`, `PAYER_SURCHARGE`, `SPLIT`)
**Who this is for:** Business Owners & Store Accountants

Every payment method (Rail) has an agreed **Platform Commission** (for example, `3.0%`). When you create a Payment Link (or set your default preference), you choose **who pays that commission** using the **Fee Bearer (`fee_bearer`)** setting:

1. **`MERCHANT_ABSORBS` (Merchant Pays the Fee — Default):**
   - If your item costs **`100.000 LYD`** and commission is `3.000 LYD`:
   - Your customer sees and pays **`100.000 LYD`**.
   - Your Wallet receives **`97.000 LYD`** net.
2. **`PAYER_SURCHARGE` (Customer Pays the Fee on Top):**
   - If your item costs **`100.000 LYD`** and commission is `3.000 LYD`:
   - Our checkout page transparently shows your customer: *`Amount: 100.000 LYD + Service Fee: 3.000 LYD = Total: 103.000 LYD`*.
   - Your customer pays **`103.000 LYD`**, and your Wallet receives the full **`100.000 LYD`** net!
3. **`SPLIT` (Shared Between You and the Customer):**
   - You choose the split percentage (for example, `50% / 50%`).
   - On a **`100.000 LYD`** link with `3.000 LYD` commission:
   - Your customer pays **`101.500 LYD`**, and your Wallet receives **`98.500 LYD`** net.

*(Use the **Interactive Fee & Net Settlement Calculator** right on this page to test any LYD amount across all three modes!)*

---

### CHAPTER M-05: In-Store Point of Sale (POS) Terminals & Realtime Cashier/Customer Screens (`/pos`)
**Who this is for:** Store Managers & In-Store Cashiers (`MERCHANT_CASHIER`)

If you have a physical shop, pharmacy, clinic, or restaurant, you don't need expensive hardware to accept **LYPay QR, OnePay QR, Sadad, Edfali, MobiCash, Yussor Pay, or NeomPay** at the counter:
1. **Step 1 — Create a POS Terminal (`/pos`):**
   - Click **New POS Terminal**, choose your store Application, and name the counter (e.g., *"Cashier Desk 1 — Main Entrance"*).
2. **Step 2 — Pair a Customer-Facing Screen (`/pos/screen/:code`):**
   - Click **Pair Screen** to generate a unique `screen_code`. Open that screen on a tablet facing the customer (or on your cashier monitor).
   - The screen connects to a **Realtime Live Room** (via Server-Sent Events / WebSockets).
3. **Step 3 — Taking a Payment at the Counter:**
   - When the cashier creates a payment for `45.500 LYD`, the QR code or payment instructions **instantly appear on the customer-facing tablet** with a live countdown timer!
   - The moment the customer scans the QR code in their banking app and confirms, **both the customer screen and the cashier screen turn green (`SUCCEEDED`) in real time**—so the cashier knows immediately that it is safe to hand over the goods!
4. **The 15-Minute Idle Rule & Pending QR Safety (Edge Case 14 & 95):**
   - If a POS tablet sits untouched for 15 minutes, its display session idles for security, and automatically resyncs as soon as the cashier taps reconnect. Even if the tablet's Wi-Fi drops while a customer is scanning a QR code, our server keeps watching the payment and credits your Wallet the moment the bank confirms!
   - If a customer changes their mind and wants to pay cash instead, the cashier clicks **Cancel Pending Payment** on the POS screen before the customer pays.

---

### CHAPTER M-06: Understanding Payment Statuses — When Is It Safe to Hand Over the Goods?
**Who this is for:** Cashiers, Customer Service & Store Managers

> **THE #1 GOLDEN RULE FOR STORE STAFF & CASHIERS:**
> **ONLY hand over goods or mark an invoice paid when the Payment Status in your Merchant Portal or POS Screen is green `SUCCEEDED` (`مكتملة`).**
> Never accept a screenshot of an SMS on a customer's phone as proof of payment if your portal still says `AWAITING_CUSTOMER`, `FAILED`, or `EXPIRED`!

| Status Shown in Portal | What Happened | Should You Deliver the Goods? | What to Tell the Customer |
| :--- | :--- | :--- | :--- |
| **`SUCCEEDED` (Green)** | The bank confirmed the payment and the money is credited to your Wallet. | **YES — Deliver immediately.** | *"Thank you, your payment is confirmed!"* |
| **`AWAITING_CUSTOMER`** | The system sent the SMS code or displayed the QR/Redirect, and is still waiting for the customer to finish. | **NO — Wait.** | *"Please enter the SMS code or approve the notification in your wallet app before the timer ends."* |
| **`VERIFYING` / `UNKNOWN` (Amber)** | The customer submitted their confirmation, and our server is currently verifying the final receipt with the bank switch (or waiting for a slow bank response). | **WAIT until it turns `SUCCEEDED`.** | *"Our system is confirming your payment with the bank right now. **Please do not pay a second time**—your payment reference is saved and will update automatically."* |
| **`FAILED` / `EXPIRED` / `CANCELLED` (Red/Grey)** | No money was taken (wrong OTP 3 times, insufficient funds, customer limit exceeded, or timer ran out). | **NO — Not paid.** | *"The payment did not go through and you were not charged. You can safely try again or choose another payment method."* |

---

### CHAPTER M-07: Reading Your Wallet Balance, Monthly Statements & Requesting Cash-Outs (`/wallets` & `/cashouts`)
**Who this is for:** Business Owners & Accountants (`MERCHANT_ADMIN`)

1. **Requesting a Cash-Out (`/cashouts`):**
   - Click **Request Cash-Out**, select your Wallet, and enter the LYD amount you want wired to your verified corporate bank account.
   - Your request moves through 4 transparent stages:
     - `PENDING` (Submitted by you) -> `PROCESSING` (Being wired by our Finance team to the exact bank IBAN snapshotted when you clicked request) -> `COMPLETE` (Wire sent) -> `SUBTRACTED` (Finalized on your ledger statement).
2. **Downloading Hash-Verified Monthly Statements (`/wallets`):**
   - At the end of every month, you can download your official **Monthly Wallet Statement** (`CSV` or `PDF`), showing:
     - **Opening Balance** (which always equals the exact Closing Balance of the previous month),
     - **Every Confirmed Payment** (Gross Amount, Platform Commission, Net Credited),
     - **Refunds & Dispute Adjustments**,
     - **Cash-Out Payouts**, and
     - **Closing Balance**, sealed with a cryptographic SHA-256 content hash for your auditors.

---

### CHAPTER M-08: Responding to Customer Disputes & Refunds (`/disputes` & `/payments`)
**Who this is for:** Business Owners & Customer Support

1. **What Happens When a Customer Opens a Dispute (Chargeback)?**
   - If a customer claims to their bank that they did not receive their order or did not authorize a card payment, the bank notifies us and a **Dispute (`disputes`)** opens in `/disputes` with a strict **Evidence Deadline (`evidence_due_at`)**.
   - You will receive an immediate email and in-app notification (`DISPUTE_OPENED`).
   - While the dispute is open, the disputed amount is temporarily held in reserve (`CHARGEBACK_RESERVE`).
2. **How to Win a Legitimate Dispute:**
   - Open `/disputes` **before `evidence_due_at`**, click **Upload Evidence**, and attach proof that you delivered the goods or services (signed delivery receipt, customer invoice, shipping log, or service record).
   - If the bank decides the dispute in your favor (**`WON`**), the full net amount is immediately released back into your Wallet!
3. **What if a Chargeback Happens After You Already Cashed Out Your Wallet?**
   - If a chargeback or refund is approved when your Wallet balance is low (and within your approved `negative_balance_ceiling`), your Wallet balance will temporarily show a negative number (e.g., `-45.000 LYD` owed to the platform). You do not need to send a separate wire: your next incoming customer payments will automatically pay down that negative balance until your Wallet is positive again!

---

### CHAPTER M-09: Using Your Own Gateway Credentials (`MERCHANT_DIRECT` Mode — `/credentials`)
**Who this is for:** Enterprise Merchants with Their Own Direct Aggregator/Bank Contracts

By default, your payments use **our platform's master bank connections (`PLATFORM_CLEARING`)**, and we wire your money via Cash-Outs.
However, if your company already has its own direct merchant contract with an aggregator or switch that supports merchant-owned credentials (such as **DPay**), you can plug your own keys into **Credentials (`/credentials`)**:
1. **Write-Only Security:** When you enter your API keys/secrets and click **Save & Verify**, our server encrypts them inside our hardware-backed `Vault` and runs a live **`CREDENTIAL_CHECK`** test call. Once saved, no human being (not even you or our staff) can ever read the secret back—it can only be replaced.
2. **How Money & Commission Work in `MERCHANT_DIRECT` Mode:**
   - Because the gateway is using **your own account**, when a customer pays `100.000 LYD`, the gateway sends that `100.000 LYD` **directly to your company's bank account**!
   - Therefore, our platform **does not credit your Merchant Wallet** for `MERCHANT_DIRECT` payments. Instead, we record our software commission (e.g., `3.000 LYD`) in your **Commission Receivable** balance (`COMMISSION_RECEIVABLE`), which is automatically netted against your platform Wallet balance or settled by invoice.
   - **Important:** Keep your Commission Receivable below your account's `commission_receivable_ceiling`; if unpaid commission exceeds your ceiling, `MERCHANT_DIRECT` routes automatically pause until settled!

---

### CHAPTER M-10: Managing Your Team, Roles, Application Scopes & Security (`/team`)
**Who this is for:** Business Owners (`MERCHANT_ADMIN`)

Never share your owner login password with cashiers or accountants! Instead, open **Team (`/team`)** and invite each staff member with only the permissions they need:
- **`MERCHANT_CASHIER`:** Can only operate assigned in-store POS screens (`/pos`). Cannot see company bank accounts, cannot create API tokens, and cannot request cash-outs.
- **`MERCHANT_STAFF`:** You choose their exact checkboxes (`links.create`, `payments.read`, `stats.read`, etc.) and you can restrict them to **specific Applications (`app_scope_ids`)**—so the manager of *Branch A* can only see links and payments for *Branch A*, never *Branch B*!
- **`MERCHANT_ADMIN`:** Full business owner access (requires mandatory Multi-Factor Authentication `MFA`).

---

# PART IV: THE MERCHANT DEVELOPER & API INTEGRATION GUIDE (`merchant-front/src/pages/guide/developers/index.tsx`)

## 8. Verbatim Content: Complete Zero-to-Production API & Webhook Reference (`merchantDeveloperApiGuide.ts`)

This guide is written so that **both** a junior web developer building their first e-commerce site and a senior backend architect can integrate with our External Merchant API (`/api/v1/external/*`) cleanly and securely on the first try.

---

### DEV CHAPTER D-01: How the API Works From Zero (For Beginners & Architects)
If your company has an online store, mobile app, hospital billing system, or ERP (like Odoo, WooCommerce, Laravel, or a custom Node/Python app), you can automate payment link creation and payment verification so no human has to click buttons in the portal:

```text
1. Customer clicks "Checkout (150.000 LYD)" on Your Website
       │
       ▼
2. Your Backend Server calls:  POST https://merchant.<domain>/api/v1/external/links
   (Using your secret `pg_live_...` Bearer Token + Amount: "150.000")
       │
       ▼
3. Our Platform returns:       { "key": "lnk_01J...", "checkoutUrl": "https://pay.<domain>/pay/lnk_01J..." }
       │
       ▼
4. Your Website sends the Customer to `checkoutUrl` (where they pay with Sadad, Edfali, Moamalat, LYPay, etc.)
       │
       ▼
5. When the Customer finishes, Your Backend Server verifies the truth by calling:
   GET https://merchant.<domain>/api/v1/external/links/lnk_01J...
   (or GET /api/v1/external/payments/:reference) — and ONLY marks the order paid when `state === "COMPLETED"` / `status === "SUCCEEDED"`!
```

---

### DEV CHAPTER D-02: Authentication (`pg_live_` Bearer Tokens) & IP CIDR Allowlists (`/developers/tokens`)

#### 1. Creating Your API Access Token
1. In the Merchant Portal, open **Developers -> API Tokens (`/developers/tokens`)** and click **Create Token**.
2. Select the **Application** this token will belong to, and select the minimum required **Scopes** (`links:create`, `links:read`, `links:cancel`, `payments:read`).
3. Copy your token immediately (it starts with **`pg_live_`** followed by 32 random base64url bytes).
   - **Why can't I view the token again later?** For your security, our database never stores your plaintext token—it stores only a one-way `SHA-256` hash (`token_hash`) and the last 4 characters (`last_four`). If you lose the token, revoke it and create a new one.
4. **NEVER put a `pg_live_` token inside frontend browser JavaScript, a React/Vue bundle, or a mobile APK!** `pg_live_` tokens must only be called from your own backend server.

#### 2. Locking Your Token to Your Server's IP Address (`ip_whitelist_enabled`)
To make a stolen token useless to an attacker, enable **IP Whitelist (`ip_whitelist_enabled = true`)** and add your backend server's static public IP in CIDR notation:
- Single server IP example: `203.0.113.45/32`
- Subnet example: `203.0.113.0/24`
If any request arrives with your token from an IP address outside your CIDR list, our edge and core guards reject it immediately with `403 IP_NOT_ALLOWLISTED`.

---

### DEV CHAPTER D-03: Money Precision Rules & Redirect Allowlists (Avoid These 3 Common Mistakes)

1. **Always Send Amounts as Decimal Strings (Never Floats!):**
   - Libyan Dinars have **3 decimal places (Dirhams)**, and our ledger uses `DECIMAL(18,4)`.
   - Always pass amounts as strings like `"150.000"` or `"76.255"`, **never** JavaScript floats like `150.00000000000003`.
2. **`redirectUrl` Rules:**
   - A custom `redirectUrl` is permitted **only on Single-Use links** (`infiniteUse: false, useCount: 1`).
   - The hostname of `redirectUrl` (e.g., `https://shop.yourcompany.ly/orders/4092/return`) **must** be pre-registered in your Application's `redirect_domain_allowlist` in `/applications`, otherwise link creation will fail with `400 REDIRECT_DOMAIN_NOT_ALLOWED`.
3. **Never Trust the Browser Return Alone:**
   - When the customer's browser lands back on your `redirectUrl`, treat that page load only as a trigger for your backend server to call `GET /api/v1/external/links/:key` (or `GET /api/v1/external/payments/:reference`). Only fulfill the order when our API returns `state: "COMPLETED"` and the attempt `status: "SUCCEEDED"`.

---

### DEV CHAPTER D-04: Complete Endpoint Reference (`/api/v1/external/*`)

#### Endpoint 1: Create a Payment Link — `POST /api/v1/external/links`
- **Required Header:** `Authorization: Bearer pg_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
- **Request Body Schema:**
```json
{
  "applicationId": "0192d4a0-7c10-7000-8000-000000000001",
  "amount": "150.000",
  "currency": "LYD",
  "feeBearer": "MERCHANT_ABSORBS",
  "infiniteUse": false,
  "useCount": 1,
  "redirectUrl": "https://shop.yourcompany.ly/checkout/return?orderId=ORD-9012",
  "railWhitelist": null,
  "expiresAt": "2026-11-01T18:00:00.000Z"
}
```
- **Success Response (`201 Created`):**
```json
{
  "id": "0192d8f0-1122-7000-8000-000000000099",
  "key": "lnk_0192d8f0112270008000000000000099",
  "checkoutUrl": "https://pay.yourdomain.ly/pay/lnk_0192d8f0112270008000000000000099",
  "amount": "150.0000",
  "currency": "LYD",
  "feeBearer": "MERCHANT_ABSORBS",
  "state": "PENDING",
  "confirmedCount": 0,
  "activeLockedCount": 0,
  "expiresAt": "2026-11-01T18:00:00.000Z"
}
```

#### Endpoint 2: Get Link & Attempts Status — `GET /api/v1/external/links/:key`
- Returns the current link `state` (`PENDING | COMPLETED | EXPIRED | CANCELLED`), slot counters (`confirmedCount`, `activeLockedCount`), and the array of attempts with their `reference`, `status`, `railCode`, `requestedAmount`, `surchargeAmount`, `totalChargedAmount`, `platformCommissionAmount`, `netMerchantAmount`, and `terminalAt`.

#### Endpoint 3: Get Single Payment Attempt by Reference — `GET /api/v1/external/payments/:reference`
- Looks up a specific attempt by its unique platform reference (`reference`) and returns its authoritative status and settlement breakdown.

#### Endpoint 4: Cancel an Unpaid Payment Link — `POST /api/v1/external/links/:key/cancel`
- Cancels a `PENDING` link as long as no attempt is currently past the point of no return.

---

### DEV CHAPTER D-05: Copy-Pasteable Production Code Templates (Interactive Code Generator)

The interactive widget in `/guide/developers` pre-fills your selected `applicationId` and generates ready-to-run code in 4 languages:

#### 1. TypeScript / Node.js / Bun
```ts
const PG_BASE_URL = "https://merchant.yourdomain.ly/api/v1/external";
const PG_API_TOKEN = process.env.PG_LIVE_TOKEN!; // pg_live_...

export async function createCheckoutLink(orderId: string, amountLyd: string) {
  const response = await fetch(`${PG_BASE_URL}/links`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PG_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      applicationId: process.env.PG_APPLICATION_ID!,
      amount: amountLyd, // Always pass a decimal string, e.g. "150.000"
      currency: "LYD",
      feeBearer: "MERCHANT_ABSORBS",
      infiniteUse: false,
      useCount: 1,
      redirectUrl: `https://shop.yourcompany.ly/orders/${encodeURIComponent(orderId)}/verify`,
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Payment Gateway Error [${err.code}]: ${err.message}`);
  }
  return (await response.json()) as { key: string; checkoutUrl: string; state: string };
}

export async function isLinkPaidAndConfirmed(linkKey: string): Promise<boolean> {
  const response = await fetch(`${PG_BASE_URL}/links/${encodeURIComponent(linkKey)}`, {
    headers: { "Authorization": `Bearer ${PG_API_TOKEN}` },
  });
  if (!response.ok) return false;
  const link = await response.json();
  return link.state === "COMPLETED" && Number(link.confirmedCount) >= 1;
}
```

#### 2. PHP (Laravel / Guzzle)
```php
<?php
use Illuminate\Support\Facades\Http;

class PaymentGatewayClient {
    public function createSingleUseLink(string $orderId, string $amountLyd): array {
        $response = Http::withToken(config('services.payment_gateway.token'))
            ->acceptJson()
            ->post(config('services.payment_gateway.base_url') . '/links', [
                'applicationId' => config('services.payment_gateway.app_id'),
                'amount'        => $amountLyd, // e.g. "150.000"
                'currency'      => 'LYD',
                'feeBearer'     => 'MERCHANT_ABSORBS',
                'infiniteUse'   => false,
                'useCount'      => 1,
                'redirectUrl'   => route('checkout.verify', ['orderId' => $orderId]),
            ]);

        $response->throw();
        return $response->json();
    }
}
```

#### 3. Python (`httpx` / FastAPI / Django)
```python
import os
import httpx

PG_BASE_URL = "https://merchant.yourdomain.ly/api/v1/external"
PG_TOKEN = os.environ["PG_LIVE_TOKEN"]

async def create_payment_link(order_id: str, amount_lyd: str) -> dict:
    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.post(
            f"{PG_BASE_URL}/links",
            headers={"Authorization": f"Bearer {PG_TOKEN}"},
            json={
                "applicationId": os.environ["PG_APPLICATION_ID"],
                "amount": amount_lyd,
                "currency": "LYD",
                "feeBearer": "MERCHANT_ABSORBS",
                "infiniteUse": False,
                "useCount": 1,
                "redirectUrl": f"https://shop.yourcompany.ly/orders/{order_id}/verify",
            },
        )
        res.raise_for_status()
        return res.json()
```

---

# PART V: OPENCODE IMPLEMENTATION ARCHITECTURE & AUTOMATED CONTENT-COMPLETENESS GATES

## 9. Exact File Structure & Implementation Tasks for OpenCode

OpenCode MUST execute the following tasks in sequence to replace the brief placeholder guide/academy screens with the full Zero-to-Hero systems specified in Parts I–IV:

- [ ] **`ZA-1` Create Verbatim TypeScript Content Modules in `admin-front/src/content/`:**
  - Create `admin-front/src/content/guide/glossaryData.ts` containing all 20+ core glossary items plus all 10 GL Account definitions, 14 AttemptStatus definitions, and 9 Collection Mode definitions in both English and Arabic.
  - Create `admin-front/src/content/guide/booksPart1.ts` (Books 1–6 verbatim from Part I) and `admin-front/src/content/guide/booksPart2.ts` (Books 7–12 verbatim from Part I), including every table, ASCII flow diagram, SOP checklist, and red **"CRITICAL HUMAN ERROR WARNING"** callout.
  - Create `admin-front/src/content/academy/modulesTrackA.ts` (Modules 1–4 verbatim from Part II) and `admin-front/src/content/academy/modulesTrackB.ts` (Modules 5–8 verbatim from Part II), including every lesson tab (`M1-L1`..`M8-L2`), all 8 interactive lab scenarios (`LAB-01`..`LAB-08`), and all 64 quiz questions with per-option explanations (`QUIZ-M1`..`QUIZ-M8`).
- [ ] **`ZA-2` Rebuild `admin-front/src/pages/guide/index.tsx` & `ContextualHelpDrawer.tsx` (`kt-dc` TSX):**
  - Render the 12 Books with a left-hand chapter tree, progress bookmarks, `Ctrl+K` instant search modal (`GlobalGuideSearchModal.tsx`), red human-error warning cards, and the 3 interactive embedded simulators (`TransformPlayground.tsx`, `CryptoSignatureLab.tsx`, and `LedgerTAccountVisualizer.tsx`).
  - Wire `ContextualHelpDrawer.tsx` into the top app bar of `admin-front` so clicking `"Help & SOP (?)"` on any route (`/approvals`, `/join-requests`, `/aml/cases`, `/operator-cases`, `/disputes`, `/reconciliation`, `/gateways/wizard/:id`) opens the exact corresponding Book and SOP checklist for that route.
- [ ] **`ZA-3` Rebuild `admin-front/src/pages/academy/index.tsx` & the 8 Interactive Sandbox Labs (`kt-dc` TSX):**
  - Implement the Role Track selector (`Support`, `Operations`, `Compliance`, `Finance`, `Gateway Architect`, `Master Operator`), the strict sequential mastery gate (Lessons -> Interactive Lab -> 8-Question 100% Quiz), the simulated red **"Production Incident!"** feedback screen when a user clicks an unsafe action in a lab, and automatic progress persistence to `GET/PUT /api/v1/admin/academy/progress`.
- [ ] **`ZA-4` Create Verbatim Merchant Content & Rebuild `merchant-front/src/pages/guide/index.tsx` (`kt-dc` TSX):**
  - Create `merchant-front/src/content/guide/merchantOperationsGuide.ts` (Chapters `M-01` through `M-10` verbatim from Part III) and `merchant-front/src/content/guide/merchantDeveloperApiGuide.ts` (Developer Chapters `D-01` through `D-05` verbatim from Part IV).
  - Render the Role Filter tabs (`Owner`, `Manager/Accountant`, `POS Cashier`, `Developer API`), the "First 5 Steps" interactive checklist, the `decimal.js` **Fee Bearer & Net Settlement Calculator**, and the **Developer API Code Snippet Generator** (TypeScript, PHP Laravel, Python, cURL).
- [ ] **`ZA-5` Add Automated Content-Completeness & Anti-Summarization Verification Suite (`vitest` & `playwright`):**
  - Create `admin-front/src/content/__tests__/content-completeness.test.ts` and `merchant-front/src/content/__tests__/content-completeness.test.ts` asserting:
    1. All **12 Admin Guide Books** are present and each Book's body text is `>= 1,500 characters` with at least 1 SOP checklist and 1 `humanErrorWarning` block,
    2. All **8 Academy Modules** (`M1`..`M8`) are present, each with `>= 2` full lessons, 1 interactive `lab` definition with fatal-error traps, and **exactly 8 quiz questions** (`64 quiz questions total`) where every question has a detailed `explanation`,
    3. All **10 Merchant Operations Chapters (`M-01`..`M-10`)** and **5 Developer API Chapters (`D-01`..`D-05`)** are present in `merchant-front` with complete code templates in all 4 languages,
    4. Both `cd admin-front && bun run test:unit && bun run build` and `cd merchant-front && bun run test:unit && bun run build` pass with zero errors.

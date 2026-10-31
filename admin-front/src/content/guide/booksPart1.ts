import type { GuideBook } from "./types";

export const BOOKS_PART_1: GuideBook[] = [
    {
        "id": "book-1",
        "number": 1,
        "titleEn": "Welcome to the Platform — How Money, Data, and Security Work From Zero",
        "titleAr": "مرحباً بك في المنصة — كيف يعمل المال والبيانات والأمان من الصفر",
        "summaryEn": "A zero-assumption introduction to the business, the seven-service zero-trust architecture, and the boundaries that protect money and customer data.",
        "summaryAr": "مقدمة بلا افتراضات مسبقة عن العمل وهندسة الثقة الصفرية بين الخدمات السبع والحدود التي تحمي المال وبيانات العملاء.",
        "chapters": [
            {
                "id": "book-1-chapter-1.1",
                "number": "1.1",
                "titleEn": "What Does Our Company Actually Do? (From Zero)",
                "bodyEn": "When a customer in Tripoli, Benghazi, or Misrata wants to buy something online or in a store—whether a plane ticket, an electronics order, or a clinic bill—they might want to pay using **Sadad** (Almadar), **Edfali** (Bank of Commerce & Development), **Moamalat** (their local debit card on the National Switch), **LYPay / OnePay** (instant bank QR transfer), **MobiCash**, **T-LYNC**, **MyPay**, or **NeomPay**.\n\nFor an individual store owner (**Merchant**), integrating all 20 of those systems is nearly impossible: each bank speaks a different computer language, uses different mathematical formulas to sign messages, measures Libyan Dinars differently (some in Dinars `10.50`, some in Dirhams `10500`), and settles money on different schedules.\n\n**Our platform solves this completely:**\n1. **One Unified Integration for Merchants:** A Merchant registers once in our **Merchant Portal** (`merchant-front`), passes our legal & compliance checks (**KYB/AML**), and creates a **Payment Link**, connects their website via **API**, or pairs an in-store **POS Screen**.\n2. **One Intelligent Checkout for Customers:** When the customer opens the Payment Link in **Checkout** (`checkout-front`), our system automatically calculates which payment methods (**Rails**) are healthy, allowed, and within limits for that exact amount, and shows a clean Arabic/English screen.\n3. **One Zero-Code Engine Behind the Scenes:** When the customer clicks a Rail (e.g., *Sadad*), our isolated core engine (**`core-back`**) translates the request into Sadad's exact format, verifies the result from a trusted server channel, and records the accounting movement in our **Double-Entry Ledger**.",
                "tags": [
                    "does",
                    "company",
                    "actually",
                    "zero",
                    "customer",
                    "tripoli",
                    "benghazi",
                    "misrata",
                    "wants",
                    "buy",
                    "something",
                    "online",
                    "store—whether",
                    "plane"
                ]
            },
            {
                "id": "book-1-chapter-1.2",
                "number": "1.2",
                "titleEn": "Why Is Our System Split Into 7 Separate Projects? (The Zero-Trust Model)",
                "bodyEn": "If you hear engineers mention `core-back`, `admin-back`, `merchant-back`, or `checkout-back`, here is why our platform is built like a high-security bank rather than a single website:\n\n```text\n[ PUBLIC INTERNET ] ──▶ Checkout Website (checkout-front / checkout-back)   ─┐\n[ PUBLIC INTERNET ] ──▶ Merchant Portal  (merchant-front / merchant-back)   ─┼──▶ (mTLS 1.3 Certificate Lock) ──▶ [ CORE ENGINE & DATABASE (core-back) ]\n[ OFFICE LAN ONLY ] ──▶ Admin Back Office (admin-front / admin-back :8443)  ─┘                                     (Holds All Money, Keys & MySQL DB)\n```\n\n1. **The Public Edge Servers Hold Zero Secrets and Zero Database Access:**\n   - The Checkout server (`checkout-back`) and Merchant server (`merchant-back`) face the public internet so customers and merchants can reach them. Because anything on the public internet can be attacked, those servers **do not have the database password, do not have the database software installed, and do not hold any bank secret keys**.\n2. **The Admin Portal (`admin-front` / `admin-back`) Is Local-Network (LAN) Only:**\n   - The Admin Back Office you are using right now runs on a private office network port (`:8443`) that is blocked from the public internet at the firewall level.\n3. **The Vault (`core-back`) Trusts Nobody Blindly (\"The Double-Check Rule\"):**\n   - Only `core-back` can talk to the MySQL/MariaDB database, decrypt bank credentials (`Vault`), talk to external banks, or write to the financial ledger (`LedgerPoster`).\n   - Even when `admin-back` or `checkout-back` sends a message to `core-back` using a cryptographic certificate (**mTLS 1.3**), `core-back` **re-checks everything from scratch**: it verifies your login token, your Multi-Factor Authentication (MFA), your exact permission flags (`authorities_map`), and ensures that the Maker and Checker on an approval are two different human beings.\n\n> **CRITICAL HUMAN ERROR WARNING — NEVER BYPASS NETWORK OR ACCOUNT BOUNDARIES:**\n> - Never attempt to expose the Admin Portal (`:8443`) or Core Engine (`:4000`) to the public internet or over an unsecured public proxy.\n> - Never share your Admin account or MFA device with another employee. Every click you make records your `user_id`, IP address, and before/after snapshot in the permanent `audit_log`.\n\n---",
                "humanErrorWarning": "**CRITICAL HUMAN ERROR WARNING — NEVER BYPASS NETWORK OR ACCOUNT BOUNDARIES:**\n- Never attempt to expose the Admin Portal (`:8443`) or Core Engine (`:4000`) to the public internet or over an unsecured public proxy.\n- Never share your Admin account or MFA device with another employee. Every click you make records your `user_id`, IP address, and before/after snapshot in the permanent `audit_log`.",
                "tags": [
                    "system",
                    "split",
                    "separate",
                    "projects",
                    "zero-trust",
                    "model",
                    "you",
                    "hear",
                    "engineers",
                    "mention",
                    "core-back",
                    "admin-back",
                    "merchant-back",
                    "checkout-back"
                ]
            }
        ],
        "sopChecklist": [
            "Identify which service tier is reporting a problem before changing anything.",
            "Confirm the Admin Portal is reachable only on the private LAN and the Core Engine is not publicly exposed.",
            "Verify you are using your own account and MFA device, never a shared login.",
            "Check the audit_log entry for the action you are about to take.",
            "Escalate any request to bypass mTLS, the LAN boundary, or MFA to Security immediately."
        ],
        "humanErrorWarning": "NEVER BYPASS NETWORK OR ACCOUNT BOUNDARIES:\n- Never attempt to expose the Admin Portal (:8443) or Core Engine (:4000) to the public internet or over an unsecured public proxy.\n- Never share your Admin account or MFA device with another employee. Every click you make records your user_id, IP address, and before/after snapshot in the permanent audit_log.",
        "tags": [
            "welcome",
            "platform",
            "money",
            "data",
            "security",
            "work",
            "zero",
            "does",
            "company",
            "actually",
            "system",
            "split",
            "separate",
            "projects"
        ]
    },
    {
        "id": "book-2",
        "number": 2,
        "titleEn": "Roles, Authorities & The Four-Eyes (Maker-Checker) Governance Rule",
        "titleAr": "الأدوار والصلاحيات وقاعدة العيون الأربع (المنشئ والمدقق)",
        "summaryEn": "How roles, authorities_map, default-deny, confidentiality walls, and the four-eyes maker-checker engine protect every sensitive action.",
        "summaryAr": "كيف تحمي الأدوار وauthorities_map وقاعدة المنع الافتراضي وجدران السرية ومحرك العيون الأربع كل إجراء حساس.",
        "chapters": [
            {
                "id": "book-2-chapter-2.1",
                "number": "2.1",
                "titleEn": "Understanding Your Role vs. Your Authorities (`authorities_map`)",
                "bodyEn": "In our platform, every employee account has two layers of access control:\n1. **Your Role (`UserRole`):** Describes your job function (`GATEWAY_ADMIN`, `SECURITY_ADMIN`, `FINANCE`, `OPERATOR`, `COMPLIANCE`, `MLRO`, `SUPPORT`).\n2. **Your Authorities Map (`authorities_map`):** The exact list of actions your account is permitted to perform (for example, `case:read`, `dispute:write`, `gateway:write`, `aml:read_confidential`).\n   - **Default-Deny Rule:** If an admin creates a new user account and leaves `authorities_map` empty, that user can see **zero** pages and call **zero** APIs, regardless of their Role title.\n   - **Confidentiality Wall (`AML-CONFIDENTIAL`):** Only `COMPLIANCE`, `MLRO` (Money Laundering Reporting Officer), and `SECURITY_ADMIN` (for audit) can view AML screenings, watch-list matches, or Suspicious Activity Reports. `SUPPORT` and `OPERATOR` staff are blocked from seeing AML reasons so they can never accidentally \"tip off\" a merchant under investigation.",
                "tags": [
                    "understanding",
                    "role",
                    "authorities",
                    "map",
                    "platform",
                    "employee",
                    "account",
                    "two",
                    "layers",
                    "access",
                    "control",
                    "userrole",
                    "describes",
                    "job"
                ]
            },
            {
                "id": "book-2-chapter-2.2",
                "number": "2.2",
                "titleEn": "How the Four-Eyes (Maker-Checker) System Protects You and the Company",
                "bodyEn": "Imagine if a tired Finance officer accidentally typed `100,000 LYD` instead of `1,000 LYD` on a manual adjustment, or if a Gateway Admin accidentally pasted a broken URL into a live bank integration. In a normal system, that mistake would immediately break production or lose money.\n\nIn our platform, **every sensitive action is governed by the Four-Eyes (Maker-Checker) rule**:\n1. **Step 1 — The Maker Proposes (`DRAFT -> PENDING_REVIEW`):**\n   - User A (who has `is_maker = true`) fills out the form (e.g., editing a merchant's payout bank account, proposing a refund, changing a commission rate, or promoting a Gateway Version to `LIVE`).\n   - Instead of changing the live database immediately, the system saves an **Approval Request (`approval_requests`)** containing a **JSON-Patch Diff** (a side-by-side comparison of the Old Value vs. the Proposed New Value) and records the entity's current `base_version`.\n2. **Step 2 — The Checker Inspects & Decides (`PENDING_REVIEW -> APPROVED -> EXECUTED` or `REJECTED`):**\n   - User B (a **different** person with `is_checker = true` in that domain) opens the **Approvals Queue (`/approvals`)**.\n   - The system enforces **`checker_user_id != maker_user_id`** at three separate levels: in the UI, in the backend middleware, and in a hard MySQL database trigger (`approval_requests_checker_not_maker`). You **cannot** approve your own request.\n   - When the Checker clicks **Approve**, the system verifies that the record hasn't been modified by someone else in the meantime (`base_version` check) and **atomically executes** the change and writes the ledger/audit record in the exact same database transaction.",
                "tags": [
                    "four-eyes",
                    "maker-checker",
                    "system",
                    "protects",
                    "you",
                    "company",
                    "imagine",
                    "tired",
                    "finance",
                    "officer",
                    "accidentally",
                    "typed",
                    "100",
                    "000"
                ]
            },
            {
                "id": "book-2-chapter-2.3",
                "number": "2.3",
                "titleEn": "The Asymmetry Rule — Emergency Actions (`EMERGENCY_RATIFICATION`)",
                "bodyEn": "What if a merchant is actively committing fraud at 2:00 AM on a Friday, or an AML rule needs to be tightened immediately to stop an attack, and a second Checker is asleep?\n- **Actions that REDUCE risk** (Suspending a merchant, tightening a velocity/AML rule, pausing a broken route) are allowed to take effect **immediately** with one authorized person, creating an approval request in **`EMERGENCY_RATIFICATION`** mode with a **24-hour countdown timer (`ratify_due_at`)**.\n- Within 24 hours, an `MLRO` or `COMPLIANCE` Checker must review and ratify the emergency suspension. If the 24-hour timer expires without ratification, a `P2` alert pages management—and the merchant **stays suspended** (fail-safe, never fail-open) until a human Checker decides.\n- **Actions that INCREASE risk or MOVE money** (Reinstating a suspended merchant, loosening a rule, releasing an AML hold, approving a refund/cash-out, promoting a gateway to `LIVE`) **NEVER** have an emergency bypass; they always wait for a second human Checker prior to execution.",
                "tags": [
                    "asymmetry",
                    "rule",
                    "emergency",
                    "actions",
                    "ratification",
                    "merchant",
                    "actively",
                    "committing",
                    "fraud",
                    "friday",
                    "aml",
                    "needs",
                    "tightened",
                    "immediately"
                ]
            },
            {
                "id": "book-2-chapter-2.4",
                "number": "2.4",
                "titleEn": "Step-by-Step SOP for Checkers Reviewing `/approvals`",
                "bodyEn": "Before you ever click **Approve** on any row in `/approvals`, complete this 5-point checklist:\n1. **Read the Green/Red JSON Diff Line by Line:** Never approve based only on the summary title. Inspect the exact numbers, account IBANs, URLs, or transform pipes changing in the diff viewer.\n2. **Check the Currency & Decimal Scale:** Remember that LYD uses 3 decimals (`100.0000` is One Hundred Dinars). Verify that a Maker did not enter `100000` thinking in Dirhams!\n3. **Verify External Evidence:**\n   - For a **Bank Account Change (`payout_bank_details_json`)**: Open the merchant's KYB documents and verify the official stamped Bank Letter matches the new IBAN and the merchant's legal name.\n   - For a **Manual Refund / Adjustment**: Verify the `provider_refund_ref` or `external_dispute_ref` against the gateway portal or statement.\n   - For a **Gateway Version Promotion to `LIVE`**: Verify that all **12 Go-Live Gates** show green badges and a valid `rollback_version_id` is selected.\n4. **Check the Chargeback Outcome Selector (When Approving a Dispute Adjustment):** Confirm whether the adjustment is escrowing an opened dispute, releasing a `WON` dispute, or finalizing a `LOST` dispute.\n5. **Write a Clear Rejection Reason if Anything Looks Wrong:** If even one field is ambiguous, click **Reject**, type the exact correction needed, and let the Maker submit a clean draft.\n\n---",
                "sopChecklist": [
                    "**Read the Green/Red JSON Diff Line by Line:** Never approve based only on the summary title. Inspect the exact numbers, account IBANs, URLs, or transform pipes changing in the diff viewer.",
                    "**Check the Currency & Decimal Scale:** Remember that LYD uses 3 decimals (`100.0000` is One Hundred Dinars). Verify that a Maker did not enter `100000` thinking in Dirhams!",
                    "**Verify External Evidence:**",
                    "**Check the Chargeback Outcome Selector (When Approving a Dispute Adjustment):** Confirm whether the adjustment is escrowing an opened dispute, releasing a `WON` dispute, or finalizing a `LOST` dispute.",
                    "**Write a Clear Rejection Reason if Anything Looks Wrong:** If even one field is ambiguous, click **Reject**, type the exact correction needed, and let the Maker submit a clean draft."
                ],
                "tags": [
                    "step-by-step",
                    "sop",
                    "checkers",
                    "reviewing",
                    "approvals",
                    "before",
                    "you",
                    "ever",
                    "click",
                    "approve",
                    "any",
                    "row",
                    "complete",
                    "5-point"
                ]
            }
        ],
        "sopChecklist": [
            "Read the green/red JSON-Patch diff line by line.",
            "Check the currency and decimal scale; LYD uses three decimals.",
            "Verify external evidence: bank letter, provider refund reference, or all twelve go-live gates.",
            "Check the chargeback outcome selector when approving a dispute adjustment.",
            "Write a clear rejection reason if even one field is ambiguous."
        ],
        "humanErrorWarning": "NEVER approve your own Maker request, never share credentials to get a second signature, and never use the EMERGENCY_RATIFICATION path for actions that increase risk or move money. The database trigger, middleware, and audit log track every Maker and Checker.",
        "tags": [
            "roles",
            "authorities",
            "four-eyes",
            "maker-checker",
            "governance",
            "rule",
            "understanding",
            "role",
            "map",
            "system",
            "protects",
            "you",
            "company",
            "asymmetry"
        ]
    },
    {
        "id": "book-3",
        "number": 3,
        "titleEn": "The Four-Layer Payment Catalog (`Gateway` -> `Credential Set` -> `Rail` -> `Route`)",
        "titleAr": "كتالوج الدفع الرباعي (البوابة ثم مجموعة الاعتماد ثم السكة ثم المسار)",
        "summaryEn": "The four-layer catalog and the ten-condition Visible Rails Formula that explains every missing payment method at checkout.",
        "summaryAr": "الكتالوج الرباعي وصيغة السكك المرئية ذات الشروط العشرة التي تفسر كل طريقة دفع غائبة عند الدفع.",
        "chapters": [
            {
                "id": "book-3-chapter-3.1",
                "number": "3.1",
                "titleEn": "Why Do We Separate Gateways, Credential Sets, Rails, and Routes?",
                "bodyEn": "New employees often ask: *\"Why don't we just have one table called 'Payment Methods'?\"*\nHere is why our 4-layer design is essential in the Libyan market:\n- Suppose **Edfali** is a payment method that customers love.\n- We can connect to Edfali **directly** through Bank of Commerce & Development (`Gateway 1: edfali_direct`, which costs us `0.5%`), **or** through the **Plutu Aggregator** (`Gateway 2: plutu`, which costs us `1.2%`), **or** through the **DPay Aggregator** (`Gateway 3: dpay`, which costs us `1.5%`).\n- Furthermore, a large supermarket chain might have its **own** direct contract with DPay (`Credential Set: Merchant-Owned`), while 500 smaller stores use **our company's** master contract (`Credential Set: Platform-Owned`).\n\nBy separating the 4 layers, the customer at checkout simply sees **one clean \"Edfali\" button (`Rail`)**, while our engine automatically picks the best, cheapest, healthy **`Route`** and **`Credential Set`** behind the scenes!\n\n```text\nLayer 3: RAIL (What the Customer Sees)\n  [ Edfali (إدفع لي) ]  ── Owns Logo, Arabic/English Name, Customer Input Form (09xxxxxxxx Phone + OTP)\n         │\n         ├──▶ Layer 4: ROUTE A (Priority 1, Cost 0.5%, Status: ACTIVE, Health: HEALTHY)\n         │       └──▶ Layer 1: GATEWAY (edfali_direct) + Layer 2: CREDENTIAL SET (Platform Master Account)\n         │\n         ├──▶ Layer 4: ROUTE B (Priority 2, Cost 1.2%, Status: ACTIVE, Health: HEALTHY — Automatic Backup!)\n         │       └──▶ Layer 1: GATEWAY (plutu)         + Layer 2: CREDENTIAL SET (Platform Plutu Account)\n         │\n         └──▶ Layer 4: ROUTE C (Scoped to Supermarket X Only, Settlement: MERCHANT_DIRECT)\n                 └──▶ Layer 1: GATEWAY (dpay)          + Layer 2: CREDENTIAL SET (Supermarket X's Own DPay Keys)\n```",
                "tags": [
                    "separate",
                    "gateways",
                    "credential",
                    "sets",
                    "rails",
                    "routes",
                    "new",
                    "employees",
                    "often",
                    "ask",
                    "don",
                    "just",
                    "one",
                    "table"
                ]
            },
            {
                "id": "book-3-chapter-3.2",
                "number": "3.2",
                "titleEn": "How the \"Visible Rails Formula\" Decides What Appears at Checkout",
                "bodyEn": "When a merchant calls support and asks: *\"Why isn't Sadad (or Moamalat Card) showing up on my Payment Link?\"*, you do **not** have to guess. Our engine evaluates the **Visible Rails Formula** on every checkout load. A Rail appears **only** if all 10 of these conditions are true:\n\n| # | Check Performed by `VisibleRailsResolver` | Where to Check in Admin Portal if the Rail is Missing | Machine Exclusion Code (Shown in Diagnostics) |\n| :--- | :--- | :--- | :--- |\n| **1** | Is the Rail unblocked globally? | **Catalog -> Rails (`/rails`)**: Check that `Active/Blocked` is `Active` (`blocked = false`). | `RAIL_BLOCKED` |\n| **2** | Does the Rail's currency match the Link's currency? | **Catalog -> Rails**: An `LYD` link only shows `LYD` rails; a `USD` link only shows `USD` rails (like MPGS Visa/MC). | `CURRENCY_MISMATCH` |\n| **3** | Is the Rail allowed by the Merchant's Application whitelist? | **Merchants -> Applications**: If `rail_whitelist` is empty/null, all rails are allowed. If specific rails are selected, unlisted rails are hidden. | `EXCLUDED_BY_APP_WHITELIST` |\n| **4** | Is the Rail allowed by the Payment Link's whitelist? | **Links Inspector**: Check if the merchant restricted that specific link to certain rails only. | `EXCLUDED_BY_LINK_WHITELIST` |\n| **5** | Does a live **Commission Profile** exist for this Rail? | **Finance -> Commission Profiles (`/commission-profiles`)**: Every rail must have an active, effective-dated Commission Profile (either for that merchant/app or a Platform Default) so the system knows how much commission to charge! | `NO_COMMISSION_PROFILE` |\n| **6** | Does the Rail have at least one `ACTIVE` and `HEALTHY` Route? | **Catalog -> Routes (`/routes`)**: Check that at least one route for this rail has `Status = ACTIVE` and `Health = HEALTHY` (not `PAUSED`, `DRAINING`, or `OPEN_BREAKER`). | `NO_HEALTHY_ACTIVE_ROUTE` |\n| **7** | Is the Link's amount between the Route's `min_amount` and `max_amount`? | **Catalog -> Routes**: If a customer opens a `15,000 LYD` link and Sadad's max per-transaction limit is `2,000 LYD`, Sadad is automatically hidden for that link. | `AMOUNT_BELOW_MINIMUM` / `AMOUNT_ABOVE_MAXIMUM` |\n| **8** | Is the Route within its Daily Cap (`daily_cap_amount`)? | **Finance -> Route Caps (`/finance/route-caps`)**: If a route processed `99,800 LYD` today and its daily cap is `100,000 LYD`, a `500 LYD` link will skip that route. | `DAILY_CAP_EXCEEDED` |\n| **9** | Is the current time outside the Route's Maintenance Window, and is the Merchant in Scope? | **Catalog -> Routes**: Check `maintenance_windows` and `scope` (`merchant_ids`, `risk_tiers`, `channels`). | `IN_MAINTENANCE_WINDOW` / `OUT_OF_SCOPE` |\n| **10** | Does the Route have a `VERIFIED` Credential Set? | **Catalog -> Credential Sets (`/credential-sets`)**: A route cannot process traffic if its credentials are `UNTESTED`, `FAILING`, or `REVOKED`. | `NO_VERIFIED_CREDENTIAL_SET` |\n\n---",
                "tags": [
                    "visible",
                    "rails",
                    "formula",
                    "decides",
                    "appears",
                    "checkout",
                    "merchant",
                    "calls",
                    "support",
                    "asks",
                    "isn",
                    "sadad",
                    "moamalat",
                    "card"
                ]
            }
        ],
        "sopChecklist": [
            "Confirm the Rail is globally unblocked (blocked = false).",
            "Confirm the Rail currency matches the Payment Link currency.",
            "Check the Application and Link rail whitelists.",
            "Confirm an effective Commission Profile exists for the Rail.",
            "Confirm at least one Route is ACTIVE and HEALTHY, inside amount limits, daily cap, maintenance window, scope, and has a VERIFIED Credential Set."
        ],
        "humanErrorWarning": "NEVER delete a Rail or Route with historical payments. Set blocked = true or move the Route to DRAINING. Deleting catalog rows destroys the historical explanation of settled money and can make reconciliation impossible.",
        "tags": [
            "four-layer",
            "payment",
            "catalog",
            "gateway",
            "credential",
            "set",
            "rail",
            "route",
            "separate",
            "gateways",
            "sets",
            "rails",
            "routes",
            "visible"
        ]
    },
    {
        "id": "book-4",
        "number": 4,
        "titleEn": "Collection Modes (Axis A) & Confirmation Channels (Axis B) — Why We Never Trust the Browser",
        "titleAr": "أنماط التحصيل (المحور أ) وقنوات التأكيد (المحور ب) — لماذا لا نثق بالمتصفح أبداً",
        "summaryEn": "The nine collection modes, the seven confirmation channels, and the five trusted success facts that defeat browser tampering.",
        "summaryAr": "أنماط التحصيل التسعة وقنوات التأكيد السبع وحقائق النجاح الموثوقة الخمس التي تهزم التلاعب بالمتصفح.",
        "chapters": [
            {
                "id": "book-4-chapter-4.1",
                "number": "4.1",
                "titleEn": "Axis A — The 9 Collection Modes (What the Payer Does)",
                "bodyEn": "1. **`OTP_PULL` (Two-Step SMS Code — Edfali, Sadad, MobiCash, Libyana, Masrefy):**\n   - **Step 1 (`INITIATE`):** Customer types their phone number (and Birth Year for Sadad, or 7-digit Card Number for MobiCash). Our server asks the gateway to send an SMS code (`side_effect = SENDS_NOTIFICATION`). The gateway returns a secret session ID (`process_id`), which we lock inside `context_ciphertext`.\n   - **Step 2 (`SUBMIT`):** Customer types the 4-to-6 digit SMS code. Our server sends `process_id + otp + amount + reference` to the gateway (`side_effect = MOVES_MONEY`, `point_of_no_return = true`).\n2. **`REDIRECT` (Hosted Checkout Page — T-LYNC, MyPay, DPay Hosted, MPGS 3DS2):**\n   - Our server creates a payment session with the gateway, receives a `redirect_url`, and sends the customer's browser to the gateway's website to pay. When finished, the browser returns to our `return_url`.\n3. **`EMBEDDED` (In-Page Popup/Iframe — Moamalat National Switch Lightbox, MPGS Hosted Fields):**\n   - Our server computes a cryptographic signature (`SecureHash`) over the amount, reference, and timestamp using our secret key, and hands the signed parameters (never the secret key!) to the Moamalat Lightbox script on the checkout page. The customer types their card PAN and PIN directly inside Moamalat's popup.\n4. **`PUSH_APPROVAL` (Wallet App Notification — LYPay Push, GPay Libya, Hawelli, Evo Pay, NeomPay Push):**\n   - Customer enters their wallet phone/ID. Our server sends a push request to their mobile wallet app. The screen displays a countdown timer while the customer opens their phone app and taps **Approve** or **Reject**.\n5. **`QR_DISPLAY` (Dynamic Barcode Scan — CBL LYPay QR, OnePay EMVCo QR, NeomPay QR):**\n   - Our server generates a dynamic, single-attempt QR code bound to this attempt's reference and amount. On a store POS screen or web checkout, the customer scans the QR with their banking app.\n6. **`PAY_CODE` (SMS / USSD Purchase Code — Yussor Pay Code, OnePay SMS):**\n   - Our screen displays a unique reference code and bilingual instructions telling the customer which short-code number to text or dial from their phone.\n7. **`DEEP_LINK` (Mobile App Switch — Hawelli, Mobile Wallets):**\n   - On a smartphone, tapping **\"Open in Wallet App\"** launches the installed wallet app directly with the payment pre-filled, automatically falling back to a QR code if the app isn't installed or the customer is on a desktop PC.\n8. **`MANUAL` (Bank Wire or Cash Agent Deposit):**\n   - Displays transfer instructions and our unique reference code. Money is confirmed only when matched on an uploaded bank statement (`STATEMENT`) or verified by two operators under Maker-Checker (`OPERATOR_CONFIRMATION`).\n9. **`HYBRID` (Customer Picks Sub-Mode — Yussor Pay, Sahara Pay, NeomPay):**\n   - A single Rail offers multiple sub-modes (e.g., `[OTP_PULL, QR_DISPLAY, PAY_CODE]`) as tabs on the checkout card so the customer can choose whether to scan a QR or type an OTP.",
                "tags": [
                    "axis",
                    "collection",
                    "modes",
                    "payer",
                    "does",
                    "otp",
                    "pull",
                    "two-step",
                    "sms",
                    "code",
                    "edfali",
                    "sadad",
                    "mobicash",
                    "libyana"
                ]
            },
            {
                "id": "book-4-chapter-4.2",
                "number": "4.2",
                "titleEn": "Axis B — The 7 Confirmation Channels & The \"5 Trusted Facts\" Rule",
                "bodyEn": "Why do we **never** mark a payment `SUCCEEDED` just because the customer's browser came back to `/return/:token?status=paid` or because the Moamalat Lightbox JavaScript fired `completeCallback()`?\n- **Because anyone can press `F12` (Developer Tools) in their web browser**, edit a URL to say `?status=paid&amount=100`, or type `completeCallback()` into the browser console!\n- Therefore, in our platform, **`RETURN_URL` and `BROWSER_CALLBACK` have ZERO trust.** When they arrive, our server simply says: *\"Thank you for the hint! Now I will call the bank's server directly (`VERIFY` inquiry) to see if you actually paid.\"*\n\nAn attempt transitions to `SUCCEEDED` and credits a Merchant Wallet **ONLY** when a **Server-Trusted Channel** (`SYNC_RESPONSE`, cryptographically verified `WEBHOOK`, server-to-server `INQUIRY / POLL`, `STATEMENT` match, or Maker-Checker `OPERATOR_CONFIRMATION`) proves **all 5 Trusted Success Facts**:\n1. **Fact 1 — Canonical Status is `SUCCEEDED`** (e.g., `ActionCode === \"00\"` or `Approved === true`).\n2. **Fact 2 — Reference Matches Ours** (`gateway_reference` matches the exact attempt).\n3. **Fact 3 — Settled Amount Matches Expected Total** (`settled_amount` equals `total_charged_amount` within the route's rounding `tolerance_amount`). If the customer paid less or more than expected, the attempt is **HELD in `SUSPENSE`** for operator review—never credited blindly!\n4. **Fact 4 — Currency Matches** (`LYD === LYD`).\n5. **Fact 5 — Environment Matches** (`LIVE === LIVE`; a `SANDBOX` webhook sent to a `LIVE` endpoint is rejected and triggers a security alert).\n\n---",
                "tags": [
                    "axis",
                    "confirmation",
                    "channels",
                    "trusted",
                    "facts",
                    "rule",
                    "never",
                    "mark",
                    "payment",
                    "succeeded",
                    "just",
                    "because",
                    "customer",
                    "browser"
                ]
            }
        ],
        "sopChecklist": [
            "Identify the Collection Mode the customer is using.",
            "Identify the Confirmation Channel configured for the Rail.",
            "Treat RETURN_URL and BROWSER_CALLBACK as hints only.",
            "Run VERIFY / INQUIRY whenever a weak channel fires.",
            "Confirm all five Trusted Success Facts before posting the ledger."
        ],
        "humanErrorWarning": "NEVER trust RETURN_URL or BROWSER_CALLBACK as proof of payment. Anyone can press F12 and forge a success URL. Only SYNC_RESPONSE, a cryptographically verified WEBHOOK, INQUIRY/POLL, STATEMENT, or OPERATOR_CONFIRMATION may move an attempt to SUCCEEDED.",
        "tags": [
            "collection",
            "modes",
            "axis",
            "confirmation",
            "channels",
            "never",
            "trust",
            "browser",
            "payer",
            "does",
            "trusted",
            "facts",
            "rule"
        ]
    },
    {
        "id": "book-5",
        "number": 5,
        "titleEn": "The Universal Flow Engine, `TransformPipe[]` & Cryptographic Signing",
        "titleAr": "محرك التدفق الشامل وTransformPipe[] والتوقيع التشفيري",
        "summaryEn": "The ten lifecycle phases, dot-path step parameters, the closed transform library, and the six cryptographic signing modes.",
        "summaryAr": "مراحل دورة الحياة العشر ومعاملات الخطوات ذات المسار النقطي ومكتبة التحويلات المغلقة وأنماط التوقيع التشفيري الستة.",
        "chapters": [
            {
                "id": "book-5-chapter-5.1",
                "number": "5.1",
                "titleEn": "How Our Engine Talks to Any Bank Without Writing Code",
                "bodyEn": "Every Gateway integration in our system is organized into **10 Lifecycle Phases** (`FlowPhase`):\n1. **`CREDENTIAL_CHECK`:** A harmless read-only call (like fetching a token or profile) used to test if API keys are valid when saved or during nightly health checks.\n2. **`PRE_INITIATE`:** Optional pre-check before sending an OTP (e.g., checking if a phone number is subscribed to the wallet service).\n3. **`INITIATE`:** Starts the payment (sends the SMS OTP, creates the redirect URL, generates the QR code, or computes the Lightbox hash).\n4. **`SUBMIT` (`CONFIRM`):** The money-moving step where the customer's OTP or confirmation is submitted (`side_effect = MOVES_MONEY`, `point_of_no_return = true`).\n5. **`VERIFY` (`INQUIRE`):** A read-only server call where we ask the gateway *\"What happened to payment reference X?\"* (`side_effect = READ_ONLY`, `retry_policy = SAFE`).\n6. **`CANCEL`:** Cancels an unpaid pending request at the gateway if the customer clicks Cancel or switches rails.\n7. **`REFUND`:** Returns full or partial money to the customer after a payment has settled.\n8. **`VOID`:** Cancels a captured payment on the same day before batch settlement.\n9. **`CAPTURE`:** Captures previously pre-authorized card funds.\n10. **`SETTLEMENT_FETCH`:** Pulls the daily settlement report or ledger export from the gateway's API.",
                "tags": [
                    "engine",
                    "talks",
                    "any",
                    "bank",
                    "without",
                    "writing",
                    "code",
                    "gateway",
                    "integration",
                    "system",
                    "organized",
                    "lifecycle",
                    "phases",
                    "flowphase"
                ]
            },
            {
                "id": "book-5-chapter-5.2",
                "number": "5.2",
                "titleEn": "Step Parameters, Dot-Path Selectors & The Closed Transform Library (`TransformPipe[]`)",
                "bodyEn": "When configuring an HTTP step in the 8-Step Gateway Wizard, you tell the engine where to get each piece of data (`source`), how to format it (`transforms`), and where to put it (`place: HEADERS | QUERY | PATH | BODY | FORM | MULTIPART | XML` and `key`).\n\n- **How Dot-Path Keys (`recursiveSet`) Work:**\n  - If a gateway expects nested JSON like `{\"transAmount\": {\"amount\": \"100.00\", \"currency\": \"LYD\"}}`, you simply create two parameters in `BODY`:\n    - Key 1: `transAmount.amount` -> Value: `\"100.00\"`\n    - Key 2: `transAmount.currency` -> Value: `\"LYD\"`\n  - Our engine automatically builds the nested JSON object and preserves sibling fields.\n- **How `TransformPipe[]` Works (Interactive Transform Sandbox Below):**\n  - Transforms are chained left-to-right like an assembly line:\n    - **Moamalat Dirham Example:** `ATTEMPT.total_charged_amount` (`10.5000`) -> `scale(1000)` (`10500`) -> `to_int` (`10500`) -> `to_string` (`\"10500\"`).\n    - **DPay 2-Decimal Rounding Example:** `ATTEMPT.total_charged_amount` (`76.2550`) -> `round(NEAREST, 2)` (`76.26`) -> `format_decimal(2)` (`\"76.26\"`).\n    - **Libyan Phone Normalization Example:** `CUSTOMER_FIELD.phone` (`\"٠٩١٢٣٤٥٦٧٨\"` or `\"+218912345678\"`) -> `arabic_digits_to_ascii` -> `phone_normalize(LOCAL_09)` -> `\"0912345678\"`.",
                "tags": [
                    "step",
                    "parameters",
                    "dot-path",
                    "selectors",
                    "closed",
                    "transform",
                    "library",
                    "transformpipe",
                    "configuring",
                    "http",
                    "8-step",
                    "gateway",
                    "wizard",
                    "you"
                ]
            },
            {
                "id": "book-5-chapter-5.3",
                "number": "5.3",
                "titleEn": "Understanding the 6 Cryptographic Signing Modes (`CryptoProfile`)",
                "bodyEn": "Gateways use cryptographic signatures (HMAC or RSA) so neither side can tamper with the amount or status in transit. Here are the 6 canonicalization modes built into our `CryptoEngine` (which you can test live in the **Crypto Signature Lab** widget):\n1. **`SORTED_KEY_VALUE_AMP` (The Moamalat NPG Standard):**\n   - Sorts the included fields alphabetically by key name, joins them as `Key1=Val1&Key2=Val2...`, and computes `HMAC-SHA256` using the **`HEX`-decoded** `MerchantSecretKey`, outputting `HEX_UPPER`.\n   - *Trap to avoid:* Moamalat provides its secret key as a Hexadecimal string (e.g., `303132...`). In `CryptoProfile`, you **must** set `secret_key_encoding = HEX` (not `UTF8`), otherwise the hash will never match!\n2. **`TIMESTAMP_DOT_RAW_BODY` (The DPay Standard):**\n   - Reads the timestamp header (`X-DPay-Timestamp`), joins `<timestamp>.<exact_raw_json_bytes>`, and computes `HMAC-SHA256` (`UTF8` key), verifying that the timestamp is within `300 seconds` (5 minutes) to prevent replay attacks.\n3. **`SORTED_VALUES_HASH` (The Plutu Callback Standard):**\n   - Removes the signature field itself (`excluded_fields: ['hashed']`), sorts the remaining parameter keys alphabetically, concatenates *only their values* together, and computes uppercase `HMAC-SHA256`.\n4. **`RAW_BODY` (The MyPay Standard):**\n   - Computes `HMAC-SHA256` directly over the raw, unparsed HTTP request body bytes (`Buffer`) and compares it against the `X-MYPAY-SIGNATURE` header.\n5. **`TEMPLATE_STRING` & `JSON_CANONICAL`:**\n   - Builds a custom pattern (e.g., `{MID}:{reference}:{amount}`) or deterministic key-sorted JSON before signing with HMAC or `RSA_SHA256`.\n\n---",
                "tags": [
                    "understanding",
                    "cryptographic",
                    "signing",
                    "modes",
                    "cryptoprofile",
                    "gateways",
                    "signatures",
                    "hmac",
                    "rsa",
                    "neither",
                    "side",
                    "tamper",
                    "amount",
                    "status"
                ]
            }
        ],
        "sopChecklist": [
            "Name the FlowPhase for every step you are editing.",
            "Set side_effect = MOVES_MONEY and point_of_no_return = true on the money step.",
            "Set retry_policy = NEVER on MOVES_MONEY unless idempotency is proven.",
            "Verify dot-path keys and transform pipes against the partner sample.",
            "Prove the CryptoProfile against a real partner test vector before saving."
        ],
        "humanErrorWarning": "NEVER configure a MOVES_MONEY step with automatic retries unless cryptographic idempotency is proven. Retrying a timed-out money call can charge the customer twice. Also never send secrets to an unlisted host: Safeguard 11 pins credentials to allowed_hosts.",
        "tags": [
            "universal",
            "flow",
            "engine",
            "transformpipe",
            "cryptographic",
            "signing",
            "talks",
            "any",
            "bank",
            "without",
            "writing",
            "code",
            "step",
            "parameters"
        ]
    },
    {
        "id": "book-6",
        "number": 6,
        "titleEn": "The 8-Step \"Add-a-Gateway\" Wizard & Smart AI Integration Importer",
        "titleAr": "معالج إضافة بوابة في 8 خطوات ومستورد التكامل الذكي",
        "summaryEn": "A step-by-step walkthrough of the eight-step gateway wizard, the twelve go-live gates, and the safe AI integration importer.",
        "summaryAr": "جولة خطوة بخطوة في معالج البوابة ذي الخطوات الثماني وبوابات الإطلاق الاثنتي عشرة ومستورد التكامل الذكي الآمن.",
        "chapters": [
            {
                "id": "book-6-chapter-6.1",
                "number": "6.1",
                "titleEn": "Walkthrough of the 8-Step Gateway Wizard (`/gateways/wizard/:id`)",
                "bodyEn": "Whenever you integrate a new bank or edit an existing gateway, you work inside a **`DRAFT` Gateway Version** (`gateway_versions`). Editing a draft **never** affects live customers until the version passes all **12 Go-Live Gates** and is approved by a `SECURITY_ADMIN` Checker.\n\n- **Step 1 (Identity & Basics):** Enter `code` (lowercase slug, e.g., `sadad_direct`), `name`, `operator` (`Almadar Aljadid`), `country` (`LY`), `aliases` (`[\"sadad\", \"سداد\"]`), `kind` (`DIRECT`, `AGGREGATOR`, `NATIVE_ADAPTER`, `INTERNAL`), and `risk_class` (`NORMAL` or `HIGH_RISK`).\n- **Step 2 (Environments, Auth & Credentials):** Enter `SANDBOX` and `LIVE` `base_urls` (`https://...` only) and `allowed_hosts` (which cryptographically pins where credentials can be sent—Safeguard 11). Choose the `AuthMethod` (e.g., `PERMANENT_TOKEN`, `TOKEN_ENDPOINT`, `REQUEST_SIGNATURE`, `MUTUAL_TLS`), enter the write-only secrets into the `CredentialSet`, and click **\"Run Live Credential Check\"**.\n- **Step 3 (Customer Form Builder — `Rail` & `RailField`):** Define the bilingual customer inputs (`phone`, `birth_year`, `card_number`, `otp`, `wallet_id`), validation regexes, digit/phone normalizers, and field sensitivity (`NORMAL`, `SENSITIVE`, or `PAN`—which holds 7/9-digit card numbers in memory only for a single call and wipes them immediately).\n- **Step 4 (Cryptographic Profiles):** Configure `OUTBOUND_SIGN` and `INBOUND_VERIFY` profiles and paste a real sample from the partner's documentation into the **Interactive Signature Verifier** to prove your recipe matches byte-for-byte.\n- **Step 5 (10-Phase Visual Flow Builder):** Add `HTTP`, `COMPUTE`, or `RENDER` steps for `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, and `REFUND`. Remember: any step with `side_effect = MOVES_MONEY` must have `point_of_no_return = true` and `retry_policy = NEVER` (unless idempotency key support is proven).\n- **Step 6 (Client Actions, Confirmation Channels & Polling):** Configure how `checkout-front` renders the step (`SHOW_OTP_FORM`, `HTTP_REDIRECT`, `RENDER_EMBEDDED`, `SHOW_QR_OR_CODE`, `SHOW_PUSH_OR_TRANSFER`), configure the webhook `path_token` and verification method (setting `must_inquire = true` on any weak/IP-only channel), and set the background `PollPolicy` backoff (`[5, 10, 20, 40, 60]` seconds).\n- **Step 7 (Status Rules, Error Map, Amount Scale & Statement Parser):** Map gateway codes to canonical statuses (`SUCCEEDED`, `FAILED`, `AWAITING_CUSTOMER`, `UNKNOWN`) and Error Classifications (`RETRYABLE_OTP` vs `TERMINAL_DECLINE` vs `LIMIT_EXCEEDED` vs `GATEWAY_FAULT`). Set `amount_scale` (`1`, `100`, `1000`), `amount_precision` (`0`, `2`, `3`), and `amount_rounding`, and map the CSV/XLSX/JSON columns for daily `StatementSource` reconciliation.\n- **Step 8 (Dry-Run, 15-Scenario Sandbox Suite, 12 Gates & Maker-Checker Submit):** Run the automated **15-Scenario Suite**, select a `rollback_version_id`, verify all 12 Go-Live Gates are green, and click **Submit for Checker Approval**.",
                "tags": [
                    "walkthrough",
                    "8-step",
                    "gateway",
                    "wizard",
                    "gateways",
                    "whenever",
                    "you",
                    "integrate",
                    "new",
                    "bank",
                    "edit",
                    "existing",
                    "work",
                    "inside"
                ]
            },
            {
                "id": "book-6-chapter-6.2",
                "number": "6.2",
                "titleEn": "Using the Smart AI Integration Importer (`/gateways/ai-import`) Safely",
                "bodyEn": "Instead of building all 8 steps by hand from a 40-page bank PDF, you can use our air-gapped **\"Bring-Your-Own-AI\"** workflow:\n1. Click **Download AI Onboarding Transcript** in `/gateways/ai-import`.\n2. Open any external AI model (Claude, ChatGPT, Gemini, DeepSeek) in your browser, upload the downloaded transcript + the bank's API PDF, and ask it to generate `integration-spec.json`.\n   - **CRITICAL SECRET RULE:** Never give live API keys or HMAC secrets to the external AI! Give the AI only the *names* of the credential fields.\n3. Upload `integration-spec.json` into Step 2 of `/gateways/ai-import`. Our backend runs a **4-Layer Verification Pipeline** (Zod Schema -> Semantic/SSRF Guard -> Offline Simulation against embedded `test_vectors` -> Collision Check). If any selector or signature fails against the doc's own sample payloads, click **\"Copy AI Repair Prompt\"** and paste it back to the AI.\n4. Once all 4 layers pass green, enter the real secret values into the password inputs on Step 3 and click **Import as Draft**.\n\n---",
                "tags": [
                    "smart",
                    "integration",
                    "importer",
                    "gateways",
                    "ai-import",
                    "safely",
                    "instead",
                    "building",
                    "steps",
                    "hand",
                    "40-page",
                    "bank",
                    "pdf",
                    "you"
                ]
            }
        ],
        "sopChecklist": [
            "Open a DRAFT Gateway Version and complete all eight wizard steps.",
            "Run the Live Credential Check and the fifteen-scenario sandbox suite.",
            "Verify all twelve go-live gates are green.",
            "Select a valid rollback_version_id.",
            "Submit for SECURITY_ADMIN Checker approval; never self-approve."
        ],
        "humanErrorWarning": "NEVER paste LIVE API keys, passwords, or HMAC secrets into an external AI chat. Give the AI only credential field names. Never promote a gateway version to LIVE until all twelve go-live gates are green and a second Checker approves.",
        "tags": [
            "8-step",
            "add-a-gateway",
            "wizard",
            "smart",
            "integration",
            "importer",
            "walkthrough",
            "gateway",
            "gateways",
            "ai-import",
            "safely"
        ]
    }
];

import type { GuideBook } from "./types";

export const BOOKS_PART_2: GuideBook[] = [
    {
        "id": "book-7",
        "number": 7,
        "titleEn": "The 14-State Attempt Lifecycle & Resolving `UNKNOWN`, `CONFLICT`, and `HELD` Cases (`RB-01` to `RB-05`)",
        "titleAr": "دورة حياة المحاولة ذات 14 حالة وحل UNKNOWN وCONFLICT وHELD (RB-01 إلى RB-05)",
        "summaryEn": "Every attempt status, slot lock behavior, and the exact runbooks for resolving UNKNOWN, CONFLICT, and HELD cases.",
        "summaryAr": "كل حالة محاولة وسلوك قفل الخانة والأدلة التشغيلية الدقيقة لحل حالات UNKNOWN وCONFLICT وHELD.",
        "chapters": [
            {
                "id": "book-7-chapter-7.1",
                "number": "7.1",
                "titleEn": "Complete Map of Every `AttemptStatus` What It Means & What To Do",
                "bodyEn": "| Status Badge | Category | Plain-English Meaning | Is the Link Slot Locked (`active_locked_count`)? | What Should an Operator or Support Agent Do? |\n| :--- | :--- | :--- | :--- | :--- |\n| **`CREATED` / `INITIATING`** | In-Flight | The customer just clicked \"Pay\" and our server is talking to the gateway to start the session. | **YES (Locked)** | Wait a few seconds; this transitions automatically to `AWAITING_CUSTOMER` or `FAILED`. |\n| **`AWAITING_CUSTOMER`** | In-Flight | The customer is currently looking at the OTP box (`OTP_REQUIRED`), the bank redirect page (`REDIRECT_PENDING`), the Moamalat popup (`WIDGET_OPEN`), the QR code (`QR_PENDING`), or their wallet app (`PUSH_PENDING`). | **YES (Locked)** | If the customer is still paying, tell them to complete the screen before the countdown expires. Do not cancel while they are entering their OTP. |\n| **`AUTHORIZING`** | In-Flight (Past PNR!) | The customer submitted their OTP/confirmation and our `MOVES_MONEY` request is currently in flight to the bank. | **YES (Locked)** | **Hands off!** Money is moving right now. Never cancel or retry. |\n| **`VERIFYING`** | In-Flight | A browser hint, redirect return, or `must_inquire` webhook arrived, and our server is querying the bank (`VERIFY`) to confirm the truth; **or** the payment is paused under an `AML_HOLD` (`substatus = 'AML_HOLD'`). | **YES (Locked)** | Check `substatus`: if `AML_HOLD`, refer to Compliance (`/aml/cases`). Otherwise, `PollWorker` is actively checking with the gateway. |\n| **`UNKNOWN`** | **Exception (Requires Action!)** | Our server sent a money-moving call (`SUBMIT`), and the bank timed out, reset the connection, returned HTTP 500/502, or returned an unreadable response—**or** a webhook and inquiry contradicted each other (`CONFLICT`). | **YES (Strictly Held!)** | Follow **Runbook `RB-03`** below! Click **Inquire Now** in `/operator-cases`. If the rail has no inquiry API (like Edfali direct), wait for the next **Statement Reconciliation** or verify with partner support before resolving under Maker-Checker. |\n| **`SUCCEEDED`** | Terminal (Paid) | All 5 Trusted Success Facts passed, the Double-Entry Ledger posted in the same transaction, and the Merchant Wallet (or Commission Receivable) was updated. | Slot Committed (`confirmed_count + 1`) | Payment is complete. If the customer needs their money back later, use a Maker-Checker **Refund Adjustment**. |\n| **`FAILED`** | Terminal (Unpaid) | The payment definitely failed without taking money (wrong OTP 3 times, insufficient funds, customer limit exceeded, or gateway down before point-of-no-return). | **NO (Released)** | The customer was not charged and the link slot is free; they can safely try again or pick another rail. |\n| **`EXPIRED`** | Terminal (Timed Out) | The countdown timer (`expires_at`) ran out, our sweeper ran one final `inquire()` check, and the customer hadn't paid. *(Note: the webhook inbox stays open during `grace_expires_at` in case a late bank notification arrives!)* | **NO (Released)** | If a verified payment notification arrives late during the grace window, the system automatically recovers `EXPIRED -> SUCCEEDED` (or routes to `SUSPENSE` if the link was already paid by another attempt). |\n| **`CANCELLED`** | Terminal (Aborted) | The customer or POS cashier clicked Cancel before the point of no return. | **NO (Released)** | Link slot is free for a new attempt. |\n| **`BLOCKED`** | Terminal (Risk Guard) | Blocked before calling the bank by a **Velocity Rule** (e.g., too many attempts from one IP/phone), a **Hot-Path AML Watchlist Hit**, or **Self-Payment Prevention** (merchant paying their own link). | **NO (Never Reserved)** | **Do not reveal internal AML reasons to the customer or merchant!** If blocked by Velocity, check `/velocity-rules`; if AML, escalate to `COMPLIANCE`. |\n| **`PARTIALLY_REFUNDED` / `REFUNDED`** | Post-Settlement | One or more Maker-Checker Refund Adjustments were approved and executed back to the customer. | Committed | Check `/adjustments` to see the exact refunded amount and `provider_refund_ref`. |\n| **`DISPUTED`** | Post-Settlement | The bank or card switch reported a **Chargeback / Dispute** (`disputes`). | Committed | Check `/disputes` and upload merchant evidence before `evidence_due_at`. |",
                "tags": [
                    "complete",
                    "map",
                    "attemptstatus",
                    "means",
                    "status",
                    "badge",
                    "category",
                    "plain-english",
                    "meaning",
                    "link",
                    "slot",
                    "locked",
                    "active",
                    "count"
                ]
            },
            {
                "id": "book-7-chapter-7.2",
                "number": "7.2",
                "titleEn": "Step-by-Step SOP for Operator Cases (`/operator-cases`) & Runbooks `RB-01` to `RB-05`",
                "bodyEn": "1. **Resolving an `UNKNOWN` Case (`RB-03`):**\n   - **Step 1:** Open `/operator-cases` and click the `UNKNOWN` case to inspect its `attempt_step_logs` (the exact HTTP status, timeout duration, and raw response from the bank).\n   - **Step 2:** If the gateway supports status inquiry (`supports_status_check = true`), click **\"Inquire Gateway Now\"**. If the gateway replies with a definitive paid or unpaid status, the system resolves the attempt automatically!\n   - **Step 3:** If the gateway has **no status inquiry API** (such as direct Edfali or certain aggregator OTP rails), **DO NOT GUESS**. Either upload the gateway's daily settlement statement in `/reconciliation` (which automatically matches `our_reference` / `provider_reference`), or obtain written confirmation of the `provider_reference` from the gateway's merchant portal/support desk, then submit a Maker-Checker resolution (`Resolve to SUCCEEDED` with `provider_reference` or `Resolve to FAILED`).\n2. **Resolving a `P1 CONFLICT` Case (Webhook Says `PAID`, Inquiry Says `FAILED`):**\n   - Neither signal is trusted automatically. Inspect the `inbound_events` raw webhook payload and the `attempt_step_logs` inquiry response. Verify against the official settlement statement before proposing a Maker-Checker resolution.\n3. **Resolving a `HELD` / `MISMATCH` Case (Amount Difference Beyond Tolerance):**\n   - Occurs when a customer was supposed to pay `100.0000 LYD` and the gateway settled `95.0000 LYD` or `105.0000 LYD`. The funds sit safely in `SUSPENSE`. Finance proposes a Maker-Checker Adjustment to either credit the settled amount or refund the payer.\n\n---",
                "tags": [
                    "step-by-step",
                    "sop",
                    "operator",
                    "cases",
                    "operator-cases",
                    "runbooks",
                    "rb-01",
                    "rb-05",
                    "resolving",
                    "unknown",
                    "case",
                    "rb-03",
                    "step",
                    "open"
                ]
            },
            {
                "id": "book-9-chapter-9.4",
                "number": "9.4",
                "titleEn": "Merchant Lifecycle, Sensitive Edits & Support Operations (`/merchants`)",
                "titleAr": "دورة حياة التاجر والتعديلات الحساسة وعمليات الدعم (/merchants)",
                "bodyEn": "The `/merchants` workspace is the operational merchant register. It is not a finance action screen: lifecycle changes and sensitive edits are governed, audited and, where policy requires, checked by a second person.\n\n**Lifecycle.** `PENDING` merchants are still onboarding. `ACTIVE` merchants may transact subject to the risk guards. `SUSPENDED` merchants cannot start new live payments. `REJECTED` applicants may submit a new join request. `CLOSED` merchants are read-only. Suspension, reinstatement and closure are sensitive actions.\n\n**Standard suspension and emergency suspension.** A standard suspension creates a checker request and only takes effect after approval. An emergency suspension takes effect immediately and must be ratified by a compliance or MLRO checker within 24 hours. If ratification is rejected, the suspension remains in force; it can only be reversed by a separate reinstatement approval. This is fail-safe, not fail-open.\n\n**Descriptive vs sensitive fields.** Trade name, display name, logo URL and support contacts are descriptive. Legal name, tax ID, registration number, business category, payout bank details, risk tier, KYB status override and financial ceilings are sensitive. Sensitive edits use maker-checker and a base version; the current value remains in force until the checker executes the change.\n\n**Support role.** Support sees descriptive merchant data and history only. Tax, registration, payout, ceiling, risk and AML details are redacted. Support never sees an AML suspension reason or AML case details.\n\n**Financials.** Wallet balances are derived from posted journal lines, not a mutable balance column. Open disputes, pending cash-outs and 30-day payment metrics link back to their own queues. This page never moves money and does not replace reconciliation or finance approvals.\n\n**History and pending changes.** Every field change is written to `detail_change_logs`. Sensitive edits carry a base version to prevent a stale proposal from overwriting a newer change. A maker may withdraw a pending change before a checker acts. A pending change is visible while the current value stays active.",
                "bodyAr": "مساحة `/merchants` هي سجل التشغيل للتجار. ليست شاشة لتحريك الأموال: تغييرات دورة الحياة والتعديلات الحساسة محكومة ومسجلة، وعندما تتطلب السياسة تُراجع من شخص ثانٍ.\n\n**دورة الحياة.** التاجر `PENDING` ما زال في مرحلة التأهيل. التاجر `ACTIVE` يمكنه التحصيل وفق ضوابط المخاطر. التاجر `SUSPENDED` لا يبدأ مدفوعات حية جديدة. التاجر `REJECTED` يمكنه تقديم طلب انضمام جديد. التاجر `CLOSED` للقراءة فقط. التعليق وإعادة التفعيل والإغلاق إجراءات حساسة.\n\n**التعليق العادي والطارئ.** التعليق العادي ينشئ طلب مراجعة ولا يسري إلا بعد الموافقة. التعليق الطارئ يسري فوراً ويجب أن يصادق عليه مدقق امتثال أو MLRO خلال 24 ساعة. إذا رُفضت المصادقة يبقى التعليق سارياً، ولا يُرفع إلا بموافقة إعادة تفعيل منفصلة. هذا تصميم آمن عند الفشل وليس فتحاً للوصول.\n\n**الحقول الوصفية والحساسة.** الاسم التجاري والاسم المعروض وشعار الموقع وجهات دعم التاجر وصفية. الاسم القانوني والرقم الضريبي ورقم التسجيل وفئة النشاط وبيانات الحساب البنكي ومستوى المخاطر وتجاوز حالة KYB والسقوف المالية حساسة. التعديل الحساس يستخدم منشئاً ومدققاً وإصداراً أساسياً، وتبقى القيمة الحالية سارية حتى ينفذ المدقق التغيير.\n\n**دور الدعم.** يرى الدعم بيانات التاجر الوصفية والسجل فقط. تُحجب بيانات الضريبة والتسجيل والحساب البنكي والسقوف والمخاطر وAML. لا يرى الدعم سبب تعليق AML ولا تفاصيل حالات AML.\n\n**المالية.** أرصدة المحافظ تُشتق من قيود اليومية وليس من عمود رصيد قابل للتعديل. النزاعات المفتوحة وطلبات السحب المعلقة ومؤشرات آخر 30 يوماً ترتبط بقوائمها الخاصة. هذه الصفحة لا تحرك الأموال ولا تستبدل التسويات أو موافقات المالية.\n\n**السجل والتغييرات المعلقة.** كل تغيير حقل يُسجل في `detail_change_logs`. التعديلات الحساسة تحمل إصداراً أساسياً لمنع الكتابة فوق تغيير أحدث. يمكن للمنشئ سحب تغيير معلق قبل أن يتصرف المدقق. يظل التغيير المعلق ظاهراً بينما القيمة الحالية سارية.",
                "humanErrorWarning": "NEVER use a quick status button as a substitute for an audited lifecycle action. NEVER reveal AML reasons or AML cases to Support. NEVER let a stale base version overwrite a newer merchant edit. NEVER close a merchant with a non-zero wallet balance or an open dispute.",
                "sopChecklist": [
                    "Confirm the merchant status and the requested lifecycle action.",
                    "Use standard suspension for planned actions; reserve emergency suspension for immediate risk.",
                    "For sensitive edits, record the maker reason and verify the base version.",
                    "For closure, confirm zero balance and no open disputes or cash-outs.",
                    "Check field history and pending changes before acting.",
                    "For Support, never expose tax, registration, payout, ceiling, risk or AML details."
                ],
                "tags": ["merchant", "lifecycle", "suspend", "reinstate", "close", "sensitive", "maker-checker", "support", "field-history", "kyb"]
            },
        ],
        "sopChecklist": [
            "Open /operator-cases and inspect attempt_step_logs for the exact HTTP status, timeout, and raw response.",
            "If supports_status_check = true, click Inquire Gateway Now.",
            "If there is no inquiry API, upload the daily statement or obtain written provider_reference confirmation.",
            "Propose a Maker-Checker resolution to SUCCEEDED or FAILED with evidence.",
            "For CONFLICT or HELD/MISMATCH, inspect inbound_events and the statement before resolving."
        ],
        "humanErrorWarning": "NEVER mark an UNKNOWN attempt as FAILED without checking the gateway first. Releasing the slot while the bank may have taken the money causes double charges or lost funds. Use Inquire, the statement, or Maker-Checker resolution.",
        "tags": [
            "14-state",
            "attempt",
            "lifecycle",
            "resolving",
            "unknown",
            "conflict",
            "held",
            "cases",
            "rb-01",
            "rb-05",
            "complete",
            "map",
            "attemptstatus",
            "means"
        ]
    },
    {
        "id": "book-8",
        "number": 8,
        "titleEn": "Double-Entry Accounting, Clearing Accounts, Fee Bearers & Statement Reconciliation",
        "titleAr": "المحاسبة المزدوجة وحسابات المقاصة ومتحملو الرسوم ومطابقة الكشوف",
        "summaryEn": "Debits, credits, the ten GL accounts, a complete T+1 settlement sweep, fee bearers, and statement reconciliation.",
        "summaryAr": "المدين والدائن وحسابات الدفتر العشرة ومسح تسوية T+1 الكامل ومتحملو الرسوم ومطابقة الكشوف.",
        "chapters": [
            {
                "id": "book-8-chapter-8.1",
                "number": "8.1",
                "titleEn": "Accounting From Zero — What Are Debits, Credits, and the 10 GL Accounts?",
                "bodyEn": "Even if you have never taken an accounting class, you can master our ledger in 5 minutes using one simple rule: **Every time money moves, we write a Journal Entry with at least one Debit (`Dr`, where value flows IN / asset increases) and at least one Credit (`Cr`, where value flows OUT / obligation or income increases), and `SUM(DEBIT)` must ALWAYS equal `SUM(CREDIT)`.**\n\nHere are the **10 General Ledger (`GLAccount`) types** in our platform:\n\n| GL Account Type | Normal Balance | Plain-English Meaning (What Does This Bucket Represent?) |\n| :--- | :--- | :--- |\n| **1. `TREASURY`** | **Debit (Asset)** | **Real Cash in Our Company Bank Account** (plus instant first-party NeomPay settlements). This is the actual money available to wire out when merchants request a Cash-Out. |\n| **2. `GATEWAY_CLEARING`** | **Debit (Asset / Receivable)** | **Money a Gateway Owes Us (`T+N` Pending Settlement).** When a customer pays `100 LYD` via Moamalat or DPay today, the gateway holds that cash for 1–3 days before wiring it to our bank. Each gateway + environment + credential set has its own `GATEWAY_CLEARING` account so we know *exactly* how much each partner owes us at any second! |\n| **3. `COMMISSION_RECEIVABLE`** | **Debit (Asset / Receivable)** | **Commission a `MERCHANT_DIRECT` Merchant Owes Us.** When a merchant uses their own gateway credentials, the `100 LYD` goes straight to the merchant's bank, so the merchant owes us our `3 LYD` software commission. |\n| **4. `PROVIDER_FEE_EXPENSE` / `GATEWAY_FEE_EXPENSE`** | **Debit (Expense)** | **What the Upstream Bank/Gateway Charged Us** to process the transaction (e.g., `0.80 LYD`). |\n| **5. `MERCHANT_WALLET`** | **Credit (Liability)** | **Money We Owe to a Specific Merchant.** Every merchant wallet on the portal is backed 1-to-1 by a `MERCHANT_WALLET` GL account. Its balance is computed directly from the ledger lines. |\n| **6. `PLATFORM_INCOME`** | **Credit (Revenue)** | **Our Company's Gross Commission Revenue** earned on confirmed payments (e.g., `3.00 LYD`). |\n| **7. `GATEWAY_FEE_ACCRUAL`** | **Credit (Liability)** | **Estimated Gateway Fees Waiting for the Bank Statement.** At the moment a `100 LYD` payment confirms on a T+N gateway, we estimate the gateway will take `0.80 LYD` fee when they wire us the money tomorrow. We hold `0.80 LYD` in `GATEWAY_FEE_ACCRUAL` until tomorrow's statement arrives and clears it. |\n| **8. `AML_HOLD`** | **Credit (Escrow Liability)** | **Frozen Money Under Compliance Investigation.** When a payment triggers an AML Hold rule, the money is **not** credited to the Merchant Wallet and **not** counted as Platform Income yet—it sits frozen in `AML_HOLD` until the `MLRO` approves Release or Void. |\n| **9. `CHARGEBACK_RESERVE`** | **Credit (Escrow Liability)** | **Disputed Money Escrowed During a Chargeback.** When a customer disputes a payment at their bank, and Finance approves the dispute reserve, we pull the `97 LYD` from the Merchant Wallet and `3 LYD` from Platform Income into `CHARGEBACK_RESERVE` until the dispute is Won or Lost. |\n| **10. `SUSPENSE`** | **Credit (Holding Liability)** | **Unmatched or Duplicate Money Awaiting Operator Resolution.** If a single-use link accidentally gets paid twice (because a late webhook arrived after a second attempt already paid the link), the second payment lands in `SUSPENSE` so it never double-credits the merchant and can be cleanly refunded. |",
                "tags": [
                    "accounting",
                    "zero",
                    "debits",
                    "credits",
                    "accounts",
                    "even",
                    "you",
                    "never",
                    "taken",
                    "class",
                    "master",
                    "ledger",
                    "minutes",
                    "one"
                ]
            },
            {
                "id": "book-8-chapter-8.2",
                "number": "8.2",
                "titleEn": "Walking Through a Complete Payment & T+1 Bank Sweep (Interactive T-Account Explorer)",
                "bodyEn": "Suppose a customer pays a **`100.0000 LYD`** link (`MERCHANT_ABSORBS` fee bearer, `3%` platform commission = `3.0000 LYD`, gateway fee = `0.8000 LYD` accrued):\n1. **Moment 1 — Today at 14:05 (Payment Confirms at Gateway):**\n   - `Dr GATEWAY_CLEARING (Moamalat)` = **`100.0000 LYD`** *(Moamalat now owes us 100 LYD)*\n   - `Dr GATEWAY_FEE_EXPENSE` = **`0.8000 LYD`** *(We record our 0.80 LYD gateway cost)*\n   - `Cr MERCHANT_WALLET` = **`97.0000 LYD`** *(Merchant sees +97.0000 LYD in their wallet)*\n   - `Cr PLATFORM_INCOME` = **`3.0000 LYD`** *(We earn 3.0000 LYD gross commission)*\n   - `Cr GATEWAY_FEE_ACCRUAL` = **`0.8000 LYD`** *(We expect Moamalat to deduct 0.80 LYD before wiring)*\n   - *Check:* Total Debits (`100.8000`) == Total Credits (`100.8000`).\n2. **Moment 2 — Tomorrow at 10:00 (We Upload Moamalat's CSV Statement in `/reconciliation` Showing `99.2000 LYD` Wired to Our Bank):**\n   - `Dr TREASURY` = **`99.2000 LYD`** *(99.20 LYD real cash lands in our bank)*\n   - `Dr GATEWAY_FEE_ACCRUAL` = **`0.8000 LYD`** *(Clears the accrued fee liability)*\n   - `Cr GATEWAY_CLEARING (Moamalat)` = **`100.0000 LYD`** *(Moamalat's IOU is now 0.0000 LYD!)*\n   - *What if Moamalat actually deducted `0.9000 LYD` fee instead of `0.8000 LYD`?* Our `StatementIngestor` automatically posts a **Fee Variance True-Up (Journal Entry 4)** of `0.1000 LYD` to `GATEWAY_FEE_EXPENSE`!\n\n---",
                "tags": [
                    "walking",
                    "through",
                    "complete",
                    "payment",
                    "t+1",
                    "bank",
                    "sweep",
                    "interactive",
                    "t-account",
                    "explorer",
                    "suppose",
                    "customer",
                    "pays",
                    "100"
                ]
            }
        ],
        "sopChecklist": [
            "Write at least one Debit and one Credit for every movement.",
            "Verify SUM(DEBIT) equals SUM(CREDIT) to 0.0000 LYD.",
            "Confirm ownership tags: merchant, gateway, route, currency, environment.",
            "Match statement rows by reference, amount, currency, value date, and window.",
            "Post fee variance separately; never edit the statement amount to force a match."
        ],
        "humanErrorWarning": "NEVER edit a wallet balance directly and never force a reconciliation match by changing the statement amount. Every movement must be a balanced journal entry. If the ledger invariant shows any drift other than 0.0000 LYD, halt automated cash-outs (RB-04).",
        "tags": [
            "double-entry",
            "accounting",
            "clearing",
            "accounts",
            "fee",
            "bearers",
            "statement",
            "reconciliation",
            "zero",
            "debits",
            "credits",
            "walking",
            "through",
            "complete"
        ]
    },
    {
        "id": "book-9",
        "number": 9,
        "titleEn": "Merchant Onboarding, KYB Document Verification & Duplicate Detection (`/join-requests` & `/kyb`)",
        "titleAr": "تأهيل التجار والتحقق من وثائق KYB وكشف التكرار (/join-requests و /kyb)",
        "summaryEn": "The join_requests lifecycle, the seven-point KYB checklist, document forensics, the KYB review queue, beneficial owners, expiry and duplicate detection.",
        "summaryAr": "دورة حياة join_requests وقائمة KYB ذات النقاط السبع وتحليل الوثائق والمالكون المستفيدون وكشف التكرار.",
        "chapters": [
            {
                "id": "book-9-chapter-9.1",
                "number": "9.1",
                "titleEn": "The Complete Onboarding Lifecycle (`join_requests`)",
                "bodyEn": "When a business applies to use our gateway, their application moves through the `join_requests` state machine:\n- `DRAFT` (Merchant is still filling out forms) -> `SUBMITTED` (Merchant clicked Submit; L1 AML Screening runs automatically and SLA timer starts) -> `IN_REVIEW` (Assigned to an Operator/Compliance reviewer).\n- From `IN_REVIEW`, you have three choices:\n  1. **Request Information (`INFO_REQUESTED`):** If a document is blurry, expired, or missing a page, click **Request Info** and specify which item needs replacement. This **pauses the SLA timer** until the merchant responds!\n  2. **Approve (`APPROVED` or `PENDING_CHECKER`):** Under our default `RISK_BASED` Four-Eyes policy (`OD-2`), a second Checker is required whenever: (a) proposed risk tier is `HIGH`, (b) AML screening is not `CLEAR`, (c) any owner is a PEP, (d) the business category is high-risk, (e) expected monthly volume exceeds the threshold, (f) the payout bank account name differs from the legal name, or (g) the applicant matched a duplicate/prior rejection flag.\n  3. **Reject (`REJECTED`):** Select an official enumerated `decision_reason_code` (`INCOMPLETE_DOCUMENTS`, `UNVERIFIABLE_BUSINESS`, `PROHIBITED_ACTIVITY`, or `POLICY`).",
                "tags": [
                    "complete",
                    "onboarding",
                    "lifecycle",
                    "join",
                    "requests",
                    "business",
                    "applies",
                    "gateway",
                    "application",
                    "moves",
                    "through",
                    "state",
                    "machine",
                    "draft"
                ]
            },
            {
                "id": "book-9-chapter-9.2",
                "number": "9.2",
                "titleEn": "The 7-Point KYB Reviewer Checklist (Preventing Onboarding Fraud)",
                "bodyEn": "Before approving any Join Request in `/join-requests`, verify every item below:\n1. **Check the Duplicate Detection Banner First:** Did the system flag `DUPLICATE_DOCUMENT` (same `sha256` file hash uploaded by another merchant) or `DUPLICATE_OR_RELATED` (matching Tax ID, Registration No., Owner National ID, Bank IBAN, or Phone from a rejected/suspended merchant)? If flagged, inspect the linked merchant record before proceeding.\n2. **Verify Antivirus & File Integrity:** Ensure every `kyb_documents` row shows `av_status = CLEAN` and open the preview to confirm it is a genuine, legible document.\n3. **Cross-Check Legal Name, Registration No. & Tax Certificate:** The Arabic legal name on the Commercial Registry (`السجل التجاري`) and Tax Certificate (`شهادة السداد الضريبي`) must match `merchants.legal_name` character-for-character, and `expires_on` must be in the future.\n4. **Verify Beneficial Owners (The 25% Rule):** Confirm that every natural person owning `>= 25%` (or exercising control as Director/Signatory) is listed in `beneficial_owners` with a valid National ID/Passport and `screening_status = CLEAR` (or a dispositioned false positive).\n5. **Verify Payout Bank Account Ownership:** Open the `BANK_LETTER` document and confirm the IBAN belongs to the **merchant's legal entity name** (not a personal account of an unrelated individual).\n6. **Verify Business Activity & Volume Plausibility:** Confirm `expected_monthly_volume` is realistic for the declared `business_category`.\n7. **Assign the Appropriate `proposed_risk_tier` (`LOW`, `STANDARD`, `HIGH`).**\n\n---",
                "tags": [
                    "7-point",
                    "kyb",
                    "reviewer",
                    "checklist",
                    "preventing",
                    "onboarding",
                    "fraud",
                    "before",
                    "approving",
                    "any",
                    "join",
                    "request",
                    "join-requests",
                    "verify"
                ]
            },
            {
                "id": "book-9-chapter-9.3",
                "number": "9.3",
                "titleEn": "KYB Review Queue, Document Forensics & Per-Document Decisions (`/kyb`)",
                "titleAr": "قائمة مراجعة KYB وتحليل الوثائق والقرارات لكل وثيقة (/kyb)",
                "bodyEn": "The `/kyb` workspace is the document-level review queue. It is not a second join-request decision screen: the seven-point checklist, screening context and final four-eyes decision remain on `/join-requests/:id`.\n\n**Queue scope.** The queue shows documents for submitted/active onboarding and active merchants. Documents that belong only to a `DRAFT` join request are excluded from reviewer queues (Edge Case 116). Each row shows the merchant, document type, original file, status, antivirus status, expiry state, duplicate count, related join request/SLA, uploader and reviewer.\n\n**Safe review order.** 1. Confirm `av_status = CLEAN`. A `PENDING` or `INFECTED` file cannot be opened or accepted. 2. Open the secure preview and verify the file is genuine, legible and of the declared type. 3. Compare the legal name, registration number, tax certificate and expiry with the merchant profile. 4. For a `BANK_LETTER`, verify the IBAN/account holder belongs to the merchant legal entity. 5. Read the required-document readiness panel before approving the broader join request. 6. Record the document decision and a clear note.\n\n**Duplicate documents.** A duplicate is the same `sha256` hash under an unrelated merchant, not merely the same file name. A duplicate does not block automatically: it raises a warning and requires written justification before acceptance. Repeated reuse across multiple merchants can open an AML case. Never ignore a duplicate because the preview looks clean; investigate the linked merchant and join request first.\n\n**Expiry and replacements.** A document within 30 days of expiry is `DUE_SOON`; after the date it is `EXPIRED` and cannot be accepted as current evidence. Request a replacement when the document belongs to an open join request: the document is rejected, the join request moves to `INFO_REQUESTED`, and the SLA pauses. For an active merchant, request periodic re-verification instead. A replacement is always a new `kyb_documents` row; the platform never overwrites the old file.\n\n**Access and audit.** Document bytes are encrypted at rest and list/detail APIs never expose ciphertext. Every preview, review, replacement request and automatic expiry is written to `audit_log`. Merchant messages use neutral KYB wording and never expose AML, sanctions, PEP or watchlist details.",
                "bodyAr": "مساحة `/kyb` هي قائمة مراجعة الوثائق على مستوى كل وثيقة. ليست شاشة قرار ثانية لطلب الانضمام: قائمة النقاط السبع وسياق الفحص وقرار الأربع أعين النهائي تبقى في `/join-requests/:id`.\n\n**نطاق القائمة.** تعرض القائمة وثائق طلبات الانضمام المقدمة والتجار النشطين. لا تظهر وثائق طلب بحالة `DRAFT` في قوائم المراجعين. يعرض كل صف التاجر ونوع الوثيقة والملف وحالة الوثيقة وحالة مكافحة الفيروسات والانتهاء وعدد التكرارات وطلب الانضمام وSLA ومن رفعها وراجعها.\n\n**ترتيب المراجعة الآمن.** تأكد أولاً أن `av_status = CLEAN`. لا يمكن فتح أو قبول ملف بحالة `PENDING` أو `INFECTED`. افتح المعاينة الآمنة وتأكد أن الملف حقيقي ومقروء ومن النوع المعلن. طابق الاسم القانوني ورقم التسجيل وشهادة الضريبة وتاريخ الانتهاء مع ملف التاجر. في خطاب البنك تحقق من أن الحساب يخص الكيان القانوني. راجع لوحة الوثائق المطلوبة قبل الموافقة على طلب الانضمام. سجّل قرار الوثيقة وملاحظة واضحة.\n\n**الوثائق المكررة.** التكرار هو تطابق بصمة `sha256` لدى تاجر غير مرتبط، وليس مجرد تطابق اسم الملف. لا يمنع التكرار القبول تلقائياً، لكنه يطلق تحذيراً ويتطلب تبريراً مكتوباً قبل القبول. التكرار المتعدد قد يفتح حالة AML. لا تتجاهل التكرار لمجرد أن المعاينة تبدو سليمة؛ افحص التاجر وطلب الانضمام المرتبطين أولاً.\n\n**الانتهاء والبدائل.** الوثيقة التي تنتهي خلال 30 يوماً تظهر `DUE_SOON`، وبعد تاريخ الانتهاء تصبح `EXPIRED` ولا تصلح كدليل حالي. اطلب بديلاً عندما تنتمي الوثيقة إلى طلب انضمام مفتوح: تُرفض الوثيقة وينتقل الطلب إلى `INFO_REQUESTED` وتتوقف مؤقتاً مهلة SLA. أما التاجر النشط فتُطلب منه إعادة تحقق دورية. البديل دائماً صف جديد في `kyb_documents` ولا يتم استبدال الملف القديم فوق نفسه.\n\n**الوصول والتدقيق.** محتوى الوثائق مشفر عند التخزين ولا تعرض واجهات القائمة أو التفاصيل النص المشفر. كل معاينة أو قرار أو طلب بديل أو انتهاء تلقائي يُسجل في `audit_log`. رسائل التاجر تستخدم لغة KYB محايدة ولا تكشف تفاصيل AML أو العقوبات أو PEP أو قوائم المراقبة.",
                "humanErrorWarning": "NEVER preview or accept a file whose av_status is not CLEAN. NEVER ignore a DUPLICATE_DOCUMENT warning without documented justification. NEVER accept an expired document as current evidence. NEVER expose AML, sanctions, PEP or watchlist details to a merchant.",
                "sopChecklist": [
                    "Confirm the document is UPLOADED, unexpired and av_status = CLEAN.",
                    "Open the secure preview and verify the file is genuine and legible.",
                    "Check the type, legal name, registration/tax data, expiry and bank account holder.",
                    "Investigate every duplicate SHA-256 match before accepting.",
                    "Ask for a replacement or active-merchant re-verification instead of accepting expired evidence.",
                    "Leave a clear decision note; complete the join-request checklist and decision on the Join Request page."
                ],
                "tags": [
                    "kyb", "review", "queue", "document", "antivirus", "sha256", "duplicate",
                    "expiry", "replacement", "revalidation", "audit", "forensics", "join-requests"
                ]
            }
        ],
        "sopChecklist": [
            "Check the duplicate detection banner first.",
            "Verify every kyb_documents row shows av_status = CLEAN and open the preview.",
            "Cross-check legal name, registration number, tax certificate, and expiry dates.",
            "Verify every beneficial owner at or above 25% and their screening disposition.",
            "Verify the payout IBAN belongs to the merchant's legal entity and assign the proposed risk tier."
        ],
        "humanErrorWarning": "NEVER activate a PENDING merchant before KYB and AML are complete. NEVER ignore a DUPLICATE_DOCUMENT or DUPLICATE_OR_RELATED flag. NEVER open an AV-pending or infected KYB file. NEVER accept an expired document. NEVER approve a join request you prepared yourself under ADMIN_ASSISTED onboarding. NEVER expose AML, sanctions, PEP or watchlist details to a merchant.",
        "tags": [
            "merchant",
            "onboarding",
            "kyb",
            "document",
            "verification",
            "duplicate",
            "detection",
            "join-requests",
            "complete",
            "lifecycle",
            "join",
            "requests",
            "7-point",
            "reviewer",
        ]
    },
    {
        "id": "book-10",
        "number": 10,
        "titleEn": "The 7-Layer AML & Compliance Program, Screening Dispositions & CBL Reporting (`/aml/*`)",
        "titleAr": "برنامج مكافحة غسل الأموال ذو 7 طبقات وتصنيفات الفحص وإبلاغ المصرف المركزي (/aml/*)",
        "summaryEn": "The seven AML layers, screening dispositions, correlated escalation, no-tipping-off, and CBL regulatory reporting.",
        "summaryAr": "طبقات مكافحة غسل الأموال السبع وتصنيفات الفحص والتصعيد المترابط وعدم الإفصاح وإبلاغ مصرف ليبيا المركزي.",
        "chapters": [
            {
                "id": "book-10-chapter-10.1",
                "number": "10.1",
                "titleEn": "How Our 7 AML Layers Work Together",
                "bodyEn": "1. **Layer 1 (Onboarding Screening):** Screens the merchant entity and all Beneficial Owners against Sanctions, PEP, Adverse Media, and Internal Watchlists upon Join Request submission. **Fail-Closed Rule:** If the screening provider is down (`result = ERROR`), the system blocks approval (`503 SCREENING_UNAVAILABLE`) until screening succeeds.\n2. **Layer 2 (Periodic & List-Update Re-Screening):** Automatically re-screens active merchants when watchlists update or on their tier schedule.\n3. **Layer 3 (Hot-Path Transaction Posture Check):** Runs inside the checkout initiation guard in `< 5ms` against local watchlists, merchant status, and fast `aml_rules`.\n4. **Layer 4 (Confirmation-Time & Batch Monitoring):** Evaluates `SINGLE_AMOUNT`, `CUMULATIVE_WINDOW` (aggregating across all links/apps of a subject so splitting a sale across 5 links never evades a threshold—Edge Case 125!), `STRUCTURING` (clustering payments just below a threshold), and `MERCHANT_DIRECT_AMOUNT`.\n   - **Correlated Escalation Rule:** If a payment triggers both a Velocity `FLAG` rule and an AML rule on the same attempt, case severity automatically escalates to **`CRITICAL`** (4-hour SLA).\n5. **Layer 5 (Case Management — `/aml/cases`):** Compliance analysts (`COMPLIANCE`, Maker) investigate and propose **Release (`RELEASED`)**, **Void & Refund to Payer (`REJECTED_VOID`)**, **Freeze (`FROZEN`)**, or **Escalate to STR (`ESCALATED_STR`)**. Only the **`MLRO`** (Checker) can approve the resolution, which atomically posts the `AML_RELEASE` or `AML_VOID` journal entry and finalizes the payment attempt!\n6. **Layer 6 (Regulatory Reporting — `/aml/reports`):** Generates `LARGE_TRANSACTION` (LTR), `SUSPICIOUS_ACTIVITY` (STR), and `PERIODIC_RETURN` filings. **Safety Guard (`OD-1`):** A `PROVISIONAL` reporting rule can detect and record internally, but the database refuses to submit a live regulatory filing unless the rule has been promoted to `CONFIRMED` with a written CBL circular reference (`source_reference`).\n7. **Layer 7 (No Tipping-Off & 5-Year Retention):** Strictly blocks `AML-CONFIDENTIAL` data from non-compliance staff and merchant notifications, and preserves all audit/ledger records under the 5-year retention policy (`OD-4`).\n\n---",
                "tags": [
                    "aml",
                    "layers",
                    "work",
                    "together",
                    "layer",
                    "onboarding",
                    "screening",
                    "screens",
                    "merchant",
                    "entity",
                    "beneficial",
                    "owners",
                    "against",
                    "sanctions"
                ]
            }
        ],
        "sopChecklist": [
            "Confirm the onboarding screening result is CLEAR or dispositioned; fail closed on ERROR.",
            "Review hot-path, confirmation-time, and batch AML alerts with correlated escalation.",
            "Disposition every screening candidate with evidence.",
            "Propose RELEASED, REJECTED_VOID, FROZEN, or ESCALATED_STR for MLRO approval.",
            "Use neutral POLICY wording in every merchant or payer notification; never tip off."
        ],
        "humanErrorWarning": "NEVER mention AML, Sanctions, PEP, watchlists, or an STR in any merchant or payer message. NEVER submit a live regulatory filing from a PROVISIONAL rule without a written CBL circular reference. Use the neutral POLICY reason code.",
        "tags": [
            "7-layer",
            "aml",
            "compliance",
            "program",
            "screening",
            "dispositions",
            "cbl",
            "reporting",
            "layers",
            "work",
            "together"
        ]
    },
    {
        "id": "book-11",
        "number": 11,
        "titleEn": "Disputes, Chargebacks, Refunds, Cash-Outs & Negative Balance Ceilings",
        "titleAr": "النزاعات والاسترداد العكسي والاستردادات والسحوبات وسقوف الرصيد السالب",
        "summaryEn": "Automated chargeback drafting, refund caps, three-phase refunds, negative balance ceilings, and cash-out safety.",
        "summaryAr": "إعداد الاسترداد العكسي الآلي وحدود الاسترداد والاسترداد بثلاث مراحل وسقوف الرصيد السالب وأمان السحوبات.",
        "chapters": [
            {
                "id": "book-11-chapter-11.1",
                "number": "11.1",
                "titleEn": "How Automated Chargeback Drafting Works (`/disputes` & `/adjustments`)",
                "bodyEn": "When an upstream switch (like Moamalat or MPGS) notifies us via webhook or statement that a cardholder disputed a payment:\n1. Our system creates a `disputes` row (`UNIQUE(gateway_id, external_dispute_ref)` so duplicate webhooks never draft two chargebacks).\n2. If a voluntary refund was already partially issued on that payment earlier, the system automatically caps the chargeback amount to the **unrefunded remainder** (`settled_amount - executed_refunds`, Edge Case 126).\n3. The non-human service identity **`SYSTEM_AUTOMATION`** automatically creates a `DRAFT -> PENDING_REVIEW` `CHARGEBACK` Adjustment as the **Maker**.\n4. **Human Authorization Required:** `SYSTEM_AUTOMATION` is strictly forbidden from acting as a Checker. No money moves until a human **`FINANCE` Checker** reviews and approves the adjustment in `/approvals`!\n5. **What if the Merchant Already Cashed Out Their Wallet?**\n   - Each merchant has a `negative_balance_ceiling` (default `0.0000 LYD` for new merchants; adjustable via Maker-Checker).\n   - If the chargeback stays within their ceiling, the wallet balance goes negative (Journal Entry 15, e.g., `-57.0000 LYD`), and every future payment the merchant receives automatically nets against that negative balance until it returns to `+0.0000 LYD`!\n   - If the chargeback would breach the ceiling, the adjustment is held in `PENDING_REVIEW` and opens a **`P1` Operator Case** so Finance can collect from the merchant or net against pending cash-outs.",
                "tags": [
                    "automated",
                    "chargeback",
                    "drafting",
                    "works",
                    "disputes",
                    "adjustments",
                    "upstream",
                    "switch",
                    "like",
                    "moamalat",
                    "mpgs",
                    "notifies",
                    "via",
                    "webhook"
                ]
            },
            {
                "id": "book-11-chapter-11.2",
                "number": "11.2",
                "titleEn": "Safe Refunds (Three-Phase Non-Deadlocking Execution)",
                "bodyEn": "When a Finance Checker approves a `REFUND` adjustment on a settled payment:\n- **Phase 1 (Claim):** Locks the attempt, verifies that `rail.capabilities.refund` (or `partial_refund`) is supported, verifies `refund_window_days` has not expired, checks `SUM(refunds) + new_refund <= settled_amount`, and sets adjustment state to `EXECUTING`.\n- **Phase 2 (Gateway Call):** Executes the gateway's `REFUND` flow over the network with no database lock held open. If the gateway times out, the adjustment safely stays in `EXECUTING` (never double-refunding) until inquiry/reconciliation confirms the outcome.\n- **Phase 3 (Finalize):** Once the gateway returns `provider_refund_ref`, posts Journal Entry 9 (or 14 for NeomPay) and marks the adjustment `EXECUTED`.\n\n---",
                "tags": [
                    "safe",
                    "refunds",
                    "three-phase",
                    "non-deadlocking",
                    "execution",
                    "finance",
                    "checker",
                    "approves",
                    "refund",
                    "adjustment",
                    "settled",
                    "payment",
                    "phase",
                    "claim"
                ]
            }
        ],
        "sopChecklist": [
            "Lock the attempt and sum executed and executing refunds before drafting a chargeback.",
            "Cap the chargeback to settled_amount minus executed refunds.",
            "Require a human FINANCE Checker; SYSTEM_AUTOMATION is Maker only.",
            "Check the merchant's negative_balance_ceiling before releasing any adjustment.",
            "Execute refunds in three phases: claim, gateway call with no DB lock, finalize."
        ],
        "humanErrorWarning": "NEVER let SYSTEM_AUTOMATION approve its own chargeback draft. NEVER refund more than settled_amount minus executed refunds. NEVER release a cash-out that breaches the merchant's negative_balance_ceiling without Finance approval and a recovery plan.",
        "tags": [
            "disputes",
            "chargebacks",
            "refunds",
            "cash-outs",
            "negative",
            "balance",
            "ceilings",
            "automated",
            "chargeback",
            "drafting",
            "works",
            "adjustments",
            "safe",
            "three-phase"
        ]
    },
    {
        "id": "book-12",
        "number": 12,
        "titleEn": "Platform Profitability, Liquidity, Solvency & The 12 Go-Live Gates",
        "titleAr": "ربحية المنصة والسيولة والملاءة وبوابات الإطلاق الاثنتا عشرة",
        "summaryEn": "Reading profitability and liquidity from journal_lines, clearing ageing, the ledger invariant, and the twelve go-live gates.",
        "summaryAr": "قراءة الربحية والسيولة من journal_lines وعمر المقاصة وثبات الدفتر وبوابات الإطلاق الاثنتي عشرة.",
        "chapters": [
            {
                "id": "book-12-chapter-12.1",
                "number": "12.1",
                "titleEn": "Reading the Profitability & Liquidity Dashboards (`/finance/profitability` & `/finance/liquidity`)",
                "bodyEn": "Every number on our Finance dashboards is computed directly from `journal_lines`:\n- **Gross Commission Revenue:** Total credits minus debits on `PLATFORM_INCOME` (note: commission on `AML_HOLD` payments is recognized only after the hold is released).\n- **Realized Gateway Cost:** Total `PROVIDER_FEE_EXPENSE` + `GATEWAY_FEE_EXPENSE` (including statement fee variance true-ups).\n- **Net Revenue:** Gross Commission minus Realized Gateway Cost.\n- **Treasury Cover Ratio:** `(TREASURY Balance + GATEWAY_CLEARING Balances) / (MERCHANT_WALLET Balances + AML_HOLD + CHARGEBACK_RESERVE)`.\n- **Clearing Ageing Buckets:** Shows how much money sits in `GATEWAY_CLEARING` for `T+0`, `T+1`, `T+2`, and `> settlement_lag_days`. If a gateway has not wired funds past its lag window, follow up with the partner bank before approving large cash-outs.\n- **Ledger Invariant Monitor (`/finance/invariant-check`):** Must always read **`0.0000 LYD` drift**. If any drift is detected, automated payouts halt immediately (`Runbook RB-04`).\n\n\n---\n\nNeither `activateGatewayVersion` (promoting a draft to `LIVE`) nor `rollbackGatewayVersion` (rolling back to a previous version) can execute unless **all 12 Go-Live Gates** pass against persisted `GatewayVersionEvidence`:\n1. **Gate 1:** Four-Eyes Maker-Checker Approval (`checker_user_id != maker_user_id`).\n2. **Gate 2:** All 15 Automated Sandbox Scenarios Passed Green.\n3. **Gate 3:** Amount Pipeline Contract Test Passed (proving `amount_scale`, `amount_precision`, and `amount_rounding` on wire values).\n4. **Gate 4:** Reference Format Contract Test Passed (proving charset and max-length rules).\n5. **Gate 5:** Cryptographic Signature Contract Test Passed against captured partner vectors.\n6. **Gate 6:** Channel Verification Strength Enforced (`must_inquire = true` on all weak/hint channels).\n7. **Gate 7:** Named Rollback Version (`rollback_version_id`) Configured.\n8. **Gate 8:** Route Limits, Commission Profile, and Statement Parser Preview Verified.\n9. **Gate 9:** Evidence Level `VERIFIED` (or signed executive `risk_acceptance_note` for `HIGH_RISK` gateways; or green staging contract suite for `INTERNAL` NeomPay).\n10. **Gate 10:** PCI Scope Review Passed for any rail using a `PAN`-typed field.\n11. **Gate 11:** Canary Traffic Plan Configured.\n12. **Gate 12:** Route Health Alerts & Runbooks Wired.",
                "tags": [
                    "reading",
                    "profitability",
                    "liquidity",
                    "dashboards",
                    "finance",
                    "number",
                    "computed",
                    "directly",
                    "journal",
                    "lines",
                    "gross",
                    "commission",
                    "revenue",
                    "total"
                ]
            }
        ],
        "sopChecklist": [
            "Read Gross Commission Revenue from PLATFORM_INCOME credits minus debits.",
            "Read Realized Gateway Cost from PROVIDER_FEE_EXPENSE plus GATEWAY_FEE_EXPENSE.",
            "Check Treasury Cover Ratio and clearing ageing buckets before large cash-outs.",
            "Confirm the Ledger Invariant Monitor reads exactly 0.0000 LYD drift.",
            "Do not release a gateway version until all twelve go-live gates have evidence."
        ],
        "humanErrorWarning": "NEVER waive a money-safety go-live gate under delivery pressure. NEVER treat GATEWAY_CLEARING as spendable cash. If any ledger drift appears, halt payouts and follow RB-04 before approving large merchant cash-outs.",
        "tags": [
            "platform",
            "profitability",
            "liquidity",
            "solvency",
            "go-live",
            "gates",
            "reading",
            "dashboards",
            "finance"
        ]
    }
];

// Book 7-12 operational lookups. The canonical registry lives in
// glossaryData.ts so Ctrl+K can index it together with the glossary, but it is
// re-exported here because Book 7 (runbooks) and Book 10/11 (edge cases) are the
// chapters that consume it.
export {
    EDGE_CASE_DEFINITIONS as BOOKS_PART_2_EDGE_CASES,
    RUNBOOK_DEFINITIONS as BOOKS_PART_2_RUNBOOKS,
} from "./glossaryData";

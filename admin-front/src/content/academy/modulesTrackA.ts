import type { AcademyModule } from "./types";

export const ACADEMY_MODULES_TRACK_A: AcademyModule[] = [
    {
        "id": "M1",
        "code": "M1",
        "letter": "A–C",
        "titleEn": "Foundations From Zero — How Digital Payments, Links, Slots & Zero-Trust Security Work",
        "titleAr": "الأساسيات من الصفر — كيف تعمل المدفوعات الرقمية والروابط والخانات وأمان الثقة الصفرية",
        "summaryEn": "Follow one payment from link to bank, understand slot locks, and learn why the browser is never trusted.",
        "summaryAr": "تابع دفعة من الرابط إلى البنك وافهم أقفال الخانات ولماذا لا يُوثق بالمتصفح أبداً.",
        "tracks": [
            "SUPPORT",
            "OPERATIONS",
            "COMPLIANCE",
            "FINANCE",
            "GATEWAY_ARCHITECT",
            "MASTER_OPERATOR"
        ],
        "lessons": [
            {
                "id": "M1-L1",
                "titleEn": "The Life of a Payment (Who Are the 4 Players?)",
                "bodyEn": "Imagine a customer named **Tariq** wants to pay **`250.000 LYD`** to **Al-Madina Clinic** for a medical checkup.\nThere are **4 players** in this story:\n1. **The Merchant (Al-Madina Clinic):** Uses our **Merchant Portal** to create a digital bill called a **Payment Link** for `250.000 LYD`.\n2. **The Payer (Tariq):** Clicks the link on his phone, opening our **Checkout Page**.\n3. **Our Platform (The Payment Gateway):** Shows Tariq the available payment methods (**Rails** like Sadad, Edfali, Moamalat Card, LYPay), locks the link so nobody else can pay the same bill at the same time, talks to the bank, and records the accounting entry.\n4. **The Upstream Gateway / Bank Switch (e.g., Almadar Sadad or Moamalat National Switch):** The external institution that actually holds Tariq's money and verifies his SMS OTP or card PIN."
            },
            {
                "id": "M1-L2",
                "titleEn": "Wallets, Applications, Payment Links & The Single-Use Slot Lock",
                "bodyEn": "Before a Merchant can create a Payment Link, they set up two building blocks inside their account:\n- **A Wallet (`wallets`):** The digital account where the merchant's money accumulates on our platform. Each wallet has a single currency (default `LYD`) and is tied 1-to-1 to a **`MERCHANT_WALLET` General Ledger Account**.\n- **An Application (`applications`):** Represents one sales channel of the merchant (for example, *\"Clinic Website\"*, *\"WhatsApp Billing Desk\"*, or *\"Main Reception POS\"*).\n  - **Hard Rule:** Every Application is connected to **exactly one Wallet** (`assigned_wallet_id`). Why? So there is never any confusion about which wallet receives the money when a link is paid!\n\nWhen a customer opens a **Single-Use Payment Link (`use_count = 1`)** and clicks \"Pay with Sadad\", what stops them from opening the same link on a second phone and paying the same invoice twice?\n- **The Atomic Slot Reservation (`active_locked_count`):** The instant Tariq clicks \"Pay\", our database locks the link row and sets `active_locked_count = 1`.\n- Our database enforces the formula: **`confirmed_count + active_locked_count <= use_count`**.\n- While Tariq's attempt is in progress (`active_locked_count = 1`), anyone else opening that single-use link sees *\"A payment is currently in progress for this link\"*.\n- The lock is released **only** if Tariq's attempt ends in `FAILED`, `CANCELLED`, or `EXPIRED`. If Tariq's attempt becomes **`UNKNOWN`** (because the bank timed out), the lock stays **HELD** so Tariq cannot accidentally pay twice while we verify with the bank!"
            },
            {
                "id": "M1-L3",
                "titleEn": "Why We Never Trust the Customer's Browser (Zero-Trust Checkout)",
                "bodyEn": "In web browsers, customers (or attackers) can change anything on their screen:\n- They can modify the URL bar after a redirect to say `?status=success&amount=250.000`.\n- They can open the browser's Developer Console (`F12`) and trigger a JavaScript callback like `Lightbox.completeCallback()`.\n- They can try to send `\"amount\": 0.01` in an API request body.\n\n**How our platform defeats all three attacks automatically:**\n1. **Checkout Never Accepts Amounts from the Browser:** The `/initiate` and `/confirm` APIs do not even have an `amount` field! `core-back` reads the amount strictly from `payment_links.amount` in the database.\n2. **Return URLs and Browser Callbacks Are \"Doorbells\", Not Proof:** When a browser hits `/return/:token` or `/client-event`, our server transitions the attempt to `VERIFYING` and makes a secure, server-to-server **`VERIFY` (Inquiry)** call directly to the bank's server. Money is posted **only** when the bank's server confirms all **5 Trusted Success Facts** (Status = Success, Our Reference Matches, Settled Amount Matches, Currency Matches, Environment Matches)."
            }
        ],
        "lab": {
            "id": "LAB-01",
            "titleEn": "The Payment & Tamper-Detection Tracer",
            "descriptionEn": "- **What the Student Sees in the Lab UI:** An interactive 4-column visual simulation showing `[Payer's Browser] -> [checkout-back] -> [core-back + Database] -> [Bank Switch]`.\n- **Step 1 Task:** The student clicks **\"Start 250.000 LYD Payment\"**, observes `active_locked_count` change from `0` to `1`, and must answer what happens when a second browser tab tries to initiate on the same link (*Correct action: Block second tab with `SLOT_RESERVATION_FAILED`*).\n- **Step 2 Task (Attack Simulation):** The simulated payer intercepts the browser redirect and changes the URL to `/return/tok_123?status=PAID&amount=250.000` without paying at the bank. The lab asks the student to choose how `core-back` responds:\n  - *Option A (Fatal Error):* Mark the attempt `SUCCEEDED` and credit the merchant wallet. *(Triggers red incident screen: \"You just credited 250 LYD of fake money from a forged browser URL!\")*\n  - *Option B (Fatal Error):* Mark the attempt `FAILED` immediately. *(Triggers warning: \"A real customer might have paid while their browser query string was stripped!\")*\n  - *Option C (Correct):* Treat `/return` as an untrusted hint, transition to `VERIFYING`, and run the server-to-server `VERIFY` inquiry against the bank switch.",
            "scenarios": [
                {
                    "id": "LAB-01-S1",
                    "titleEn": "Second tab on a single-use link",
                    "promptEn": "Tariq starts a 250.000 LYD payment on a single-use link and the slot is locked. A second browser tab opens the same link. What should happen?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Allow the second tab to start another attempt.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! Two attempts on one single-use invoice can both reach the bank and charge the payer twice."
                        },
                        {
                            "id": "b",
                            "labelEn": "Block the second tab with SLOT_RESERVATION_FAILED.",
                            "feedbackEn": "Correct. The atomic slot reservation protects the single-use link until the first attempt terminates."
                        },
                        {
                            "id": "c",
                            "labelEn": "Delete the link and ask the customer to create a new one.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! Deleting the link destroys the audit trail and the in-flight attempt reference."
                        }
                    ]
                },
                {
                    "id": "LAB-01-S2",
                    "titleEn": "Forged browser return URL",
                    "promptEn": "The payer edits the URL to /return/tok_123?status=PAID&amount=250.000 without paying at the bank. How should core-back respond?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Mark SUCCEEDED and credit the merchant wallet.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You just credited 250 LYD of fake money from a forged browser URL."
                        },
                        {
                            "id": "b",
                            "labelEn": "Mark FAILED immediately.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! A real customer might have paid while their browser query string was stripped."
                        },
                        {
                            "id": "c",
                            "labelEn": "Treat /return as an untrusted hint, transition to VERIFYING, and run the server-to-server VERIFY inquiry.",
                            "feedbackEn": "Correct. Only a server-trusted channel can prove the five success facts."
                        }
                    ]
                }
            ]
        },
        "quiz": [
            {
                "id": "QUIZ-M1-Q1",
                "questionEn": "Why is every Merchant `Application` required by the database schema to have `assigned_wallet_id NOT NULL` (connected to exactly one Wallet)?",
                "options": [
                    {
                        "text": "To limit merchants to one currency across their entire company.",
                        "correct": false,
                        "explanation": "Incorrect. A Merchant can create multiple Wallets and multiple Applications, but each Application binds to one specific Wallet so the ledger always knows which `MERCHANT_WALLET` GL account to credit."
                    },
                    {
                        "text": "To eliminate settlement ambiguity so every Payment Link and POS terminal under that Application has a single, deterministic destination Wallet.",
                        "correct": true,
                        "explanation": "A Merchant can create multiple Wallets and multiple Applications, but each Application binds to one specific Wallet so the ledger always knows which `MERCHANT_WALLET` GL account to credit."
                    },
                    {
                        "text": "Because a Merchant is only allowed to create one Wallet in total.",
                        "correct": false,
                        "explanation": "Incorrect. A Merchant can create multiple Wallets and multiple Applications, but each Application binds to one specific Wallet so the ledger always knows which `MERCHANT_WALLET` GL account to credit."
                    }
                ],
                "explanation": "A Merchant can create multiple Wallets and multiple Applications, but each Application binds to one specific Wallet so the ledger always knows which `MERCHANT_WALLET` GL account to credit.",
                "critical": false
            },
            {
                "id": "QUIZ-M1-Q2",
                "questionEn": "A customer opens a Single-Use Payment Link (`use_count = 1`, `infinite_use = false`), enters their phone number for Sadad, and receives an SMS OTP. At this exact moment, what are `confirmed_count` and `active_locked_count` on the link?",
                "options": [
                    {
                        "text": "`confirmed_count = 1`, `active_locked_count = 0`",
                        "correct": false,
                        "explanation": "Incorrect. The slot is reserved (`active_locked_count = 1`) at initiation and only moves to `confirmed_count = 1` (releasing `active_locked_count = 0`) when the payment reaches `SUCCEEDED`."
                    },
                    {
                        "text": "`confirmed_count = 0`, `active_locked_count = 0`",
                        "correct": false,
                        "explanation": "Incorrect. The slot is reserved (`active_locked_count = 1`) at initiation and only moves to `confirmed_count = 1` (releasing `active_locked_count = 0`) when the payment reaches `SUCCEEDED`."
                    },
                    {
                        "text": "`confirmed_count = 0`, `active_locked_count = 1`",
                        "correct": true,
                        "explanation": "The slot is reserved (`active_locked_count = 1`) at initiation and only moves to `confirmed_count = 1` (releasing `active_locked_count = 0`) when the payment reaches `SUCCEEDED`."
                    }
                ],
                "explanation": "The slot is reserved (`active_locked_count = 1`) at initiation and only moves to `confirmed_count = 1` (releasing `active_locked_count = 0`) when the payment reaches `SUCCEEDED`.",
                "critical": false
            },
            {
                "id": "QUIZ-M1-Q3",
                "questionEn": "While a customer's payment attempt is in `UNKNOWN` status (because the bank timed out during OTP confirmation), what happens to `active_locked_count` on that single-use link?",
                "options": [
                    {
                        "text": "It is released to `0` so the customer can immediately pay again.",
                        "correct": false,
                        "explanation": "Incorrect. Releasing the lock while `UNKNOWN` would allow the customer to pay a second time while the first payment might have already succeeded at the bank!"
                    },
                    {
                        "text": "It remains strictly held at `1` until `UNKNOWN` is resolved to either `SUCCEEDED` or `FAILED`.",
                        "correct": true,
                        "explanation": "Releasing the lock while `UNKNOWN` would allow the customer to pay a second time while the first payment might have already succeeded at the bank!"
                    },
                    {
                        "text": "It increments to `2`.",
                        "correct": false,
                        "explanation": "Incorrect. Releasing the lock while `UNKNOWN` would allow the customer to pay a second time while the first payment might have already succeeded at the bank!"
                    }
                ],
                "explanation": "Releasing the lock while `UNKNOWN` would allow the customer to pay a second time while the first payment might have already succeeded at the bank!",
                "critical": true
            },
            {
                "id": "QUIZ-M1-Q4",
                "questionEn": "Where does `core-back` get the payment amount when a customer initiates a payment from `checkout-front`?",
                "options": [
                    {
                        "text": "From the JSON body sent by `checkout-front`.",
                        "correct": false,
                        "explanation": "Incorrect. `checkout-back` and `core-back` never accept amounts or currencies from the client browser (Edge Case 80)."
                    },
                    {
                        "text": "Exclusively from `payment_links.amount` in the database, looked up by `linkKey`.",
                        "correct": true,
                        "explanation": "`checkout-back` and `core-back` never accept amounts or currencies from the client browser (Edge Case 80)."
                    },
                    {
                        "text": "From a query parameter in the checkout URL.",
                        "correct": false,
                        "explanation": "Incorrect. `checkout-back` and `core-back` never accept amounts or currencies from the client browser (Edge Case 80)."
                    }
                ],
                "explanation": "`checkout-back` and `core-back` never accept amounts or currencies from the client browser (Edge Case 80).",
                "critical": false
            },
            {
                "id": "QUIZ-M1-Q5",
                "questionEn": "When the Moamalat Lightbox JavaScript inside the customer's browser fires `completeCallback()`, what does our server do?",
                "options": [
                    {
                        "text": "Immediately credits the merchant's wallet.",
                        "correct": false,
                        "explanation": "Incorrect. Browser callbacks can be spoofed via browser developer tools (`T-06`), so they only trigger a server inquiry."
                    },
                    {
                        "text": "Treats the browser event as an untrusted hint (`must_inquire = true`), transitions to `VERIFYING`, and calls Moamalat's server-to-server `FilterTransactions` inquiry API.",
                        "correct": true,
                        "explanation": "Browser callbacks can be spoofed via browser developer tools (`T-06`), so they only trigger a server inquiry."
                    },
                    {
                        "text": "Ignores the event completely and waits for tomorrow's CSV file.",
                        "correct": false,
                        "explanation": "Incorrect. Browser callbacks can be spoofed via browser developer tools (`T-06`), so they only trigger a server inquiry."
                    }
                ],
                "explanation": "Browser callbacks can be spoofed via browser developer tools (`T-06`), so they only trigger a server inquiry.",
                "critical": false
            },
            {
                "id": "QUIZ-M1-Q6",
                "questionEn": "Which service in our 7-project architecture is the only service that holds the MySQL database connection and `KMS_MASTER_KEY`?",
                "options": [
                    {
                        "text": "`admin-back`",
                        "correct": false,
                        "explanation": "Incorrect. `admin-back`, `merchant-back`, and `checkout-back` have zero database drivers or secrets and communicate with `core-back` over mTLS 1.3."
                    },
                    {
                        "text": "`checkout-back`",
                        "correct": false,
                        "explanation": "Incorrect. `admin-back`, `merchant-back`, and `checkout-back` have zero database drivers or secrets and communicate with `core-back` over mTLS 1.3."
                    },
                    {
                        "text": "`core-back`",
                        "correct": true,
                        "explanation": "`admin-back`, `merchant-back`, and `checkout-back` have zero database drivers or secrets and communicate with `core-back` over mTLS 1.3."
                    }
                ],
                "explanation": "`admin-back`, `merchant-back`, and `checkout-back` have zero database drivers or secrets and communicate with `core-back` over mTLS 1.3.",
                "critical": false
            },
            {
                "id": "QUIZ-M1-Q7",
                "questionEn": "What happens if a compromised `checkout-back` server tries to call `/internal/admin/approvals` on `core-back` using its `CN=checkout-back` mTLS client certificate?",
                "options": [
                    {
                        "text": "`core-back` allows it because the certificate was signed by our internal CA.",
                        "correct": false,
                        "explanation": "Incorrect. Each edge service's mTLS certificate Common Name (`CN`) is locked to its own internal route namespace."
                    },
                    {
                        "text": "`core-back`'s `mtlsGuard` rejects it immediately with `403 FORBIDDEN_SERVICE_IDENTITY` because `CN=checkout-back` is only allowed on `/internal/checkout/*`.",
                        "correct": true,
                        "explanation": "Each edge service's mTLS certificate Common Name (`CN`) is locked to its own internal route namespace."
                    }
                ],
                "explanation": "Each edge service's mTLS certificate Common Name (`CN`) is locked to its own internal route namespace.",
                "critical": false
            },
            {
                "id": "QUIZ-M1-Q8",
                "questionEn": "Which five facts must a trusted server confirmation channel verify before `core-back` moves an attempt to `SUCCEEDED`?",
                "options": [
                    {
                        "text": "Browser IP, User-Agent, Link Key, Merchant Name, and Timezone.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Status is Success, Our Reference matches, Settled Amount matches within route tolerance, Currency matches, and Environment (`SANDBOX` vs `LIVE`) matches."
                    },
                    {
                        "text": "Status is Success, Our Reference matches, Settled Amount matches within route tolerance, Currency matches, and Environment (`SANDBOX` vs `LIVE`) matches.",
                        "correct": true,
                        "explanation": "The correct answer is: Status is Success, Our Reference matches, Settled Amount matches within route tolerance, Currency matches, and Environment (`SANDBOX` vs `LIVE`) matches."
                    },
                    {
                        "text": "Only that HTTP status is `200 OK`. ---",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Status is Success, Our Reference matches, Settled Amount matches within route tolerance, Currency matches, and Environment (`SANDBOX` vs `LIVE`) matches."
                    }
                ],
                "explanation": "The correct answer is: Status is Success, Our Reference matches, Settled Amount matches within route tolerance, Currency matches, and Environment (`SANDBOX` vs `LIVE`) matches.",
                "critical": false
            }
        ]
    },
    {
        "id": "M2",
        "code": "M2",
        "letter": "D–F",
        "titleEn": "The Four-Eyes (Maker-Checker) Governance Engine & Field Control",
        "titleAr": "محرك حوكمة العيون الأربع (المنشئ والمدقق) والتحكم بالحقول",
        "summaryEn": "Separate descriptive from sensitive fields and run a safe maker-checker review with base_version protection.",
        "summaryAr": "افصل الحقول الوصفية عن الحساسة ونفّذ مراجعة آمنة للمنشئ والمدقق مع حماية base_version.",
        "tracks": [
            "SUPPORT",
            "OPERATIONS",
            "COMPLIANCE",
            "FINANCE",
            "GATEWAY_ARCHITECT",
            "MASTER_OPERATOR"
        ],
        "lessons": [
            {
                "id": "M2-L1",
                "titleEn": "Descriptive vs. Sensitive Fields — What Requires Four Eyes?",
                "bodyEn": "Not every edit requires a second person. If a merchant fixes a typo in their store's display trade name, making them wait for a Checker would slow down support. However, if someone changes a merchant's **payout bank IBAN**, **commission rate**, **risk tier**, or **application wallet binding**, a single mistake or malicious insider action could misdirect funds.\n\nTherefore, our platform divides every field into two classes:\n1. **Descriptive Fields (Direct Edit + Logged in `detail_change_logs`):**\n   - Merchant `trade_name`, display logo, POS terminal name/location, application `name` and `business_use_description`.\n   - Takes effect immediately, and writes an unchangeable before/after row in `detail_change_logs` so Support can always see who changed what and when.\n2. **Sensitive Fields (Strictly Governed by Maker-Checker `approval_requests`):**\n   - **Merchant:** `legal_name`, `tax_id`, `registration_no`, `business_category`, `payout_bank_details_json`, `risk_tier`, `kyb_status`, `commission_receivable_ceiling`, `negative_balance_ceiling`.\n   - **Application:** `assigned_wallet_id`, `rail_whitelist`, `redirect_domain_allowlist`.\n   - **Platform & Money:** All `adjustments` (refunds, chargebacks, manual credits/debits), `commission_profiles`, `velocity_rules`, `aml_rules`, `aml_cases` resolutions, `regulatory_reports`, `gateway_versions` promotions to `LIVE`, and admin `users` authority changes."
            },
            {
                "id": "M2-L2",
                "titleEn": "Optimistic Concurrency (`base_version`) & Stale Approvals",
                "bodyEn": "What happens if Maker 1 proposes changing a Merchant's `risk_tier` when the Merchant record is at `version = 4` (`base_version = 4`), and before a Checker reviews it, another approved request updates the Merchant to `version = 5`?\n- When the Checker clicks **Approve** on Maker 1's request, `ApprovalService` compares `base_version (4)` against the Merchant's current version (`5`).\n- Because they no longer match, the system **refuses to overwrite the newer record** and returns the request to `DRAFT` (`BASE_VERSION_MISMATCH`) so the Maker can review the updated record first!"
            }
        ],
        "lab": {
            "id": "LAB-02",
            "titleEn": "The Checker Approval Desk Simulator",
            "descriptionEn": "- **What the Student Sees:** A simulated `/approvals` queue containing **4 pending requests** with full JSON-Patch diffs and attached evidence documents. The student is logged in as Checker `user_finance_02`:\n  - **Case 1:** A `payout_bank_details_json` change for *Tripoli Electronics LLC*, where the attached Bank Letter PDF shows the exact new IBAN under *Tripoli Electronics LLC*'s legal name, submitted by Maker `user_op_01`. *(Correct action: **Approve**).*\n  - **Case 2:** A `payout_bank_details_json` change where the new account holder name is a personal name (*\"Ahmed Al-abidi\"*) that does NOT match the company's legal name or any documented resolution. *(Correct action: **Reject** with reason `BANK_ACCOUNT_HOLDER_MISMATCH`).*\n  - **Case 3:** A `REFUND` adjustment of `500.0000 LYD` on an attempt whose `settled_amount` was only `50.0000 LYD` (a `10x` decimal typo by the Maker!). *(Correct action: **Reject** — approving triggers a red incident alert explaining `REFUND_EXCEEDS_SETTLED_AMOUNT`).*\n  - **Case 4:** An emergency merchant suspension (`mode = EMERGENCY_RATIFICATION`) triggered 3 hours ago after a confirmed sanctions hit, with full screening evidence attached. *(Correct action: **Approve / Ratify**).*",
            "scenarios": [
                {
                    "id": "LAB-02-S1",
                    "titleEn": "Bank account change with matching evidence",
                    "promptEn": "Case 1 changes payout_bank_details_json for Tripoli Electronics LLC. The attached Bank Letter shows the new IBAN under the same legal name, submitted by user_op_01. You are user_finance_02. What do you do?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Approve after checking the diff and evidence.",
                            "feedbackEn": "Correct. The evidence matches the legal entity and you are a different authorized checker."
                        },
                        {
                            "id": "b",
                            "labelEn": "Reject because all bank changes are forbidden.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! Rejecting a legitimate verified change blocks a real merchant payout."
                        },
                        {
                            "id": "c",
                            "labelEn": "Approve without opening the Bank Letter.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You approved a payout destination without verifying ownership."
                        }
                    ]
                },
                {
                    "id": "LAB-02-S2",
                    "titleEn": "Bank account holder name mismatch",
                    "promptEn": "Case 2 changes payout_bank_details_json, but the new account holder is a personal name (Ahmed Al-abidi) that does not match the company's legal name or any documented resolution. What do you do?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Reject with reason BANK_ACCOUNT_HOLDER_MISMATCH.",
                            "feedbackEn": "Correct. A payout account must belong to the merchant's legal entity or be supported by a documented resolution."
                        },
                        {
                            "id": "b",
                            "labelEn": "Approve because the IBAN is valid.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You approved a payout to an unrelated personal account."
                        },
                        {
                            "id": "c",
                            "labelEn": "Ask the Maker to resubmit the same evidence.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! The evidence cannot prove ownership; the request must be rejected, not recycled."
                        }
                    ]
                },
                {
                    "id": "LAB-02-S3",
                    "titleEn": "Emergency suspension ratification",
                    "promptEn": "Case 4 is an emergency merchant suspension (mode = EMERGENCY_RATIFICATION) triggered 3 hours ago after a confirmed sanctions hit, with full screening evidence attached. What do you do?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Approve / ratify the emergency suspension within the 24-hour window.",
                            "feedbackEn": "Correct. Reducing risk may take effect immediately but must be ratified by an MLRO/COMPLIANCE Checker within 24 hours."
                        },
                        {
                            "id": "b",
                            "labelEn": "Reject and reinstate the merchant immediately.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You reinstated a merchant with a confirmed sanctions hit."
                        },
                        {
                            "id": "c",
                            "labelEn": "Ignore it and let the timer expire.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! The merchant stays suspended, a P2 alert pages management, and the ratification SLA is breached."
                        }
                    ]
                },
                {
                    "id": "LAB-02-S4",
                    "titleEn": "Ten-times refund typo",
                    "promptEn": "Case 3 is a 500.0000 LYD REFUND on an attempt whose settled_amount is only 50.0000 LYD. What do you do?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Approve; the merchant can absorb it.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! REFUND_EXCEEDS_SETTLED_AMOUNT. You refunded ten times the settled money."
                        },
                        {
                            "id": "b",
                            "labelEn": "Reject and explain the decimal typo.",
                            "feedbackEn": "Correct. A refund can never exceed settled_amount minus executed refunds."
                        },
                        {
                            "id": "c",
                            "labelEn": "Approve after changing the amount yourself.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! Checkers must not silently rewrite a Maker's proposal; reject and ask for a clean draft."
                        }
                    ]
                }
            ]
        },
        "quiz": [
            {
                "id": "QUIZ-M2-Q1",
                "questionEn": "Where is the `checker_user_id != maker_user_id` (Maker cannot be Checker) rule enforced in our platform?",
                "options": [
                    {
                        "text": "Only by hiding the Approve button in the frontend UI.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: In three layers: the frontend UI, the `makerCheckerGuard` / `ApprovalService` in `core-back`, and the `approval_requests_checker_not_maker` `BEFORE INSERT` trigger inside MySQL/MariaDB."
                    },
                    {
                        "text": "In three layers: the frontend UI, the `makerCheckerGuard` / `ApprovalService` in `core-back`, and the `approval_requests_checker_not_maker` `BEFORE INSERT` trigger inside MySQL/MariaDB.",
                        "correct": true,
                        "explanation": "The correct answer is: In three layers: the frontend UI, the `makerCheckerGuard` / `ApprovalService` in `core-back`, and the `approval_requests_checker_not_maker` `BEFORE INSERT` trigger inside MySQL/MariaDB."
                    },
                    {
                        "text": "Only in `admin-back`.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: In three layers: the frontend UI, the `makerCheckerGuard` / `ApprovalService` in `core-back`, and the `approval_requests_checker_not_maker` `BEFORE INSERT` trigger inside MySQL/MariaDB."
                    }
                ],
                "explanation": "The correct answer is: In three layers: the frontend UI, the `makerCheckerGuard` / `ApprovalService` in `core-back`, and the `approval_requests_checker_not_maker` `BEFORE INSERT` trigger inside MySQL/MariaDB.",
                "critical": true
            },
            {
                "id": "QUIZ-M2-Q2",
                "questionEn": "While a sensitive edit to `applications.assigned_wallet_id` is in `PENDING_REVIEW` waiting for a Checker, which wallet receives money from payments on that application?",
                "options": [
                    {
                        "text": "Payments are blocked until the Checker decides.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: The currently active wallet; a pending change never alters live behavior until a Checker approves it (`EXECUTED`), and in-flight attempts always stay pinned to the wallet they started with."
                    },
                    {
                        "text": "The proposed new wallet.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: The currently active wallet; a pending change never alters live behavior until a Checker approves it (`EXECUTED`), and in-flight attempts always stay pinned to the wallet they started with."
                    },
                    {
                        "text": "The currently active wallet; a pending change never alters live behavior until a Checker approves it (`EXECUTED`), and in-flight attempts always stay pinned to the wallet they started with.",
                        "correct": true,
                        "explanation": "The correct answer is: The currently active wallet; a pending change never alters live behavior until a Checker approves it (`EXECUTED`), and in-flight attempts always stay pinned to the wallet they started with."
                    }
                ],
                "explanation": "The correct answer is: The currently active wallet; a pending change never alters live behavior until a Checker approves it (`EXECUTED`), and in-flight attempts always stay pinned to the wallet they started with.",
                "critical": true
            },
            {
                "id": "QUIZ-M2-Q3",
                "questionEn": "What happens if a Merchant edits their `payout_bank_details_json` while a `CashoutRequest` is already in `PROCESSING`?",
                "options": [
                    {
                        "text": "The in-flight cash-out wires money to the unapproved new bank account.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: `cashout_requests` snapshots `destination_bank_json` at creation, so the in-flight payout uses the verified snapshot, while the new bank details require Maker-Checker approval and apply only to future cash-outs (Edge Case 111)."
                    },
                    {
                        "text": "`cashout_requests` snapshots `destination_bank_json` at creation, so the in-flight payout uses the verified snapshot, while the new bank details require Maker-Checker approval and apply only to future cash-outs (Edge Case 111).",
                        "correct": true,
                        "explanation": "The correct answer is: `cashout_requests` snapshots `destination_bank_json` at creation, so the in-flight payout uses the verified snapshot, while the new bank details require Maker-Checker approval and apply only to future cash-outs (Edge Case 111)."
                    },
                    {
                        "text": "The cash-out is automatically deleted.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: `cashout_requests` snapshots `destination_bank_json` at creation, so the in-flight payout uses the verified snapshot, while the new bank details require Maker-Checker approval and apply only to future cash-outs (Edge Case 111)."
                    }
                ],
                "explanation": "The correct answer is: `cashout_requests` snapshots `destination_bank_json` at creation, so the in-flight payout uses the verified snapshot, while the new bank details require Maker-Checker approval and apply only to future cash-outs (Edge Case 111).",
                "critical": false
            },
            {
                "id": "QUIZ-M2-Q4",
                "questionEn": "Which of the following actions is allowed to use the `EMERGENCY_RATIFICATION` path (immediate effect by one authorized person, ratified within 24 hours by a second Checker)?",
                "options": [
                    {
                        "text": "Reinstating a suspended merchant.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Suspending a merchant or tightening a velocity/AML rule (actions that *reduce* risk)."
                    },
                    {
                        "text": "Releasing an `AML_HOLD` to a merchant wallet.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Suspending a merchant or tightening a velocity/AML rule (actions that *reduce* risk)."
                    },
                    {
                        "text": "Suspending a merchant or tightening a velocity/AML rule (actions that *reduce* risk).",
                        "correct": true,
                        "explanation": "The correct answer is: Suspending a merchant or tightening a velocity/AML rule (actions that *reduce* risk)."
                    }
                ],
                "explanation": "The correct answer is: Suspending a merchant or tightening a velocity/AML rule (actions that *reduce* risk).",
                "critical": true
            },
            {
                "id": "QUIZ-M2-Q5",
                "questionEn": "What happens if an `EMERGENCY_RATIFICATION` merchant suspension is NOT ratified within its 24-hour window (`ratify_due_at`)?",
                "options": [
                    {
                        "text": "The merchant automatically becomes `ACTIVE` again after 24 hours.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: A `P2` alert pages `MLRO` and management, and the merchant remains `SUSPENDED` (fail-safe, never fail-open) until a Checker formally decides (Edge Case 127)."
                    },
                    {
                        "text": "A `P2` alert pages `MLRO` and management, and the merchant remains `SUSPENDED` (fail-safe, never fail-open) until a Checker formally decides (Edge Case 127).",
                        "correct": true,
                        "explanation": "The correct answer is: A `P2` alert pages `MLRO` and management, and the merchant remains `SUSPENDED` (fail-safe, never fail-open) until a Checker formally decides (Edge Case 127)."
                    },
                    {
                        "text": "The merchant record is deleted.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: A `P2` alert pages `MLRO` and management, and the merchant remains `SUSPENDED` (fail-safe, never fail-open) until a Checker formally decides (Edge Case 127)."
                    }
                ],
                "explanation": "The correct answer is: A `P2` alert pages `MLRO` and management, and the merchant remains `SUSPENDED` (fail-safe, never fail-open) until a Checker formally decides (Edge Case 127).",
                "critical": false
            },
            {
                "id": "QUIZ-M2-Q6",
                "questionEn": "Can the automated dispute principal (`SYSTEM_AUTOMATION`) ever approve its own drafted `CHARGEBACK` adjustment?",
                "options": [
                    {
                        "text": "Yes, if the amount is under 100 LYD.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Never. `SYSTEM_AUTOMATION` can only act as a Maker to draft the adjustment into `PENDING_REVIEW`; a human `FINANCE` Checker must authorize every money movement."
                    },
                    {
                        "text": "Never. `SYSTEM_AUTOMATION` can only act as a Maker to draft the adjustment into `PENDING_REVIEW`; a human `FINANCE` Checker must authorize every money movement.",
                        "correct": true,
                        "explanation": "The correct answer is: Never. `SYSTEM_AUTOMATION` can only act as a Maker to draft the adjustment into `PENDING_REVIEW`; a human `FINANCE` Checker must authorize every money movement."
                    }
                ],
                "explanation": "The correct answer is: Never. `SYSTEM_AUTOMATION` can only act as a Maker to draft the adjustment into `PENDING_REVIEW`; a human `FINANCE` Checker must authorize every money movement.",
                "critical": true
            },
            {
                "id": "QUIZ-M2-Q7",
                "questionEn": "Why does `approval_requests` store `base_version` when proposing a JSON-Patch edit to a Merchant or Application?",
                "options": [
                    {
                        "text": "To compress the JSON payload.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: To detect if the record was modified by another action while the approval was pending, preventing a stale approval from silently overwriting newer data."
                    },
                    {
                        "text": "To detect if the record was modified by another action while the approval was pending, preventing a stale approval from silently overwriting newer data.",
                        "correct": true,
                        "explanation": "The correct answer is: To detect if the record was modified by another action while the approval was pending, preventing a stale approval from silently overwriting newer data."
                    }
                ],
                "explanation": "The correct answer is: To detect if the record was modified by another action while the approval was pending, preventing a stale approval from silently overwriting newer data.",
                "critical": false
            },
            {
                "id": "QUIZ-M2-Q8",
                "questionEn": "Where should a `SUPPORT` agent look when a merchant asks *\"What was our application's redirect domain allowlist set to last month?\"*",
                "options": [
                    {
                        "text": "`inbound_events`",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: `detail_change_logs` (Field Change History), which records every descriptive and sensitive field change with timestamp, actor, old value, and new value. ---"
                    },
                    {
                        "text": "`detail_change_logs` (Field Change History), which records every descriptive and sensitive field change with timestamp, actor, old value, and new value. ---",
                        "correct": true,
                        "explanation": "The correct answer is: `detail_change_logs` (Field Change History), which records every descriptive and sensitive field change with timestamp, actor, old value, and new value. ---"
                    }
                ],
                "explanation": "The correct answer is: `detail_change_logs` (Field Change History), which records every descriptive and sensitive field change with timestamp, actor, old value, and new value. ---",
                "critical": false
            }
        ]
    },
    {
        "id": "M3",
        "code": "M3",
        "letter": "G–I",
        "titleEn": "Merchant Onboarding, KYB Forensics, Beneficial Owners & Duplicate Detection",
        "titleAr": "تأهيل التجار وتحليل KYB والمالكون المستفيدون وكشف التكرار",
        "summaryEn": "Move a join request through KYB, verify beneficial owners, inspect document magic bytes, and catch duplicates.",
        "summaryAr": "انقل طلب انضمام عبر KYB وتحقق من المالكين المستفيدين وافحص بصمات الوثائق واكتشف التكرار.",
        "tracks": [
            "SUPPORT",
            "OPERATIONS",
            "COMPLIANCE",
            "MASTER_OPERATOR"
        ],
        "lessons": [
            {
                "id": "M3-L1",
                "titleEn": "Step-by-Step Through the `JoinRequest` Lifecycle — Part 1",
                "bodyEn": "1. **Self-Service vs. Admin-Assisted Onboarding:**\n   - Most merchants register themselves (`onboarding_channel = SELF_SERVICE`).\n   - Sometimes a sales or operations officer helps a large corporate merchant fill out their onboarding package (`ADMIN_ASSISTED`).\n   - **Rule (Edge Case 119):** If an operator prepares an `ADMIN_ASSISTED` join request, the system records that operator as the submitter/maker and **bars them from acting as the deciding reviewer or checker** on that request!\n2. **How Document Upload Forensics Work (`kyb_documents`):**\n   - **Magic-Byte Inspection:** When a file is uploaded, our server inspects the actual binary header bytes (`%PDF-`, `\\x89PNG`, `\\xFF\\xD8\\xFF` for JPEG)—never trusting the `.pdf` or `.png` filename extension alone (`415 UPLOAD_SIGNATURE_MISMATCH`)."
            },
            {
                "id": "M3-L2",
                "titleEn": "Step-by-Step Through the `JoinRequest` Lifecycle — Part 2",
                "bodyEn": "   - **Cross-Merchant SHA-256 Hash Indexing:** The system computes a 64-character `sha256` fingerprint of every file. If Merchant B uploads the exact same file that Merchant A uploaded, the reviewer screen lights up with a **`DUPLICATE_DOCUMENT`** warning badge (Edge Case 120).\n3. **Beneficial Owners & The 25% Threshold (`beneficial_owners`):**\n   - Every natural person who owns **`25%` or more** (`aml.owner_threshold_percent`) or exercises control (`DIRECTOR`, `SIGNATORY`, `CONTROLLER`) must be declared and screened.\n   - If a beneficial owner is added or edited *after* the join request was submitted, the system automatically triggers a new AML screening, invalidates any pending approval, and returns the request to `IN_REVIEW` (Edge Case 121)."
            }
        ],
        "lab": {
            "id": "LAB-03",
            "titleEn": "The KYB & Fraud Detection Desk",
            "descriptionEn": "- **What the Student Sees:** Three submitted `join_requests` in a simulated reviewer console:\n  - **Applicant A (*Al-Waha Pharmacy*):** Clean Commercial Registry, valid Tax Certificate, 2 owners (60% / 40%) with `CLEAR` screening, Bank Letter matching *Al-Waha Pharmacy*, `LOW` risk. *(Correct action: Complete 7-point checklist & **Approve**).*\n  - **Applicant B (*Desert Star Trading*):** Commercial Registry expired 8 months ago, and the Tax Certificate scan is illegible/blurry. *(Correct action: Click **Request Info (`INFO_REQUESTED`)**, selecting `COMMERCIAL_REGISTRY` and `TAX_CERTIFICATE`, which pauses the SLA timer).*\n  - **Applicant C (*Barqa Express Electronics*):** System displays a red `DUPLICATE_DOCUMENT` badge on the Commercial Registry PDF (matching a merchant rejected last week for prohibited activity) and a `DUPLICATE_OR_RELATED` match on the owner's National ID. *(Correct action: **Reject** with code `PROHIBITED_ACTIVITY` / `POLICY` and flag for Compliance).*",
            "scenarios": [
                {
                    "id": "LAB-03-S1",
                    "titleEn": "Clean applicant with matching evidence",
                    "promptEn": "Applicant A (Al-Waha Pharmacy) has a clean Commercial Registry, a valid Tax Certificate, two owners (60% / 40%) with CLEAR screening, a Bank Letter matching Al-Waha Pharmacy, and LOW risk. What is the correct action?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Complete the 7-point checklist and approve.",
                            "feedbackEn": "Correct. All evidence matches, ownership is clear, and the LOW-risk request does not require a second Checker."
                        },
                        {
                            "id": "b",
                            "labelEn": "Reject because every applicant needs enhanced due diligence.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You rejected a clean low-risk applicant without a valid reason."
                        },
                        {
                            "id": "c",
                            "labelEn": "Approve without checking the beneficial owners.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You skipped the 25% beneficial-owner verification."
                        }
                    ]
                },
                {
                    "id": "LAB-03-S2",
                    "titleEn": "Expired registry and illegible tax certificate",
                    "promptEn": "Applicant B (Desert Star Trading) has an expired Commercial Registry and an illegible Tax Certificate. What is the correct action?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Approve because the owner is friendly.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You onboarded an entity with expired and unreadable KYB evidence."
                        },
                        {
                            "id": "b",
                            "labelEn": "Request Info for COMMERCIAL_REGISTRY and TAX_CERTIFICATE, pausing the SLA timer.",
                            "feedbackEn": "Correct. INFO_REQUESTED pauses the SLA and tells the merchant exactly what to replace."
                        },
                        {
                            "id": "c",
                            "labelEn": "Reject permanently without explanation.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! A correctable document issue was turned into an unfair permanent rejection."
                        }
                    ]
                },
                {
                    "id": "LAB-03-S3",
                    "titleEn": "Duplicate document and related owner",
                    "promptEn": "Applicant C has a DUPLICATE_DOCUMENT badge on the Commercial Registry matching a merchant rejected for prohibited activity, plus a DUPLICATE_OR_RELATED match on the owner's National ID. What do you do?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Approve because the documents are legible.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You onboarded a duplicate linked to a prohibited-activity rejection."
                        },
                        {
                            "id": "b",
                            "labelEn": "Reject with PROHIBITED_ACTIVITY or POLICY and flag for Compliance.",
                            "feedbackEn": "Correct. The duplicate evidence is a hard stop and must be escalated confidentially."
                        },
                        {
                            "id": "c",
                            "labelEn": "Tell the applicant the exact AML watchlist reason.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You tipped off the applicant in violation of AML law."
                        }
                    ]
                }
            ]
        },
        "quiz": [
            {
                "id": "QUIZ-M3-Q1",
                "questionEn": "What happens to the review SLA timer (`sla_due_at`) when a reviewer moves a Join Request to `INFO_REQUESTED`?",
                "options": [
                    {
                        "text": "It keeps ticking and breaches SLA if the merchant is slow.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: The SLA clock pauses while waiting for the applicant and is recomputed when the applicant submits the requested information."
                    },
                    {
                        "text": "The SLA clock pauses while waiting for the applicant and is recomputed when the applicant submits the requested information.",
                        "correct": true,
                        "explanation": "The correct answer is: The SLA clock pauses while waiting for the applicant and is recomputed when the applicant submits the requested information."
                    },
                    {
                        "text": "The Join Request is deleted.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: The SLA clock pauses while waiting for the applicant and is recomputed when the applicant submits the requested information."
                    }
                ],
                "explanation": "The correct answer is: The SLA clock pauses while waiting for the applicant and is recomputed when the applicant submits the requested information.",
                "critical": false
            },
            {
                "id": "QUIZ-M3-Q2",
                "questionEn": "Under the default `RISK_BASED` Four-Eyes policy (`OD-2`), which of the following Join Requests requires a second Checker (`four_eyes_required = true`)?",
                "options": [
                    {
                        "text": "A `LOW` risk pharmacy with `CLEAR` screening, no PEP owners, and a matching bank letter.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Any request where proposed risk is `HIGH`, screening is not `CLEAR`, an owner is a PEP, expected volume exceeds the threshold, payout bank ownership differs, or a duplicate/prior-rejection flag fired."
                    },
                    {
                        "text": "Any request where proposed risk is `HIGH`, screening is not `CLEAR`, an owner is a PEP, expected volume exceeds the threshold, payout bank ownership differs, or a duplicate/prior-rejection flag fired.",
                        "correct": true,
                        "explanation": "The correct answer is: Any request where proposed risk is `HIGH`, screening is not `CLEAR`, an owner is a PEP, expected volume exceeds the threshold, payout bank ownership differs, or a duplicate/prior-rejection flag fired."
                    },
                    {
                        "text": "No Join Requests ever require a second Checker.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Any request where proposed risk is `HIGH`, screening is not `CLEAR`, an owner is a PEP, expected volume exceeds the threshold, payout bank ownership differs, or a duplicate/prior-rejection flag fired."
                    }
                ],
                "explanation": "The correct answer is: Any request where proposed risk is `HIGH`, screening is not `CLEAR`, an owner is a PEP, expected volume exceeds the threshold, payout bank ownership differs, or a duplicate/prior-rejection flag fired.",
                "critical": true
            },
            {
                "id": "QUIZ-M3-Q3",
                "questionEn": "What happens if the AML Screening Provider is temporarily unreachable (`result = ERROR`) when an applicant submits their Join Request?",
                "options": [
                    {
                        "text": "The system approves the merchant anyway and screens them next month.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: The system fails closed (`503 SCREENING_UNAVAILABLE`), blocks approval, keeps the request in `IN_REVIEW`, pauses the SLA with `PROVIDER_OUTAGE`, and retries screening with backoff (Edge Case 124)."
                    },
                    {
                        "text": "The system fails closed (`503 SCREENING_UNAVAILABLE`), blocks approval, keeps the request in `IN_REVIEW`, pauses the SLA with `PROVIDER_OUTAGE`, and retries screening with backoff (Edge Case 124).",
                        "correct": true,
                        "explanation": "The correct answer is: The system fails closed (`503 SCREENING_UNAVAILABLE`), blocks approval, keeps the request in `IN_REVIEW`, pauses the SLA with `PROVIDER_OUTAGE`, and retries screening with backoff (Edge Case 124)."
                    },
                    {
                        "text": "The system permanently rejects the merchant.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: The system fails closed (`503 SCREENING_UNAVAILABLE`), blocks approval, keeps the request in `IN_REVIEW`, pauses the SLA with `PROVIDER_OUTAGE`, and retries screening with backoff (Edge Case 124)."
                    }
                ],
                "explanation": "The correct answer is: The system fails closed (`503 SCREENING_UNAVAILABLE`), blocks approval, keeps the request in `IN_REVIEW`, pauses the SLA with `PROVIDER_OUTAGE`, and retries screening with backoff (Edge Case 124).",
                "critical": true
            },
            {
                "id": "QUIZ-M3-Q4",
                "questionEn": "An attacker renames a Windows program `malware.exe` to `tax_certificate.pdf` and uploads it as a KYB document. How does our platform stop it?",
                "options": [
                    {
                        "text": "It only checks that the filename ends in `.pdf`.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Both `merchant-back` and `core-back` inspect the binary magic bytes of the file (`%PDF-`, PNG, JPEG headers), rejecting the upload immediately with `415 UPLOAD_SIGNATURE_MISMATCH`, in addition to size caps, antivirus scanning (`av_status`), and `nosniff` storage."
                    },
                    {
                        "text": "Both `merchant-back` and `core-back` inspect the binary magic bytes of the file (`%PDF-`, PNG, JPEG headers), rejecting the upload immediately with `415 UPLOAD_SIGNATURE_MISMATCH`, in addition to size caps, antivirus scanning (`av_status`), and `nosniff` storage.",
                        "correct": true,
                        "explanation": "The correct answer is: Both `merchant-back` and `core-back` inspect the binary magic bytes of the file (`%PDF-`, PNG, JPEG headers), rejecting the upload immediately with `415 UPLOAD_SIGNATURE_MISMATCH`, in addition to size caps, antivirus scanning (`av_status`), and `nosniff` storage."
                    }
                ],
                "explanation": "The correct answer is: Both `merchant-back` and `core-back` inspect the binary magic bytes of the file (`%PDF-`, PNG, JPEG headers), rejecting the upload immediately with `415 UPLOAD_SIGNATURE_MISMATCH`, in addition to size caps, antivirus scanning (`av_status`), and `nosniff` storage.",
                "critical": false
            },
            {
                "id": "QUIZ-M3-Q5",
                "questionEn": "What triggers a `DUPLICATE_DOCUMENT` alert during KYB review (Edge Case 120)?",
                "options": [
                    {
                        "text": "Two documents having the same filename `registry.pdf`.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Two unrelated merchants uploading files with the exact same `sha256` cryptographic content hash."
                    },
                    {
                        "text": "Two unrelated merchants uploading files with the exact same `sha256` cryptographic content hash.",
                        "correct": true,
                        "explanation": "The correct answer is: Two unrelated merchants uploading files with the exact same `sha256` cryptographic content hash."
                    }
                ],
                "explanation": "The correct answer is: Two unrelated merchants uploading files with the exact same `sha256` cryptographic content hash.",
                "critical": false
            },
            {
                "id": "QUIZ-M3-Q6",
                "questionEn": "If an operator helps a merchant prepare an `ADMIN_ASSISTED` Join Request, can that same operator approve the Join Request?",
                "options": [
                    {
                        "text": "Yes, if the merchant is `LOW` risk.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: No. The operator who prepared the request is recorded as the Maker and is barred from acting as the deciding reviewer or Checker (Edge Case 119)."
                    },
                    {
                        "text": "No. The operator who prepared the request is recorded as the Maker and is barred from acting as the deciding reviewer or Checker (Edge Case 119).",
                        "correct": true,
                        "explanation": "The correct answer is: No. The operator who prepared the request is recorded as the Maker and is barred from acting as the deciding reviewer or Checker (Edge Case 119)."
                    }
                ],
                "explanation": "The correct answer is: No. The operator who prepared the request is recorded as the Maker and is barred from acting as the deciding reviewer or Checker (Edge Case 119).",
                "critical": false
            },
            {
                "id": "QUIZ-M3-Q7",
                "questionEn": "When a Join Request is rejected because of a confirmed AML watchlist match, what reason code is sent in the merchant-facing SMS/email notification?",
                "options": [
                    {
                        "text": "`\"Rejected due to CBL AML Watchlist Hit on Owner X\"`",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: The neutral code `POLICY` (never disclosing AML/Sanctions/PEP screening details, enforcing the strict No-Tipping-Off rule)."
                    },
                    {
                        "text": "The neutral code `POLICY` (never disclosing AML/Sanctions/PEP screening details, enforcing the strict No-Tipping-Off rule).",
                        "correct": true,
                        "explanation": "The correct answer is: The neutral code `POLICY` (never disclosing AML/Sanctions/PEP screening details, enforcing the strict No-Tipping-Off rule)."
                    }
                ],
                "explanation": "The correct answer is: The neutral code `POLICY` (never disclosing AML/Sanctions/PEP screening details, enforcing the strict No-Tipping-Off rule).",
                "critical": true
            },
            {
                "id": "QUIZ-M3-Q8",
                "questionEn": "What happens when an active merchant's required KYB document passes its `expires_on` date?",
                "options": [
                    {
                        "text": "Nothing; KYB documents are only checked once at signup.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: The system sends `KYB_DOC_EXPIRING` warnings 30 and 7 days prior, marks the document `EXPIRED` on the date, and automatically suspends the merchant (`KYB_EXPIRED`) if unrenewed past the 30-day grace window. ---"
                    },
                    {
                        "text": "The system sends `KYB_DOC_EXPIRING` warnings 30 and 7 days prior, marks the document `EXPIRED` on the date, and automatically suspends the merchant (`KYB_EXPIRED`) if unrenewed past the 30-day grace window. ---",
                        "correct": true,
                        "explanation": "The correct answer is: The system sends `KYB_DOC_EXPIRING` warnings 30 and 7 days prior, marks the document `EXPIRED` on the date, and automatically suspends the merchant (`KYB_EXPIRED`) if unrenewed past the 30-day grace window. ---"
                    }
                ],
                "explanation": "The correct answer is: The system sends `KYB_DOC_EXPIRING` warnings 30 and 7 days prior, marks the document `EXPIRED` on the date, and automatically suspends the merchant (`KYB_EXPIRED`) if unrenewed past the 30-day grace window. ---",
                "critical": false
            }
        ]
    },
    {
        "id": "M4",
        "code": "M4",
        "letter": "J–L",
        "titleEn": "Double-Entry Accounting From Scratch, Fee Bearers, T+N Clearing & Statement Reconciliation",
        "titleAr": "المحاسبة المزدوجة من الصفر ومتحملو الرسوم ومقاصة T+N ومطابقة الكشوف",
        "summaryEn": "Build balanced journals for all three fee bearers, post T+1 sweeps, and reconcile five statement outcomes.",
        "summaryAr": "ابنِ قيوداً متوازنة لمتحملي الرسوم الثلاثة وقيّد مسح T+1 وطابق نتائج الكشف الخمس.",
        "tracks": [
            "FINANCE",
            "MASTER_OPERATOR"
        ],
        "lessons": [
            {
                "id": "M4-L1",
                "titleEn": "The 3 Fee Bearers & How Every Dinar Is Accounted For",
                "bodyEn": "Let's compare a **`200.0000 LYD`** Payment Link with a **`2.5%` Platform Commission (`5.0000 LYD`)** and a **`1.0000 LYD` Accrued Gateway Fee** across all three `FeeBearer` modes:\n\n| Fee Bearer Mode | What the Customer Sees & Pays (`total_charged_amount`) | What the Merchant Wallet Receives (`net_merchant_amount`) | Our Platform Income (`PLATFORM_INCOME`) | Journal Lines Posted at Confirmation (Template 2 / 5 / 5b) |\n| :--- | :--- | :--- | :--- | :--- |\n| **`MERCHANT_ABSORBS`** | Pays **`200.0000 LYD`** | Receives **`195.0000 LYD`** | **`5.0000 LYD`** | `Dr GATEWAY_CLEARING 200.0000`<br>`Dr GATEWAY_FEE_EXPENSE 1.0000`<br>`Cr MERCHANT_WALLET 195.0000`<br>`Cr PLATFORM_INCOME 5.0000`<br>`Cr GATEWAY_FEE_ACCRUAL 1.0000` |\n| **`PAYER_SURCHARGE`** | Pays **`205.0000 LYD`** (`200 + 5 fee`) | Receives **`200.0000 LYD`** | **`5.0000 LYD`** | `Dr GATEWAY_CLEARING 205.0000`<br>`Dr GATEWAY_FEE_EXPENSE 1.0000`<br>`Cr MERCHANT_WALLET 200.0000`<br>`Cr PLATFORM_INCOME 5.0000`<br>`Cr GATEWAY_FEE_ACCRUAL 1.0000` |\n| **`SPLIT` (50/50)** | Pays **`202.5000 LYD`** (`200 + 2.50 fee`) | Receives **`197.5000 LYD`** | **`5.0000 LYD`** | `Dr GATEWAY_CLEARING 202.5000`<br>`Dr GATEWAY_FEE_EXPENSE 1.0000`<br>`Cr MERCHANT_WALLET 197.5000`<br>`Cr PLATFORM_INCOME 5.0000`<br>`Cr GATEWAY_FEE_ACCRUAL 1.0000` |"
            },
            {
                "id": "M4-L2",
                "titleEn": "How Statement Reconciliation (`/reconciliation`) Closes the Loop",
                "bodyEn": "When the gateway wires money to our bank account and sends us their daily CSV/XLSX/JSON settlement file, `StatementIngestor` matches every row against `payment_attempts` and assigns one of **5 Reconciliation Results**:\n1. **`MATCHED`:** Reference and amount match! Posts the `SETTLEMENT_SWEEP` journal entry (`Dr TREASURY + Dr GATEWAY_FEE_ACCRUAL / Cr GATEWAY_CLEARING`), plus a `FEE_VARIANCE` entry if the gateway's actual fee differed from our accrued estimate.\n2. **`AMOUNT_MISMATCH`:** Reference matches, but the gateway statement shows `98.0000 LYD` instead of `100.0000 LYD`. Opens an `AMOUNT_MISMATCH` `OperatorCase`.\n3. **`MISSING_AT_GATEWAY`:** Our database says the attempt `SUCCEEDED` 3 days ago, but it is missing from the gateway's settlement statement! Opens a high-priority case to investigate with the partner bank.\n4. **`MISSING_LOCALLY`:** The gateway statement says they collected `100.0000 LYD` from a customer (perhaps our server was down when their webhook fired and the attempt was stuck in `UNKNOWN` or `EXPIRED`!). Opens an `OperatorCase` so we can reconcile and credit/refund properly.\n5. **`DUPLICATE`:** The same transaction appeared twice on the statement."
            }
        ],
        "lab": {
            "id": "LAB-04",
            "titleEn": "T-Account Balancing & Statement Reconciliation Lab",
            "descriptionEn": "- **Part A (Journal Entry Builder):** The student is given 3 business events (1: A `100 LYD` `PAYER_SURCHARGE` confirmation with `3%` commission and `0.80 LYD` accrued fee; 2: The T+1 bank settlement sweep where the gateway actually charged `0.90 LYD` fee; 3: A `100 LYD` `MERCHANT_DIRECT` payment with `3%` commission) and must build the exact Debit and Credit lines until the live balance indicator turns green (`SUM(DEBIT) == SUM(CREDIT)`).\n- **Part B (Reconciliation Desk):** The student inspects a 5-row uploaded gateway statement containing 3 `MATCHED` rows, 1 `MISSING_LOCALLY` row (corresponding to a local `UNKNOWN` attempt!), and 1 `AMOUNT_MISMATCH` row, and executes the proper resolution for each.",
            "scenarios": [
                {
                    "id": "LAB-04-S1",
                    "titleEn": "PAYER_SURCHARGE journal",
                    "promptEn": "A 100 LYD PAYER_SURCHARGE confirmation with 3% commission and 0.80 LYD accrued gateway fee is posted. Which entry balances?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Dr GATEWAY_CLEARING 103.00 + Dr GATEWAY_FEE_EXPENSE 0.80 / Cr MERCHANT_WALLET 100.00 + Cr PLATFORM_INCOME 3.00 + Cr GATEWAY_FEE_ACCRUAL 0.80",
                            "feedbackEn": "Correct. Debits 103.80 equal credits 103.80 and the payer surcharge is included in clearing."
                        },
                        {
                            "id": "b",
                            "labelEn": "Dr GATEWAY_CLEARING 100.00 / Cr MERCHANT_WALLET 97.00 + Cr PLATFORM_INCOME 3.00",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You ignored the payer surcharge and the gateway fee accrual, so the journal is unbalanced."
                        },
                        {
                            "id": "c",
                            "labelEn": "Dr TREASURY 103.00 / Cr PLATFORM_INCOME 103.00",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You booked gateway clearing as treasury and overstated platform income."
                        }
                    ]
                },
                {
                    "id": "LAB-04-S2",
                    "titleEn": "Statement row missing locally",
                    "promptEn": "The gateway statement contains a 100.0000 LYD row for a reference our database does not know, while our server was down during the webhook. What result and action apply?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "MATCHED; credit the merchant immediately.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You matched a row with no local attempt and credited money without reconciliation."
                        },
                        {
                            "id": "b",
                            "labelEn": "MISSING_LOCALLY; open an OperatorCase to reconcile and credit/refund properly.",
                            "feedbackEn": "Correct. MISSING_LOCALLY means the provider collected money we cannot yet explain locally."
                        },
                        {
                            "id": "c",
                            "labelEn": "DUPLICATE; ignore it.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! A real missing local payment was dismissed as a duplicate."
                        }
                    ]
                }
            ]
        },
        "quiz": [
            {
                "id": "QUIZ-M4-Q1",
                "questionEn": "Why is floating-point math (`Float`, `Double`, `parseFloat`) strictly banned across our entire database and codebase in favor of `DECIMAL(18,4)` / `decimal.js`?",
                "options": [
                    {
                        "text": "Because `DECIMAL(18,4)` uses less disk space.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Because binary floating-point numbers cannot represent decimal fractions like `0.1 + 0.2` or Libyan Dirham thousandths (`0.005 LYD`) exactly, which would cause penny/dirham drift in the Double-Entry Ledger."
                    },
                    {
                        "text": "Because binary floating-point numbers cannot represent decimal fractions like `0.1 + 0.2` or Libyan Dirham thousandths (`0.005 LYD`) exactly, which would cause penny/dirham drift in the Double-Entry Ledger.",
                        "correct": true,
                        "explanation": "The correct answer is: Because binary floating-point numbers cannot represent decimal fractions like `0.1 + 0.2` or Libyan Dirham thousandths (`0.005 LYD`) exactly, which would cause penny/dirham drift in the Double-Entry Ledger."
                    }
                ],
                "explanation": "The correct answer is: Because binary floating-point numbers cannot represent decimal fractions like `0.1 + 0.2` or Libyan Dirham thousandths (`0.005 LYD`) exactly, which would cause penny/dirham drift in the Double-Entry Ledger.",
                "critical": false
            },
            {
                "id": "QUIZ-M4-Q2",
                "questionEn": "When a customer pays `100.0000 LYD` on a `MERCHANT_DIRECT` route (using the merchant's own DPay credentials) with a `3%` platform commission, what journal entry is posted at confirmation?",
                "options": [
                    {
                        "text": "`Dr TREASURY 100 / Cr MERCHANT_WALLET 97 / Cr PLATFORM_INCOME 3`",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: `Dr COMMISSION_RECEIVABLE 3.0000 / Cr PLATFORM_INCOME 3.0000` (because the `100 LYD` went directly to the merchant's own bank account and never touched our platform)."
                    },
                    {
                        "text": "`Dr COMMISSION_RECEIVABLE 3.0000 / Cr PLATFORM_INCOME 3.0000` (because the `100 LYD` went directly to the merchant's own bank account and never touched our platform).",
                        "correct": true,
                        "explanation": "The correct answer is: `Dr COMMISSION_RECEIVABLE 3.0000 / Cr PLATFORM_INCOME 3.0000` (because the `100 LYD` went directly to the merchant's own bank account and never touched our platform)."
                    }
                ],
                "explanation": "The correct answer is: `Dr COMMISSION_RECEIVABLE 3.0000 / Cr PLATFORM_INCOME 3.0000` (because the `100 LYD` went directly to the merchant's own bank account and never touched our platform).",
                "critical": false
            },
            {
                "id": "QUIZ-M4-Q3",
                "questionEn": "What happens automatically if a `MERCHANT_DIRECT` merchant's unpaid `COMMISSION_RECEIVABLE` balance exceeds their `commission_receivable_ceiling` (Edge Case 48)?",
                "options": [
                    {
                        "text": "Their merchant account is permanently deleted.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: The guard pipeline automatically pauses their direct routes (`CEILING_EXCEEDED_PAUSE`) and nets the receivable against any platform-held wallet balance until paid."
                    },
                    {
                        "text": "The guard pipeline automatically pauses their direct routes (`CEILING_EXCEEDED_PAUSE`) and nets the receivable against any platform-held wallet balance until paid.",
                        "correct": true,
                        "explanation": "The correct answer is: The guard pipeline automatically pauses their direct routes (`CEILING_EXCEEDED_PAUSE`) and nets the receivable against any platform-held wallet balance until paid."
                    }
                ],
                "explanation": "The correct answer is: The guard pipeline automatically pauses their direct routes (`CEILING_EXCEEDED_PAUSE`) and nets the receivable against any platform-held wallet balance until paid.",
                "critical": false
            },
            {
                "id": "QUIZ-M4-Q4",
                "questionEn": "Why does a `neompay` (`kind = INTERNAL`) payment debit `TREASURY` directly at confirmation instead of `GATEWAY_CLEARING` (Ledger Rule INTERNAL-1)?",
                "options": [
                    {
                        "text": "Because NeomPay does not charge commissions.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Because NeomPay is our first-party internal wallet ledger, so the payer's debit and our Treasury credit happen instantaneously inside our own operator-controlled ledger with zero external bank clearing delay."
                    },
                    {
                        "text": "Because NeomPay is our first-party internal wallet ledger, so the payer's debit and our Treasury credit happen instantaneously inside our own operator-controlled ledger with zero external bank clearing delay.",
                        "correct": true,
                        "explanation": "The correct answer is: Because NeomPay is our first-party internal wallet ledger, so the payer's debit and our Treasury credit happen instantaneously inside our own operator-controlled ledger with zero external bank clearing delay."
                    }
                ],
                "explanation": "The correct answer is: Because NeomPay is our first-party internal wallet ledger, so the payer's debit and our Treasury credit happen instantaneously inside our own operator-controlled ledger with zero external bank clearing delay.",
                "critical": false
            },
            {
                "id": "QUIZ-M4-Q5",
                "questionEn": "When an payment is placed on `AML_HOLD` at confirmation (Journal Entry 7), when is the `3.0000 LYD` platform commission credited to `PLATFORM_INCOME`?",
                "options": [
                    {
                        "text": "Immediately at confirmation.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Only if and when the `MLRO` Checker approves releasing the hold (`AML_RELEASE`). While held, the full `100.0000 LYD` sits in `AML_HOLD` so profitability reports never overstate revenue on frozen funds."
                    },
                    {
                        "text": "Only if and when the `MLRO` Checker approves releasing the hold (`AML_RELEASE`). While held, the full `100.0000 LYD` sits in `AML_HOLD` so profitability reports never overstate revenue on frozen funds.",
                        "correct": true,
                        "explanation": "The correct answer is: Only if and when the `MLRO` Checker approves releasing the hold (`AML_RELEASE`). While held, the full `100.0000 LYD` sits in `AML_HOLD` so profitability reports never overstate revenue on frozen funds."
                    }
                ],
                "explanation": "The correct answer is: Only if and when the `MLRO` Checker approves releasing the hold (`AML_RELEASE`). While held, the full `100.0000 LYD` sits in `AML_HOLD` so profitability reports never overstate revenue on frozen funds.",
                "critical": true
            },
            {
                "id": "QUIZ-M4-Q6",
                "questionEn": "What happens if an operator accidentally uploads the exact same daily CSV bank statement file twice in `/reconciliation`?",
                "options": [
                    {
                        "text": "Every transaction is swept into `TREASURY` twice.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: `reconciliation_runs.file_hash` (`UNIQUE` SHA-256 hash of the file) detects the duplicate upload immediately and makes it a harmless no-op."
                    },
                    {
                        "text": "`reconciliation_runs.file_hash` (`UNIQUE` SHA-256 hash of the file) detects the duplicate upload immediately and makes it a harmless no-op.",
                        "correct": true,
                        "explanation": "The correct answer is: `reconciliation_runs.file_hash` (`UNIQUE` SHA-256 hash of the file) detects the duplicate upload immediately and makes it a harmless no-op."
                    }
                ],
                "explanation": "The correct answer is: `reconciliation_runs.file_hash` (`UNIQUE` SHA-256 hash of the file) detects the duplicate upload immediately and makes it a harmless no-op.",
                "critical": false
            },
            {
                "id": "QUIZ-M4-Q7",
                "questionEn": "How is a Merchant Wallet's live balance calculated by `CheckpointService`?",
                "options": [
                    {
                        "text": "By reading a mutable `balance` column on the `wallets` table.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: By taking the linked `gl_accounts.checkpoint_balance` and adding `SUM(journal_lines posted after last_checkpoint_id)`."
                    },
                    {
                        "text": "By taking the linked `gl_accounts.checkpoint_balance` and adding `SUM(journal_lines posted after last_checkpoint_id)`.",
                        "correct": true,
                        "explanation": "The correct answer is: By taking the linked `gl_accounts.checkpoint_balance` and adding `SUM(journal_lines posted after last_checkpoint_id)`."
                    }
                ],
                "explanation": "The correct answer is: By taking the linked `gl_accounts.checkpoint_balance` and adding `SUM(journal_lines posted after last_checkpoint_id)`.",
                "critical": false
            },
            {
                "id": "QUIZ-M4-Q8",
                "questionEn": "What does the platform do automatically if `/finance/invariant-check` detects even `0.0010 LYD` of unexplained ledger drift?",
                "options": [
                    {
                        "text": "Ignores it if it is less than 1 Dinar.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Fires a `P1` alert and immediately halts automated merchant cash-out payouts (`Runbook RB-04`) until Finance reconciles the drift. ---"
                    },
                    {
                        "text": "Fires a `P1` alert and immediately halts automated merchant cash-out payouts (`Runbook RB-04`) until Finance reconciles the drift. ---",
                        "correct": true,
                        "explanation": "The correct answer is: Fires a `P1` alert and immediately halts automated merchant cash-out payouts (`Runbook RB-04`) until Finance reconciles the drift. ---"
                    }
                ],
                "explanation": "The correct answer is: Fires a `P1` alert and immediately halts automated merchant cash-out payouts (`Runbook RB-04`) until Finance reconciles the drift. ---",
                "critical": false
            }
        ]
    }
];

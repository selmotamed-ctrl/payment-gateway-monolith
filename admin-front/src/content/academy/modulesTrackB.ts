import type { AcademyModule } from "./types";

export const ACADEMY_MODULES_TRACK_B: AcademyModule[] = [
    {
        "id": "M5",
        "code": "M5",
        "letter": "M–P",
        "titleEn": "The Universal Rail Engine, 8-Step Gateway Wizard & Smart AI Importer",
        "titleAr": "محرك السكك الشامل ومعالج البوابة ذو 8 خطوات ومستورد الذكاء الاصطناعي",
        "summaryEn": "Configure a two-step OTP rail, enforce MOVES_MONEY safety, and prove a Moamalat HEX-HMAC profile.",
        "summaryAr": "أعد سكة OTP بخطوتين وفرض أمان MOVES_MONEY وأثبت ملف Moamalat HEX-HMAC.",
        "tracks": [
            "GATEWAY_ARCHITECT",
            "MASTER_OPERATOR"
        ],
        "lessons": [
            {
                "id": "M5-L1",
                "titleEn": "Mastering the 8-Step Wizard & Save-Time Safety Guards — Part 1",
                "bodyEn": "When configuring a Gateway Version in `/gateways/wizard/:id`, the save-time validator enforces strict engineering rules so you cannot accidentally build an unsafe integration:\n1. **The `MOVES_MONEY` Retry Rule:** Any `FlowStep` with `side_effect = MOVES_MONEY` (such as confirming an OTP in `SUBMIT` or sending a `REFUND`) **must** have `retry_policy = NEVER` (unless `supports_idempotency_key = true` and `idempotency_config` is configured and proven).\n2. **The Weak-Channel Inquiry Rule:** Any `ConfirmationChannel` using `RETURN_URL`, `BROWSER_CALLBACK`, `IP_ONLY`, or `SHARED_TOKEN` **must** have `must_inquire = true` (forcing the engine to run the `VERIFY` inquiry flow before trusting the event)."
            },
            {
                "id": "M5-L2",
                "titleEn": "Mastering the 8-Step Wizard & Save-Time Safety Guards — Part 2",
                "bodyEn": "3. **The Host-Pinned Credential Rule (Safeguard 11):** Every URL in `base_urls` and `flow_steps` must use `https://` and its hostname must be listed in `gateway_environments.allowed_hosts`. If someone changes a flow step URL to an unlisted external domain, the engine refuses to attach any secrets from `credential_sets`!\n4. **The Unmapped Money-Step Rule:** In `StatusRule`, if a `MOVES_MONEY` step receives a response that matches **none** of your status rules, the engine transitions the attempt to **`UNKNOWN`** (never `FAILED`)."
            }
        ],
        "lab": {
            "id": "LAB-05",
            "titleEn": "Build & Verify a Two-Step OTP Rail + Moamalat Hex-HMAC Profile",
            "descriptionEn": "- **What the Student Does in the Lab:**\n  1. Configures a 2-step `OTP_PULL` flow (`INITIATE` `/verify` extracting `result.process_id -> STATE.process_id`, and `SUBMIT` `/confirm` sending `STATE.process_id + CUSTOMER_FIELD.otp + ATTEMPT.gateway_reference`). If the student leaves `retry_policy = SAFE` on the `SUBMIT` step, the validator catches it and explains why `MOVES_MONEY` requires `retry_policy = NEVER`.\n  2. Configures a Moamalat `CryptoProfile`: selects `HMAC_SHA256`, `SORTED_KEY_VALUE_AMP`, `HEX_UPPER`, and switches `secret_key_encoding` from `UTF8` to **`HEX`** so the test vector signature matches the official Moamalat sample!",
            "scenarios": [
                {
                    "id": "LAB-05-S1",
                    "titleEn": "MOVES_MONEY retry policy",
                    "promptEn": "You configure a 2-step OTP_PULL flow. The SUBMIT step sends STATE.process_id + CUSTOMER_FIELD.otp + ATTEMPT.gateway_reference and moves money. What retry_policy must it have?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "SAFE",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! A timed-out SUBMIT retried with SAFE can debit the customer twice."
                        },
                        {
                            "id": "b",
                            "labelEn": "NEVER",
                            "feedbackEn": "Correct. MOVES_MONEY must never retry unless cryptographic idempotency is proven."
                        },
                        {
                            "id": "c",
                            "labelEn": "AGGRESSIVE",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! Aggressive retries on a money step are catastrophic."
                        }
                    ]
                },
                {
                    "id": "LAB-05-S2",
                    "titleEn": "Moamalat secret key encoding",
                    "promptEn": "You configure a Moamalat CryptoProfile with HMAC_SHA256, SORTED_KEY_VALUE_AMP, HEX_UPPER, but the test vector signature does not match. What is the likely fix?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Switch secret_key_encoding from UTF8 to HEX.",
                            "feedbackEn": "Correct. Moamalat issues the MerchantSecretKey as a hexadecimal string that must be decoded into raw bytes."
                        },
                        {
                            "id": "b",
                            "labelEn": "Change HMAC_SHA256 to MD5.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! Changing the algorithm breaks the partner contract and security."
                        },
                        {
                            "id": "c",
                            "labelEn": "Disable signature verification.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! Disabling verification accepts forged callbacks and can move money incorrectly."
                        }
                    ]
                }
            ]
        },
        "quiz": [
            {
                "id": "QUIZ-M5-Q1",
                "questionEn": "Why must `secret_key_encoding` be set to `HEX` (not `UTF8`) when configuring a `CryptoProfile` for the Moamalat National Switch?",
                "options": [
                    {
                        "text": "Because Moamalat uses RSA keys.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Because Moamalat issues its `MerchantSecretKey` as a hexadecimal string that must be decoded into raw binary bytes before computing `HMAC-SHA256`."
                    },
                    {
                        "text": "Because Moamalat issues its `MerchantSecretKey` as a hexadecimal string that must be decoded into raw binary bytes before computing `HMAC-SHA256`.",
                        "correct": true,
                        "explanation": "The correct answer is: Because Moamalat issues its `MerchantSecretKey` as a hexadecimal string that must be decoded into raw binary bytes before computing `HMAC-SHA256`."
                    }
                ],
                "explanation": "The correct answer is: Because Moamalat issues its `MerchantSecretKey` as a hexadecimal string that must be decoded into raw binary bytes before computing `HMAC-SHA256`.",
                "critical": false
            },
            {
                "id": "QUIZ-M5-Q2",
                "questionEn": "What transform pipeline converts a `10.5000 LYD` payment link amount into the `\"10500\"` integer Dirham string expected by Moamalat?",
                "options": [
                    {
                        "text": "`round(NEAREST, 2) |> format_decimal(2)`",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: `scale(1000) |> to_int |> to_string`"
                    },
                    {
                        "text": "`scale(1000) |> to_int |> to_string`",
                        "correct": true,
                        "explanation": "The correct answer is: `scale(1000) |> to_int |> to_string`"
                    }
                ],
                "explanation": "The correct answer is: `scale(1000) |> to_int |> to_string`",
                "critical": false
            },
            {
                "id": "QUIZ-M5-Q3",
                "questionEn": "In a 2-step `OTP_PULL` flow (like Edfali or Sadad), `INITIATE` Step 1 receives a `process_id` from the gateway that will be needed later in `SUBMIT` Step 1, but should NOT be exposed to the customer's browser. What should `store_as` be set to on that `StepOutput`?",
                "options": [
                    {
                        "text": "`PUBLIC`",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: `STATE` (which encrypts it inside `payment_attempts.context_ciphertext` on the server)."
                    },
                    {
                        "text": "`STATE` (which encrypts it inside `payment_attempts.context_ciphertext` on the server).",
                        "correct": true,
                        "explanation": "The correct answer is: `STATE` (which encrypts it inside `payment_attempts.context_ciphertext` on the server)."
                    }
                ],
                "explanation": "The correct answer is: `STATE` (which encrypts it inside `payment_attempts.context_ciphertext` on the server).",
                "critical": false
            },
            {
                "id": "QUIZ-M5-Q4",
                "questionEn": "When using the Smart AI Integration Importer (`/gateways/ai-import`), what must you NEVER paste into the external AI chat?",
                "options": [
                    {
                        "text": "The bank's sample JSON responses.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Real `LIVE` API keys, passwords, or HMAC secrets (give the AI only the credential field *names*; enter real secrets in Step 3 inside our portal after upload)."
                    },
                    {
                        "text": "Real `LIVE` API keys, passwords, or HMAC secrets (give the AI only the credential field *names*; enter real secrets in Step 3 inside our portal after upload).",
                        "correct": true,
                        "explanation": "The correct answer is: Real `LIVE` API keys, passwords, or HMAC secrets (give the AI only the credential field *names*; enter real secrets in Step 3 inside our portal after upload)."
                    }
                ],
                "explanation": "The correct answer is: Real `LIVE` API keys, passwords, or HMAC secrets (give the AI only the credential field *names*; enter real secrets in Step 3 inside our portal after upload).",
                "critical": false
            },
            {
                "id": "QUIZ-M5-Q5",
                "questionEn": "What happens if an admin edits a gateway's flows while 40 customers are currently in the middle of paying on that gateway?",
                "options": [
                    {
                        "text": "Those 40 customers fail immediately.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Every `payment_attempts` row pins `gateway_version_id` at creation, and admin edits always create a new `DRAFT` `GatewayVersion`, so all 40 in-flight attempts finish on the exact version they started with (Edge Case 68)."
                    },
                    {
                        "text": "Every `payment_attempts` row pins `gateway_version_id` at creation, and admin edits always create a new `DRAFT` `GatewayVersion`, so all 40 in-flight attempts finish on the exact version they started with (Edge Case 68).",
                        "correct": true,
                        "explanation": "The correct answer is: Every `payment_attempts` row pins `gateway_version_id` at creation, and admin edits always create a new `DRAFT` `GatewayVersion`, so all 40 in-flight attempts finish on the exact version they started with (Edge Case 68)."
                    }
                ],
                "explanation": "The correct answer is: Every `payment_attempts` row pins `gateway_version_id` at creation, and admin edits always create a new `DRAFT` `GatewayVersion`, so all 40 in-flight attempts finish on the exact version they started with (Edge Case 68).",
                "critical": false
            },
            {
                "id": "QUIZ-M5-Q6",
                "questionEn": "When classifying gateway error codes in `ErrorMap`, why is it critical to classify customer errors (`RETRYABLE_OTP`, `LIMIT_EXCEEDED`, `TERMINAL_DECLINE` for insufficient funds) with `counts_toward_breaker = false`?",
                "options": [
                    {
                        "text": "So customers don't see an error message.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: So that customers typing wrong OTPs or having empty bank accounts never trip the route's Circuit Breaker (`OPEN_BREAKER`) and shut down the rail for everyone else!"
                    },
                    {
                        "text": "So that customers typing wrong OTPs or having empty bank accounts never trip the route's Circuit Breaker (`OPEN_BREAKER`) and shut down the rail for everyone else!",
                        "correct": true,
                        "explanation": "The correct answer is: So that customers typing wrong OTPs or having empty bank accounts never trip the route's Circuit Breaker (`OPEN_BREAKER`) and shut down the rail for everyone else!"
                    }
                ],
                "explanation": "The correct answer is: So that customers typing wrong OTPs or having empty bank accounts never trip the route's Circuit Breaker (`OPEN_BREAKER`) and shut down the rail for everyone else!",
                "critical": false
            },
            {
                "id": "QUIZ-M5-Q7",
                "questionEn": "Can a `StepParameter` on the first step (`order_index = 0`) of a flow use `source = PREVIOUS_RESPONSE`?",
                "options": [
                    {
                        "text": "Yes, it reads the request headers.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: No; there is no previous step response on step 0, and the save-time semantic validator rejects it immediately."
                    },
                    {
                        "text": "No; there is no previous step response on step 0, and the save-time semantic validator rejects it immediately.",
                        "correct": true,
                        "explanation": "The correct answer is: No; there is no previous step response on step 0, and the save-time semantic validator rejects it immediately."
                    }
                ],
                "explanation": "The correct answer is: No; there is no previous step response on step 0, and the save-time semantic validator rejects it immediately.",
                "critical": false
            },
            {
                "id": "QUIZ-M5-Q8",
                "questionEn": "What sensitivity level must be assigned to a `RailField` that collects a 7-digit MobiCash or 9-digit OnePay transaction card number?",
                "options": [
                    {
                        "text": "`NORMAL`",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: `PAN` (which holds the value in memory only for the single outbound call, never writes it to `context_ciphertext` or logs, and requires a PCI scope review—Gate 10). ---"
                    },
                    {
                        "text": "`PAN` (which holds the value in memory only for the single outbound call, never writes it to `context_ciphertext` or logs, and requires a PCI scope review—Gate 10). ---",
                        "correct": true,
                        "explanation": "The correct answer is: `PAN` (which holds the value in memory only for the single outbound call, never writes it to `context_ciphertext` or logs, and requires a PCI scope review—Gate 10). ---"
                    }
                ],
                "explanation": "The correct answer is: `PAN` (which holds the value in memory only for the single outbound call, never writes it to `context_ciphertext` or logs, and requires a PCI scope review—Gate 10). ---",
                "critical": false
            }
        ]
    },
    {
        "id": "M6",
        "code": "M6",
        "letter": "Q–S",
        "titleEn": "Handling `UNKNOWN` Payments, Outages, Circuit Breakers & Runbooks `RB-01`–`RB-05`",
        "titleAr": "معالجة مدفوعات UNKNOWN والانقطاعات وقواطع الدائرة والأدلة التشغيلية RB-01 إلى RB-05",
        "summaryEn": "Distinguish pre-PNR failover from post-PNR UNKNOWN, resolve inquiry and statement cases, and handle outages.",
        "summaryAr": "ميّز التحويل قبل PNR عن UNKNOWN بعده وحل حالات الاستعلام والكشف وتعامل مع الانقطاعات.",
        "tracks": [
            "SUPPORT",
            "OPERATIONS",
            "GATEWAY_ARCHITECT",
            "MASTER_OPERATOR"
        ],
        "lessons": [
            {
                "id": "M6-L1",
                "titleEn": "Point of No Return & Why `UNKNOWN` Is Our Most Important Safety Net — Part 1",
                "bodyEn": "Let's trace the difference between a failure **before** the Point of No Return (`INITIATE`) and a failure **at or after** the Point of No Return (`SUBMIT`):\n- **Case A — Gateway Fails at `INITIATE` (Before Point of No Return):**\n  - Customer clicks \"Pay with Edfali\". Our server tries to call our primary route (`plutu`), and Plutu's server returns `503 Service Unavailable`.\n  - Because no OTP was sent and no money could possibly have moved yet, our engine **transparently fails over** within milliseconds to our backup route (`edfali_direct`), sends the OTP through BCD Bank, and the customer never even notices Plutu was down!\n- **Case B — Gateway Times Out at `SUBMIT` (At Point of No Return — `MOVES_MONEY`):**"
            },
            {
                "id": "M6-L2",
                "titleEn": "Point of No Return & Why `UNKNOWN` Is Our Most Important Safety Net — Part 2",
                "bodyEn": "  - Customer received their OTP, typed `482910`, and clicked Confirm. Our server sent the debit call to the bank, and after 15 seconds (`timeout_ms`), the bank hadn't replied.\n  - Did the bank take the customer's `250 LYD` right before the connection dropped, or did the request never reach them? **We do not know.**\n  - Therefore, our engine moves the attempt to **`UNKNOWN`**, keeps the link slot locked (`active_locked_count = 1`), shows the customer *\"We are confirming your payment with the bank—please do not pay again\"*, starts background `PollWorker` inquiries, and opens an **`OperatorCase`** in `/operator-cases`."
            }
        ],
        "lab": {
            "id": "LAB-06",
            "titleEn": "Incident & `UNKNOWN` Queue Simulator",
            "descriptionEn": "- **What the Student Resolves in the Lab:**\n  1. **Ticket 1 (`UNKNOWN` on LYPay — Supports Inquiry):** Student clicks **\"Inquire Gateway Now\"**, inspects the `VERIFY` response (`status: \"Confirmed\", provider_ref: \"LYP-99201\", amount: \"250.000\"`), and watches the attempt transition to `SUCCEEDED` and post the ledger entry.\n  2. **Ticket 2 (`UNKNOWN` on Edfali Direct — No Inquiry API):** The \"Inquire\" button is disabled because Edfali direct has no inquiry endpoint. The student must upload the daily Edfali CSV statement (or verify the `provider_reference` from the bank statement preview) before proposing a Maker-Checker resolution—if the student tries to click \"Force Mark Failed Without Evidence\", the simulator blocks them and explains why that could double-charge the customer!\n  3. **Ticket 3 (`P1 CONFLICT` on MyPay):** Webhook said `PAID`, but Inquiry returned `FAILED`. The student inspects the raw `inbound_events` log vs `attempt_step_logs`, verifies against the settlement statement that no funds settled, and submits a Maker-Checker resolution to `FAILED`.",
            "scenarios": [
                {
                    "id": "LAB-06-S1",
                    "titleEn": "UNKNOWN with inquiry support",
                    "promptEn": "Ticket 1 is UNKNOWN on LYPay and supports_status_check = true. You click Inquire Gateway Now and receive status Confirmed, provider_ref LYP-99201, amount 250.000. What happens next?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Resolve to SUCCEEDED and post the ledger entry.",
                            "feedbackEn": "Correct. The inquiry is a server-trusted channel and all success facts match."
                        },
                        {
                            "id": "b",
                            "labelEn": "Force FAILED and release the slot.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You marked a confirmed payment FAILED and released the slot for a second charge."
                        },
                        {
                            "id": "c",
                            "labelEn": "Wait for the customer to pay again.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! Asking for a second payment on a confirmed charge double-bills the customer."
                        }
                    ]
                },
                {
                    "id": "LAB-06-S2",
                    "titleEn": "UNKNOWN with no inquiry API",
                    "promptEn": "Ticket 2 is UNKNOWN on Edfali Direct, which has no inquiry endpoint. What is the safe path?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Force Mark Failed Without Evidence.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! Edfali may have taken the money; forcing FAILED can double-charge the customer."
                        },
                        {
                            "id": "b",
                            "labelEn": "Upload the daily Edfali CSV statement or verify provider_reference, then propose a Maker-Checker resolution.",
                            "feedbackEn": "Correct. Without an inquiry API, evidence must come from the statement or written provider confirmation."
                        },
                        {
                            "id": "c",
                            "labelEn": "Retry the SUBMIT call immediately.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! Retrying a non-idempotent money call can debit twice."
                        }
                    ]
                },
                {
                    "id": "LAB-06-S3",
                    "titleEn": "CONFLICT on MyPay",
                    "promptEn": "Ticket 3 is a P1 CONFLICT on MyPay: the webhook says PAID but the inquiry returned FAILED. What do you do?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Trust the webhook and credit the wallet.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! Neither signal is trusted automatically in a CONFLICT."
                        },
                        {
                            "id": "b",
                            "labelEn": "Inspect inbound_events and attempt_step_logs, verify the settlement statement, then propose a Maker-Checker resolution.",
                            "feedbackEn": "Correct. Evidence from the official statement resolves the contradiction."
                        },
                        {
                            "id": "c",
                            "labelEn": "Trust the inquiry and mark FAILED without review.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You ignored a contradictory paid webhook and closed the case without evidence."
                        }
                    ]
                }
            ]
        },
        "quiz": [
            {
                "id": "QUIZ-M6-Q1",
                "questionEn": "When a `MOVES_MONEY` step (`SUBMIT`) times out after 15 seconds, why does the engine NEVER automatically retry the request (unless cryptographic idempotency is proven)?",
                "options": [
                    {
                        "text": "To save bandwidth.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Because if the first request actually succeeded at the bank right before the connection timed out, sending a second non-idempotent request could debit the customer's bank account twice!"
                    },
                    {
                        "text": "Because if the first request actually succeeded at the bank right before the connection timed out, sending a second non-idempotent request could debit the customer's bank account twice!",
                        "correct": true,
                        "explanation": "The correct answer is: Because if the first request actually succeeded at the bank right before the connection timed out, sending a second non-idempotent request could debit the customer's bank account twice!"
                    }
                ],
                "explanation": "The correct answer is: Because if the first request actually succeeded at the bank right before the connection timed out, sending a second non-idempotent request could debit the customer's bank account twice!",
                "critical": true
            },
            {
                "id": "QUIZ-M6-Q2",
                "questionEn": "How can an operator safely retire an old Route (`RailRoute`) and move traffic to a new Route without dropping customers who are currently typing their OTPs?",
                "options": [
                    {
                        "text": "Delete the old Route immediately.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Set the old Route's status to `DRAINING`, which stops new attempts from picking it while allowing all in-flight pinned attempts to finish cleanly."
                    },
                    {
                        "text": "Set the old Route's status to `DRAINING`, which stops new attempts from picking it while allowing all in-flight pinned attempts to finish cleanly.",
                        "correct": true,
                        "explanation": "The correct answer is: Set the old Route's status to `DRAINING`, which stops new attempts from picking it while allowing all in-flight pinned attempts to finish cleanly."
                    }
                ],
                "explanation": "The correct answer is: Set the old Route's status to `DRAINING`, which stops new attempts from picking it while allowing all in-flight pinned attempts to finish cleanly.",
                "critical": false
            },
            {
                "id": "QUIZ-M6-Q3",
                "questionEn": "What happens when the only active Route for a Rail opens its Circuit Breaker (`OPEN_BREAKER`) during a bank outage?",
                "options": [
                    {
                        "text": "All Payment Links on the platform break.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: That single Rail is temporarily hidden from checkout by the Visible Rails Formula while all other healthy Rails on the Payment Link continue working normally, and an alert fires (`RB-01` / Edge Case 53)."
                    },
                    {
                        "text": "That single Rail is temporarily hidden from checkout by the Visible Rails Formula while all other healthy Rails on the Payment Link continue working normally, and an alert fires (`RB-01` / Edge Case 53).",
                        "correct": true,
                        "explanation": "The correct answer is: That single Rail is temporarily hidden from checkout by the Visible Rails Formula while all other healthy Rails on the Payment Link continue working normally, and an alert fires (`RB-01` / Edge Case 53)."
                    }
                ],
                "explanation": "The correct answer is: That single Rail is temporarily hidden from checkout by the Visible Rails Formula while all other healthy Rails on the Payment Link continue working normally, and an alert fires (`RB-01` / Edge Case 53).",
                "critical": false
            },
            {
                "id": "QUIZ-M6-Q4",
                "questionEn": "How does a Route in `OPEN_BREAKER` state test whether the upstream bank has recovered?",
                "options": [
                    {
                        "text": "By sending real customer money calls through it.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: By running periodic half-open read-only `CREDENTIAL_CHECK` or `VERIFY` probes; once healthy probes succeed, the breaker closes back to `HEALTHY`."
                    },
                    {
                        "text": "By running periodic half-open read-only `CREDENTIAL_CHECK` or `VERIFY` probes; once healthy probes succeed, the breaker closes back to `HEALTHY`.",
                        "correct": true,
                        "explanation": "The correct answer is: By running periodic half-open read-only `CREDENTIAL_CHECK` or `VERIFY` probes; once healthy probes succeed, the breaker closes back to `HEALTHY`."
                    }
                ],
                "explanation": "The correct answer is: By running periodic half-open read-only `CREDENTIAL_CHECK` or `VERIFY` probes; once healthy probes succeed, the breaker closes back to `HEALTHY`.",
                "critical": false
            },
            {
                "id": "QUIZ-M6-Q5",
                "questionEn": "Before `ExpirySweeperWorker` marks an expired `AWAITING_CUSTOMER` or `VERIFYING` attempt as `EXPIRED`, what must it do first (for any gateway where `supports_status_check = true`)?",
                "options": [
                    {
                        "text": "Delete the attempt logs.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Execute one final `inquire(attempt)` (`VERIFY` flow) to ensure the customer didn't complete the payment in the final seconds before expiry (Edge Case 1)."
                    },
                    {
                        "text": "Execute one final `inquire(attempt)` (`VERIFY` flow) to ensure the customer didn't complete the payment in the final seconds before expiry (Edge Case 1).",
                        "correct": true,
                        "explanation": "The correct answer is: Execute one final `inquire(attempt)` (`VERIFY` flow) to ensure the customer didn't complete the payment in the final seconds before expiry (Edge Case 1)."
                    }
                ],
                "explanation": "The correct answer is: Execute one final `inquire(attempt)` (`VERIFY` flow) to ensure the customer didn't complete the payment in the final seconds before expiry (Edge Case 1).",
                "critical": false
            },
            {
                "id": "QUIZ-M6-Q6",
                "questionEn": "Why does the webhook inbox stay open for `grace_expires_at` (24 hours by default) even *after* an attempt has transitioned to `EXPIRED`?",
                "options": [
                    {
                        "text": "Because webhooks are only processed once a week.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Because a customer might approve a push notification or scan a QR code just before expiry while the bank's webhook arrives late; the grace window allows verified late-success recovery (`EXPIRED -> SUCCEEDED` or `SUSPENSE` refund if the link was already paid)."
                    },
                    {
                        "text": "Because a customer might approve a push notification or scan a QR code just before expiry while the bank's webhook arrives late; the grace window allows verified late-success recovery (`EXPIRED -> SUCCEEDED` or `SUSPENSE` refund if the link was already paid).",
                        "correct": true,
                        "explanation": "The correct answer is: Because a customer might approve a push notification or scan a QR code just before expiry while the bank's webhook arrives late; the grace window allows verified late-success recovery (`EXPIRED -> SUCCEEDED` or `SUSPENSE` refund if the link was already paid)."
                    }
                ],
                "explanation": "The correct answer is: Because a customer might approve a push notification or scan a QR code just before expiry while the bank's webhook arrives late; the grace window allows verified late-success recovery (`EXPIRED -> SUCCEEDED` or `SUSPENSE` refund if the link was already paid).",
                "critical": false
            },
            {
                "id": "QUIZ-M6-Q7",
                "questionEn": "If a gateway returns HTTP `200 OK` on a `MOVES_MONEY` step, but the gateway silently renamed its JSON field from `result.tx_id` to `data.transactionId` so our required `PROVIDER_REF` output selector finds nothing, what state does the attempt enter (Edge Case 57)?",
                "options": [
                    {
                        "text": "`FAILED`",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: `UNKNOWN` (preserving the raw response text in `attempt_step_logs` and alerting engineering so a real debit is never lost)."
                    },
                    {
                        "text": "`UNKNOWN` (preserving the raw response text in `attempt_step_logs` and alerting engineering so a real debit is never lost).",
                        "correct": true,
                        "explanation": "The correct answer is: `UNKNOWN` (preserving the raw response text in `attempt_step_logs` and alerting engineering so a real debit is never lost)."
                    }
                ],
                "explanation": "The correct answer is: `UNKNOWN` (preserving the raw response text in `attempt_step_logs` and alerting engineering so a real debit is never lost).",
                "critical": true
            },
            {
                "id": "QUIZ-M6-Q8",
                "questionEn": "When an inbound webhook arrives from a gateway with a valid cryptographic HMAC signature, but from a new IP address that is not in `inbound_ip_allowlist`, what happens (`Runbook RB-02`)?",
                "options": [
                    {
                        "text": "The system deletes the gateway.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: The event is stored in `inbound_events` (`verified = false`), an unlisted-IP security alert fires (`RB-02`), and once Security confirms the new IP with the partner and updates the allowlist under Maker-Checker, the stored event can be replayed losslessly from the inbox. ---"
                    },
                    {
                        "text": "The event is stored in `inbound_events` (`verified = false`), an unlisted-IP security alert fires (`RB-02`), and once Security confirms the new IP with the partner and updates the allowlist under Maker-Checker, the stored event can be replayed losslessly from the inbox. ---",
                        "correct": true,
                        "explanation": "The correct answer is: The event is stored in `inbound_events` (`verified = false`), an unlisted-IP security alert fires (`RB-02`), and once Security confirms the new IP with the partner and updates the allowlist under Maker-Checker, the stored event can be replayed losslessly from the inbox. ---"
                    }
                ],
                "explanation": "The correct answer is: The event is stored in `inbound_events` (`verified = false`), an unlisted-IP security alert fires (`RB-02`), and once Security confirms the new IP with the partner and updates the allowlist under Maker-Checker, the stored event can be replayed losslessly from the inbox. ---",
                "critical": false
            }
        ]
    },
    {
        "id": "M7",
        "code": "M7",
        "letter": "T–V",
        "titleEn": "The 7-Layer AML Program, Arabic Name Matching, Velocity Rules & No Tipping-Off",
        "titleAr": "برنامج AML ذو 7 طبقات ومطابقة الأسماء العربية وقواعد السرعة وعدم الإفصاح",
        "summaryEn": "Disposition Arabic-name screening matches, detect structuring across links, and enforce no-tipping-off.",
        "summaryAr": "صنّف تطابقات الأسماء العربية واكتشف التجزئة عبر الروابط وفرض عدم الإفصاح.",
        "tracks": [
            "COMPLIANCE",
            "MASTER_OPERATOR"
        ],
        "lessons": [
            {
                "id": "M7-L1",
                "titleEn": "Dispositioning Screening Matches & The Arabic Name Challenge",
                "bodyEn": "When our `ScreeningProvider` checks a Merchant or Beneficial Owner against Sanctions and PEP lists, it normalizes Arabic script (removing diacritics/tashkeel, unifying `أ إ آ ا` to `ا`, `ة` to `ه`, `ى` to `ي`) and checks both Arabic and Latin transliterations.\nEvery candidate hit in `aml_screening_matches` must be reviewed by a `COMPLIANCE` analyst and given a disposition:\n1. **`FALSE_POSITIVE`:** Common name similarity, but Date of Birth, Nationality, or National ID proves it is a different person. You may toggle **`suppress_future = true`** with a `suppress_until` expiry date so periodic re-screens don't re-alert on the exact same list entry—unless the owner's identifying data changes!\n2. **`TRUE_MATCH` / `ESCALATED`:** Genuine match on a PEP or Sanctions list. For a Sanctions match, the merchant is immediately restricted (`SUSPENDED` via emergency path), cash-outs are frozen, and an STR draft is opened for the `MLRO`."
            },
            {
                "id": "M7-L2",
                "titleEn": "The Strict \"No Tipping-Off\" Law",
                "bodyEn": "Under AML law and CBL regulations, **Tipping-Off**—telling a merchant, beneficial owner, or payer (directly or indirectly) that their payment or account is being held for AML suspicion or that a Suspicious Activity Report (`STR`) is being prepared—is a severe legal violation.\n- If a merchant contacts Support asking why a payment is taking time to settle or why their account was suspended, Support (`SUPPORT` role) **cannot even see** the `AML-CONFIDENTIAL` tables (`403 Forbidden`), and all merchant-facing messages use neutral operational wording."
            }
        ],
        "lab": {
            "id": "LAB-07",
            "titleEn": "Compliance & MLRO Investigation Simulator",
            "descriptionEn": "- **What the Student Resolves in the Lab:**\n  1. **Screening Match 1:** Beneficial Owner *\"محمد علي المبروك\"* born `1994-05-12` (Libyan National ID verified) matches a PEP list entry with a `78%` name score, but the PEP entry was born in `1952` in another country. *(Correct action: Disposition as `FALSE_POSITIVE` with notes comparing DOB and National ID, and set `suppress_future` for 12 months).*\n  2. **AML Case 2 (`CRITICAL` Correlated Escalation):** A merchant declared `expected_monthly_volume = 5,000 LYD` (small stationery shop), but today processed 8 rapid payments of `4,900 LYD` each (`39,200 LYD` total in 2 hours) just below the `5,000 LYD` threshold, triggering both a Velocity `FLAG` and the `STRUCTURING` AML rule! *(Correct action: Propose `ESCALATED_STR` / `FROZEN` for `MLRO` Checker approval, and verify that the merchant notification template contains zero mention of AML/Structuring).*",
            "scenarios": [
                {
                    "id": "LAB-07-S1",
                    "titleEn": "Arabic-name PEP false positive",
                    "promptEn": "Beneficial Owner محمد علي المبروك born 1994-05-12 matches a PEP entry born in 1952 in another country with a 78% name score. What disposition is correct?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "FALSE_POSITIVE with DOB and National ID notes, suppress_future for 12 months.",
                            "feedbackEn": "Correct. The discriminating evidence proves a different person, and suppression is scoped and expiring."
                        },
                        {
                            "id": "b",
                            "labelEn": "TRUE_MATCH and immediately report an STR.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You escalated a false positive based on name similarity alone."
                        },
                        {
                            "id": "c",
                            "labelEn": "Ignore the match without recording anything.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! An undispositioned screening hit is a compliance breach."
                        }
                    ]
                },
                {
                    "id": "LAB-07-S2",
                    "titleEn": "Structuring across links",
                    "promptEn": "A small stationery shop declared 5,000 LYD monthly volume but processed eight rapid payments of 4,900 LYD each (39,200 LYD in two hours) across different links, triggering a Velocity FLAG and the STRUCTURING rule. What do you do?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Propose ESCALATED_STR / FROZEN for MLRO approval and verify the merchant notification contains no AML wording.",
                            "feedbackEn": "Correct. The correlated escalation is CRITICAL and the no-tipping-off rule applies."
                        },
                        {
                            "id": "b",
                            "labelEn": "Email the merchant that they are under AML investigation.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You tipped off the subject, a severe legal violation."
                        },
                        {
                            "id": "c",
                            "labelEn": "Close the case because each payment is below 5,000 LYD.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! Structuring across links is exactly what CUMULATIVE_WINDOW and STRUCTURING detect."
                        }
                    ]
                }
            ]
        },
        "quiz": [
            {
                "id": "QUIZ-M7-Q1",
                "questionEn": "What happens when a single payment attempt triggers both a `FLAG` Velocity Rule and an AML Rule?",
                "options": [
                    {
                        "text": "Only the Velocity Rule is logged.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Correlated escalation automatically raises the `AmlCase` severity to `CRITICAL` (4-hour SLA)."
                    },
                    {
                        "text": "Correlated escalation automatically raises the `AmlCase` severity to `CRITICAL` (4-hour SLA).",
                        "correct": true,
                        "explanation": "The correct answer is: Correlated escalation automatically raises the `AmlCase` severity to `CRITICAL` (4-hour SLA)."
                    }
                ],
                "explanation": "The correct answer is: Correlated escalation automatically raises the `AmlCase` severity to `CRITICAL` (4-hour SLA).",
                "critical": true
            },
            {
                "id": "QUIZ-M7-Q2",
                "questionEn": "A merchant tries to evade a `10,000 LYD` `CUMULATIVE_WINDOW` or `STRUCTURING` AML rule by creating 5 separate `2,500 LYD` Payment Links across 2 different Applications. Does this evade our AML engine (Edge Case 125)?",
                "options": [
                    {
                        "text": "Yes, because rules only check one link at a time.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: No. `AmlRuleEngine` aggregates volume by subject (Merchant, Beneficial Owner, and Payer identifier) across all links, applications, and rails within the rolling window."
                    },
                    {
                        "text": "No. `AmlRuleEngine` aggregates volume by subject (Merchant, Beneficial Owner, and Payer identifier) across all links, applications, and rails within the rolling window.",
                        "correct": true,
                        "explanation": "The correct answer is: No. `AmlRuleEngine` aggregates volume by subject (Merchant, Beneficial Owner, and Payer identifier) across all links, applications, and rails within the rolling window."
                    }
                ],
                "explanation": "The correct answer is: No. `AmlRuleEngine` aggregates volume by subject (Merchant, Beneficial Owner, and Payer identifier) across all links, applications, and rails within the rolling window.",
                "critical": true
            },
            {
                "id": "QUIZ-M7-Q3",
                "questionEn": "When an AML threshold rule triggers on a `MERCHANT_DIRECT` payment (where the customer paid into the merchant's own DPay account), what action does the platform take (Edge Case 67)?",
                "options": [
                    {
                        "text": "Debits the merchant's personal bank account.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Because the platform never held the principal cash, it executes `CASE_ONLY` (blocks the checkout completion receipt, flags the merchant, and opens an operational `AmlCase` for investigation/reporting without posting a fake `AML_HOLD` journal entry)."
                    },
                    {
                        "text": "Because the platform never held the principal cash, it executes `CASE_ONLY` (blocks the checkout completion receipt, flags the merchant, and opens an operational `AmlCase` for investigation/reporting without posting a fake `AML_HOLD` journal entry).",
                        "correct": true,
                        "explanation": "The correct answer is: Because the platform never held the principal cash, it executes `CASE_ONLY` (blocks the checkout completion receipt, flags the merchant, and opens an operational `AmlCase` for investigation/reporting without posting a fake `AML_HOLD` journal entry)."
                    }
                ],
                "explanation": "The correct answer is: Because the platform never held the principal cash, it executes `CASE_ONLY` (blocks the checkout completion receipt, flags the merchant, and opens an operational `AmlCase` for investigation/reporting without posting a fake `AML_HOLD` journal entry).",
                "critical": true
            },
            {
                "id": "QUIZ-M7-Q4",
                "questionEn": "Who is the required Checker to approve resolving an `AmlCase` (`RELEASED` or `REJECTED_VOID`) or submitting a `RegulatoryReport`?",
                "options": [
                    {
                        "text": "Any `SUPPORT` agent.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: An `MLRO` (Money Laundering Reporting Officer, distinct from the Maker)."
                    },
                    {
                        "text": "The same `COMPLIANCE` analyst who investigated the case.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: An `MLRO` (Money Laundering Reporting Officer, distinct from the Maker)."
                    },
                    {
                        "text": "An `MLRO` (Money Laundering Reporting Officer, distinct from the Maker).",
                        "correct": true,
                        "explanation": "The correct answer is: An `MLRO` (Money Laundering Reporting Officer, distinct from the Maker)."
                    }
                ],
                "explanation": "The correct answer is: An `MLRO` (Money Laundering Reporting Officer, distinct from the Maker).",
                "critical": true
            },
            {
                "id": "QUIZ-M7-Q5",
                "questionEn": "Can a `RegulatoryReport` be transitioned to `SUBMITTED` if its underlying `ReportingRule` has `status = PROVISIONAL` (`OD-1`)?",
                "options": [
                    {
                        "text": "Yes, at any time.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Never. The platform refuses to generate a live regulatory filing from a `PROVISIONAL` rule until the rule is promoted to `CONFIRMED` with a written CBL circular reference (`source_reference`) via Maker-Checker."
                    },
                    {
                        "text": "Never. The platform refuses to generate a live regulatory filing from a `PROVISIONAL` rule until the rule is promoted to `CONFIRMED` with a written CBL circular reference (`source_reference`) via Maker-Checker.",
                        "correct": true,
                        "explanation": "The correct answer is: Never. The platform refuses to generate a live regulatory filing from a `PROVISIONAL` rule until the rule is promoted to `CONFIRMED` with a written CBL circular reference (`source_reference`) via Maker-Checker."
                    }
                ],
                "explanation": "The correct answer is: Never. The platform refuses to generate a live regulatory filing from a `PROVISIONAL` rule until the rule is promoted to `CONFIRMED` with a written CBL circular reference (`source_reference`) via Maker-Checker.",
                "critical": false
            },
            {
                "id": "QUIZ-M7-Q6",
                "questionEn": "Why does the Notification Template Validator block saving any `MERCHANT` or `PUBLIC` template that references `aml_case` or `screening` variables?",
                "options": [
                    {
                        "text": "Because those variables are too long for SMS.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: To structurally prevent accidental Tipping-Off of a merchant or payer under AML investigation."
                    },
                    {
                        "text": "To structurally prevent accidental Tipping-Off of a merchant or payer under AML investigation.",
                        "correct": true,
                        "explanation": "The correct answer is: To structurally prevent accidental Tipping-Off of a merchant or payer under AML investigation."
                    }
                ],
                "explanation": "The correct answer is: To structurally prevent accidental Tipping-Off of a merchant or payer under AML investigation.",
                "critical": true
            },
            {
                "id": "QUIZ-M7-Q7",
                "questionEn": "When `RetentionWorker` runs to purge expired personal data after the 5-year regulatory retention window (`OD-4`), what happens to `journal_entries` and `journal_lines`?",
                "options": [
                    {
                        "text": "They are deleted along with the attempts.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: `journal_entries` and `journal_lines` (which contain zero PII) are strictly excluded from retention deletion so that historical merchant wallet balances and the `0.0000 LYD` ledger invariant never shift!"
                    },
                    {
                        "text": "`journal_entries` and `journal_lines` (which contain zero PII) are strictly excluded from retention deletion so that historical merchant wallet balances and the `0.0000 LYD` ledger invariant never shift!",
                        "correct": true,
                        "explanation": "The correct answer is: `journal_entries` and `journal_lines` (which contain zero PII) are strictly excluded from retention deletion so that historical merchant wallet balances and the `0.0000 LYD` ledger invariant never shift!"
                    }
                ],
                "explanation": "The correct answer is: `journal_entries` and `journal_lines` (which contain zero PII) are strictly excluded from retention deletion so that historical merchant wallet balances and the `0.0000 LYD` ledger invariant never shift!",
                "critical": false
            },
            {
                "id": "QUIZ-M7-Q8",
                "questionEn": "If a confirmed `FALSE_POSITIVE` screening match has `suppress_future = true`, what happens if the merchant later updates that Beneficial Owner's name or National ID?",
                "options": [
                    {
                        "text": "The suppression stays active forever.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Changing the subject's identifying data (`input_hash` change) automatically revokes the suppression and triggers a fresh screening. ---"
                    },
                    {
                        "text": "Changing the subject's identifying data (`input_hash` change) automatically revokes the suppression and triggers a fresh screening. ---",
                        "correct": true,
                        "explanation": "The correct answer is: Changing the subject's identifying data (`input_hash` change) automatically revokes the suppression and triggers a fresh screening. ---"
                    }
                ],
                "explanation": "The correct answer is: Changing the subject's identifying data (`input_hash` change) automatically revokes the suppression and triggers a fresh screening. ---",
                "critical": false
            }
        ]
    },
    {
        "id": "M8",
        "code": "M8",
        "letter": "W–Z",
        "titleEn": "Disputes, Chargebacks, Refunds, Negative Balance Ceilings & The 12 Go-Live Gates",
        "titleAr": "النزاعات والاسترداد العكسي والاستردادات وسقوف الرصيد السالب وبوابات الإطلاق الاثنتا عشرة",
        "summaryEn": "Cap chargebacks after refunds, respect negative ceilings, run three-phase refunds, and audit all twelve gates.",
        "summaryAr": "حدّد سقف الاسترداد العكسي بعد الاستردادات واحترم السقوف السالبة ونفّذ الاسترداد بثلاث مراحل ودقق البوابات الاثنتي عشرة.",
        "tracks": [
            "FINANCE",
            "GATEWAY_ARCHITECT",
            "MASTER_OPERATOR"
        ],
        "lessons": [
            {
                "id": "M8-L1",
                "titleEn": "Voluntary Refunds vs. Subsequent Chargebacks (Preventing Double Loss)",
                "bodyEn": "Suppose a customer paid **`100.0000 LYD`** on a card rail. Two days later, the merchant voluntarily refunded **`40.0000 LYD`** to the customer (`PARTIALLY_REFUNDED`). A week later, the customer's bank sends a `100.0000 LYD` **Chargeback (`DISPUTE_OPENED`)** webhook for that same payment!\n- If our system blindly drafted a `100.0000 LYD` chargeback adjustment, the merchant would lose `40 + 100 = 140 LYD` on a `100 LYD` sale!\n- **How Our Platform Protects the Merchant (Edge Case 126):** When the dispute arrives, our engine locks the attempt (`SELECT ... FOR UPDATE`), sums all `EXECUTED` and `EXECUTING` refunds (`40.0000 LYD`), and automatically caps the drafted `CHARGEBACK` adjustment to the unrefunded remainder (**`60.0000 LYD`**). If the payment was already 100% refunded, it records the dispute with `NO_CHARGEBACK_DRAFTED` and drafts `0.0000 LYD`!"
            },
            {
                "id": "M8-L2",
                "titleEn": "The 12 Go-Live Gates (`GoLiveGateValidator`)",
                "bodyEn": "Neither `activateGatewayVersion` (promoting a draft to `LIVE`) nor `rollbackGatewayVersion` (rolling back to a previous version) can execute unless **all 12 Go-Live Gates** pass against persisted `GatewayVersionEvidence`:\n1. **Gate 1:** Four-Eyes Maker-Checker Approval (`checker_user_id != maker_user_id`).\n2. **Gate 2:** All 15 Automated Sandbox Scenarios Passed Green.\n3. **Gate 3:** Amount Pipeline Contract Test Passed (proving `amount_scale`, `amount_precision`, and `amount_rounding` on wire values).\n4. **Gate 4:** Reference Format Contract Test Passed (proving charset and max-length rules).\n5. **Gate 5:** Cryptographic Signature Contract Test Passed against captured partner vectors.\n6. **Gate 6:** Channel Verification Strength Enforced (`must_inquire = true` on all weak/hint channels).\n7. **Gate 7:** Named Rollback Version (`rollback_version_id`) Configured.\n8. **Gate 8:** Route Limits, Commission Profile, and Statement Parser Preview Verified.\n9. **Gate 9:** Evidence Level `VERIFIED` (or signed executive `risk_acceptance_note` for `HIGH_RISK` gateways; or green staging contract suite for `INTERNAL` NeomPay).\n10. **Gate 10:** PCI Scope Review Passed for any rail using a `PAN`-typed field.\n11. **Gate 11:** Canary Traffic Plan Configured.\n12. **Gate 12:** Route Health Alerts & Runbooks Wired."
            }
        ],
        "lab": {
            "id": "LAB-08",
            "titleEn": "Dispute Cap, Negative Ceiling & 12-Gate Audit Simulator",
            "descriptionEn": "- **Part A:** Student processes a dispute on a `200.0000 LYD` payment that already had a `50.0000 LYD` partial refund, verifies the system auto-capped the `CHARGEBACK` draft to `150.0000 LYD`, approves the reserve, uploads merchant delivery evidence, and resolves the dispute as `WON` (verifying Journal Entry 12 releases the reserve back to the merchant wallet and platform income).\n- **Part B:** Student inspects a `GatewayVersion` promotion request that is failing Gate 6 (`WEBHOOK` with `IP_ONLY` verification has `must_inquire = false`) and Gate 10 (a 7-digit card field is marked `NORMAL` instead of `PAN`), fixes both settings in the wizard preview, re-runs the gate validator to 12/12 green, and completes graduation!",
            "scenarios": [
                {
                    "id": "LAB-08-S1",
                    "titleEn": "Chargeback after a partial refund",
                    "promptEn": "A 200.0000 LYD payment already had a 50.0000 LYD partial refund. A 200.0000 LYD chargeback webhook arrives. What does SYSTEM_AUTOMATION draft?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "200.0000 LYD",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! The merchant would lose 250 LYD on a 200 LYD sale."
                        },
                        {
                            "id": "b",
                            "labelEn": "150.0000 LYD (capped to settled_amount minus executed refunds).",
                            "feedbackEn": "Correct. The total returned can never exceed the settled amount."
                        },
                        {
                            "id": "c",
                            "labelEn": "0.0000 LYD and close the dispute.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You ignored a valid chargeback remainder."
                        }
                    ]
                },
                {
                    "id": "LAB-08-S2",
                    "titleEn": "Two failing go-live gates",
                    "promptEn": "A GatewayVersion promotion fails Gate 6 (WEBHOOK with IP_ONLY verification has must_inquire = false) and Gate 10 (a 7-digit card field is marked NORMAL instead of PAN). What do you do?",
                    "options": [
                        {
                            "id": "a",
                            "labelEn": "Promote anyway; the gates are advisory.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! You bypassed a weak-channel gate and a PCI scope gate."
                        },
                        {
                            "id": "b",
                            "labelEn": "Fix must_inquire = true and the PAN sensitivity, re-run the validator to 12/12, then submit.",
                            "feedbackEn": "Correct. Every gate needs evidence before promotion."
                        },
                        {
                            "id": "c",
                            "labelEn": "Disable the gate validator.",
                            "fatal": true,
                            "feedbackEn": "Simulated Production Incident! Disabling the validator removes the platform's last release safety net."
                        }
                    ]
                }
            ]
        },
        "quiz": [
            {
                "id": "QUIZ-M8-Q1",
                "questionEn": "A `100.0000 LYD` payment had a `30.0000 LYD` partial refund executed yesterday. Today, a `100.0000 LYD` chargeback webhook arrives for that same attempt. What amount does `SYSTEM_AUTOMATION` draft for the `CHARGEBACK` adjustment (Edge Case 126)?",
                "options": [
                    {
                        "text": "`100.0000 LYD`",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: `70.0000 LYD` (capped to `settled_amount - executed_refunds` so the total returned never exceeds `100.0000 LYD`)."
                    },
                    {
                        "text": "`70.0000 LYD` (capped to `settled_amount - executed_refunds` so the total returned never exceeds `100.0000 LYD`).",
                        "correct": true,
                        "explanation": "The correct answer is: `70.0000 LYD` (capped to `settled_amount - executed_refunds` so the total returned never exceeds `100.0000 LYD`)."
                    },
                    {
                        "text": "`0.0000 LYD`",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: `70.0000 LYD` (capped to `settled_amount - executed_refunds` so the total returned never exceeds `100.0000 LYD`)."
                    }
                ],
                "explanation": "The correct answer is: `70.0000 LYD` (capped to `settled_amount - executed_refunds` so the total returned never exceeds `100.0000 LYD`).",
                "critical": true
            },
            {
                "id": "QUIZ-M8-Q2",
                "questionEn": "Why does our Refund execution use Three Separate Short Phases (Phase 1: Claim & set `EXECUTING` -> Phase 2: Call gateway over network with NO DB transaction open -> Phase 3: Finalize journal entry & set `EXECUTED`)?",
                "options": [
                    {
                        "text": "To make the UI spinner last longer.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: To prevent holding a MySQL row lock open during a slow external network call (which would deadlock the database) and to ensure that if the gateway times out, the adjustment stays safely in `EXECUTING` without ever double-refunding."
                    },
                    {
                        "text": "To prevent holding a MySQL row lock open during a slow external network call (which would deadlock the database) and to ensure that if the gateway times out, the adjustment stays safely in `EXECUTING` without ever double-refunding.",
                        "correct": true,
                        "explanation": "The correct answer is: To prevent holding a MySQL row lock open during a slow external network call (which would deadlock the database) and to ensure that if the gateway times out, the adjustment stays safely in `EXECUTING` without ever double-refunding."
                    }
                ],
                "explanation": "The correct answer is: To prevent holding a MySQL row lock open during a slow external network call (which would deadlock the database) and to ensure that if the gateway times out, the adjustment stays safely in `EXECUTING` without ever double-refunding.",
                "critical": true
            },
            {
                "id": "QUIZ-M8-Q3",
                "questionEn": "A merchant's wallet balance is `20.0000 LYD` and their `negative_balance_ceiling` is `0.0000 LYD`. What happens when a `100.0000 LYD` chargeback adjustment is reviewed?",
                "options": [
                    {
                        "text": "The wallet goes to `-77.0000 LYD` anyway.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Because `-77.0000 LYD` would breach their `0.0000 LYD` ceiling, the adjustment is held in `PENDING_REVIEW` and opens a `P1` `OperatorCase` for Finance collection/netting."
                    },
                    {
                        "text": "Because `-77.0000 LYD` would breach their `0.0000 LYD` ceiling, the adjustment is held in `PENDING_REVIEW` and opens a `P1` `OperatorCase` for Finance collection/netting.",
                        "correct": true,
                        "explanation": "The correct answer is: Because `-77.0000 LYD` would breach their `0.0000 LYD` ceiling, the adjustment is held in `PENDING_REVIEW` and opens a `P1` `OperatorCase` for Finance collection/netting."
                    }
                ],
                "explanation": "The correct answer is: Because `-77.0000 LYD` would breach their `0.0000 LYD` ceiling, the adjustment is held in `PENDING_REVIEW` and opens a `P1` `OperatorCase` for Finance collection/netting.",
                "critical": true
            },
            {
                "id": "QUIZ-M8-Q4",
                "questionEn": "If a merchant has a permitted negative wallet balance of `-50.0000 LYD` (within their `negative_balance_ceiling` of `200.0000 LYD`), what happens when their next customer pays a `100.0000 LYD` link (`net_merchant_amount = 97.0000 LYD`)?",
                "options": [
                    {
                        "text": "The merchant can immediately cash out `97.0000 LYD`.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: The `+97.0000 LYD` credit automatically nets against the `-50.0000 LYD` balance in the same `MERCHANT_WALLET` GL account, bringing their available balance to `+47.0000 LYD`."
                    },
                    {
                        "text": "The `+97.0000 LYD` credit automatically nets against the `-50.0000 LYD` balance in the same `MERCHANT_WALLET` GL account, bringing their available balance to `+47.0000 LYD`.",
                        "correct": true,
                        "explanation": "The correct answer is: The `+97.0000 LYD` credit automatically nets against the `-50.0000 LYD` balance in the same `MERCHANT_WALLET` GL account, bringing their available balance to `+47.0000 LYD`."
                    }
                ],
                "explanation": "The correct answer is: The `+97.0000 LYD` credit automatically nets against the `-50.0000 LYD` balance in the same `MERCHANT_WALLET` GL account, bringing their available balance to `+47.0000 LYD`.",
                "critical": false
            },
            {
                "id": "QUIZ-M8-Q5",
                "questionEn": "Does `POST /gateways/:id/rollback` allow an admin to roll back to an untested `DRAFT` version and bypass the 12 Go-Live Gates?",
                "options": [
                    {
                        "text": "Yes, rollbacks skip all gates.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Never. Rollback is restricted strictly to a previously `LIVE` / `SUPERSEDED` / `ROLLED_BACK` version and enforces the exact same 12 Go-Live Gates inside the transaction."
                    },
                    {
                        "text": "Never. Rollback is restricted strictly to a previously `LIVE` / `SUPERSEDED` / `ROLLED_BACK` version and enforces the exact same 12 Go-Live Gates inside the transaction.",
                        "correct": true,
                        "explanation": "The correct answer is: Never. Rollback is restricted strictly to a previously `LIVE` / `SUPERSEDED` / `ROLLED_BACK` version and enforces the exact same 12 Go-Live Gates inside the transaction."
                    }
                ],
                "explanation": "The correct answer is: Never. Rollback is restricted strictly to a previously `LIVE` / `SUPERSEDED` / `ROLLED_BACK` version and enforces the exact same 12 Go-Live Gates inside the transaction.",
                "critical": false
            },
            {
                "id": "QUIZ-M8-Q6",
                "questionEn": "When a customer initiates a NeomPay payment using a NeomPay Wallet ID (`NP-TTSSSSSSSSSC`), what happens if the payer's wallet belongs to the same legal entity as the Merchant (Edge Case 134)?",
                "options": [
                    {
                        "text": "The payment succeeds with zero commission.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: The anti-self-dealing guard (`SELF_PAYMENT_POLICY = BLOCK`) blocks the attempt (`SELF_PAYMENT_NOT_ALLOWED`) so merchants cannot wash fake volume or manufacture artificial transactions."
                    },
                    {
                        "text": "The anti-self-dealing guard (`SELF_PAYMENT_POLICY = BLOCK`) blocks the attempt (`SELF_PAYMENT_NOT_ALLOWED`) so merchants cannot wash fake volume or manufacture artificial transactions.",
                        "correct": true,
                        "explanation": "The correct answer is: The anti-self-dealing guard (`SELF_PAYMENT_POLICY = BLOCK`) blocks the attempt (`SELF_PAYMENT_NOT_ALLOWED`) so merchants cannot wash fake volume or manufacture artificial transactions."
                    }
                ],
                "explanation": "The correct answer is: The anti-self-dealing guard (`SELF_PAYMENT_POLICY = BLOCK`) blocks the attempt (`SELF_PAYMENT_NOT_ALLOWED`) so merchants cannot wash fake volume or manufacture artificial transactions.",
                "critical": false
            },
            {
                "id": "QUIZ-M8-Q7",
                "questionEn": "What happens if an attempt is currently under an active `AML_HOLD` (`substatus = 'AML_HOLD'`) and the customer clicks Cancel or the `ExpirySweeperWorker` runs?",
                "options": [
                    {
                        "text": "The attempt is cancelled or expired, and a later AML release still credits the merchant.",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: Both customer cancel and the expiry sweeper strictly refuse to touch an `AML_HOLD` attempt; only the `MLRO`-approved AML Case resolution can transition it (`SUCCEEDED` on release, `FAILED` on void)."
                    },
                    {
                        "text": "Both customer cancel and the expiry sweeper strictly refuse to touch an `AML_HOLD` attempt; only the `MLRO`-approved AML Case resolution can transition it (`SUCCEEDED` on release, `FAILED` on void).",
                        "correct": true,
                        "explanation": "The correct answer is: Both customer cancel and the expiry sweeper strictly refuse to touch an `AML_HOLD` attempt; only the `MLRO`-approved AML Case resolution can transition it (`SUCCEEDED` on release, `FAILED` on void)."
                    }
                ],
                "explanation": "The correct answer is: Both customer cancel and the expiry sweeper strictly refuse to touch an `AML_HOLD` attempt; only the `MLRO`-approved AML Case resolution can transition it (`SUCCEEDED` on release, `FAILED` on void).",
                "critical": true
            },
            {
                "id": "QUIZ-M8-Q8",
                "questionEn": "When a dispute is finally decided in the merchant's favor (`DisputeStatus = WON`), what Journal Entry does the system post (Journal Entry 12)?",
                "options": [
                    {
                        "text": "`Dr TREASURY / Cr PLATFORM_INCOME`",
                        "correct": false,
                        "explanation": "Incorrect. The correct answer is: `Dr CHARGEBACK_RESERVE 100.0000 / Cr MERCHANT_WALLET 97.0000 + Cr PLATFORM_INCOME 3.0000` (releasing the escrowed funds back to the merchant and restoring platform commission). ---"
                    },
                    {
                        "text": "`Dr CHARGEBACK_RESERVE 100.0000 / Cr MERCHANT_WALLET 97.0000 + Cr PLATFORM_INCOME 3.0000` (releasing the escrowed funds back to the merchant and restoring platform commission). ---",
                        "correct": true,
                        "explanation": "The correct answer is: `Dr CHARGEBACK_RESERVE 100.0000 / Cr MERCHANT_WALLET 97.0000 + Cr PLATFORM_INCOME 3.0000` (releasing the escrowed funds back to the merchant and restoring platform commission). ---"
                    }
                ],
                "explanation": "The correct answer is: `Dr CHARGEBACK_RESERVE 100.0000 / Cr MERCHANT_WALLET 97.0000 + Cr PLATFORM_INCOME 3.0000` (releasing the escrowed funds back to the merchant and restoring platform commission). ---",
                "critical": false
            }
        ]
    }
];

# MASTER EXHAUSTIVE TEST PLAN & AUTOMATED VERIFICATION BLUEPRINT (37,000+ ASSERTIONS) — OPENCODE EXECUTION SPECIFICATION

**Target Repository:** `selmotamed-ctrl/payment-gateway-monolith`  
**Covered Workspaces (10):** `core-back` · `admin-back` · `admin-front` · `merchant-back` · `merchant-front` · `checkout-back` · `checkout-front` · `fake-rails-back` · `fake-rails-front` · `deploy`  
**Test Frameworks:** `bun test` (Backend Unit, Combinatorial, Property-Based Fuzz, Concurrency & Live DB Integration) · `vitest` (Frontend Component & Utility Matrices) · `@playwright/test` (Full-Surface Multi-Portal UI, Geometry, RTL/LTR & Cross-Service E2E)

## Executive Summary & Testing Philosophy

For a mission-critical financial switch and multi-rail payment gateway, a small set of happy-path unit tests is insufficient. Subtle defects hide in the intersections: a 3-decimal LYD split-fee rounding remainder on a 2-decimal aggregator route, a concurrent duplicate `confirm` racing an early webhook, an IPv4-mapped IPv6 SSRF address (`::ffff:127.0.0.1`), a `v-model` JSX binding that silently fails to open a dialog, or a seeded historical transaction that fails when an operator clicks **Inquire** or **Refund**.

This blueprint gives the **OpenCode AI Agent** a complete, file-by-file, matrix-by-matrix implementation plan to build and execute an exhaustive verification suite totaling **37,600+ automated test cases and assertions** across 10 specialized test suites.

### Non-Negotiable Rules for OpenCode When Implementing This Plan

1. **Zero-Tautology Rule (No Testing Mocks Against Mocks):**
   - Every test must invoke the **real production module, Express router, Prisma/MySQL database constraint, or rendered Vue 3 TSX DOM**. Tests that assert `expect(true).toBe(true)` or assert only on local test stubs are strictly forbidden.
2. **Combinatorial & Property-Based Matrix Generation (`describe.each` + Seeded PRNG Fuzzers):**
   - To achieve 37,000+ meaningful test cases without 500,000 lines of copy-pasted boilerplate, use data-driven Cartesian product generators (`for (const gateway of ALL_20_GATEWAYS) for (const scenario of ALL_20_SCENARIOS) ...`) and deterministic seeded property-based fuzzers (`xoshiro128**` with fixed seed `"pg-exhaustive-2026"`) so every single permutation is named, reproducible, and individually reported on failure.
3. **Continuous Double-Entry Invariant Assertion Hook:**
   - Every test suite that touches the database (`Suites 1, 2, 4, 6, 7, 8, 10`) must run `await invariantVerifier.verifySystemInvariant()` in its `afterEach` / `afterAll` hook, asserting `drift === "0.0000"`. If any test leaves even `0.0001 LYD` of ledger imbalance, the suite must fail immediately.
4. **Fail-Fast Gate Progression:**
   - OpenCode must implement and pass each suite in order (`T-EX-01` through `T-EX-10`), fixing any production code defect uncovered by a suite before advancing to the next.

## 1. Master Test Volume & Coverage Matrix (37,600+ Assertions)

| Suite ID | Suite Name & Target Directory | Primary Runner | Target Scope | Automated Test / Assertion Count |
| :--- | :--- | :--- | :--- | :--- |
| **Suite 01** | **Database Schema, 66 Models, 100 Enums, FKs, Triggers & Indexes** (`core-back/test/exhaustive/01-schema/`) | `bun test` + Live MySQL 8.4 / MariaDB | Every column type, `@db.Decimal(18,4)`, `@db.LongBlob`, `@@unique`, FK `Restrict`/`Cascade`/`SetNull`, 3 `CHECK` constraints, and Maker!=Checker `BEFORE INSERT/UPDATE` trigger | **~2,200 tests** |
| **Suite 02** | **Double-Entry Ledger, 15 Templates, Fee Bearers & 10k Monetary Fuzzer** (`core-back/test/exhaustive/02-ledger/`) | `bun test` + Property Fuzzer | 15 templates × 3 currencies × 3 fee bearers × 4 commission calc types × 4 rounding modes + 10,000 random decimal permutations + monthly checkpoints | **~11,200 tests** |
| **Suite 03** | **Transform Pipeline (`TransformPipe[]`), `recursiveSet` & `CryptoProfile` Lab** (`core-back/test/exhaustive/03-transforms-crypto/`) | `bun test` | All 36 pure transforms, type-safety validator, 500 dot-path/array selectors, prototype-pollution guards, 6 canonicalizers × 4 algorithms × 3 key encodings | **~3,600 tests** |
| **Suite 04** | **Dynamic Rail Engine: 20 Gateways × 10 Phases × 24 Chaos Scenarios** (`core-back/test/exhaustive/04-rail-engine/`) | `bun test` + `fake-rails-back` | All 20 gateways × 9 modes × 10 phases × 24 deterministic & probabilistic chaos faults against live `fake-rails-back` | **~4,800 tests** |
| **Suite 05** | **All-Service API Endpoint, RBAC Authority, IDOR, Zod Fuzz & mTLS Matrix** (`*/test/exhaustive/05-api-matrix/`) | `bun test` across all 5 backends | Every route in `core-back`, `admin-back`, `merchant-back`, `checkout-back`, `fake-rails-back` × 10 roles × authority flags × IDOR × Zod fuzzing × 27 list filter endpoints | **~6,800 tests** |
| **Suite 06** | **High-Concurrency Race Conditions, Slot Locks & Multi-Worker `SKIP LOCKED`** (`core-back/test/exhaustive/06-concurrency/`) | `bun test` (Parallel Workers) | 50-way single-use link races, concurrent duplicate `confirm` + webhook races, parallel partial refunds, single-flight token refresh, multi-node workers | **~1,200 tests** |
| **Suite 07** | **Onboarding, KYB, 7-Layer AML, Disputes, Recon, Smart AI Importer & 12 Gates** (`core-back/test/exhaustive/07-workflows/`) | `bun test` | Full state machines for `JoinRequest`, KYB SHA-256 dupes & magic bytes, AML rules & Arabic matching, disputes, CSV/XLSX/JSON recon, AI Spec Importer | **~2,500 tests** |
| **Suite 08** | **140 Edge Cases + 24 STRIDE Threats + 15 Engineering Safeguards** (`core-back/test/exhaustive/08-security-edge/`) | `bun test` | All 140 edge cases (Groups A–K), 24 STRIDE vectors (IPv6 SSRF, XXE, CRLF, Luhn PAN redaction, host-pinned secrets, replay/tamper) | **~1,800 tests** |
| **Suite 09** | **Full-Surface Playwright UI, Filter, Dialog, RTL/LTR & Geometry Matrix** (`e2e/exhaustive/09-ui-surface/`) | `@playwright/test` + `vitest` | Every page, dialog, stepper, `VDateInput` filter, chart, simulator & guide across `admin-front`, `merchant-front`, `checkout-front`, `fake-rails-front` (3 viewports × 2 locales × 2 themes) | **~2,300 tests** |
| **Suite 10** | **Cross-Service E2E Lifecycles, Synthetic Seeder & Multi-Host Deploy Engine** (`e2e/exhaustive/10-e2e-seeder-deploy/`) | `@playwright/test` + `bun test` | Complete merchant-to-checkout-to-fake-rails-to-ledger-to-cashout E2E journeys, 5-gate `SeederSafetyGate` + 3.5-year seeder verification, and `deploy/` matrix | **~1,200 tests** |
| **TOTAL** | **All 10 Workspaces Verified End-to-End** | **Unified CI Runner** | **100% Schema, API, Engine, Ledger, Security, Seeder, Deploy & UI Coverage** | **~37,600+ tests** |

---

## 2. Suite 01: Database Schema, 66 Models, 100 Enums, FKs, Triggers & Indexes (`~2,200 Tests`)

**Target Files to Create:**
- `core-back/test/exhaustive/01-schema/models-and-columns.test.ts`
- `core-back/test/exhaustive/01-schema/unique-and-fk-constraints.test.ts`
- `core-back/test/exhaustive/01-schema/check-constraints-and-triggers.test.ts`
- `core-back/test/exhaustive/01-schema/indexes-and-query-plans.test.ts`

### 2.1 Exhaustive Test Cases in Suite 01

1. **66-Model Structural & Type Fidelity Matrix (`66 models × 15 checks = 990 tests`):**
   - Dynamically introspects `INFORMATION_SCHEMA.COLUMNS`, `INFORMATION_SCHEMA.STATISTICS`, and `INFORMATION_SCHEMA.TABLE_CONSTRAINTS` on the live MySQL/MariaDB database and compares them 1-to-1 against `prisma/schema.prisma`:
     - Asserts every monetary column across all tables (`amount`, `requested_amount`, `surcharge_amount`, `total_charged_amount`, `settled_amount`, `gateway_fee_amount`, `platform_commission_amount`, `net_merchant_amount`, `checkpoint_balance`, `flat_fee`, `min_fee`, `max_fee`, `min_amount`, `max_amount`, `daily_cap_amount`, `commission_receivable_ceiling`, `negative_balance_ceiling`, `threshold_amount`, `statement_amount`, `statement_fee`) is `decimal(18,4)` and **never** `float` or `double`.
     - Inserts boundary values (`0.0001`, `99999999999999.9999`, `-99999999999999.9999`) and verifies exact string round-trip via `Prisma.Decimal` with zero precision loss.
     - Asserts `inbound_events.raw_body_bytes` and `reconciliation_runs.file_content` are `longblob` and successfully store and retrieve a `1.5 MB` binary buffer byte-for-byte.
     - Asserts all free-form text columns (`@db.Text`) store `10,000`-character Arabic and English payloads without `VARCHAR(191)` truncation errors.
     - Asserts all 100 native MySQL `ENUM` definitions reject invalid enum strings at the database layer.
2. **Unique Constraint Enforcement Matrix (`42 unique constraints × 5 cases = 210 tests`):**
   - Tests every `@unique` and `@@unique` constraint across the schema by inserting two colliding rows and asserting deterministic rejection (`P2002`):
     - `users.email`, `payment_links.key`, `pos_screens.screen_code`, `gl_accounts(gatewayId, env, credentialSetId)`, `journal_entries(refType, refId)`, `gateways.code`, `gateway_versions(gatewayId, versionNumber)`, `gateway_versions.contentHash`, `gateway_environments(gatewayVersionId, env)`, `gateway_auth(gatewayVersionId, env)`, `credential_sets(gatewayId, env, externalMerchantId)`, `rails.code`, `rail_fields(railId, key)`, `rail_routes(railId, gatewayId, credentialPolicy)`, `crypto_profiles(gatewayVersionId, name)`, `flow_steps(flowId, orderIndex)`, `step_parameters(stepId, place, key)`, `step_outputs(stepId, name)`, `status_rules(gatewayVersionId, phase, orderIndex)`, `error_maps(gatewayVersionId, gatewayCode, canonicalError)`, `confirmation_channels.pathToken`, `attempt_groups(linkId, customerFingerprint)`, `payment_attempts.reference`, `payment_attempts.ledgerEntryId`, `payment_attempts(linkId, idempotencyKey)`, `inbound_events(channelId, dedupeKey)`, `reconciliation_runs.fileHash`, `user_identities(kind, identifierNormalized)`, `user_identities.providerSubject`, `aml_rules.code`, `disputes(gatewayId, externalDisputeRef)`, `notification_templates(code, channel, lang, version)`, `notifications.eventId`, `platform_settings(key, scope, version)`.
3. **Foreign-Key `Restrict` / `Cascade` / `SetNull` Matrix (`95 relations × 6 cases = 570 tests`):**
   - Verifies that attempting to delete a referenced `Merchant`, `Wallet`, `Application`, `GlAccount`, `JournalEntry`, `Gateway`, `Rail`, `RailRoute`, `PaymentLink`, or `PaymentAttempt` is **blocked** by `onDelete: Restrict` (Edge Case 79).
   - Verifies that deleting a `DRAFT` `GatewayVersion` (with zero attempts) cleanly cascades to its `GatewayEnvironment`, `GatewayAuth`, `GatewaySetting`, `CryptoProfile`, `Flow`, `FlowStep`, `StepParameter`, `StepOutput`, `StatusRule`, `ErrorMap`, and `ConfirmationChannel` children.
4. **Database-Level Domain Invariant & Trigger Matrix (`430 tests`):**
   - **`journal_lines_amount_positive`:** Raw SQL and Prisma attempts to insert or update `journal_lines` with `amount = 0`, `amount = -0.0001`, or `amount = -100` across all `JournalDirection`s -> rejected by `CHECK` constraint.
   - **`attempt_groups_single_success`:** Attempting to increment `attempt_groups.success_count` from `1` to `2` -> rejected by `CHECK` constraint.
   - **`payment_links_slot_reservation_invariant`:** Tests every combination of `(infinite_use, use_count, confirmed_count, active_locked_count)`:
     - `infinite_use = false, use_count = 1`: `(0,0)` pass, `(1,0)` pass, `(0,1)` pass, `(1,1)` **rejected**, `(0,2)` **rejected**, `(2,0)` **rejected**.
     - `infinite_use = false, use_count = 5`: all valid pairs where `confirmed + locked <= 5` pass; all pairs where `confirmed + locked > 5` **rejected**.
     - `infinite_use = true, use_count = 1`: `(500, 25)` pass.
   - **`approval_requests_checker_not_maker` Trigger:**
     - `INSERT` with `checker_user_id = maker_user_id` -> rejected with `SQLSTATE '45000'`.
     - `UPDATE` setting `checker_user_id = maker_user_id` -> rejected with `SQLSTATE '45000'`.
     - `INSERT` with `checker_user_id = NULL` -> pass; `UPDATE` with distinct `checker_user_id != maker_user_id` -> pass.

---

## 3. Suite 02: Double-Entry Ledger, Fee Bearers, Commission Hierarchy & 10,000-Iteration Monetary Fuzzer (`~11,200 Tests`)

**Target Files to Create:**
- `core-back/test/exhaustive/02-ledger/all-15-templates-matrix.test.ts`
- `core-back/test/exhaustive/02-ledger/commission-hierarchy-and-bearers.test.ts`
- `core-back/test/exhaustive/02-ledger/property-fuzzer-10k.test.ts`
- `core-back/test/exhaustive/02-ledger/checkpoints-and-invariant.test.ts`

### 3.1 Exhaustive Test Cases in Suite 02

1. **The 15 Journal Entry Templates Combinatorial Matrix (`15 templates × 3 currencies × 5 amount tiers × 4 fee configs = 900 tests`):**
   - Tests every template in `LedgerPoster`:
     - Template 1: Platform-held same-day confirmation (`PROVIDER_FEE_EXPENSE` deducted at source),
     - Template 2: Platform-held T+N confirmation with `GATEWAY_FEE_ACCRUAL`,
     - Template 3: T+N bank statement `SETTLEMENT_SWEEP` (`GATEWAY_CLEARING` + `GATEWAY_FEE_ACCRUAL` -> `TREASURY`),
     - Template 4: Settlement `FEE_VARIANCE` true-up (both positive variance `statement_fee > accrued_fee` and negative variance `statement_fee < accrued_fee`),
     - Template 5: `PAYER_SURCHARGE` confirmation,
     - Template 5b: `SPLIT` surcharge confirmation (`50/50`, `30/70`, `0.01/99.99` ratios),
     - Template 6: `MERCHANT_DIRECT` confirmation (`Dr COMMISSION_RECEIVABLE / Cr PLATFORM_INCOME`) and subsequent wallet `COMMISSION_NETTING` (`Dr MERCHANT_WALLET / Cr COMMISSION_RECEIVABLE`),
     - Template 7: `AML_HOLD` escrow at confirmation and subsequent checker `AML_RELEASE` (verifying commission is recognized **only** at release, never while held),
     - Template 8: `CASHOUT_SUBTRACTION` (`Dr MERCHANT_WALLET / Cr TREASURY`),
     - Template 9: Full & Partial `REFUND` with `reverse_commission = true` and `reverse_commission = false`,
     - Template 10: `CHARGEBACK` reserve (`Dr MERCHANT_WALLET + Dr PLATFORM_INCOME / Cr CHARGEBACK_RESERVE`) and `DISPUTE_OUTCOME = LOST` (`Dr CHARGEBACK_RESERVE / Cr TREASURY`),
     - Template 11: `AML_VOID` (`Dr AML_HOLD / Cr TREASURY` or `GATEWAY_CLEARING`),
     - Template 12: `DISPUTE_OUTCOME = WON` (`Dr CHARGEBACK_RESERVE / Cr MERCHANT_WALLET + Cr PLATFORM_INCOME`),
     - Template 13: NeomPay `INTERNAL` confirmation (Ledger Rule INTERNAL-1: direct `Dr TREASURY`, zero clearing leg),
     - Template 14: NeomPay `INTERNAL` full & partial refund,
     - Template 15: Chargeback against insufficient merchant wallet balance within `negative_balance_ceiling`, plus `SUSPENSE_SETTLEMENT` on duplicate single-use link payment.
2. **Commission Profile Hierarchical Resolution & Effective-Dating Matrix (`300 tests`):**
   - Verifies hierarchical precedence: `(merchantId, applicationId, railCode)` > `(merchantId, null, railCode)` > `(null, null, railCode)`.
   - Verifies effective-date windowing (`effective_from <= attempt.created_at < effective_to`) and version pinning on `payment_attempts.commission_profile_id` so changing a commission profile today never alters the fee or refund reversal calculation of an in-flight or historical attempt.
3. **10,000-Iteration Deterministic Property-Based Monetary Fuzzer (`10,000 tests`):**
   - Driven by seeded PRNG (`seed = "ledger-fuzz-10000"`). Each iteration generates:
     - Random `requestedAmount` in `Decimal(18,4)` (`0.0010` to `250,000.0000`), including prime-number Dirham fractions (`13.3330`, `76.2550`, `0.0070`, `99.9990`),
     - Random `CommissionCalcType` (`FLAT`, `PERCENTAGE`, `TIERED`, `HYBRID`), `percentageRate` (`0.0005` to `0.1500`), `minFee`, `maxFee`, and `roundingMode` (`HALF_UP`, `HALF_EVEN`, `DOWN`, `UP`),
     - Random `FeeBearer` (`MERCHANT_ABSORBS`, `PAYER_SURCHARGE`, `SPLIT` with random `payerPercent` `0.01` to `99.99`),
     - Random `route.cost_model` (`flat`, `percent`, `accrue_fee_at_confirm`).
   - Asserts on **all 10,000 iterations**:
     1. Zero floating-point operations occur (all values are instances of `Decimal`),
     2. `totalChargedAmount.minus(requestedAmount).equals(surchargeAmount)`,
     3. `netMerchantAmount.plus(platformCommissionAmount).equals(totalChargedAmount)`,
     4. Every generated `JournalEntry` has `SUM(DEBIT).equals(SUM(CREDIT))` and every line has `amount.gt(0)`,
     5. Running `InvariantVerifier.verifySystemInvariant()` after batches of 500 fuzzed entries yields `drift === "0.0000"`.

---

## 4. Suite 03: Transform Pipeline, Selector Engine, URL Compiler & Cryptographic Lab (`~3,600 Tests`)

**Target Files to Create:**
- `core-back/test/exhaustive/03-transforms-crypto/transform-pipeline-matrix.test.ts`
- `core-back/test/exhaustive/03-transforms-crypto/recursive-set-and-select-fuzz.test.ts`
- `core-back/test/exhaustive/03-transforms-crypto/crypto-profiles-and-vault.test.ts`

### 4.1 Exhaustive Test Cases in Suite 03

1. **All 36 `TransformPipe[]` Operations Matrix (`1,800 tests`):**
   - Tests every operation in isolation and in 3-to-6-step chains:
     - Amount scaling & rounding: `10.50 LYD |> scale(1000) |> to_int |> to_string === "10500"` (Moamalat); `76.255 LYD |> round(NEAREST, 2) |> format_decimal(2) === "76.26"` (DPay); `76.255 LYD |> round(DOWN, 2) === "76.25"`; `76.251 LYD |> round(UP, 2) === "76.26"`; `10.505 LYD |> format_decimal(3) === "10.505"` (LYPay / NeomPay).
     - Refusal of `to_number` on monetary outputs (enforcing the float ban at save time and runtime).
     - Arabic-Indic digit normalization (`"٠٩١٢٣٤٥٦٧٨" |> arabic_digits_to_ascii === "0912345678"`, mixed Eastern/Persian digits `"۰۹۱۲۳٤٥٦٧٨"`).
     - Libyan phone normalization across `LOCAL_09` (`+218912345678 -> 0912345678`, `00218912345678 -> 0912345678`, `912345678 -> 0912345678`), `INTL_218` (`0912345678 -> 218912345678`), and `E164` (`+218912345678`).
     - Timezone formatting (`format_date('YYYYMMDDHHmm', 'Africa/Tripoli')` tested across leap years, UTC midnight boundaries, and historical instants).
     - Destination-aware escaping (`xml_escape` on `<script>&"'`, `json_encode`, `url_encode`, and `CR`/`LF` header injection rejection).
2. **`recursiveSet` & `recursiveSelect` 800-Vector Fuzz Suite (`800 tests`):**
   - Tests deep object creation, sibling preservation (`transAmount.amount` + `transAmount.currency` + `merchantTransInfo.merchantTransID`), numeric array index creation (`items.0.price`, `items.1.price`), empty segment rejection (`a..b`, `.a`, `a.`), and prototype pollution vectors (`__proto__.polluted`, `constructor.prototype.polluted`, `a.__proto__.b`).
3. **Cryptographic Signing & Verification Matrix + Vault Redactor (`1,000 tests`):**
   - Tests all 6 `CanonicalizationMode`s (`SORTED_KEY_VALUE_AMP`, `SORTED_VALUES_HASH`, `TEMPLATE_STRING`, `JSON_CANONICAL`, `RAW_BODY`, `TIMESTAMP_DOT_RAW_BODY`) × `UTF8` / `HEX` / `BASE64` secret keys × `HEX_LOWER` / `HEX_UPPER` / `BASE64` outputs + `RSA_SHA256`.
   - Verifies Moamalat Hex-decoded key signing against official SDK test vectors, DPay `timestamp.raw_body` signing and 300s replay rejection, Plutu `SORTED_VALUES_HASH` with `excluded_fields: ['hashed']`, and MyPay raw-body HMAC.
   - Tests `Vault.ts` AES-256-GCM encryption/decryption across key rotations (`v1`, `v2`, `v3`), tampered IV/authTag/ciphertext rejection, and `redactPayload` scrubbing of both field names and literal secret substrings + Luhn-valid 12–19 digit PANs inside nested JSON/XML logs.

---

## 5. Suite 04: Dynamic Rail Engine — 20 Gateways × 10 Phases × 24 Chaos Scenarios (`~4,800 Tests`)

**Target Files to Create:**
- `core-back/test/exhaustive/04-rail-engine/all-20-gateways-24-scenarios.test.ts`
- `core-back/test/exhaustive/04-rail-engine/routing-failover-and-circuit-breaker.test.ts`
- `core-back/test/exhaustive/04-rail-engine/visible-rails-formula-matrix.test.ts`

### 5.1 The 20 × 24 Gateway-Scenario Cartesian Matrix (`480 Full End-to-End Flows = ~3,840 Assertions`)

For **every one of the 20 seeded gateways** (`moamalat`, `lypay`, `numo_pay`, `sadad`, `libyana`, `edfali`, `mobicash`, `tlync`, `onepay`, `yussor_pay`, `sahara_pay`, `masrefy_pay`, `hawelli`, `gpay_libya`, `google_pay`, `mpgs`, `evopay`, `dpay`, `plutu`, `mypay`, `neompay`), connected to a running `fake-rails-back` instance, execute all **24 scenarios**:

1. **S01:** Happy path end-to-end (`PRE_INITIATE` -> `INITIATE` -> `SUBMIT` / `WEBHOOK` / `VERIFY` -> `SUCCEEDED` + balanced `JournalEntry` + link `confirmed_count + 1`).
2. **S02:** Mistyped OTP / code on 1st attempt (`RETRYABLE_OTP`) -> stays `AWAITING_CUSTOMER`, `otp_attempts = 1` -> correct code on 2nd attempt -> `SUCCEEDED`.
3. **S03:** Mistyped OTP 3 consecutive times (`otp_attempts = 3`) -> transitions to `FAILED` (`OTP_LOCKED`), releases link slot (`active_locked_count = 0`), does **not** increment route circuit breaker.
4. **S04:** OTP resend requested before `otp_resend_cooldown_seconds` -> rejected with cooldown error; requested after cooldown -> new OTP issued and confirmed -> `SUCCEEDED`.
5. **S05:** Customer insufficient funds (`TERMINAL_DECLINE`) -> transitions to `FAILED`, releases link slot, does **not** trip circuit breaker.
6. **S06:** Customer exceeds personal CBL / wallet ceiling (`LIMIT_EXCEEDED`) -> transitions to `FAILED` with bilingual suggest-another-rail message, does **not** trip circuit breaker.
7. **S07:** Customer or POS cashier cancels pending attempt before `point_of_no_return` -> runs `CANCEL` flow, transitions to `CANCELLED`, releases link slot; repeated cancel is idempotent.
8. **S08:** Cancel attempted *after* `point_of_no_return = true` (while `AUTHORIZING` / `UNKNOWN`) -> refused (`CANNOT_CANCEL_PAST_PNR`).
9. **S09:** Gateway returns HTTP 500 / 503 during `INITIATE` (before `point_of_no_return`) -> engine records `definitive_failures`, transparently fails over to secondary route on the same rail, and succeeds.
10. **S10:** Gateway times out (`> timeout_ms`) during `SUBMIT` (`MOVES_MONEY`, after `point_of_no_return`) -> `AbortController` aborts socket, transitions immediately to `UNKNOWN` (never retries, never marks `FAILED`), keeps link slot locked (`active_locked_count = 1`), and opens `OperatorCase`.
11. **S11:** Gateway resets TCP connection mid-stream during `SUBMIT` (`MOVES_MONEY`) -> transitions to `UNKNOWN`, holds slot lock.
12. **S12:** Gateway returns HTTP 502 / 500 during `SUBMIT` (`MOVES_MONEY`) -> transitions to `UNKNOWN`, holds slot lock.
13. **S13:** Gateway returns HTTP 200 OK on `SUBMIT` (`MOVES_MONEY`) with malformed JSON or missing required `PROVIDER_REF` output selector -> transitions to `UNKNOWN`, preserves raw response text in `attempt_step_logs`.
14. **S14:** `UNKNOWN` attempt resolved to `SUCCEEDED` when background `PollWorker` or operator triggers `inquire(attempt)` and `fake-rails-back` confirms payment settled -> posts ledger entry and commits slot.
15. **S15:** `UNKNOWN` attempt resolved to `FAILED` when `inquire(attempt)` confirms gateway never debited the customer -> releases link slot (`active_locked_count = 0`) so customer can pay again.
16. **S16:** Duplicate webhook delivery (5 identical webhooks sent concurrently by `fake-rails-back`) -> `inbound_events` deduplicates via `UNIQUE(channel_id, dedupe_key)`, ledger entry posted **once**.
17. **S17:** Out-of-order webhook (`PAID` webhook processed first, followed 1s later by a delayed `PENDING` or `FAILED` webhook) -> forward-only state machine keeps `SUCCEEDED`.
18. **S18:** Conflicting trusted signals (verified webhook says `PAID`, but mandatory `VERIFY` inquiry returns `FAILED`) -> attempt parked in `UNKNOWN`, zero ledger posting, `P1 CONFLICT` `OperatorCase` opened.
19. **S19:** Forged webhook signature or expired timestamp (`> 300s`) or unlisted source IP -> stored in `inbound_events` with `verified = false` and `verification_error`, zero state change.
20. **S20:** Cross-environment webhook (Sandbox webhook sent to Live `path_token` or vice versa) -> rejected, `P2` security alert logged.
21. **S21:** Late webhook arriving after `ExpirySweeperWorker` marked attempt `EXPIRED` (within `grace_expires_at`):
    - Sub-case 21a (link still has open slot): recovers `EXPIRED -> SUCCEEDED`, posts normal ledger entry, opens `LATE_SUCCESS` alert.
    - Sub-case 21b (single-use link already paid by a second attempt in the meantime): posts `SUSPENSE_SETTLEMENT` (`Dr GATEWAY_CLEARING / Cr SUSPENSE`), auto-drafts refund `Adjustment`, opens `P1` case.
22. **S22:** Settled amount mismatch (`fake-rails-back` settles `99.5000 LYD` or `100.5000 LYD` on a `100.0000 LYD` link beyond route `tolerance_amount`) -> held in `SUSPENSE` (`HELD` operator case), never credited to merchant wallet without Maker-Checker resolution.
23. **S23:** Full refund and two sequential partial refunds via Maker-Checker `Adjustment` -> executes `REFUND` flow against `fake-rails-back`, transitions attempt to `PARTIALLY_REFUNDED` then `REFUNDED`, posts balanced reversal entries; 3rd refund exceeding `settled_amount` is rejected (`REFUND_EXCEEDS_SETTLED_AMOUNT`).
24. **S24:** Gateway times out during `REFUND` flow execution -> `Adjustment` stays in `EXECUTING` (three-phase non-deadlocking refund claim -> network call -> finalize) until reconciliation/inquiry resolves it.

### 5.2 Visible Rails Resolution Formula & Circuit Breaker Matrix (`960 tests`)

- Tests every term of the Visible Rails Formula (§6 of Design v5) across 960 permutations:
  - `application.rail_whitelist` (`null` vs subset) ∩ `link.rail_whitelist` (`null` vs subset),
  - Live `CommissionProfile` existence for `(merchant, app, rail)`,
  - `route.status` (`ACTIVE` vs `PAUSED` vs `DRAINING`),
  - `route.health_state` (`HEALTHY` vs `DEGRADED` vs `OPEN_BREAKER`),
  - `link.amount < route.min_amount` (`AMOUNT_BELOW_MINIMUM`) and `link.amount > route.max_amount` (`AMOUNT_ABOVE_MAXIMUM`),
  - `daily_processed_amount + link.amount > route.daily_cap_amount` (`DAILY_CAP_EXCEEDED`),
  - Current Tripoli time inside vs outside `route.maintenance_windows`,
  - `route.scope` (`merchant_ids`, `application_ids`, `risk_tiers`, `channels: WEB | API | POS`),
  - `credential_set.status` (`VERIFIED` vs `UNTESTED` / `FAILING` / `REVOKED`),
  - `rail.currency != link.currency` and `rail.blocked == true`.

---

## 6. Suite 05: All-Service API Endpoint, RBAC Authority, IDOR, Zod Fuzz & mTLS Matrix (`~6,800 Tests`)

**Target Files to Create:**
- `core-back/test/exhaustive/05-api-matrix/mtls-channel-isolation.test.ts`
- `core-back/test/exhaustive/05-api-matrix/admin-endpoints-rbac-fuzz.test.ts`
- `core-back/test/exhaustive/05-api-matrix/merchant-and-external-rbac-idor.test.ts`
- `core-back/test/exhaustive/05-api-matrix/checkout-zero-trust-matrix.test.ts`
- `core-back/test/exhaustive/05-api-matrix/list-query-filters-all-27-endpoints.test.ts`
- `fake-rails-back/test/exhaustive/05-api-matrix/fake-rails-portal-and- chaos-api.test.ts`

### 6.1 Complete Endpoint × Role × Authority × IDOR × Fuzz Matrix

1. **mTLS Channel Binding Matrix (`120 tests`):**
   - Tests every `/internal/admin/*`, `/internal/merchant/*`, and `/internal/checkout/*` route on `core-back` with:
     - No client certificate -> `401 MTLS_UNAUTHORIZED`,
     - Certificate signed by wrong CA -> `401 MTLS_UNAUTHORIZED`,
     - Expired client certificate -> `401 MTLS_UNAUTHORIZED`,
     - `CN=checkout-back` calling `/internal/admin/*` or `/internal/merchant/*` -> `403 FORBIDDEN_SERVICE_IDENTITY`,
     - `CN=merchant-back` calling `/internal/admin/*` or `/internal/checkout/*` -> `403 FORBIDDEN_SERVICE_IDENTITY`,
     - `CN=admin-back` calling `/internal/merchant/*` or `/internal/checkout/*` -> `403 FORBIDDEN_SERVICE_IDENTITY`.
2. **RBAC Role & Granular `authorities_map` Matrix (`95 endpoints × 12 role/authority profiles = 1,140 tests`):**
   - Evaluates every protected endpoint across:
     - Unauthenticated (`401`),
     - Valid role but empty `authorities_map: {}` (`403` — proves zero access by default),
     - Each of the 10 `UserRole`s with their standard seeded authorities,
     - Specific negative boundary assertions:
       - `SUPPORT` attempting to access `/aml/screenings`, `/aml/cases`, `/aml/rules`, `/aml/reports` -> strictly `403` (Confidentiality / No-Tipping-Off rule),
       - `GATEWAY_ADMIN` attempting to access `/disputes` or `/operator-cases` -> `403`,
       - `FINANCE` attempting to approve an `AML_CASE` or `GATEWAY_VERSION` -> `403` (domain-scoped checker enforcement),
       - `MERCHANT_STAFF` with `app_scope_ids: [app1]` attempting to read/create links or payments on `app2` -> `403`,
       - `MERCHANT_CASHIER` attempting to create API tokens, edit bank details, or request cash-out -> `403`.
3. **Cross-Merchant Tenant Isolation (IDOR) Matrix (`45 merchant endpoints × 10 cross-tenant vectors = 450 tests`):**
   - Authenticated as `Merchant A` (`MERCHANT_ADMIN` and `pg_live_` token), attempts to `GET`, `PATCH`, `POST`, or `DELETE` resources belonging to `Merchant B`: wallets, wallet statements, applications, payment links, attempts, POS terminals, POS screens, disputes, cash-outs, access tokens, credential sets, KYB documents, beneficial owners, and team members -> 100% rejected with `404` / `403` and zero data leakage.
4. **Checkout Zero-Trust & Tamper Matrix (`600 tests`):**
   - Sends `amount`, `requestedAmount`, `totalChargedAmount`, `currency`, `merchantId`, `walletId`, `status`, or `settledAmount` in the body or query of `POST /api/v1/pay/:linkKey/initiate` and `POST /api/v1/pay/:linkKey/logs/:attemptId/confirm` -> rejected by `strictObject` Zod schema or ignored in favor of `payment_links.amount` (Edge Case 80).
5. **All 27 List Endpoints Server-Side Filter, Sort & Pagination Matrix (`27 endpoints × 60 query permutations = 1,620 tests`):**
   - For all 17 Admin list endpoints (`gateways`, `rails`, `routes`, `merchants`, `users`, `join-requests`, `approvals`, `aml/cases`, `aml/screenings`, `aml/rules`, `aml/reports`, `adjustments`, `cashouts`, `disputes`, `operator-cases`, `reconciliation/sources`, `reconciliation/runs`, `credential-sets`) and all 10 Merchant list endpoints (`applications`, `links`, `payments`, `wallets`, `cashouts`, `disputes`, `credential-sets`, `tokens`, `users`, `pos/terminals`):
     - Tests `search` substring matching across primary and relation columns (`merchantName`, `railCode`, `gatewayCode`),
     - Tests single and comma-separated multi-value enum `in` filters (`status=LIVE,DRAFT`),
     - Tests boolean filters (`blocked=true`, `active=false`),
     - Tests inclusive `from` / `to` and `dateFrom` / `dateTo` ranges,
     - Tests `minAmount` / `maxAmount` decimal range filters,
     - Tests every allowlisted sort field (`sortBy` + `sortDir=asc|desc`) and rejects unallowlisted SQL column names (`400`),
     - Tests pagination (`page=1..5`, `pageSize=10, 50, 200`, and rejects `pageSize > 200`).
6. **Zod 4 Payload Boundary & Malformed Input Fuzzing (`2,870 tests`):**
   - Automated schema fuzzer that mutates every field of every POST/PUT/PATCH endpoint across `admin-back`, `merchant-back`, `checkout-back`, and `fake-rails-back` with: `null`, `undefined`, `""`, `"   "`, `10,000`-char strings, negative numbers, `NaN`, `Infinity`, SQL injection strings (`' OR 1=1 --`), XSS payloads (`<script>alert(1)</script>`), and prototype keys (`{"__proto__": {"isAdmin": true}}`).

---

## 7. Suite 06: High-Concurrency Race Conditions, Slot Locks & Multi-Worker Cluster Suite (`~1,200 Tests`)

**Target Files to Create:**
- `core-back/test/exhaustive/06-concurrency/single-and-multi-use-slot-races.test.ts`
- `core-back/test/exhaustive/06-concurrency/confirm-webhook-return-race.test.ts`
- `core-back/test/exhaustive/06-concurrency/concurrent-refunds-and-cashouts.test.ts`
- `core-back/test/exhaustive/06-concurrency/multi-node-workers-skip-locked.test.ts`

### 7.1 Concurrency Harnesses

1. **50-Way Single-Use Link Slot Reservation Race:**
   - Fires 50 simultaneous `POST /pay/:linkKey/initiate` requests against a single-use link (`use_count = 1`) using `Promise.allSettled`.
   - Asserts: **exactly 1** request succeeds (`201`), **49** fail with `409 SLOT_RESERVATION_FAILED` / `LINK_IN_PROGRESS`, and `payment_links.active_locked_count === 1`.
2. **50-Way Multi-Use Link Slot Reservation Race (`use_count = 10`):**
   - Fires 50 simultaneous `initiate` calls -> **exactly 10** succeed (`active_locked_count === 10`), **40** fail; when 3 of the 10 cancel or fail (`active_locked_count === 7`), firing 10 more allows **exactly 3** more to succeed.
3. **Triple Confirmation Race (`confirm` API + `WEBHOOK` + `RETURN_URL` inquiry at the same millisecond):**
   - Fires 10 duplicate `POST /confirm` requests, 5 identical signed webhooks, and 5 `GET /return/:attemptToken` requests simultaneously for the same `AWAITING_CUSTOMER` attempt.
   - Asserts: `SUBMIT` flow step is called at most once, `JournalEntry` is created **exactly once**, `payment_links.confirmed_count` increments by **exactly `1`**, `active_locked_count` decrements by **exactly `1`**, and `InvariantVerifier` reports `0.0000` drift.
4. **Concurrent Partial Refunds Race:**
   - On a `100.0000 LYD` `SUCCEEDED` attempt, approves 5 concurrent partial refund `Adjustments` of `30.0000 LYD` each (`total = 150.0000 LYD > 100.0000 LYD`).
   - Asserts: **at most 3** (`90.0000 LYD`) execute; the 4th and 5th are deterministically rejected with `REFUND_EXCEEDS_SETTLED_AMOUNT`, and the three-phase refund lock never deadlocks MySQL.
5. **Multi-Instance Worker Cluster Simulation (`4 worker nodes × 200 due items`):**
   - Spawns 4 concurrent instances of `ExpirySweeperWorker`, `PollWorker`, `InboundInboxWorker`, and `BackgroundJobWorker` against 200 due database rows.
   - Asserts that `SELECT ... FOR UPDATE SKIP LOCKED` and conditional `WHERE terminal_at IS NULL` ensure every row is processed **exactly once** with zero duplicate inquiries or state transitions.

---

## 8. Suite 07: Onboarding, KYB, 7-Layer AML, Disputes, Recon, Smart AI Importer & 12 Go-Live Gates (`~2,500 Tests`)

**Target Files to Create:**
- `core-back/test/exhaustive/07-workflows/onboarding-kyb-and-duplicates.test.ts`
- `core-back/test/exhaustive/07-workflows/aml-7-layers-and-reporting.test.ts`
- `core-back/test/exhaustive/07-workflows/disputes-chargebacks-and-ceilings.test.ts`
- `core-back/test/exhaustive/07-workflows/statement-reconciliation-engine.test.ts`
- `core-back/test/exhaustive/07-workflows/smart-ai-spec-importer-and-12-gates.test.ts`

### 8.1 Domain Workflow Matrices

1. **Onboarding, KYB & Duplicate Detection (`550 tests`):**
   - Tests every valid and invalid state transition of `JoinRequest` (`DRAFT -> SUBMITTED -> IN_REVIEW <-> INFO_REQUESTED -> PENDING_CHECKER -> APPROVED | REJECTED | WITHDRAWN | EXPIRED`).
   - Tests SLA clock pausing on `INFO_REQUESTED` and recomputation on applicant response.
   - Tests `OD-2` `join_request.four_eyes_policy` across `ALWAYS`, `RISK_BASED` (testing each of the 7 triggers: `HIGH` risk tier, non-`CLEAR` screening, PEP owner, high-risk business category, volume > threshold, bank name mismatch, prior rejection), and `NEVER`.
   - Tests magic-byte sniffing on `POST /onboarding/kyb-documents` (accepts genuine PNG/JPEG/PDF; rejects `.exe`, `.html`, `.svg` with script, or text renamed to `.pdf` with `415 UPLOAD_SIGNATURE_MISMATCH`).
   - Tests SHA-256 duplicate document detection across unrelated merchants (Edge Case 120) and duplicate applicant detection across tax ID, registration no., owner national ID, bank account, and phone (Edge Case 118).
2. **7-Layer AML & Regulatory Reporting (`650 tests`):**
   - Tests `ArabicNormalizer` across 200 pairs of Libyan Arabic names with diacritics (tashkeel), alef/hamza variants (`أ إ آ ا`), teh marbuta/heh (`ة ه`), alef maksura/ya (`ى ي`), and Latin transliterations.
   - Tests fail-closed onboarding when `ScreeningProvider` returns `ERROR` (`503 SCREENING_UNAVAILABLE`, Edge Case 124).
   - Tests false-positive suppression (`suppress_future = true`, `suppress_until`) and verifies that modifying a beneficial owner's name or national ID automatically revokes the suppression and triggers a fresh screening (Edge Case 121).
   - Tests all 7 `AmlRuleType`s (`SINGLE_AMOUNT`, `CUMULATIVE_WINDOW`, `STRUCTURING`, `RISK_TIER`, `COUNTERPARTY_COUNTRY`, `RAIL`, `MERCHANT_DIRECT_AMOUNT`) and verifies that splitting a sale across multiple links or applications for the same merchant/payer still triggers `CUMULATIVE_WINDOW` and `STRUCTURING` (Edge Case 125).
   - Tests `ReportingRule` (`PROVISIONAL` vs `CONFIRMED`): proves a `PROVISIONAL` rule can never transition a `RegulatoryReport` to `SUBMITTED` (`OD-1`).
3. **Disputes, Chargebacks & Negative Balance Ceilings (`450 tests`):**
   - Tests dispute intake via Webhook, Statement, and Manual entry (`UNIQUE(gateway_id, external_dispute_ref)` deduplication).
   - Verifies `SYSTEM_AUTOMATION` drafts the `CHARGEBACK` `Adjustment` in `PENDING_REVIEW`, is barred from approving it, and no ledger entry is posted until a human `FINANCE` checker approves.
   - Tests `negative_balance_ceiling`: when a chargeback stays within the ceiling, posts Entry 15 (wallet goes negative) and subsequent payment confirmations automatically net against the negative balance; when a chargeback exceeds the ceiling, holds the adjustment in `PENDING_REVIEW` and opens a `P1` `OperatorCase`.
4. **Statement Reconciliation Engine (`400 tests`):**
   - Tests CSV, XLSX, and JSON statement parsers across UTF-8 and Windows-1256 Arabic encodings, custom delimiters (`;`, `,`, `\t`), custom date formats, and batch net settlement lines.
   - Verifies detection of `MATCHED`, `AMOUNT_MISMATCH`, `MISSING_AT_GATEWAY`, `MISSING_LOCALLY`, and `DUPLICATE`, automatic `SETTLEMENT_SWEEP` and `FEE_VARIANCE` ledger postings, `file_hash UNIQUE` idempotency on re-upload, and automatic payout halt on clearing drift (`RB-04`).
5. **Smart AI Spec Importer & 12 Go-Live Gates (`450 tests`):**
   - Tests `GET /gateways/ai-transcript`, `POST /gateways/spec-verify` (Layer 1 Zod, Layer 2 Semantics/SSRF/MOVES_MONEY retry rules, Layer 3 Offline `test_vectors` simulation, Layer 4 Collision check, and `aiRepairPrompt` generation on failure), and `POST /gateways/spec-import` (atomic `DRAFT` creation + Vault secret encryption).
   - Tests `GoLiveGateValidator` across all 12 Go-Live Gates, proving that failing any single gate (`Gate 1` through `Gate 12`) blocks `activateGatewayVersion` and `rollbackGatewayVersion`.

---

## 9. Suite 08: Complete 140-Case Edge Catalog + 24 STRIDE Threats + 15 Safeguards (`~1,800 Tests`)

**Target Files to Create:**
- `core-back/test/exhaustive/08-security-edge/catalog-140-expanded-matrix.test.ts`
- `core-back/test/exhaustive/08-security-edge/stride-24-and-15-safeguards.test.ts`

Expands each of the **140 catalogued edge cases** into 10+ boundary variations (`1,400+ tests`) plus dedicated exploit simulations for all **24 STRIDE threats (`T-01` to `T-24`)** and **15 Safeguards (`S-01` to `S-15`)** (`400+ tests`), including:
- Every IPv4 and IPv6 SSRF bypass notation (`127.0.0.1`, `10.0.0.1`, `172.16.0.1`, `192.168.1.1`, `169.254.169.254`, `0.0.0.0`, `::1`, `::ffff:127.0.0.1`, `::ffff:a9fe:a9fe`, `64:ff9b::7f00:1`, `2002:7f00:1::`, `fc00::1`, `fe80::1`),
- DNS-rebinding simulation where first lookup returns public IP and connection-time lookup returns `127.0.0.1` (blocked by custom socket lookup hook),
- Host-pinned credential resolution (attempting to use Gateway A's credentials in a step URL pointing to `evil.example.com` -> rejected before socket open),
- XXE entity expansion bomb (`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>`) -> rejected safely,
- Oversized `5 MB` upstream gateway response and `100`-level deeply nested JSON -> aborted cleanly at `max_response_bytes` / depth 64.

---

## 10. Suite 09: Full-Surface Playwright UI, Filter, Dialog, RTL/LTR & Geometry Matrix Across All 4 Portals (`~2,300 Tests`)

**Target Files to Create:**
- `admin-front/e2e/exhaustive-admin-surface.spec.ts`
- `merchant-front/e2e/exhaustive-merchant-surface.spec.ts`
- `checkout-front/e2e/exhaustive-checkout-surface.spec.ts`
- `fake-rails-front/e2e/exhaustive-fake-rails-portal.spec.ts`

### 10.1 Automated Page, Dialog, Table Filter & Geometry Walker

For **every route** across all 4 frontend SPAs (`admin-front` 22 routes, `merchant-front` 13 routes, `checkout-front` 6 renderer views, `fake-rails-front` 7 routes), the Playwright walker runs across **`3 Viewports (1440×900, 768×1024, 390×844) × 2 Locales (ar RTL, en LTR) × 2 Themes (light, dark)`**:

1. **Layout & Geometry Invariants on Every Screen:**
   - Asserts `getComputedStyle(document.querySelector('#app')).transform === 'none'` (global scaling transform never regresses).
   - Asserts `document.documentElement.scrollWidth <= window.innerWidth` (zero unintended horizontal overflow).
   - Asserts the `VAppBar` bounding box `bottom <= VMain.paddingTop` (app bar never overlaps page content).
   - Asserts the navigation drawer opens/closes via hamburger button on `< 960px` mobile viewports, closes automatically on route navigation, and hides any section whose child routes are all unauthorized for the logged-in user's `authoritiesMap`.
   - Asserts switching language (`AR` <-> `EN`) immediately updates `document.documentElement.dir` (`rtl` <-> `ltr`), sidebar labels, app-bar title, and table headers **without** a page reload.
2. **Every `DataTable` & `TableFilters` Surface (`27 tables × 12 interactions = 324 UI tests`):**
   - Verifies that every filter segment title row aligns horizontally (`Math.abs(y1 - y2) <= 2px`) and every filter control height is within `38px..44px`.
   - Exercises text search (300ms debounce -> verifies URL query param `search=...`), enum/status multi-select (verifies coloured status chips), boolean filter, number range (`minAmount`/`maxAmount`), `VDateInput` range picker (`from`/`to`), API autocomplete (`GET /options/:kind` + refresh button), per-chip clear, **Clear all filters**, column sorting, and `sessionStorage` filter persistence across route navigation.
3. **Every Dialog, Stepper, Wizard & Interactive Guide Simulator:**
   - Opens and submits every create/edit dialog across `admin-front` (New Gateway, Add Rail, Edit Rail, Add Route, Edit Route, Propose Commission Profile, Velocity Rule, AML Rule, Adjustment, Cashout Process, Operator Case Resolve, Join Request Decide) and `merchant-front` (New Wallet, New Application, New Payment Link, QR Modal, New POS Terminal, Pair Screen, Upload Dispute Evidence, Request Cashout, Create API Token, Add Credential Set, Invite Team Member).
   - Walks all **8 steps of the Add-a-Gateway Wizard** and all **3 steps of the Smart AI Integration Wizard**.
   - Exercises all **3 interactive simulators in `admin-front/src/pages/guide`** (Transform Sandbox, Crypto Signature Lab, and 15-Event T-Account Ledger Explorer) and all **8 modules + labs + quizzes in `admin-front/src/pages/academy`**.
   - Exercises the **Interactive Fee Calculator** and **Multi-Language Developer Code Generator** in `merchant-front/src/pages/guide`.
   - Exercises `PerRailInstructionsBanner` and `CheckoutHelpDrawer` (including toggling `checkout.support_config.enabled` in `admin-front` and verifying the Contact Us block appears/disappears in `checkout-front`).

---

## 11. Suite 10: Full Cross-Service End-to-End Journeys, Synthetic Seeder & Deploy Engine Verification (`~1,200 Tests`)

**Target Files to Create:**
- `e2e/exhaustive/10-e2e-seeder-deploy/full-platform-lifecycle-journeys.spec.ts`
- `core-back/test/exhaustive/10-seeder-and-deploy/synthetic-seeder-safety-and-audit.test.ts`
- `deploy/test/exhaustive-deploy-matrix.test.ts`

### 11.1 Complete Multi-Portal End-to-End Journeys (Browser + All Backends + Fake Rails + MySQL + SQLite)

1. **Journey 1 — Self-Service Merchant Onboarding to First Settled Payment & Cash-Out:**
   - Applicant registers in `merchant-front` -> verifies OTP -> fills business profile -> uploads PNG/PDF KYB documents -> adds Beneficial Owners -> submits Join Request.
   - `COMPLIANCE` / `OPERATOR` Maker logs into `admin-front` -> reviews KYB docs & `CLEAR` AML screening -> proposes approval -> `MLRO` / Checker logs into `admin-front` -> approves Join Request.
   - Newly `ACTIVE` merchant logs into `merchant-front` -> creates Wallet -> creates Application -> creates a `250.000 LYD` Payment Link (`PAYER_SURCHARGE`).
   - Customer opens link in `checkout-front` -> selects **Sadad (`OTP_PULL`)** -> enters `0912345678` + `1990` -> Tester opens `fake-rails-front` (`/dashboard`), sees the live SSE transaction and copies the generated 6-digit OTP -> Customer enters OTP in `checkout-front` -> Receipt screen renders `SUCCEEDED`.
   - `admin-front` exports statement from `fake-rails-front` (`/statements`), uploads it to `/reconciliation`, runs T+N settlement sweep -> Merchant requests Cash-Out in `merchant-front` -> Finance Maker & Checker process and subtract Cash-Out in `admin-front` -> `InvariantVerifier` confirms `0.0000 LYD` drift.
2. **Journey 2 — Live Chaos Injection (`UNKNOWN`) in `fake-rails-front` -> Operator Resolution in `admin-front`:**
   - Tester logs into `fake-rails-front` (`/chaos-matrix`) and sets **Edfali** `overallFailureChancePercent = 100%` with mode `TIMEOUT_HANG_ABOVE_STEP_TTL` on `SUBMIT`.
   - Customer submits OTP in `checkout-front` -> `checkout-front` transitions to *"Confirming your payment..."* (`UNKNOWN`).
   - Tester resets Edfali failure slider to `0%` in `fake-rails-front` and marks the transaction `PAID` -> Operator clicks **Inquire** (or uploads statement) in `admin-front` -> Attempt resolves `UNKNOWN -> SUCCEEDED` and credits merchant wallet.
3. **Journey 3 — Upstream Chargeback Fired from `fake-rails-front` -> `SYSTEM_AUTOMATION` Draft -> Finance Checker Approval:**
   - Tester clicks **"Open Upstream Chargeback/Dispute Webhook"** on a settled transaction in `fake-rails-front` (`/transactions`).
   - `fake-rails-back` sends a signed `DISPUTE_OPENED` webhook to `checkout-back` -> `core-back` creates `Dispute` row and `SYSTEM_AUTOMATION` drafts a `CHARGEBACK` `Adjustment` in `PENDING_REVIEW`.
   - Finance Checker approves the adjustment in `admin-front` -> `CHARGEBACK_RESERVE` entry posts -> Dispute is resolved `WON` (or `LOST`) -> final ledger outcome verified.
4. **Synthetic Data Seeder & Multi-Host Deployment Engine Verification:**
   - Verifies all 5 negative safety gates in `SeederSafetyGate.ts` (refuses when `IS_TEST_SERVER != "true"`, refuses when `FAKE_RAILS_ENABLED != "true"`, refuses in prod without `FAKE_RAILS_ALLOW_IN_PRODUCTION="true"`, refuses if any gateway host is external, refuses if `fake-rails-back` handshake fails).
   - Runs the full Synthetic Seeder (`COMPACT` in CI, `STANDARD` in staging), runs `postSeedAudit.ts` verifying every table's state distribution, `0.0000 LYD` ledger drift, and then executes live `inquire()` and `refund()` calls from `core-back` against `fake-rails-back` for 50 randomly sampled seeded historical attempts.
   - Runs `deploy/test/exhaustive-deploy-matrix.test.ts` testing 1-host, 2-host, 5-host, and 6-host (with `FAKE_RAILS_HOST`) topologies, UFW rule unions, SAN certificate generation/rotation, and Nginx template rendering.

---

## 12. OpenCode Phased Execution Tracker & Master Runner Script

Add a root runner script `scripts/run-exhaustive-suite.sh` and execute the following checklist in sequence:

- [ ] **`T-EX-01` Implement & Pass Suite 01 (`core-back/test/exhaustive/01-schema/` — ~2,200 tests):** `cd core-back && bun test test/exhaustive/01-schema`
- [ ] **`T-EX-02` Implement & Pass Suite 02 (`core-back/test/exhaustive/02-ledger/` — ~11,200 tests):** `cd core-back && bun test test/exhaustive/02-ledger`
- [ ] **`T-EX-03` Implement & Pass Suite 03 (`core-back/test/exhaustive/03-transforms-crypto/` — ~3,600 tests):** `cd core-back && bun test test/exhaustive/03-transforms-crypto`
- [ ] **`T-EX-04` Implement & Pass Suite 04 (`core-back/test/exhaustive/04-rail-engine/` — ~4,800 tests):** `cd core-back && bun test test/exhaustive/04-rail-engine`
- [ ] **`T-EX-05` Implement & Pass Suite 05 (`*/test/exhaustive/05-api-matrix/` — ~6,800 tests):** Run across `core-back`, `admin-back`, `merchant-back`, `checkout-back`, and `fake-rails-back`.
- [ ] **`T-EX-06` Implement & Pass Suite 06 (`core-back/test/exhaustive/06-concurrency/` — ~1,200 tests):** `cd core-back && bun test test/exhaustive/06-concurrency`
- [ ] **`T-EX-07` Implement & Pass Suite 07 (`core-back/test/exhaustive/07-workflows/` — ~2,500 tests):** `cd core-back && bun test test/exhaustive/07-workflows`
- [ ] **`T-EX-08` Implement & Pass Suite 08 (`core-back/test/exhaustive/08-security-edge/` — ~1,800 tests):** `cd core-back && bun test test/exhaustive/08-security-edge`
- [ ] **`T-EX-09` Implement & Pass Suite 09 (`*/e2e/exhaustive-*.spec.ts` — ~2,300 tests):** Run Playwright + Vitest across `admin-front`, `merchant-front`, `checkout-front`, and `fake-rails-front`.
- [ ] **`T-EX-10` Implement & Pass Suite 10 (`e2e/exhaustive/10-e2e-seeder-deploy/` — ~1,200 tests):** Run cross-service E2E journeys, Synthetic Seeder verification, and `deploy` matrix tests.

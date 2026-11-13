---
id: core.engine
title: Core Engine
status: partial
confidence: high
last_verified: 2026-11-13
verified_against: 5a24f6f+working-tree
code:
  - core-back/lib/commerceStatus.ts
  - core-back/engine/runtime/index.ts
  - core-back/engine/runtime/platform.ts
  - core-back/engine/flow/DynamicRailEngine.ts
  - core-back/engine/flow/StepExecutor.ts
  - core-back/engine/flow/VisibleRailsResolver.ts
  - core-back/engine/flow/VisibleRailsCatalog.ts
  - core-back/engine/flow/NativeAdapterRegistry.ts
  - core-back/engine/flow/GoLiveGateValidator.ts
  - core-back/engine/apiConsumer/ApiConsumer.ts
  - core-back/engine/apiConsumer/ConsumerRegistry.ts
  - core-back/engine/apiConsumer/compileUrl.ts
  - core-back/engine/crypto/CryptoEngine.ts
  - core-back/engine/crypto/Vault.ts
  - core-back/engine/transforms/TransformPipeline.ts
  - core-back/engine/specImporter/**
  - core-back/engine/mockGateway/MockGatewayServer.ts
design_sources:
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#8-engine-contract-apiconsumer-registry-recursiveset-transforms--crypto-engine
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#82-the-six-method-universal-engine-contract-dynamicrailengine
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#84-the-closed-transform-library-transformpipe--pure-operations
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#9-the-13-state-attempt-lifecycle-machine-and-atomic-slot-reservation-invariant
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#6-engine-contract-client-actions-auth-registry-transforms--crypto-engine
  - design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md#5-the-flow-engine
  - design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md#9-confirmation-and-verification
  - design/90-archive/delivery-logs/opencode_technical_delivery_design.md#15-smart-ai-assisted-provider-onboarding-bring-your-own-ai
  - design/08-ai-onboarding/smart_ai_rail_and_voucher_onboarding_plan.md
tests:
  - core-back/test/engine/attempt-guard-pipeline.test.ts
  - core-back/test/gaps/gap-015-018-regressions.test.ts
  - core-back/test/engine/step-executor.test.ts
  - core-back/test/engine/api-consumer.test.ts
  - core-back/test/engine/api-consumer-primitives.test.ts
  - core-back/test/engine/transform-pipeline.test.ts
  - core-back/test/engine/crypto.test.ts
  - core-back/test/engine/attempt-state-machine.test.ts
  - core-back/test/engine/pre-initiate.test.ts
  - core-back/test/engine/visible-rails.test.ts
  - core-back/test/engine/suspense-settlement.test.ts
  - core-back/test/engine/go-live-gates.test.ts
  - core-back/test/spec-importer.test.ts
  - core-back/test/spec-materializer.test.ts
  - core-back/test/phase3-dynamic-engine-and-blueprints.test.ts
  - core-back/test/exhaustive/04-rail-engine/all-20-gateways-24-scenarios.test.ts
  - core-back/test/security-regressions/c1-forged-success.test.ts
  - core-back/test/security-regressions/h8-webhook.test.ts
  - core-back/test/security-regressions/m10-ssrf.test.ts
gaps:
  - CAPTURE and SETTLEMENT_FETCH are database/spec enum values but have no engine runtime executor.
  - CANCEL is in the runtime FlowPhase union and flow provider mapping but no engine method or caller executes the CANCEL flow.
  - NativeAdapterRegistry is a primitive; the production PlatformRuntime does not register or invoke native adapters.
  - preInitiate is implemented on the engine but the checkout route relies on initiate to run the PRE_INITIATE stack.
  - Partial refunds post the FULL_REFUND/INTERNAL_REFUND scenario rather than a partial-refund scenario.
  - Trusted success requires an environment fact; a sync response that does not map environment becomes UNKNOWN.
  - The credential-check probe is generic HTTP when a version has no CREDENTIAL_CHECK flow.
---

# Core Engine

## 1. Purpose and scope

This part describes the universal payment rail engine inside `core-back`: how a gateway is represented declaratively, how an attempt moves through the state machine, how steps are executed and secured, how authentication and signatures are applied, how the visible rails are resolved, how gateway configuration is validated/imported, and how the engine is composed at runtime.

It covers the engine and its supporting primitives. The ledger posting internals are owned by `01-core-back/03-ledger.md`; the workers are owned by `05-workers.md`; storage is owned by `06-storage-engine.md`. Where the engine calls those subsystems, this part describes the boundary and the exact call.

## 2. Design intent (extracted and synthesized from ./design)

The engine is a voucher-inspired, zero-code provider engine applied to payments. An operator describes:

1. How to authenticate (`GatewayAuth`, credential sets, `ApiConsumer`).
2. What the customer must enter (`RailField`).
3. Which HTTP calls pre-validate, initiate, confirm, inquire, cancel, refund and void (`Flow`, `FlowStep`, `StepParameter`, `StepOutput`).
4. How the result arrives (`ConfirmationChannel`).
5. How gateway status/error codes map to canonical statuses (`StatusRule`, `ErrorMap`).
6. How money settles (`CredentialSet` ownership and `LedgerPoster`).

The historical design names ten declarative phases: `CREDENTIAL_CHECK`, `PRE_INITIATE`, `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, `REFUND`, `VOID`, `CAPTURE`, `SETTLEMENT_FETCH`. The actual runtime executes seven of them plus a separate credential-check path.

The design contract is a six-method universal engine:

| Method | Intent |
| :--- | :--- |
| `preInitiate` | Optional read-only eligibility/quote check before initiation |
| `initiate` | Validate the customer form, execute the initiation stack, return a declarative client action |
| `confirm` | Execute the SUBMIT stack, enforce the point of no return, verify trusted success, post the ledger atomically |
| `verifyCallback` | Verify a webhook/IP/inquiry hint, dedupe, correlate and trigger inquiry when required |
| `inquire` | Ask the gateway for authoritative status; resolve `UNKNOWN`, expiry and operator checks |
| `refund` | Execute REFUND or VOID through the gateway, then book the adjustment |

The design's core invariants are:

- Browser callbacks and return URLs are never trusted.
- A timeout/reset/5xx/extraction failure on a `MOVES_MONEY` step becomes `UNKNOWN`, never a blind retry.
- Trusted success requires status, reference, amount within tolerance, currency and environment.
- The slot reservation is held through `UNKNOWN` and released only on terminal non-success.
- Gateway configuration is immutable per version and pinned on the attempt.
- The transform library is closed and pure; there is no `eval` or `Function`.
- Secrets are host-pinned and redacted.
- The engine never posts money by itself; the ledger poster is the only posting path.

## 3. As-built architecture

### 3.1 Runtime composition

`core-back/engine/runtime/index.ts` exposes a lazy singleton `PlatformRuntime`:

- `getPlatformRuntime(db)` creates it once.
- `getPlatformRuntimeAsync(db)` de-duplicates concurrent construction.
- `setPlatformStorage(storage)` updates the storage reference.
- `resetPlatformRuntime()` closes the consumer registry and clears the singleton.

`createPlatformRuntime(db, { storage })` in `engine/runtime/platform.ts` constructs:

| Component | Implementation | Role |
| :--- | :--- | :--- |
| `vault` | `new Vault()` | AES-256-GCM secrets, redaction |
| `crypto` | `new CryptoEngine()` | canonicalization/signing |
| `repositories` | `new PrismaRepositories(db)` | repository ports |
| `consumerRegistry` | `new ConsumerRegistry(...)` | outbound consumer cache |
| `stepExecutor` | `new StepExecutor(...)` | declarative steps |
| `ledgerPoster` | `createLedgerPoster(db)` | double-entry posting |
| `attempts` | `PrismaAttemptRepository` | attempt projection/update |
| `slots` | `PrismaSlotReservationStore` | link slot reservation |
| `flowProvider` | `PrismaFlowProvider` | declarative flow projection |
| `callbackVerifier` | `PrismaCallbackVerifier` | webhook verification |
| `contextCipher` | `VaultContextCipher(vault)` | encrypted attempt context |
| `reportingEvaluator` | `ReportingRuleEvaluator` | reporting rules on success |
| `credentialCheck` | `CredentialCheckService` | CREDENTIAL_CHECK/probe |
| `engine` | `DynamicRailEngine` | universal contract |
| `screening` | `CachedScreeningProvider(InternalWatchlistProvider)` | merchant screening |
| `guardPipeline` | `AttemptGuardPipeline` | velocity/AML/slot guard |

When a storage engine is present, the runtime uses `storage.uow.run` for transactions and records the commit LSN per attempt in an in-process map. When it is absent (tests/tools), it falls back to `db.$transaction` and reports `"0/0"` as the LSN.

The runtime is constructed with `transactionRunner`, `credentialResolver`, `operatorCaseSink`, `reportingEvaluator`, `invalidationBus`, `logSink` and an attempt repository. The consumer registry is keyed by `(gatewayId, env, credentialSetId, gatewayVersionId?)`; the version is part of the key so two pinned versions with different auth recipes do not share a consumer.

### 3.2 Attempt projection and state machine

`PrismaAttemptRepository` projects a `payment_attempts` row into `DynamicAttempt`, deriving:

- `ownershipMode`: `INTERNAL` when the pinned gateway kind is `INTERNAL`; `MERCHANT_DIRECT` when the settlement target is `MERCHANT_DIRECT`; otherwise `PLATFORM_CLEARING`.
- `gatewayId`: from the pinned gateway version relation (the attempt table has no `gateway_id` column).
- `mismatchTolerance`: from the pinned route's `mismatch_policy.tolerance_amount`.
- `feeAccrual`: from the pinned route's `cost_model.accrue_fee_at_confirm`.
- Amounts as 4-decimal strings.

The 14 statuses are:

```text
CREATED, INITIATING, AWAITING_CUSTOMER, AUTHORIZING, VERIFYING,
UNKNOWN, SUCCEEDED, FAILED, EXPIRED, CANCELLED, BLOCKED,
PARTIALLY_REFUNDED, REFUNDED, DISPUTED
```

`ALLOWED_TRANSITIONS` is explicit. Noteworthy edges:

- `CREATED` can go to `INITIATING`, `AWAITING_CUSTOMER`, `VERIFYING`, `BLOCKED`, `CANCELLED`, `EXPIRED`, `FAILED`.
- `INITIATING` can go to `AWAITING_CUSTOMER`, `VERIFYING`, `FAILED`, `BLOCKED`, `CANCELLED`, `EXPIRED`, `UNKNOWN`.
- `AWAITING_CUSTOMER` can go to `AUTHORIZING`, `AWAITING_CUSTOMER` (retryable OTP), `VERIFYING`, `FAILED`, `CANCELLED`, `EXPIRED`, `BLOCKED`, `UNKNOWN`.
- `AUTHORIZING` and `VERIFYING` can go to `VERIFYING`, `SUCCEEDED`, `FAILED`, `UNKNOWN`, `AWAITING_CUSTOMER`.
- `UNKNOWN` can go to `VERIFYING`, `SUCCEEDED`, `FAILED`, `UNKNOWN`.
- `SUCCEEDED` can go to `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED`.
- `FAILED` and `EXPIRED` can go to `SUCCEEDED` for a late success.
- `CANCELLED` and `BLOCKED` are terminal.
- `DISPUTED` can go to `PARTIALLY_REFUNDED` or `REFUNDED`.

Every transition calls `attempts.updateAttempt`, then publishes `attempt:transition` to the invalidation bus. Terminal transitions also enqueue an `attempt.transitioned` outbox event. A terminal attempt sets `terminalAt` and clears `nextCheckAt`.

### 3.3 DynamicRailEngine methods

`preInitiate(attempt, formData)`:
- Loads the current attempt.
- Applies the optional normalizer, without validation (`validate=false`).
- Executes the `PRE_INITIATE` stack and persists state/outputs.
- Returns the result. It does not transition to a terminal state.

`initiate(attempt, formData, { slotReserved })`:
- Loads the current attempt.
- Normalizes and validates the form.
- If a `PRE_INITIATE` flow exists, executes it; a FAILED/BLOCKED result transitions and releases a caller-owned slot.
- Reserves the slot if the caller did not already reserve it.
- Transitions to `INITIATING`.
- Executes the `INITIATE` stack, persists outputs.
- `UNKNOWN` -> transition `UNKNOWN`.
- `FAILED`/`BLOCKED` -> transition and release the slot.
- Otherwise -> transition `AWAITING_CUSTOMER` with public outputs.
- Wipes PAN fields in a `finally` block.

`confirm(attempt, evidence, { claim })`:
- Loads the current attempt; an already-`SUCCEEDED` attempt returns its persisted state.
- If a `claim` function is provided, calls it. Only the winner continues; a loser returns the persisted state without contacting the gateway. The winner sets `AUTHORIZING`, `pointOfNoReturn=true`, publishes the transition and executes.
- Without a claim, an `UNKNOWN` attempt with `pointOfNoReturn` throws `409 POINT_OF_NO_RETURN`; otherwise it transitions to `AUTHORIZING` with `pointOfNoReturn=true`.
- Executes the `SUBMIT` stack. The only customer input forwarded is the OTP; payer `evidence` is ignored (see section 11).
- `UNKNOWN` -> transition `UNKNOWN`.
- `AWAITING_CUSTOMER` with a `RETRYABLE_OTP` error -> increments `otpAttempts`; at the max it transitions `FAILED` and releases the slot, otherwise it returns to `AWAITING_CUSTOMER`.
- `FAILED` -> transition `FAILED`, release the slot.
- `VERIFYING` -> transition `VERIFYING`.
- A `SUBMIT` phase with zero steps runs `inquire()` (the `VERIFY` steps) instead of counting as success; without `VERIFY` steps the attempt stays `AWAITING_CUSTOMER`.
- Otherwise verifies the five trusted-success facts against the SUBMIT step response only (the payer's evidence is never merged in), and either transitions `UNKNOWN` with `TRUSTED_SUCCESS_FACTS_FAILED` or finalizes success.

`verifyCallback(channel, rawRequest)`:
- Requires a callback verifier; otherwise `501 CALLBACK_VERIFIER_MISSING`.
- Verifies the channel; an unverified/missing attempt throws `401 CALLBACK_VERIFICATION_FAILED`.
- Loads the attempt.
- Builds a dedupe key from the channel plus an explicit `dedupeKey`/`dedupe_key`, or `channel:attemptId`. If a callback inbox is configured, an already-seen key returns the persisted state.
- Checks the callback environment against the attempt environment; mismatch -> `409 CALLBACK_ENVIRONMENT_MISMATCH`.
- If `mustInquire`, runs `inquire` and returns its result.
- Otherwise verifies trusted success and either transitions `UNKNOWN` or finalizes success.

`inquire(attempt)`:
- Already `SUCCEEDED` -> return persisted state.
- `FAILED`/`EXPIRED` are late-success candidates and do not get forced back to `VERIFYING`; other non-`UNKNOWN`/`VERIFYING` states transition to `VERIFYING`.
- Executes the `VERIFY` stack.
- `UNKNOWN` -> transition `UNKNOWN`.
- `FAILED` -> if the stored context observed a trusted success, freeze as `UNKNOWN` with `CONFLICTING_TRUSTED_SIGNALS` and open a P1 `CONFLICT` operator case; otherwise transition `FAILED` and release the slot.
- `VERIFYING`/`AWAITING_CUSTOMER` -> transition and return.
- Otherwise verify trusted success and either `UNKNOWN` or finalize success.

`refund(attempt, amount, adjustmentId)`:
- Validates a positive amount not exceeding `totalChargedAmount`.
- Chooses `VOID` when `settledAmount` is undefined, otherwise `REFUND`.
- Sets `adjustmentState=EXECUTING`.
- Executes the phase.
- `UNKNOWN`/`FAILED` keep `EXECUTING` and schedule reconciliation.
- On success, posts the ledger scenario (`INTERNAL_REFUND` for internal rails, otherwise `FULL_REFUND`) and transitions `REFUNDED` or `PARTIALLY_REFUNDED`.

The engine has a `FlowPhase` union of `PRE_INITIATE`, `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, `REFUND`, `VOID`. It has no public `cancel` method, and `CANCEL` is not executed anywhere in the current callers.

### 3.4 Phase execution

`executeSteps(phase, attempt, input, steps)`:

1. Decrypts the attempt context into `state`.
2. Merges stored customer fields with the input.
3. Resolves credentials through `credentialResolver`.
4. Iterates steps in order.
5. Builds a `StepExecutionContext` with attempt, customer fields, credentials, state, previous response, URLs and the transform context.
6. Calls `StepExecutor.execute`.
7. Records step logs.
8. Merges `STATE` and `PUBLIC` outputs.
9. Captures `SETTLED_AMOUNT`, `PROVIDER_FEE`, `PROVIDER_REF` and `NETWORK_REF`.
10. Stops on `BLOCKED`, `UNKNOWN`, `FAILED`, `AWAITING_CUSTOMER` or `VERIFYING`.
11. Handles a `BRANCH` result by jumping to the `thenStepId`/`elseStepId` within the same stack.
12. Returns `SUCCEEDED` when the stack completes (or `AWAITING_CUSTOMER` for an empty non-SUBMIT phase; an empty SUBMIT phase is treated as success).

`persistOutputs` encrypts the state with `contextCipher`, stores `publicOutputs`, provider/network references and the settled amount. The context cipher is `VaultContextCipher(vault)`; without it the previous ciphertext is retained.

`phaseStatus` is phase-agnostic: any non-empty stack that completes returns `SUCCEEDED`. The caller interprets the result per phase. This means a PRE_INITIATE flow is expected to signal a business failure through an explicit step status, not through an HTTP 200 with an empty stack.

### 3.5 Trusted success and finalization

`verifyTrustedSuccessFacts(evidence, attempt)` reads the evidence object it is given (the `evidence.trustedFacts` unwrapping was removed) and requires:

| Fact | Check |
| :--- | :--- |
| `status` | One of `SUCCESS`, `SUCCEEDED`, `PAID`, `CAPTURED`, `CONFIRMED`, `APPROVED` (case-insensitive) |
| `reference` | Present and equal to `gatewayReference` or `reference` |
| `amount` | Present and equal to `totalChargedAmount`, or within the pinned route tolerance |
| `currency` | Present and equal to the attempt currency (case-insensitive) |
| `environment` | Present and equal to the attempt `env` |

All five must be true. A missing environment fact makes the result untrusted. The callback verifier derives the environment from the attempt, so webhook evidence is safe; a declarative sync response must map an environment value for confirmation to succeed. Success facts may come only from the SUBMIT step response, a verified webhook or an inquiry.

`finalizeSuccess` runs inside the runtime transaction when available:

1. Calls `slots.commitSlot(attempt, transaction)`.
2. If the slot outcome is `SUSPENSE`, updates the attempt to `SUCCEEDED` with `substatus=SUSPENSE_SETTLEMENT` and the suspense journal entry id.
3. Otherwise posts the payment confirmation through `ledgerPoster.postPaymentConfirmation` with ownership mode, fee bearer, fee accrual, requested amount, surcharge, commission, merchant amount and gateway/provider fee.
4. Updates the attempt to `SUCCEEDED` with the ledger entry id.
5. Publishes the success transition.
6. Sets `trustedSuccessObserved` in the context.
7. Opens a `LATE_SUCCESS` P2 case if the previous status was `FAILED` or `EXPIRED`.
8. Evaluates reporting rules.

The commission is always taken from the pinned `platformCommissionAmount` (or the context); there is no default rate. A missing commission throws `COMMISSION_NOT_RESOLVED`.

The slot store implements the single-use invariant with a conditional `UPDATE` on `payment_links`. A settlement that cannot commit a slot is posted to `SUSPENSE` through the ledger, an automatic refund adjustment is drafted, a P1 operator case is opened, and the merchant is not credited. The engine returns `settlement: "SUSPENSE"` with `substatus` so callers cannot mistake it for a normal success.

### 3.6 StepExecutor

`StepExecutor` supports six step types:

| Type | Behavior |
| :--- | :--- |
| `HTTP` | Builds and sends an HTTP request, maps status rules, extracts outputs, retries only safe non-money steps |
| `COMPUTE` | Resolves a named compute operation from the registry, applies transforms, extracts outputs |
| `RENDER` | Builds a declarative `ClientAction` payload, applies transforms |
| `WAIT` | Waits for a duration/event with timeout |
| `ASSERT` | Evaluates assertions and fails the step on a mismatch |
| `BRANCH` | Evaluates a condition and returns a `then`/`else` branch |

Parameter places: `HEADERS`, `QUERY`, `PATH`, `BODY`, `FORM`, `MULTIPART`, `XML`.

Parameter sources: `GATEWAY_META`, `ROUTE_META`, `CREDENTIAL`, `ATTEMPT`, `CUSTOMER_FIELD`, `STATE`, `PREVIOUS_RESPONSE`, `URLS`, `CLIENT_CONTEXT`, `CONSTANT`, `NOW`, `RANDOM`, `COMPUTED`, `CRYPTO_SIGNATURE`.

Output stores: `STATE`, `PUBLIC`, `SETTLED_AMOUNT`, `PROVIDER_FEE`, `PROVIDER_REF`, `NETWORK_REF`.

HTTP behavior:

- Method default `POST`; content types JSON, form-urlencoded, multipart, XML, or JSON-by-default.
- URL templates support `{name}`/`{{name}}` base URL placeholders; path parameters are encoded and cannot contain `/`, `\`, CR, LF or NUL.
- Headers reject CR/LF/NUL.
- Query arrays support indices, brackets and repeat formats.
- XML placeholders are escaped; destination-aware encoding is used.
- Idempotency config can inject a rendered key as a header or a body field.
- `CRYPTO_SIGNATURE` parameters resolve a crypto profile and sign the canonical payload.
- Retry: `MOVES_MONEY` always has one attempt; safe steps retry on retryable status/errors according to `max_attempts`.
- A `MOVES_MONEY` step without a matched status rule and a failed/5xx response becomes `UNKNOWN`.
- A missing required output on a money step becomes `UNKNOWN`.
- Response reader: 2 MiB cap, JSON depth 64, XML DTD/entity block.
- Redirects are blocked (`manual` and a 3xx error).
- DNS guard: all resolved addresses must be public; `localhost`, `.localhost`, `.local` rejected.
- Final URL is re-validated for HTTPS, host allowlist, no userinfo/fragment, no traversal/encoded separators.
- PAN field names are wiped from customer fields and state after the step.

`COMPUTE` uses the production registry:

- `MOAMALAT_LIGHTBOX_PAYLOAD`.
- `NEOMPAY_QR_PAYLOAD`.
- `LOCAL_SETTLEMENT_RECONCILE`.

A missing compute operation throws `UNKNOWN_COMPUTE_OPERATION`. A `RENDER` step maps one of the five client actions: `SHOW_OTP_FORM`, `HTTP_REDIRECT`, `RENDER_EMBEDDED`, `SHOW_QR_OR_CODE`, `SHOW_PUSH_OR_TRANSFER`.

Status mapping uses declarative `status_rules` first; a matched rule wins even on a money step. An unmatched 2xx is `SUCCEEDED`; an unmatched non-2xx on a money step is `UNKNOWN`, otherwise `FAILED`.

### 3.7 ApiConsumer and ConsumerRegistry

`ApiConsumer` supports ten auth methods: `NONE`, `API_KEY`, `PERMANENT_TOKEN`, `TOKEN_ENDPOINT`, `REFRESH_TOKEN`, `USERNAME_PASSWORD`, `BASIC`, `REQUEST_SIGNATURE`, `OAUTH2_CLIENT_CREDENTIALS`, `MUTUAL_TLS`.

Behaviors:

- Auth can be applied as header, query or body (API key).
- `REQUEST_SIGNATURE` signs `${timestamp}.${payload}` with HMAC-SHA256/512 and sets timestamp/signature headers, plus `X-API-KEY` when present.
- Token refresh is single-flight: concurrent callers share one `refreshPromise`.
- A rotated refresh token is persisted through the configured callback **before** the refresh promise resolves.
- Refresh scheduling uses a chained `setTimeout` with ±10% jitter and a 30-second accelerated retry on failure.
- A 401/403 on a safe pre-money step triggers one refresh and one retry. A money/point-of-no-return step never retries.
- Transport timeouts use an `AbortController`; a timeout on a money step is `moneyUncertain`.
- Redirects are blocked; response size/depth/XML limits match `StepExecutor`.
- Host allowlist and DNS/IP SSRF checks match the engine; the Fake Rails exception is the same three-condition allowlist.
- Mutual TLS uses credential-provided cert/key/ca via a fetch `tls` extension.
- `responseError` marks 5xx as retryable, but the money-step boundary prevents retry.

`ConsumerRegistry`:

- `consumersMap` maps a cache key to `Promise<ApiConsumer>`.
- The promise is stored synchronously before the DB config load, so concurrent callers share one initialization.
- The key is `${gatewayId}:${env}:${credentialSetId}[:${gatewayVersionId}]`.
- A failed initialization removes the promise from the map.
- It subscribes to `credential:*` invalidation and stops consumers for the matching credential set.
- `invalidateGateway` stops all consumers for a gateway.
- `close` stops all and unsubscribes.

### 3.8 Crypto and vault

`CryptoEngine` canonicalization modes:

- `MOAMALAT_SECURE_HASH`
- `DPAY_WEBHOOK_VERIFY`
- `PLUTU_CALLBACK_HASH`
- `MYPAY_RAW_BODY`
- `SORTED_KEY_VALUE_AMP`
- `TIMESTAMP_DOT_RAW_BODY`
- `SORTED_VALUES_HASH`
- `TEMPLATE_STRING`
- `JSON_CANONICAL`
- `RAW_BODY`

Algorithms: `HMAC_SHA256`, `HMAC_SHA512`, `RSA_SHA256`, `SHA256`. Key encodings: `UTF8`, `HEX`, `BASE64`. Output encodings: `HEX_LOWER`, `HEX_UPPER`, `BASE64`.

`Vault`:

- AES-256-GCM with a 12-byte IV and a 16-byte tag.
- Key id as AAD.
- Payload format `keyId:iv:authTag:ciphertext`, all base64 segments.
- Strict base64 decoding and length checks.
- HKDF-SHA256 per-key derivation from a master key, or direct `KMS_KEYS_JSON` keys, or a custom `VaultKms`.
- `redactPayload` handles objects, arrays, cycles, Buffers, sensitive field names, literal secrets and Luhn-valid PANs.
- `timingSafeStringEqual` hashes both sides to fixed length before `timingSafeEqual`.

### 3.9 Transform library (39 operations)

The closed union has exactly 39 operations:

```text
scale, MUL_INT, DIV_DECIMAL, round, format_decimal, to_int, to_number,
to_string, concat, template, lowercase, uppercase, trim, pad_left,
pad_right, substring, mask, prepend, arabic_digits_to_ascii,
phone_normalize, sort_keys, values_only, join_pairs, format_date,
epoch_seconds, epoch_millis, uuid, numeric_random, base64_encode,
hex_lower, hex_upper, url_encode, json_encode, xml_escape, sha256,
sha512, hmac_sha256, hmac_sha512, rsa_sha256_sign
```

`validate` enforces arity, integer positions, rounding modes, decimal divisors, timezones, phone styles, key encodings and secret-reference non-emptiness. `validateForStore` additionally forbids `to_number` on `SETTLED_AMOUNT` and `PROVIDER_FEE`, because those stores are money and must not pass through a float. The spec importer's `SPEC_TRANSFORM_OPERATIONS` is the same list and a test asserts equality.

`TransformPipeline.apply` is sequential and type-aware. It uses `Decimal`/bigint-style decimal helpers for numeric operations, not native floats, and can resolve secrets through a `TransformSecretResolver`.

### 3.10 Visible rails

`VisibleRailsResolver.resolve` implements:

```text
visible =
  application rail whitelist ∩ link rail whitelist
  ∩ rail not blocked
  ∩ rail currency = link currency
  ∩ a live/active commission profile
  ∩ at least one route with a verified credential set
  ∩ route ACTIVE and HEALTHY
  ∩ amount within min/max
  ∩ daily cap not exceeded
  ∩ outside maintenance windows
  ∩ in merchant/application/risk-tier/channel scope
```

The application and link whitelists are intersected when both exist; a single list is used when only one exists; `null` means no restriction. Commission profiles are resolved by hierarchy: merchant+application+rail, merchant+rail, platform+rail, platform+`default`. The newest effective profile wins.

Credential resolution respects the route policy:

- `PLATFORM`: only a platform-owned verified set.
- `MERCHANT_REQUIRED`: only a verified merchant-owned set for the application's merchant.
- `MERCHANT_OR_PLATFORM`: platform or the merchant's own set.

A platform set wins when both are available.

Route ranking uses `EFFECTIVE_COST` (default; effective cost then priority), `STRICT_PRIORITY` (priority descending) or `WEIGHTED` (weight descending). Ties fall back to gateway id, credential-set id and route id. The daily cap is `processed + amount <= cap`; the processed volume comes from succeeded attempts in the gateway timezone business day.

Exclusion reasons are returned to the caller, so the daily cap is observable at checkout.

### 3.11 Native adapters and Mock Gateway

`NativeAdapterRegistry` stores adapters by code and supports register/unregister/get/require/has/list/clear. A `NativeAdapter` has the same six methods as the engine.

`MockGatewayServer` is the only production-code class that implements `NativeAdapter`. It supports 15 scenarios:

```text
HAPPY_PATH, WRONG_OTP_RETRY_SUCCESS, EXPIRED_OTP, INSUFFICIENT_FUNDS,
CUSTOMER_LIMIT_HIT, CANCEL, CONFIRM_5XX, CONFIRM_TIMEOUT,
MALFORMED_RESPONSE, DUPLICATE_WEBHOOK, OUT_OF_ORDER_WEBHOOK,
LATE_WEBHOOK_AFTER_EXPIRY, AMOUNT_MISMATCH, THREE_DECIMAL_ROUNDING,
CROSS_ENVIRONMENT_WEBHOOK
```

It returns deterministic client actions (`SHOW_OTP_FORM`), scenarios for wrong OTP, timeout/5xx uncertainty, malformed responses, amount mismatch, duplicate/out-of-order/late webhooks and cross-environment webhooks. It can also start a small HTTP server for manual testing.

The production `PlatformRuntime` does **not** register native adapters and does not consult `NativeAdapterRegistry`. The mock is used by the admin sandbox suite and by tests, not by the live `DynamicRailEngine` path. The native-adapter escape hatch is therefore a primitive, not a wired production route.

### 3.12 Spec importer and Smart AI onboarding

`engine/specImporter/**` implements a four-layer importer:

1. **Schema & version:** `IntegrationSpecSchema` (Zod) and `SPEC_VERSION = "1.0"`.
2. **Semantic & security guard:** `validateSpecSemantics` checks closed sets, URL templates, credential references, unsafe combinations, mobile/inquiry requirements, channel verification strength, PAN handling and similar rules.
3. **Offline vector simulation:** `simulateSpec` drives the real `StepExecutor` against the spec's `test_vectors` with synthetic secrets and an in-memory transport. No gateway host is contacted.
4. **Collision check:** a callback checks whether the gateway/rail code exists and how many versions exist.

The failure report includes diagnostics with `path`, `code`, `message` and an `aiFixHint`, plus `buildRepairPrompt` for an external AI. The transcript builder (`buildTranscriptKit`) emits a Markdown/schema kit the admin hands to an external AI; it exposes the closed vocabularies so the AI cannot invent operations.

`materializeSpec` re-runs the full verification inside core (the Double-Check Rule), then in one transaction:

- Creates or reuses a gateway.
- Creates a new `GatewayVersion` in `DRAFT` with a SHA-256 snapshot hash.
- Writes environments, auth, settings, crypto profiles, rail/fields, flows/steps/parameters/outputs, status rules, error maps, confirmation channels, a route and an optional credential set.
- Encrypts supplied secrets with the vault; missing secret values do not fail the import.
- Returns ids and counts.

It never marks the version live. The admin route then runs a live credential check and leaves the draft for secret binding and go-live approval.

### 3.13 Go-live gates and credential check

`GoLiveGateValidator` evaluates the twelve gates against persisted evidence (sandbox suite, contract tests, channel strength, rollback version, route/commission/statement preview, PCI scope, canary plan, alerts). `activateGatewayVersionInTransaction` refuses activation unless the gates pass and shares the transaction with the state change.

`CredentialCheckService`:

- Resolves the credential set and the pinned (or live) gateway version.
- If the version defines `CREDENTIAL_CHECK` steps, executes them through the `StepExecutor` with real credentials.
- Otherwise probes the environment base URL through `ApiConsumer`, exercising the auth recipe.
- Records `VERIFIED`/`FAILING` and `lastVerifiedAt` on the credential set.
- Is called by the merchant/admin verify routes and lazily on the first `INITIATING` attempt through the engine's `credentialResolver`.

The probe is generic when no check flow exists: a base-URL request with the auth recipe. It does not prove a payment capability.

## 4. Contracts and invariants

1. **Six-method contract.** `preInitiate`, `initiate`, `confirm`, `verifyCallback`, `inquire`, `refund`.
2. **Pinned configuration.** An attempt uses its pinned version, route, credential set and commission profile, not the latest live rows.
3. **Single-winner confirm.** The atomic claim is owned by the caller; the engine only executes SUBMIT for the winner.
4. **Point of no return.** A money-moving `UNKNOWN` attempt with `pointOfNoReturn` cannot be resubmitted.
5. **Five trusted facts.** Status, reference, amount within tolerance, currency and environment.
6. **Money steps never retry.** Enforced in both `StepExecutor` and `ApiConsumer`.
7. **Slot invariant.** A single-use link never commits more than its `use_count`; excess settlements go to `SUSPENSE`.
8. **Atomic success.** Slot commit + ledger posting + SUCCEEDED status share one transaction.
9. **No default commission.** A missing pinned commission is an error, not a rate.
10. **Closed transform library.** 39 pure operations, validated before use; no scripting.
11. **Closed auth/step vocabularies.** The spec importer accepts only names the runtime supports.
12. **Secrets are host-pinned and redacted.** The engine never logs a decrypted secret.

## 5. Data / API / config / deployment surface

### 5.1 Engine data model

- `gateways`, `gateway_versions`, `gateway_environments`, `gateway_auth`, `gateway_settings`.
- `credential_sets` with encrypted entries.
- `rails`, `rail_fields`, `rail_routes`.
- `flows`, `flow_steps`, `step_parameters`, `step_outputs`, `status_rules`, `error_maps`.
- `crypto_profiles`, `confirmation_channels`, `widget_definitions`, `redirect_definitions`, `poll_policies`.
- `payment_attempts`, `attempt_step_logs`, `inbound_events`.
- `commission_profiles`, `velocity_rules`, `operator_cases`, `journal_entries`, `journal_lines`.

### 5.2 Engine/env keys

- `KMS_MASTER_KEY`, optional `KMS_KEYS_JSON` for the vault.
- `CORE_REQUEST_TIMEOUT_MS` on the edge, per-step `timeout_ms` in the flow.
- `WORKER_*` for inquiry/poll/expiry workers.
- `FAKE_RAILS_ENABLED`, `ALLOW_FAKE_RAILS_HOSTS`, `FAKE_RAILS_ALLOWED_HOSTS` for the optional tier.
- `NOTIFICATION_WEBHOOK_URL` for notification steps outside the engine.

### 5.3 Engine routes

- Admin spec/transcript: `GET /gateways/ai-transcript`, `POST /gateways/spec-verify`, `POST /gateways/spec-import`.
- Admin dry-run/suite: `POST /gateway-versions/:vid/dry-run`, `POST /gateway-versions/:vid/run-suite`.
- Admin credential check: `POST /credential-sets/:id/verify`.
- Merchant credential check: `POST /credential-sets/:id/verify`.
- Checkout execution: `POST /pay/:linkKey/initiate`, `POST .../confirm`, `POST .../client-event`, `GET/POST /return/:attemptToken`.
- Admin inquiry: `POST /attempts/:id/inquire`.
- Worker-driven inquiry: `ExpirySweeperWorker`, `PollWorker`.

### 5.4 Compute operations

| Name | Used by |
| :--- | :--- |
| `MOAMALAT_LIGHTBOX_PAYLOAD` | Moamalat embedded lightbox blueprint |
| `NEOMPAY_QR_PAYLOAD` | NeomPay internal QR blueprint |
| `LOCAL_SETTLEMENT_RECONCILE` | no-inquiry rails reconciled from local state |

A declarative flow that names any other compute operation fails with `UNKNOWN_COMPUTE_OPERATION`.

### 5.5 Client actions

The engine recognizes five declarative actions from `RENDER`/public outputs:

- `SHOW_OTP_FORM`
- `HTTP_REDIRECT`
- `RENDER_EMBEDDED`
- `SHOW_QR_OR_CODE`
- `SHOW_PUSH_OR_TRANSFER`

`clientActionFrom` accepts either `{type,payload}` in `public.clientAction` or flat `actionType`/`type` keys in public outputs.

## 6. Operational usage

### 6.1 Add a declarative gateway

1. Build the spec/transcript or edit through the admin builder.
2. Run `POST /gateways/spec-verify` and inspect the four layers.
3. Import with `POST /gateways/spec-import` in `CREATE_NEW` or `NEW_VERSION`.
4. Bind remaining secrets in the admin portal; run `POST /credential-sets/:id/verify`.
5. Run the sandbox suite and go-live gates.
6. Submit the version for approval; a different checker approves it.
7. Activate the route; attempts pin the new version.

### 6.2 Diagnose an attempt

- `GET /internal/admin/attempts/:id` for status/substatus/context.
- `POST /internal/admin/attempts/:id/inquire` to resolve `UNKNOWN`.
- Inspect `attempt_step_logs` for the phase/step outcome (redacted).
- Check `operator_cases` for `CONFLICT`, `LATE_SUCCESS`, `SUSPENSE_SETTLEMENT` or `UNMATCHED_STATEMENT`.
- Check the ledger entry and the journal lines for the money outcome.

### 6.3 Re-run a sandbox scenario

`POST /gateway-versions/:vid/run-suite` runs the 15 mock scenarios and persists evidence for the go-live gate. The mock is deterministic and does not contact a gateway.

### 6.4 Add a native adapter

1. Implement `NativeAdapter` with the six methods.
2. Register it in a `NativeAdapterRegistry` in the composition root.
3. Add a gateway kind/registration lookup in the engine.

Step 3 is not present today; registering an adapter alone does not make the live engine use it.

## 7. Status and deviations

### Implemented

- Six-method `DynamicRailEngine` with a 14-status transition graph.
- Seven runtime phases plus the separate `CREDENTIAL_CHECK` flow.
- Attempt pinning, slot reservation/release/commit, SUSPENSE settlement.
- Trusted-success facts, retryable OTP, late success, conflicting signals, UNKNOWN resolution.
- `StepExecutor` with HTTP/COMPUTE/RENDER/WAIT/ASSERT/BRANCH, parameter sources/places/output stores, idempotency, crypto signatures, SSRF guards and response caps.
- `ApiConsumer` with ten auth methods, single-flight refresh, rotated-token persistence, jitter and money-safe retries.
- Crypto canonicalization/signing and AES-GCM vault/redaction.
- Closed 39-operation transform library with monetary-store validation.
- Visible-rails resolution, ranking, daily caps and exclusion reasons.
- 15-scenario mock gateway and go-live gate validator.
- Four-layer spec importer, transcript builder and DRAFT materializer.
- Credential check flow/probe and lazy first-use verification.

### Partial

- **Phase coverage.** `CANCEL` is in the union and flow mapping but has no engine method or caller. `CAPTURE` and `SETTLEMENT_FETCH` are in the database/spec enum but not in the runtime union or flow mapping.
- **Native adapters.** The registry and mock exist, but production composition does not consult native adapters.
- **Pre-initiate.** The method exists; the checkout route does not call it directly, relying on `initiate` to run the PRE_INITIATE stack.
- **Refund scenarios.** Any successful refund posts `FULL_REFUND` (or `INTERNAL_REFUND`) even when the amount is partial; the resulting status correctly becomes `PARTIALLY_REFUNDED`, but the ledger scenario is not partial-specific.
- **Trusted success.** A sync response must explicitly map `environment`; otherwise an otherwise successful payment is held as `UNKNOWN`.
- **Credential probe.** Without a `CREDENTIAL_CHECK` flow, the check is a generic base-URL probe, not a payment-capability proof.
- **Mock coverage.** The 15 scenarios are unit-level; the 20-gateway blueprint suite is not a live partner contract.

### Missing / deferred

- CAPTURE and SETTLEMENT_FETCH runtime executors and routes.
- A production native-adapter registration/invocation path.
- A true gateway CANCEL flow execution on the checkout cancel route.
- A partial-refund ledger scenario distinct from `FULL_REFUND`.
- A generic OTP resend flow (the API route is a cooldown-only stub).
- Arbitrary scripting (intentionally prohibited).
- A universal live test harness for every partner gateway.

### Known bugs / risks

- **Code gap:** `FlowPhase` includes `CANCEL`; `PrismaFlowProvider` maps it; no engine method or caller executes it.
- **Code gap:** a `MOVES_MONEY` step with a 2xx but missing required output is `UNKNOWN` (correct), but the caller must resolve it through inquiry; no automatic resolution is guaranteed.
- **Code gap:** partial refunds use the full-refund scenario; verify the ledger template handles partial amounts and commission split correctly before relying on it.
- **Code gap:** `evidence.environment` is required for trusted success; declarative flows must output it.
- **Risk:** the in-process commit-LSN map is per core node; a confirm response with `x-pg-min-lsn` followed by a read on another node may not observe the commit.
- **Risk:** `NativeAdapterRegistry` and `MockGatewayServer` can give a false sense that native adapters are live; they are not wired into `PlatformRuntime`.
- **Documentation gap:** historical claims of a "10-phase runtime" and 36 transforms are wrong; the actual counts are seven runtime phases plus a separate credential check, and 39 transforms.

## 8. Verification and tests

- `core-back/test/engine/step-executor.test.ts` covers step types, HTTP, compute, render, retry boundaries, idempotency, assertions, branches and mock scenarios.
- `core-back/test/engine/api-consumer.test.ts` and `api-consumer-primitives.test.ts` cover auth methods, refresh, SSRF, recursive set/select and URL compilation.
- `core-back/test/engine/transform-pipeline.test.ts` covers the 39-operation library and monetary-store restrictions.
- `core-back/test/engine/crypto.test.ts` covers canonicalization, signing, vault and redaction.
- `core-back/test/engine/attempt-state-machine.test.ts` covers allowed/forbidden transitions.
- `core-back/test/engine/pre-initiate.test.ts` covers the pre-initiate path.
- `core-back/test/engine/visible-rails.test.ts` and the exhaustive visible-rails formula matrix cover resolution/ranking/caps.
- `core-back/test/engine/suspense-settlement.test.ts` covers the slot/suspense/rollback contract.
- `core-back/test/engine/go-live-gates.test.ts` and `gateway-rollback-go-live.test.ts` cover go-live evidence and activation.
- `core-back/test/spec-importer.test.ts` and `spec-materializer.test.ts` cover the four layers, repair prompt and atomic materialization.
- `core-back/test/phase3-dynamic-engine-and-blueprints.test.ts` covers the blueprint flows.
- `core-back/test/exhaustive/04-rail-engine/all-20-gateways-24-scenarios.test.ts` is the broad blueprint matrix; it is a repository test, not a live partner certification.

No build or test was run for this documentation change. Tests that require PostgreSQL/Redis or partner sandboxes are environment-dependent.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` §8 engine contract/registry/transforms/crypto, §8.2 six methods, §8.4 transform library, §9 state machine and slot invariant, §14 go-live gates.
- `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md` §6 engine contract and §7 state machine.
- `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md` §5 flow engine, §9 confirmation/verification.
- `design/90-archive/delivery-logs/opencode_technical_delivery_design.md` §15 Smart AI onboarding.
- `design/08-ai-onboarding/smart_ai_rail_and_voucher_onboarding_plan.md`.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` for the emulator intent.

### Code paths

- `core-back/engine/runtime/index.ts`, `platform.ts`, `flowProvider.ts`, `attemptRepository.ts`, `slotStore.ts`.
- `core-back/engine/flow/DynamicRailEngine.ts`, `StepExecutor.ts`, `VisibleRailsResolver.ts`, `VisibleRailsCatalog.ts`, `NativeAdapterRegistry.ts`, `GoLiveGateValidator.ts`.
- `core-back/engine/apiConsumer/ApiConsumer.ts`, `ConsumerRegistry.ts`, `compileUrl.ts`, `recursiveSet.ts`, `recursiveSelect.ts`.
- `core-back/engine/crypto/Vault.ts`, `CryptoEngine.ts`.
- `core-back/engine/transforms/TransformPipeline.ts`.
- `core-back/engine/specImporter/**`.
- `core-back/engine/mockGateway/MockGatewayServer.ts`.
- `core-back/engine/runtime/computeRegistry.ts`.

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/stale-claims-register.md` (SC-002, SC-003, SC-006)

## 10. Change history

- 2026-11-03: Initial canonical core engine part written against `5a24f6f+working-tree`; records the seven runtime phases plus separate credential check, 39 transforms, and the reserved/unwired phases and native adapters.

## 11. Security hardening (2026-11-05)

- **Confirm input.** `POST /pay/:linkKey/logs/:attemptId/confirm` accepts only `otp` as customer input. Payer `evidence` is accepted by the schema for wire compatibility but ignored. The `evidence.trustedFacts` path was removed; success facts come only from the SUBMIT step response, a verified webhook or an inquiry. A SUBMIT phase with no steps runs `inquire()` (VERIFY steps) rather than counting as success.
- **Webhook verification.** Unkeyed `SHA256` is not a valid inbound verification algorithm; only `HMAC_SHA256`, `HMAC_SHA512` and `RSA_SHA256` verify. A payload without a status derives `UNKNOWN`, not `SUCCESS`. When `timestampToleranceSec > 0` a signed timestamp is required: a header timestamp counts only under `TIMESTAMP_DOT_RAW_BODY`, otherwise the result is `INBOUND_TIMESTAMP_MISSING`. `timestampToleranceSec = 0` is the explicit opt-out; the seed blueprints for the generic `input.code`, `mpgs` and `mypay` channels set it to 0 because they carry no timestamp field. A production channel configured the same way needs tolerance 0 or a signed timestamp field. `mustInquire` defaults to true only when it is null/undefined (the database column default is still false).
- **Inbound events.** Deduplication applies only to verified rows. Unverified rows get a unique pending key and capped body storage (64 KB); the canonical `dedupeKey` is claimed only after verification (a P2002 race maps to `DUPLICATE`). Signature and timestamp headers are stored. `x-real-client-ip` is trusted only because the mTLS edge sets it; `edgeReportedClientIp` validates it as an IP and otherwise falls back to `request.ip`.
- **Outbound URL compile.** An empty `allowed_hosts` list fails closed (`HOST_ALLOWLIST_EMPTY`) unless `ALLOW_EMPTY_OUTBOUND_HOST_ALLOWLIST=true` (default false). Private, loopback and link-local literals are blocked at compile time unless `allowPrivateHosts` is set. Consumer layers keep their own DNS/literal guards and the Fake Rails exception.
- **Tests.** `core-back/test/security-regressions/{c1-forged-success,h8-webhook,m10-ssrf}`.
- **Re-finalize guard (GAP-016, RESOLVED 2026-11-05).** `finalizeGuardFor(status)` classifies an attempt: `SUCCEEDED`, `PARTIALLY_REFUNDED`, `REFUNDED` and `DISPUTED` are `IDEMPOTENT` (already settled), `CANCELLED` and `BLOCKED` are `REFUSE`, everything else (including `FAILED` and `EXPIRED`, so a late success is still recovered) is `ALLOW`. `verifyCallback` applies it before the trusted-facts check: a duplicate of the trusted success on a settled attempt is a no-op that returns the current state, a contradicting (failure/untrusted) signal on a settled attempt throws `409 ATTEMPT_TERMINAL`, and a callback for a cancelled/blocked attempt throws `409 ATTEMPT_TERMINAL`. `finalizeSuccess` re-reads the attempt status first so a stale in-memory attempt cannot settle twice (idempotent settled attempts return `COMMITTED`, or `SUSPENSE` for `SUSPENSE_SETTLEMENT`, with the stored ledger entry id).
- **AML hold escrow after capture (GAP-015, RESOLVED 2026-11-05).** The guard pipeline no longer books escrow when it decides `HOLD` (no money has been captured yet, so `Dr GATEWAY_CLEARING` / `Cr AML_HOLD` would fabricate a balance); the decision reason is now `AML_HOLD_PENDING_CAPTURE` and `hold_journal_entry_id` is no longer written on the case. When a verified gateway capture of an AML-held attempt reaches `finalizeSuccess`, `escrowHeldCapture` books the escrow (`AML_HOLD_AND_RELEASE` scenario, idempotent per `PAYMENT_ATTEMPT`/attempt id, in the transaction runner when present) and returns the new `SlotCommitResult.outcome` `HELD`: the attempt is NOT settled, the slot is NOT committed, and the result keeps the `AML_HOLD` substatus. Because the money can only be captured by the rail, the checkout initiate route does NOT stop a `HOLD` attempt before `engine.initiate`; the attempt continues through the normal rail flow and a held attempt remains confirmable (`claimAttemptForConfirm` no longer excludes the `AML_HOLD` substatus). Cancel and expiry still refuse to touch a held attempt. The checker's release (see `core.governance`) settles it and is refused until the escrow exists. A duplicate finalize is refused atomically (`claimFinalize` conditional update), so two concurrent verified callbacks cannot settle/commit the slot twice. Residual: a merchant-direct (`MERCHANT_DIRECT`) held attempt holds no platform cash, so nothing is booked (`AML_HOLD_NO_ESCROW`) and release/void have no escrow to move.

## v38 strict plane status (2026-11-13)

OD-10 and `resolveEnvironment(merchantStatus)` are removed. Checkout and merchant link creation resolve the environment from the process plane; Live requires an ACTIVE merchant, application and wallet. Sandbox uses the same strict status rules, but its merchant envelope is created ACTIVE, so a pending Live merchant can train without a Live approval. `AttemptGuardPipeline` no longer reads the OD-10 setting and applies the same status posture on both planes.

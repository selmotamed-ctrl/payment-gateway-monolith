---
id: fake-rails.protocol
title: Fake Rails Protocol Matrix
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - fake-rails-back/api/rails/**
  - fake-rails-back/engine/chaos/DefaultRailScenarios.ts
  - fake-rails-back/api/sdk/**
  - core-back/prisma/seedBlueprints.ts
  - core-back/prisma/seedFakeRails.ts
design_sources:
  - design/fake_payment_rails_service_architecture.md#4-comprehensive-multi-rail-protocol-emulation-all-20-gateways-9-modes
  - design/fake_payment_rails_service_architecture.md#4-1-complete-endpoint-protocol-map-in-fake-rails-back
  - design/fake_payment_rails_service_architecture.md#4-2-interactive-browser-flows-redirect-embedded-mode-simulation
tests:
  - fake-rails-back/test/chaos.test.ts
  - fake-rails-back/test/api.test.ts
  - fake-rails-back/test/exhaustive/05-api-matrix/fake-rails-portal-and-chaos-api.test.ts
gaps:
  - cbl_lypay and evo_pay seeded gateway codes do not match the fake route keys ly_pay and evopay.
  - Only INITIATE, SUBMIT, VERIFY and REFUND are substantially emulated; six declarative phases have no rail implementation.
  - Inbound authorization, signatures, idempotency conflicts and source-IP rules are not enforced.
  - Statement routes are keyed to the fake descriptor codes and are not fetched by any core engine flow.
  - No test drives every one of the twenty rail routes over HTTP.
---

# Fake Rails Protocol Matrix

## 1. Purpose and scope

This part defines what the emulator actually speaks: the twenty rail descriptors, their aliases, collection modes, wire routes, amount handling, OTP generation, phase coverage and the places where the emulated protocol diverges from the gateway blueprints seeded into `core-back`.

It does not repeat the backend process model (`fake-rails.backend`), the tester UI (`fake-rails.chaos`) or the seeding/SSRF wiring (`fake-rails.integration`).

## 2. Design intent (extracted and synthesized from ./design)

The historical design requires protocol-accurate emulation of all twenty gateways and all nine collection modes. The emulator should honour:

- The exact endpoint paths used by the seeded flow steps.
- Content types: JSON, form-urlencoded, multipart/form-data and XML/SOAP.
- Amount scales: integer dirhams for Moamalat, three-decimal strings for LYPay/NeomPay, two-decimal strings for most other rails.
- Authentication shapes: Bearer, API key, Basic, OAuth token endpoint, mutual TLS and request signatures.
- Inbound signature verification using the same canonicalisation recipes as the gateway.
- Idempotency and duplicate-reference behaviour.
- Hosted redirect and embedded widget flows, including success, decline, cancel, tampered return and dropped-webhook variants.
- Settlement statement endpoints for every gateway.

The intent is not merely to return success. It is to make `core-back` exercise its real URL compiler, transform pipeline, crypto profiles, status rules and reconciliation paths.

## 3. As-built architecture

### 3.1 Descriptor catalogue

`fake-rails-back/engine/chaos/DefaultRailScenarios.ts` defines `RAIL_DESCRIPTORS`, with twenty entries. `resolveRail(code)` matches the rail code, gateway code and every alias case-insensitively. `canonicalRailCode(code)` returns the rail code.

| Rail code | Gateway code | Name | Collection modes | Aliases | OTP length |
| :--- | :--- | :--- | :--- | :--- | ---: |
| `edfali` | `edfali` | Edfali | `OTP_PULL` | `edfali` | 4 |
| `sadad` | `sadad` | Sadad | `OTP_PULL` | `sadad` | 6 |
| `mobicash` | `mobicash` | MobiCash | `OTP_PULL`, `QR_DISPLAY` | `mobicash` | 6 |
| `moamalat` | `moamalat` | Moamalat NPG | `EMBEDDED`, `REDIRECT` | `moamalat`, `moamalat_card` | 6 |
| `ly_pay` | `cbl_lypay` | CBL LYPay | `QR_DISPLAY`, `PUSH_APPROVAL` | `ly_pay`, `lypay`, `cbl_lypay` | 6 |
| `onepay` | `onepay` | OnePay | `QR_DISPLAY`, `PAY_CODE`, `OTP_PULL` | `onepay` | 6 |
| `tlync` | `tlync` | Tadawul T-LYNC | `REDIRECT` | `tlync` | 6 |
| `mypay` | `mypay` | MyPay | `REDIRECT` | `mypay` | 6 |
| `dpay` | `dpay` | DPay | `REDIRECT`, `OTP_PULL`, `EMBEDDED` | `dpay` | 6 |
| `plutu` | `plutu` | Plutu | `OTP_PULL`, `REDIRECT` | `plutu` | 6 |
| `yussor_pay` | `yussor` | Yussor Pay | `HYBRID`, `OTP_PULL`, `QR_DISPLAY`, `PAY_CODE` | `yussor_pay`, `yussor` | 6 |
| `sahara_pay` | `sahara` | Sahara Pay | `HYBRID`, `OTP_PULL`, `QR_DISPLAY`, `PAY_CODE` | `sahara_pay`, `sahara` | 6 |
| `masrefy_pay` | `masrefy` | Masrefy Pay | `HYBRID`, `OTP_PULL`, `QR_DISPLAY`, `PAY_CODE` | `masrefy_pay`, `masrefy` | 6 |
| `hawelli` | `hawelli` | Hawelli | `PUSH_APPROVAL`, `QR_DISPLAY`, `OTP_PULL`, `DEEP_LINK` | `hawelli` | 6 |
| `gpay_libya` | `gpay_libya` | GPay Libya | `PUSH_APPROVAL`, `QR_DISPLAY`, `OTP_PULL`, `DEEP_LINK` | `gpay_libya`, `gpay` | 6 |
| `numo_pay` | `numo_pay` | Numo Pay | `PUSH_APPROVAL`, `QR_DISPLAY`, `OTP_PULL`, `DEEP_LINK` | `numo_pay`, `numo` | 6 |
| `libyana` | `libyana` | Libyana | `PUSH_APPROVAL`, `QR_DISPLAY`, `OTP_PULL`, `DEEP_LINK` | `libyana` | 6 |
| `mpgs` | `mpgs` | MPGS (Visa/Mastercard) | `EMBEDDED`, `REDIRECT` | `mpgs` | 6 |
| `evopay` | `evo_pay` | Evo Pay | `QR_DISPLAY`, `PUSH_APPROVAL` | `evopay`, `evo_pay` | 6 |
| `neompay` | `neompay` | NeomPay | `HYBRID` | `neompay`, `neompay_wallet` | 6 |

### 3.2 Route definition model

`api/rails/types.ts` defines `RailRouteDefinition` with `gatewayCodes`, `method` (`GET` or `POST`), `path`, `phase` and `handler`. Router files export arrays:

- `otpPullRouter.ts` for Edfali, Sadad and MobiCash.
- `embeddedRouter.ts` for Moamalat and MPGS.
- `qrAndPushRouter.ts` for LYPay, OnePay, hybrid wallets, push wallets and Evo Pay.
- `redirectRouter.ts` for T-LYNC, MyPay, DPay and Plutu.
- `internalNeomPayRouter.ts` for NeomPay.
- `statementRouter.ts` for the per-gateway statement route.

`api/rails/index.ts` concatenates them into `RAIL_ROUTES`. `createRailsRouter()` resolves `:gatewayCode`, matches method and path segment by segment (`:param` and `*` accepted), creates or finds a transaction, evaluates chaos, records the event and sends the handler response.

### 3.3 Mode coverage

| Collection mode | Emulated? | Actual evidence |
| :--- | :--- | :--- |
| `OTP_PULL` | Yes, partial | Edfali, Sadad, MobiCash, OnePay, DPay, Plutu, hybrid/push rails |
| `REDIRECT` | Yes, partial | T-LYNC, MyPay, DPay, Plutu, Moamalat, MPGS hosted redirect |
| `EMBEDDED` | Yes, partial | Moamalat and MPGS SDK plus `/hosted/widget-frame` |
| `PUSH_APPROVAL` | Yes, generic | Push rails expose `/request`, `/confirm`, `/cancel`, `/status/:ref` |
| `QR_DISPLAY` | Yes, generic | `asyncInitiate` returns `qr_code`/`qr_payload` |
| `PAY_CODE` | Yes, generic | OnePay `/paycode`; `pay_code` uses the derived OTP |
| `DEEP_LINK` | Yes, generic | Push rails return `deep_link` to the hosted redirect page |
| `HYBRID` | Label only | Mode is advertised; routing is still a fixed set of generic routes |
| `MANUAL` | No | No descriptor uses it and no route implements it |

The descriptor catalogue contains eight of the nine modes. `MANUAL` exists in the core vocabulary but is not represented.

### 3.4 Phase coverage

The core design names ten declarative phases. The fake backend uses the five-value `FailPhase` union `INITIATE`, `SUBMIT`, `VERIFY`, `WEBHOOK`, `REFUND` for chaos decisions, while routes carry the first four plus `REFUND`.

| Declarative phase | Fake coverage | Notes |
| :--- | :--- | :--- |
| `CREDENTIAL_CHECK` | Missing | No credential probe endpoint |
| `PRE_INITIATE` | Missing | No pre-initiate route or validation |
| `INITIATE` | Implemented | OTP, QR, push, redirect, token and payment creation |
| `SUBMIT` | Implemented | OTP confirm, async confirm, wallet confirm |
| `VERIFY` | Implemented | Inquiry, status, enquiry, receipt and ledger export |
| `CANCEL` | Partial | Push wallets have `/cancel`; hosted UI has a cancel action; no generic engine cancel route |
| `REFUND` | Partial | Moamalat, MPGS, T-LYNC, DPay and NeomPay only |
| `VOID` | Missing | No void endpoint |
| `CAPTURE` | Missing | No separate capture endpoint |
| `SETTLEMENT_FETCH` | Missing | Statement GET exists but is not a core flow |

### 3.5 Per-gateway route map

| Gateway code | Routes implemented in the emulator |
| :--- | :--- |
| `edfali` | `POST /verify`, `POST /confirm`, `GET /status/:ref`, `GET /statement` |
| `sadad` | `POST /verify`, `POST /confirm`, `GET /status/:ref`, `GET /statement` |
| `mobicash` | `POST /open`, `POST /confirm`, `POST /qr`, `GET /status/:ref`, `GET /statement` |
| `moamalat` | `POST /FilterTransactions`, `POST /refund`, `POST /confirm`, `GET /statement` |
| `ly_pay` | `POST /api/v1/auth/token`, `POST /api/v1/payments/funds-transfers`, `POST /api/v1/payments/funds-transfers/:uuid/confirm`, `GET /api/v1/payments/funds-transfers/enquiry`, `GET /statement` |
| `onepay` | `POST /qr`, `POST /paycode`, `POST /verify`, `POST /confirm`, `GET /status/:ref`, `GET /statement` |
| `tlync` | `POST /payment/create`, `POST /receipt/transaction`, `POST /refund`, `GET /statement` |
| `mypay` | `POST /auth/token`, `POST /payment/create`, `GET /statement` |
| `dpay` | `POST /sessions/open`, `POST /sessions/:id/verify`, `GET /sessions/:id`, `POST /refund`, `GET /statement` |
| `plutu` | `POST /edfali/verify`, `POST /edfali/confirm`, `POST /sadad/verify`, `POST /sadad/confirm`, `POST /tlync/create`, `GET /statement` |
| `yussor` | `POST /initiate`, `POST /confirm`, `GET /status/:ref`, `GET /statement` |
| `sahara` | `POST /initiate`, `POST /confirm`, `GET /status/:ref`, `GET /statement` |
| `masrefy` | `POST /initiate`, `POST /confirm`, `GET /status/:ref`, `GET /statement` |
| `hawelli` | `POST /request`, `POST /confirm`, `POST /cancel`, `GET /status/:ref`, `GET /statement` |
| `gpay_libya` | `POST /request`, `POST /confirm`, `POST /cancel`, `GET /status/:ref`, `GET /statement` |
| `numo_pay` | `POST /request`, `POST /confirm`, `POST /cancel`, `GET /status/:ref`, `GET /statement` |
| `libyana` | `POST /request`, `POST /confirm`, `POST /cancel`, `GET /status/:ref`, `GET /statement` |
| `mpgs` | `POST /session`, `GET /order/:id`, `POST /order/:id/refund`, `POST /order/:id/confirm`, `GET /statement` |
| `evopay` | `POST /Payment`, `GET /Payment/:id`, `GET /statement` |
| `neompay` | `POST /payments/requests`, `POST /payments/:id/confirm`, `GET /payments/by-reference/:ref`, `POST /payments/:id/refund`, `GET /ledger-export`, `GET /statement` |

### 3.6 Amount and customer handling

`api/rails/common.ts` extracts references from a large recursive key list (`reference`, `merchant_reference`, `order_id`, `idempotency_key`, `ref`, and others), then from `idempotency-key` or `x-request-id`, then generates `FK-<timestamp>-<random>`. The descriptor `defaultOtp` field is never read; the expected OTP always comes from `deriveOtp()`.

`normalizeAmount()` implements:

- `moamalat`: integer dirhams, `LYD * 1000`, wire string integer.
- `ly_pay` and `neompay`: string decimal with four-decimal normalisation and scale `1000`.
- Everything else: string decimal with four-decimal normalisation and scale `100`.

`maskCustomer()` masks cards for Moamalat/MPGS, wallets for NeomPay and phones otherwise. `extractOtp()` accepts common OTP key names. `deriveOtp()` hashes the seeder token, rail code and reference and truncates to the descriptor length.

`phaseForPath()` exists but the dispatcher uses the route's declared phase rather than inferring from the path.

### 3.7 Wire shapes

`successBase()` returns our reference, provider reference, transaction id, network reference, amount, currency and process id. `successResponse()` adds `status`, `success` and `ActionCode`. `failureBody()` adds a stable error code and action code.

Handlers return protocol-shaped payloads:

- `otpInitiate`: `AWAITING_CUSTOMER`, `process_id`, OTP, expiry.
- `otpConfirm`: `PAID` or retryable wrong OTP.
- `asyncInitiate`: QR payload, deep link, push reference, pay code and expiry.
- `redirectInitiate`: hosted `redirect_url`, return/cancel URLs and expiry.
- `inquiry`: `PAID`, `FAILED` or `PENDING` with a nested `payment.status`.
- `refund`: `REFUNDED` or `NOT_REFUNDABLE`.
- `cancel`: `CANCELLED`.
- `tokenEndpoint`: fake Bearer token with gateway-dependent expiry.

### 3.8 Actual route mismatches

Two gateway codes are seeded into `core-back` but are not the codes used by the route definitions:

1. **`cbl_lypay`.** The blueprint seeds the gateway as `cbl_lypay` and the flow URL template as `{api}/api/v1/payments/funds-transfers`, where `{api}` becomes `FAKE_RAILS_PUBLIC_BASE_URL/rails/cbl_lypay`. The descriptor resolves `cbl_lypay` to gateway code `cbl_lypay`, but `qrAndPushRouter.ts` registers those paths under `gatewayCodes: ["ly_pay"]`. `matchRailRoute()` therefore returns no route and the request gets `404 UNKNOWN_RAIL_ENDPOINT`. Calling `/rails/ly_pay/...` works, but the seeded gateway never uses that URL.
2. **`evo_pay`.** The blueprint seeds `evo_pay` with `POST /Payment` and `GET /Payment/:id`. The descriptor's gateway code is `evo_pay`, but the routes are registered under `gatewayCodes: ["evopay"]`. The seeded URL `/rails/evo_pay/Payment` therefore returns `404 UNKNOWN_RAIL_ENDPOINT`.

The clean fix is to make route definitions use descriptor `gatewayCode` values, or make the dispatcher match `descriptor.railCode` as well as `descriptor.gatewayCode`. Until then, the four affected core flows cannot run against the emulator.

A related mismatch exists in `statementRouter.ts`: `STATEMENT_GATEWAYS` lists `ly_pay` and `evopay`, not `cbl_lypay` and `evo_pay`, so those two seeded gateways also lack a statement route.

### 3.9 Default webhook path bug

`WebhookDispatcher.defaultUrlFor()` builds:

```text
${CORE_INBOUND_BASE_URL}/webhook/${gateway_code}/${env.toLowerCase()}/${gateway_code}-webhook
```

With the default base `http://127.0.0.1:4103/api/v1/inbound`, this becomes `/api/v1/inbound/webhook/...`. The actual checkout route is `POST /api/v1/inbound/:gateway/:env/:pathToken`. The literal `webhook` segment is interpreted as `:gateway`, so every default webhook is routed to the wrong handler/404 path.

The third segment is also hard-coded as `${gateway_code}-webhook`. Blueprint channel tokens are not uniformly that string: examples include `cbl-lypay-webhook` and `evo-pay-webhook`. `seedFakeRails.ts` rewrites the first webhook channel per gateway code to `${code}-webhook`, which masks the token problem only when that pass has run; it does not fix the extra path segment.

### 3.10 Missing inbound signature verification

The design says the emulator verifies the gateway auth and crypto recipes. The implementation does not:

- No route checks `Authorization`, `X-API-KEY`, `Basic`, `Secret-Key`, `X-Store-Token` or `X-Store-Id`.
- No route verifies HMAC, RSA, `SecureHash`, timestamp tolerance or canonical string.
- No idempotency conflict is refused; an existing reference is silently reused.
- No source-IP allowlist is applied to rail routes.
- No `422` duplicate-reference response exists.

Only the outbound webhook path computes signatures (`FakeCryptoSigner` plus six gateway profiles). Inbound verification is therefore a protocol-fidelity gap, not just a missing test.

### 3.11 Dead auto-approve

`RailChaosScenarioConfig.autoApproveAsyncAfterSec` is defined, persisted, merged by `PUT /portal-api/scenarios/:railCode`, and returned to the UI. Nothing reads it. No timer, worker or request path schedules an automatic approval after the configured number of seconds. Async rails only settle when a caller hits `/confirm`, the hosted page approves, or the tester approves a transaction.

### 3.12 Statement route mismatch

`GET /rails/:gateway/statement` is implemented for every descriptor code. It filters the last 1,000 transactions by gateway and date window and returns CSV or JSON. There is no auth and no XLSX on this route.

`core-back` has no `SETTLEMENT_FETCH` engine flow. The seeded statement channels are inbound channel records with `pathToken = <code>-statement`; reconciliation is driven by uploaded files through the admin reconciliation route, not by fetching `/statement`. The emulator's statement endpoint is therefore a tester convenience, not part of the automated core lifecycle.

## 4. Contracts and invariants

1. **Alias resolution is case-insensitive.** `cbl_lypay`, `ly_pay` and `lypay` all resolve to the same descriptor.
2. **Route matching is exact after alias resolution.** Path segment count must match; `:param` matches one segment.
3. **A transaction reference is created once and reused.** Subsequent requests with the same reference do not create a second row.
4. **Amount normalisation is gateway-specific and text-only.** No floating-point arithmetic is used to store money.
5. **OTP generation is deterministic per transaction.** The portal exposes the current expected OTP.
6. **Successful confirmation generates a webhook.** Confirmation handlers call `dispatchSuccessWebhook`, except where a fault suppresses or delays it.
7. **Webhook signatures are derived from the seeder token.** The signature profile depends on the gateway code, with a generic fallback.

## 5. Data / API / config / deployment surface

- Descriptors: `RAIL_DESCRIPTORS` and `resolveRail()` in `DefaultRailScenarios.ts`.
- Route arrays: `RAIL_ROUTES` in `api/rails/index.ts`.
- Dispatcher: `createRailsRouter()`.
- Amount, reference, OTP and masking helpers: `api/rails/common.ts`.
- Handlers: `api/rails/handlers.ts`.
- Statement route: `api/rails/statementRouter.ts`.
- Core URL source: `core-back/prisma/seedBlueprints.ts` `urlTemplate` values.
- Core base URL rewrite: `core-back/prisma/seedFakeRails.ts` `gatewayBaseUrl()`.

## 6. Operational usage

- Test one rail directly: `curl -X POST http://127.0.0.1:4104/rails/edfali/verify -H 'content-type: application/json' -d '{"reference":"R-1","amount":"10.00","phone":"0911234567"}'`.
- Complete OTP: use the returned `otp` against `/rails/edfali/confirm`.
- List transactions: `GET /portal-api/transactions` with a tester JWT.
- Inspect wire calls: `GET /portal-api/transactions/:id`.
- Generate a statement: `POST /portal-api/statements/generate` with `{ gatewayCode, format }`.
- For seeded gateways, verify the actual base URL in `gateway_environments.base_urls`; do not assume the descriptor code is the URL code.

## 7. Status and deviations

### Implemented

- Twenty descriptors with aliases and collection-mode labels.
- Generic route implementations for OTP, QR/push, redirect, embedded and internal wallet patterns.
- Moamalat and MPGS SDK scripts.
- Per-rail statement endpoint.
- Amount-scale handling for Moamalat, LYPay/NeomPay and the default rails.
- Deterministic OTP and provider references.

### Partial

- Mode coverage: eight of nine labels; `HYBRID` is a label rather than a distinct protocol.
- Phase coverage: four phases plus refund; cancel/void/capture/settlement fetch absent.
- Protocol shape: handlers return a generic envelope rather than gateway-specific XML/SOAP or exact partner payloads.
- Auth: outbound signing exists; inbound verification does not.
- Statements: route exists, but no core fetch flow uses it.

### Missing / deferred

- Inbound signature verification and idempotency conflict handling.
- `CREDENTIAL_CHECK`, `PRE_INITIATE`, `VOID`, `CAPTURE` and `SETTLEMENT_FETCH` routes.
- Real XML/SOAP envelopes for any gateway that requires them.
- Per-gateway error catalogues and status-rule parity.
- Automatic async approval.
- Route definitions using canonical descriptor gateway codes.

### Known bugs / risks

- **Code bug:** `cbl_lypay` and `evo_pay` seeded URLs do not match route keys.
- **Code bug:** default webhook URL has an extra `/webhook` segment.
- **Code gap:** inbound requests can claim any amount, reference or provider state without authentication.
- **Code gap:** statement routes are not keyed to the canonical gateway codes for the two mismatched rails.
- **Documentation gap:** historical claims of "all 20 gateways, all modes, all phases" are false.

## 8. Verification and tests

- `fake-rails-back/test/chaos.test.ts` asserts twenty descriptors and alias resolution, including `cbl_lypay -> ly_pay` and `evo_pay -> evopay`, but does not request their seeded URLs.
- `fake-rails-back/test/api.test.ts` drives Edfali OTP, T-LYNC redirect/hosted approval and the Moamalat SDK script.
- The suite-05 fake-rails test drives the scenario API for all twenty rail codes, not the rail protocol routes.
- There is no HTTP matrix test that calls every route with the gateway code used by `core-back`.
- No test asserts the webhook URL shape, inbound auth, duplicate-reference refusal or statement parity.

## 9. Source references

### Old design sections

- `design/fake_payment_rails_service_architecture.md` section 4 and 4.1.
- `design/fake_payment_rails_service_architecture.md` section 4.2.
- `design/fake_payment_rails_service_architecture.md` section 5 for chaos phase intent.

### Code paths

- `fake-rails-back/engine/chaos/DefaultRailScenarios.ts`
- `fake-rails-back/api/rails/index.ts`
- `fake-rails-back/api/rails/common.ts`
- `fake-rails-back/api/rails/handlers.ts`
- `fake-rails-back/api/rails/otpPullRouter.ts`
- `fake-rails-back/api/rails/embeddedRouter.ts`
- `fake-rails-back/api/rails/qrAndPushRouter.ts`
- `fake-rails-back/api/rails/redirectRouter.ts`
- `fake-rails-back/api/rails/internalNeomPayRouter.ts`
- `fake-rails-back/api/rails/statementRouter.ts`
- `core-back/prisma/seedBlueprints.ts`
- `core-back/prisma/seedFakeRails.ts`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03: initial canonical part. Verified against `5a24f6f+working-tree`.

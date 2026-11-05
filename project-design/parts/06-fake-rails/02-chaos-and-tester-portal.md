---
id: fake-rails.chaos
title: Fake Rails Chaos Engine and Tester Portal
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: 5a24f6f+working-tree
code:
  - fake-rails-back/engine/chaos/**
  - fake-rails-back/engine/webhooks/**
  - fake-rails-back/engine/statements/**
  - fake-rails-back/api/portal/**
  - fake-rails-front/src/**
design_sources:
  - design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md#5-probabilistic-chaos-failure-injection-engine
  - design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md#6-single-user-tester-portal-dashboard-architecture-fake-rails-front
  - design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md#5-3-embedded-sqlite-schema
tests:
  - fake-rails-back/test/chaos.test.ts
  - fake-rails-back/test/api.test.ts
  - fake-rails-back/test/exhaustive/05-api-matrix/fake-rails-portal-and-chaos-api.test.ts
  - tests/e2e/exhaustive/exhaustive-fake-rails-surface.spec.ts
  - fake-rails-back/test/security.test.ts
  - tests/unit/frontend-security-checkout.test.ts
gaps:
  - autoApproveAsyncAfterSec is persisted but never scheduled.
  - The portal exposes failure chance and one primary failure mode, not the full phase/mode weight matrix.
  - Webhook phase chaos is not evaluated by the webhook dispatcher.
  - Statement generation has no core reconciliation upload integration.
  - The fake-rails UI e2e suite mocks every portal API and only checks login geometry.
---

# Fake Rails Chaos Engine and Tester Portal

## 1. Purpose and scope

This part covers the deterministic and probabilistic failure engine, the SQLite state it owns, outbound webhook anomalies, settlement-statement generation, the tester portal API and the `fake-rails-front` SPA.

It does not cover the backend process model (`fake-rails.backend`), the route matrix (`fake-rails.protocol`) or the core seeding/deploy wiring (`fake-rails.integration`).

## 2. Design intent (extracted and synthesized from ./design)

The design requires a tester to answer four questions at any moment:

1. What did the gateway receive and return?
2. Is this rail healthy, flaky, delayed or completely down?
3. If it fails, how and in which phase does it fail?
4. Can the tester force a specific outcome, replay a webhook, forge a signature or generate an anomalous statement?

The intended failure controls are:

- A per-rail `overallFailureChancePercent` from 0 to 100.
- Weighted phase choice across `INITIATE`, `SUBMIT`, `VERIFY`, `WEBHOOK` and `REFUND`.
- Weighted failure modes: insufficient funds, customer ceiling, wrong OTP, HTTP 500, timeout/hang, socket reset, malformed 200 body, HTTP 429, amount mismatch and conflicting webhook versus inquiry.
- Latency range.
- Async auto-approval after N seconds.
- Webhook delay, duplicate count, out-of-order PENDING-after-PAID and corrupt-signature chance.

The intended portal has a live SSE feed, an OTP/action banner, a pending-action queue, a transaction/wire inspector, a chaos matrix, a statement generator and hosted redirect/widget pages.

## 3. As-built architecture

### 3.1 Scenario model

`engine/chaos/DefaultRailScenarios.ts` defines:

```ts
interface RailChaosScenarioConfig {
  railCode: string;
  gatewayCode: string;
  enabled: boolean;
  overallFailureChancePercent: number;
  phaseBreakdown: {
    initiateFailWeight: number;
    submitFailWeight: number;
    verifyFailWeight: number;
    webhookFailWeight: number;
    refundFailWeight: number;
  };
  failureModeWeights: Record<FailureMode, number>;
  latencyMs: { min: number; max: number };
  autoApproveAsyncAfterSec: number | null;
  webhookBehavior: {
    delaySeconds: number;
    duplicateCount: number;
    outOfOrderPendingAfterPaid: boolean;
    corruptSignatureChancePercent: number;
  };
}
```

The healthy baseline is `enabled=true`, `overallFailureChancePercent=0`, latency 40-250 ms, one webhook copy and no corruption. `defaultScenario()` gives one configuration per descriptor. Defaults are inserted into `fake_rail_scenarios` on first access.

`FailureMode` has ten values exactly matching the design. `FailPhase` has five values (`INITIATE`, `SUBMIT`, `VERIFY`, `WEBHOOK`, `REFUND`). The core's ten declarative phases are not the same type.

### 3.2 Deterministic PRNG

`engine/chaos/prng.ts` implements mulberry32 plus FNV-1a string hashing, `int`, `pick`, `chance(percent)` and `weighted(record)`. A scenario seed is `${railCode}:${reference}` for transaction fate and `${transactionId}:${phase}` for latency, so repeated runs with the same reference are reproducible.

### 3.3 Evaluation priority

`ChaosEvaluator.evaluate()` applies this order:

1. **Magic input** in the current phase. It wins over everything.
2. **Disabled rail.** `enabled=false` produces `HTTP_500_GATEWAY_FAULT` with source `OUTAGE`; `applyFault` maps that source to HTTP 503.
3. **Pinned transaction fate.** When the transaction row has `assigned_failure_mode` and `assigned_fail_phase` equal to the current phase.
4. **No failure.**

`assignFate()` runs once when a new transaction row is created. It rolls `overallFailureChancePercent`; if it fails, it samples a phase from `phaseBreakdown` and a mode from `failureModeWeights`, then persists both on `fake_transactions`.

### 3.4 Magic inputs

`detectMagicTrigger()` flattens body values and the raw body text, then checks:

| Trigger | Failure mode | Phase |
| :--- | :--- | :--- |
| OTP `000000` or `0000` | `WRONG_OTP_RETRYABLE` | `SUBMIT` |
| OTP `999999` | `TERMINAL_DECLINE_INSUFFICIENT_FUNDS` | `SUBMIT` |
| OTP `500500` | `HTTP_500_GATEWAY_FAULT` | `SUBMIT` |
| OTP `408408` | `TIMEOUT_HANG_ABOVE_STEP_TTL` | `SUBMIT` |
| Phone ending `9901` | `TERMINAL_DECLINE_INSUFFICIENT_FUNDS` | `SUBMIT` |
| Phone ending `9902` | `LIMIT_EXCEEDED_CUSTOMER_CEILING` | `SUBMIT` |
| Phone ending `9905` | `HTTP_500_GATEWAY_FAULT` | `SUBMIT` |
| Phone ending `9906` | `TIMEOUT_HANG_ABOVE_STEP_TTL` | `SUBMIT` |
| Phone ending `9907` | `MALFORMED_OR_UNMAPPED_200_BODY` | `SUBMIT` |

OTP detection is exact per flattened value and also regex-scans the joined text. Phone detection strips non-digits and checks the suffix.

### 3.5 Fault application

`api/rails/common.ts` splits faults into hard transport faults and business faults.

Hard faults (`applyFault`):

- `TIMEOUT_HANG_ABOVE_STEP_TTL`: sleeps `FAKE_RAILS_TIMEOUT_HANG_MS` (default 20,000 ms) then returns 504.
- `SOCKET_RESET_MID_STREAM`: destroys the socket and returns a 499 sentinel without recording a response.
- `HTTP_500_GATEWAY_FAULT`: 503 for outage, 500 otherwise.
- `RATE_LIMIT_HTTP_429`: 429.
- `MALFORMED_OR_UNMAPPED_200_BODY`: 200 with `{ unexpected_schema: true, data: null, code: "??" }`.

Business faults (`finalizeFault`):

- `TERMINAL_DECLINE_INSUFFICIENT_FUNDS`: row `FAILED`, failure body.
- `LIMIT_EXCEEDED_CUSTOMER_CEILING`: row `FAILED`, limit body.
- `WRONG_OTP_RETRYABLE`: row `AWAITING_ACTION`, retryable response.
- `AMOUNT_ROUNDING_MISMATCH`: row `PAID`, settled amount +0.05.
- `CONFLICTING_WEBHOOK_VS_INQUIRY`: row `PAID`, inquiry override `FAILED`, success webhook fired.

Latency is drawn from the scenario range using `latencyFor()` and awaited before the handler.

### 3.6 Scenario persistence and API

`engine/chaos/scenarioStore.ts` stores the full config as JSON in `fake_rail_scenarios`, keyed by canonical rail code. `listScenarios()`, `getScenario()`, `saveScenario()` and `resetAllScenarios()` keep the config in sync with the descriptor list.

Portal endpoints in `api/portal/scenarios.ts`:

| Method | Path | Behaviour |
| :--- | :--- | :--- |
| `GET` | `/portal-api/scenarios` | Returns descriptors and all scenarios |
| `GET` | `/portal-api/scenarios/:railCode` | One scenario |
| `PUT` | `/portal-api/scenarios/:railCode` | Merge a partial patch and persist |
| `POST` | `/portal-api/scenarios/preset/:railCode/:preset` | Apply one preset |
| `POST` | `/portal-api/scenarios/global/:preset` | Apply to all rails |
| `POST` | `/portal-api/scenarios/reset` | Restore defaults |
| `GET` | `/portal-api/scenarios/:railCode/audit` | Read portal audit rows for the rail |

Presets are `healthy`, `flaky` (25 percent), `timeout_on_confirm` (100 percent submit timeout) and `outage` (`enabled=false`). Global preset application iterates every descriptor.

### 3.7 Outbound webhook anomalies

`engine/webhooks/WebhookDispatcher.ts` persists every delivery in `fake_webhook_deliveries` before scheduling it. It supports:

- `delaySeconds` before the first attempt.
- `duplicateCount` 1-5 copies.
- `outOfOrderPendingAfterPaid`: after a paid/success/captured event, queue a `transaction.pending` copy two seconds later.
- `corruptSignatureChancePercent`: use a tampered secret for the signature.

Signature profiles exist for `dpay` (timestamp dot raw body, hex lower), `mypay` (raw body, hex lower), `ly_pay` (sorted key/value, hex upper), `plutu` (sorted values, hex upper), `moamalat` (sorted key/value with hex-decoded secret) and `mpgs` (raw body). Every other gateway uses a generic sorted-key/value HMAC-SHA256 profile.

Delivery semantics:

- Timeout is `FAKE_RAILS_WEBHOOK_TIMEOUT_MS`.
- `ok` responses move to `SENT`.
- Failures retry with exponential backoff `1s, 2s, 4s` up to three attempts, then `FAILED`.
- Queued deliveries are resumed on process start.
- `replay(deliveryId, tamper)` resets state and optionally forges every signature-like header.
- The dispatcher emits `webhook.queued`, `webhook.sent` and `webhook.failed` to the SSE sink.

The default URL construction has a path bug documented in `fake-rails.protocol`.

### 3.8 Statement generation

`api/portal/statements.ts` and `engine/statements/xlsx.ts` implement the tester statement generator.

Inputs: `gatewayCode`, optional `from`/`to`, `format` (`csv`, `json`, `xlsx`) and anomalies:

- `feeVariancePercent` 0-100 with `feeVarianceAmount` added to matching rows.
- `omitOne`: drop the last line.
- `addUnrecorded`: append a synthetic `UNRECORDED-<timestamp>` line.

The generator filters `PAID`, `SUCCEEDED`, `REFUNDED` and `PARTIALLY_REFUNDED` rows, writes a `fake_statements` metadata row, broadcasts `statement.generated` and returns CSV, JSON or a dependency-free XLSX built from store-only ZIP parts and OOXML.

This is a download generator. It does not push the file to `core-back`, and the core reconciliation path remains an admin upload.

### 3.9 Tester portal API

| Router | Endpoints | Notes |
| :--- | :--- | :--- |
| `transactions.ts` | list, stream, summary, detail, action, events | Actions: `APPROVE`, `REJECT`, `APPROVE_MISMATCH`, `APPROVE_LATE`, `FORCE_OUTCOME`, `CANCEL` |
| `scenarios.ts` | list/get/put/presets/reset/audit | Full config persisted |
| `webhooks.ts` | list, fire, replay, send-now, dispute | Fire accepts delay/duplicates/out-of-order/corruption |
| `statements.ts` | list, generate | CSV/JSON/XLSX |
| `seederSync.ts` | handshake, bulk seed | Shared seeder token |
| `hosted.ts` | session read, session action | Public hosted flow |

`transactions.ts` writes `fake_portal_audit` for actions and broadcasts `transaction.action`. `summary` returns grouped status counts, per-rail counts and up to fifty pending actions. The `sseClients` field is currently `undefined`.

Hosted actions are `APPROVE`, `APPROVE_TAMPERED`, `DROP_WEBHOOK`, `ABANDON`, `DECLINE` and `CANCEL`:

- `APPROVE` sets `PAID` and fires a webhook.
- `APPROVE_TAMPERED` sets `PAID`, fires a webhook, then appends `status=failed&amount=0.01` to the redirect.
- `DROP_WEBHOOK` leaves the row awaiting action and fires nothing.
- `ABANDON` fires a paid webhook after 30 seconds while leaving the row awaiting action.
- `DECLINE` sets `FAILED`, fires a failure webhook and redirects to `cancel_url`.
- `CANCEL` sets `CANCELLED` and redirects to `cancel_url`.

The hosted router is public by design because the payer is not a tester.

### 3.10 SSE

The only stream is `GET /portal-api/transactions/stream`, authenticated by a query-string JWT because `EventSource` cannot set headers. It emits `ready`, `rail.request`, `webhook.queued`, `webhook.sent`, `webhook.failed`, `transaction.action`, `scenario.updated`, `scenario.reset`, `statement.generated`, `hosted.action`, `seeder.bulk` and `webhook.replayed`.

There is no per-replay cursor. A reconnecting client loses events that occurred while disconnected.

### 3.11 Tester SPA

`fake-rails-front/src/router/index.ts` defines seven routes:

| Route | Page | Purpose |
| :--- | :--- | :--- |
| `/login` | `pages/login/index.tsx` | Single tester login |
| `/dashboard` | `pages/dashboard/index.tsx` | KPIs, live feed, pending actions |
| `/transactions` | `pages/transactions/index.tsx` | Filter, inspect, compose webhooks |
| `/chaos-matrix` | `pages/chaos-matrix/index.tsx` | Per-rail cards and global presets |
| `/statements` | `pages/statements/index.tsx` | Generate CSV/XLSX/JSON with anomalies |
| `/hosted/redirect/:sessionId` | `pages/hosted/redirect/[sessionId].tsx` | Interactive hosted checkout |
| `/hosted/widget-frame` | `pages/hosted/widget-frame.tsx` | Moamalat/MPGS iframe content |

The router guard redirects unauthenticated non-hosted routes to `/login` and keeps the attempted path in `?redirect=`. Tokens live in `localStorage` under `fake-rails-token` and user info under `fake-rails-user`.

The portal layout has four navigation links and an environment badge. `LiveTransactionFeed` opens the SSE stream with the query token and listens for a subset of event names. `WireInspectorDrawer` shows transaction fields, step events and webhook deliveries. `WebhookComposerModal` fires or disputes a webhook. `RailChaosCard` edits failure chance, latency, primary failure mode, duplicates, out-of-order and corruption.

The SPA is fixed to the portal shell's language and theme; it does not have the admin/merchant i18n catalogue. `tests/e2e/exhaustive/exhaustive-fake-rails-surface.spec.ts` only visits `/login` across three viewports, two locales and two themes while mocking every portal API; it asserts shell geometry, no `#app` transform and no horizontal overflow.

## 4. Contracts and invariants

1. **Scenario state is durable.** Every scenario update survives a restart because it is written to SQLite.
2. **Failure fate is pinned per transaction.** A transaction that is assigned a `SUBMIT` timeout will not fail at `INITIATE`.
3. **Magic inputs are phase-scoped.** The trigger is ignored when its phase differs from the current route phase.
4. **Disabled means outage.** `enabled=false` always yields the 503 outage path.
5. **Webhook delivery is at-least-once with bounded retries.** Duplicates and tampering are deliberate test features.
6. **Hosted approval is a tester action, not a trusted payment signal.** The core must still verify any resulting webhook or inquiry.
7. **Statement anomalies are deterministic for a given window.** `feeVariancePercent` uses a PRNG seeded by gateway and window.
8. **The portal never claims to be a real switch.** It is a test surface and must remain isolated.

## 5. Data / API / config / deployment surface

- Scenario fields and failure modes: `DefaultRailScenarios.ts`.
- Magic triggers, fate assignment, latency: `ChaosEvaluator.ts`.
- Persistent config: `scenarioStore.ts` plus `fake_rail_scenarios`.
- Webhook queue and signature profiles: `WebhookDispatcher.ts`.
- Statement generator: `api/portal/statements.ts`, `engine/statements/xlsx.ts`.
- Portal routes: `api/portal/**`.
- SPA routes and components: `fake-rails-front/src/**`.

## 6. Operational usage

```bash
# Global healthy reset
curl -X POST http://127.0.0.1:4104/portal-api/scenarios/global/healthy \
  -H "authorization: Bearer $TOKEN"

# Make Edfali time out on confirm
curl -X POST http://127.0.0.1:4104/portal-api/scenarios/preset/edfali/timeout_on_confirm \
  -H "authorization: Bearer $TOKEN"

# Fire three copies of a paid webhook
curl -X POST http://127.0.0.1:4104/portal-api/webhooks/$TX_ID/fire \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"event":"payment.paid","duplicateCount":3}'
```

- Use the transaction detail endpoint before replaying a webhook so the target URL and signature profile are known.
- Reset all scenarios after a chaos test. The default row persists otherwise.
- The hosted page is intentionally public; do not expose the portal port outside the test network.

## 7. Status and deviations

### Implemented

- Ten failure modes, probability assignment, pinned fate, magic triggers and latency.
- SQLite-backed scenario store and four presets.
- Webhook delay, duplicates, out-of-order PENDING and corrupt signatures.
- Webhook replay, tamper, send-now and dispute.
- CSV/JSON/XLSX statement generation with fee variance, omission and unrecorded-line anomalies.
- Seven-route tester SPA with SSE feed, pending actions, wire inspector and hosted pages.
- Portal audit rows for transaction actions.

### Partial

- `autoApproveAsyncAfterSec` is dead.
- The UI exposes failure chance and a single primary failure mode; the full `phaseBreakdown` and all mode weights can only be changed through the raw API.
- The webhook dispatcher does not consult `assignedFailPhase=WEBHOOK` or mode weights; webhook anomalies are controlled separately.
- The dashboard's `sseClients` field is `undefined`; there is no connection count.
- Statement generation is download-only and not linked to core reconciliation.

### Missing / deferred

- Timer-driven async auto-approval.
- Per-phase UI weight controls.
- SSE replay/resume and multi-instance event fan-out.
- Server-side statement push to `core-back`.
- A real protocol-level chaos matrix (the portal edits scenario config rather than individual gateway wire failures).

### Known bugs / risks

- **Code gap:** the tester can approve a transaction with no server-side payment, which is intentional for spoof testing but must never be reachable from an untrusted network.
- **Code gap:** `ABANDON` leaves the row in `AWAITING_ACTION` while a paid webhook is sent after 30 seconds, producing a deliberate state conflict.
- **Code gap:** the query-string JWT is visible to access logs and browser history.
- **Documentation gap:** the design describes a 20-rail phase-perfect chaos matrix; the implementation is a smaller generic chaos layer.

## 8. Verification and tests

- `fake-rails-back/test/chaos.test.ts` (7 tests) covers descriptor count, aliases, magic OTP/phone triggers, reproducible fate, zero-percent health, magic-over-pinned priority, outage and PRNG determinism.
- `fake-rails-back/test/api.test.ts` (11 tests) covers persisted scenarios driving the next confirm, hosted approval and statement anomalies.
- `fake-rails-back/test/exhaustive/05-api-matrix/fake-rails-portal-and-chaos-api.test.ts` (30 tests) covers scenario CRUD for all twenty rails, global presets, reset, audit, actions, webhooks and statement formats.
- `tests/e2e/exhaustive/exhaustive-fake-rails-surface.spec.ts` (12 generated tests) only covers `/login` geometry with every API mocked. It does not exercise the dashboard, chaos matrix, transactions, statements or hosted pages.
- No test opens an SSE stream and asserts event delivery.

## 9. Source references

### Old design sections

- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 5.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 5.1, 5.2 and 5.3.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 6 and 6.1.

### Code paths

- `fake-rails-back/engine/chaos/DefaultRailScenarios.ts`
- `fake-rails-back/engine/chaos/ChaosEvaluator.ts`
- `fake-rails-back/engine/chaos/scenarioStore.ts`
- `fake-rails-back/engine/chaos/prng.ts`
- `fake-rails-back/engine/webhooks/WebhookDispatcher.ts`
- `fake-rails-back/engine/statements/xlsx.ts`
- `fake-rails-back/api/portal/**`
- `fake-rails-front/src/router/index.ts`
- `fake-rails-front/src/pages/**`
- `fake-rails-front/src/components/LiveTransactionFeed.tsx`
- `fake-rails-front/src/components/WireInspectorDrawer.tsx`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03: initial canonical part. Verified against `5a24f6f+working-tree`.

## Security hardening (2026-11-05)

fake-rails-front: the postMessage target is `VITE_CHECKOUT_ORIGIN`, otherwise the embedding parent's origin, never `*`; `redirect_url` is validated as http(s) without credentials. The SSE token is still passed in the query string, and `/hosted/*` is still public with no token on the action POST (GAP-024). New env: `VITE_CHECKOUT_ORIGIN`.

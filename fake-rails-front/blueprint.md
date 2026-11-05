<!-- GENERATED FILE. Edit project-design/parts/** instead. Do not hand-edit this file. -->

# fake-rails-front blueprint

Generated from: `fake-rails.chaos`, `fake-rails.integration`.

## Fake Rails Chaos Engine and Tester Portal

> Status: `partial` · Last verified: 2026-11-05

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

## Core Integration and Deployment

> Status: `partial` · Last verified: 2026-11-05

## 1. Purpose and scope

This part describes how `core-back`, the synthetic seeder and `deploy/` connect to the fake rails tier:

- `seedFakeRails.ts` rewrites gateway environments, widget definitions, webhook channel tokens and credential secrets.
- The scoped SSRF allowlist permits a private fake rails host without opening private-address SSRF generally.
- The synthetic seeder requires fake rails and performs a handshake plus bulk sync.
- The deploy engine plans a sixth `fake-rails` role, generates a certificate, opens the portal port, renders an Nginx vhost and optionally seeds the blueprints.
- The checkout frontend must be able to load the fake widget scripts and message origins.

It does not document the emulator internals (`fake-rails.backend`), the rail protocol (`fake-rails.protocol`) or the tester portal (`fake-rails.chaos`).

## 2. Design intent (extracted and synthesized from ./design)

The integration is designed to make the platform work out of the box with the emulator:

1. Every seeded gateway environment gets a base URL of `${FAKE_RAILS_PUBLIC_BASE_URL}/rails/<gateway_code>` and an `allowed_hosts` entry for the fake host.
2. Moamalat and MPGS widget definitions load the emulator's SDK scripts.
3. Inbound-verify crypto secrets are derived from a shared seeder token, so signatures produced by the emulator verify with real cryptography and no bypassed checks.
4. `ALLOW_FAKE_RAILS_HOSTS` relaxes the private-IP guard only when the target host is in both `FAKE_RAILS_ALLOWED_HOSTS` and the gateway version's own `allowed_hosts`.
5. The deployment engine adds an optional `fake-rails` host role with its own backend port, Nginx port, TLS mode, certificate SAN, firewall scope and PM2 process.
6. The synthetic seeder refuses to run unless it is a declared test server, fake rails is enabled, production is explicitly opted in, every gateway host is fake, and the handshake succeeds.
7. The synthetic seeder bulk-syncs its historical transactions and step events into the emulator so the tester portal shows the same history as the gateway.

## 3. As-built architecture

### 3.1 `seedFakeRails.ts`

`core-back/prisma/seedFakeRails.ts` requires `FAKE_RAILS_SEEDER_TOKEN`. It then runs four update passes and one setting upsert.

**Environments.** `updateEnvironments()` loads every `gatewayVersion` with its gateway and environments. For each environment:

- It reads existing `baseUrls` and preserves the keys (or uses `api`).
- It sets every key to `${FAKE_RAILS_PUBLIC_BASE_URL}/rails/${gateway.code}`.
- It unions the environment's existing `allowedHosts` with the fake base host, optional `FAKE_RAILS_ALLOWED_HOSTS`, `127.0.0.1` and `localhost`.
- It sets `enabled=true`.

**Widgets.** `updateWidgets()` loads widget definitions through their route and gateway. For `moamalat` and `mpgs` it sets:

- `scriptUrls = [<base>/sdk/moamalat-lightbox.js]` or `[<base>/sdk/mpgs-session.js]`.
- `scriptSriHashes = []`.
- `allowedOrigins = [<base>]`.

No other widget is changed.

**Webhook channels.** `updateWebhookChannels()` scans `confirmationChannel` rows of type `WEBHOOK`. The first channel per gateway code receives `pathToken = ${code}-webhook`; later versions keep the existing token. It does not change the channel's verification method, signature header, IP allowlist or crypto-profile reference.

**Credential secrets.** `updateCredentialSecrets()` returns zero if the seeder token is empty. Otherwise, for every `PLATFORM` credential set, it walks existing entries. When an entry key matches a crypto profile `secretKeyRef`, it derives:

```text
HMAC-SHA256(seederToken, "fake-rails:<gatewayCode>:<purpose>")
```

where purpose is `webhook` if any matching profile is `INBOUND_VERIFY`, otherwise `sign`. The derived secret is encrypted through `Vault.encryptSecret(secret, "credential-set")`, the entry is marked secret and its `secretVersion` is incremented. Entries with no matching profile are left untouched. The credential set is marked `VERIFIED`.

**Environment mode.** `ensureEnvironmentSetting()` upserts `server.environment_mode = { mode: "TEST_SANDBOX" }`.

The script prints environment, widget, channel and credential counts and exits non-zero if the token is missing.

### 3.2 Seeded gateway count

`core-back/prisma/seedBlueprints.ts` creates thirteen distinct gateway codes:

`edfali`, `sadad`, `moamalat`, `cbl_lypay`, `mypay`, `tlync`, `mobicash`, `onepay`, `yussor`, `sahara`, `mpgs`, `evo_pay`, `neompay`.

The fake descriptor catalogue has twenty rail codes. Seven fake descriptors have no core gateway blueprint:

- `dpay`
- `plutu`
- `masrefy`
- `hawelli`
- `gpay_libya`
- `numo_pay`
- `libyana`

Conversely, the core uses `cbl_lypay` and `evo_pay`, while the fake routes use `ly_pay` and `evopay`. The counts therefore agree only in spirit: 13 core gateways versus 20 fake descriptors, with two code mismatches inside the overlap.

### 3.3 Scoped SSRF allowlist

`core-back/engine/apiConsumer/fakeRailsAllowlist.ts` implements `isFakeRailsHostAllowed(hostname, gatewayAllowedHosts)`:

1. `env.ALLOW_FAKE_RAILS_HOSTS` must be `true`.
2. The normalized hostname must appear in `FAKE_RAILS_ALLOWED_HOSTS`.
3. The same hostname must appear in the caller's `gatewayAllowedHosts`.
4. Trailing dots are stripped; comparison is lowercase.

`ApiConsumer.ts` and `StepExecutor.ts` call this check before URL validation. When true, `requireHttps` is set to false, allowing the private/loopback fake host over plain HTTP. The general SSRF guard still rejects `169.254.169.254`, unrelated private addresses, redirects, userinfo, fragments, CRLF and path traversal.

The allowlist test proves:

- Closed unless explicitly enabled.
- Both environment and gateway list must match.
- An empty gateway list never matches.
- A metadata address is refused even if listed.

### 3.4 Synthetic seeder integration

`core-back/prisma/syntheticSeeder/SeederSafetyGate.ts` enforces five gates:

1. `IS_TEST_SERVER=true`.
2. `FAKE_RAILS_ENABLED=true` and a public base URL.
3. Production requires `FAKE_RAILS_ALLOW_IN_PRODUCTION=true`.
4. At least one allowed host; every configured gateway environment URL must point at an allowed fake host, not an external host or metadata address.
5. The `POST /portal-api/internal/seeder-handshake` call must succeed with the seeder token.

`sync/fakeRailsBulkSyncClient.ts` posts transactions and step events to `/portal-api/internal/bulk-seed` with `x-fake-rails-seeder-token`. The emulator inserts both batches in one `BEGIN IMMEDIATE` transaction and broadcasts `seeder.bulk`.

### 3.5 Deployment configuration

`deploy/lib/configSchema.ts` defines the fake rails keys and validates:

- Host, key path and private IP when enabled.
- Tester username/password/JWT/seeder token.
- Production opt-in.
- Password length and non-collision of backend/Nginx ports with every other role and public port.
- `RUN_SYNTHETIC_HISTORY_SEED` requires an enabled test server and fake rails.

`deploy/lib/hostPlanner.ts` maps the role to:

- Service `pg-fake-rails-back`, source `fake-rails-back`, port `FAKE_RAILS_BACK_PORT`.
- Environment with `NODE_ENV`, `HOST`, `PORT`, `FAKE_RAILS_ENABLED`, `FAKE_RAILS_ALLOW_IN_PRODUCTION`, public base URL, data directory, admin credentials, secrets, CIDRs and `CORE_INBOUND_BASE_URL`.
- Nginx site `fake-rails` on `FAKE_RAILS_NGINX_PORT` with `FAKE_RAILS_SSL`, domain, certificate paths and static root `current/fake-rails-front/dist`.
- Certificate bundle `fake-rails-server`.
- Firewall rules for SSH and the portal port restricted to `FAKE_RAILS_ALLOWED_CIDRS` plus core/checkout private IPs.

`deploy/lib/pkiManager.ts` includes `fakeRails` in the PKI bundle with SAN `DNS:<domain>`, `IP:<private-ip>` and `IP:127.0.0.1`. `deploy/deploy.ts` builds the SPA, deploys backend plus `dist`, renders the vhost and optionally runs `bun run seed-fake-rails` on the core host.

`deploy/templates/nginx.fakerails.conf.tpl` proxies `/rails`, `/sdk`, `/portal-api` and `/hosted` to the backend and serves the SPA. Its CSP allows `script-src 'self' 'unsafe-inline'` and `frame-ancestors 'self' *`.

### 3.6 Embedded widget and CSP block

The embedded flow cannot currently load the emulator widget end to end:

1. `checkout-front/src/components/renderers/EmbeddedWidgetRenderer.tsx` hard-codes `SCRIPT_ALLOWLIST_HOSTS` to public HTTPS partners (`payments.moamalat.ly`, `secure.moamalat.ly`, `test.mpgmerchant.test`, `pay.evowallet.net`, `js.numo-pay.com`). A fake URL such as `http://127.0.0.1:8444/sdk/moamalat-lightbox.js` fails `isAllowlistedScript()` for both protocol and host.
2. Even if the renderer allowed it, the checkout Nginx templates set `script-src 'self'` with no fake origin.
3. The seeded widget `cspAdditions` remain `frame-src https://*.moamalat.example.ly` and `frame-src https://*.mpgs.example.ly`; `seedFakeRails.ts` does not rewrite them.
4. `seedFakeRails.ts` writes an empty SRI array, so `EmbeddedWidgetRenderer` cannot apply an integrity hash.

The redirect flow is unaffected because it uses a browser navigation to the hosted URL, subject to the checkout redirect allowlist.

### 3.7 Webhook and callback gaps

- **Wrong path.** `WebhookDispatcher.defaultUrlFor()` inserts `/webhook/` between the inbound base and `:gateway`, while the checkout route is `/api/v1/inbound/:gateway/:env/:pathToken`.
- **Token mismatch.** The default token is `${gateway_code}-webhook`. Blueprint tokens are not uniformly that string (for example `cbl-lypay-webhook`); `seedFakeRails.ts` rewrites the first webhook channel per code to `${code}-webhook`, so the default works only after that pass and only for the rewritten channel.
- **No fake-side verification.** The emulator signs outbound webhooks but never verifies core-originated requests.
- **Credential coverage.** `updateCredentialSecrets()` only updates existing credential entries whose key matches a crypto profile. A gateway with no secret entry or a different key shape remains unconfigured.
- **Crypto-profile mismatch.** The emulator has six explicit webhook signature profiles plus a generic fallback. `evo_pay`'s blueprint declares RSA-SHA256 with a private key, but the fake profile for `evo_pay` is not defined, so it falls back to HMAC.
- **Statement channels.** The core seeds statement channel rows with `<code>-statement` tokens but has no `SETTLEMENT_FETCH` flow and no fetch URL. The fake `/statement` endpoint is not consumed automatically.

### 3.8 Deploy environment keys

| Key | Meaning |
| :--- | :--- |
| `FAKE_RAILS_ENABLED` | Build and deploy the tier |
| `FAKE_RAILS_ALLOW_IN_PRODUCTION` | Explicit production opt-in |
| `IS_TEST_SERVER` | Enables fake rails and synthetic seeding |
| `FAKE_RAILS_SSH_HOST` / `_PORT` / `_USER` / `_KEY_PATH` / `_SUDO_PASSWORD` | Host access |
| `FAKE_RAILS_PRIVATE_IP` | Internal address and SAN |
| `FAKE_RAILS_BACK_PORT` | Express port, default 4104 |
| `FAKE_RAILS_NGINX_PORT` | Public portal/API port, default 8444 |
| `FAKE_RAILS_SSL` / `_SSL_MODE` / `_DOMAIN` | TLS and vhost identity |
| `FAKE_RAILS_PUBLIC_BASE_URL` | Rewritten into gateway base URLs |
| `FAKE_RAILS_REMOTE_DIR` | Release and data root |
| `FAKE_RAILS_ALLOWED_CIDRS` | Firewall and service CIDR contract |
| `FAKE_RAILS_ALLOWED_HOSTS` | Scoped SSRF allowlist |
| `FAKE_RAILS_ADMIN_USER` / `_PASSWORD` | Tester login |
| `FAKE_RAILS_JWT_SECRET` / `_SEEDER_TOKEN` | Signing and seeder auth |
| `SEED_FAKE_RAILS_BLUEPRINTS` | Run `seed-fake-rails` after deploy |

`deploy/deploy.env.example` keeps `FAKE_RAILS_ENABLED="false"` by default. The example sets `FAKE_RAILS_SSL="false"` and an HTTP public base URL; enabling TLS requires staging verification.

### 3.9 Local all-in-one path

`scripts/deploy-localhost.sh` reads `deploy/deploy.env` when present, otherwise uses local defaults. It starts:

- `pg-fake-rails-back` on port 4104 with `FAKE_RAILS_ALLOW_IN_PRODUCTION=true`.
- `CORE_INBOUND_BASE_URL=http://127.0.0.1:4103/api/v1/inbound`.
- `FAKE_RAILS_DATA_DIR` under `.local/fake-rails-data` unless a deployed data directory exists.
- `pg-fake-rails-front` preview on 5104.

It then runs `seedFakeRails.ts` with `FAKE_RAILS_ALLOWED_HOSTS=127.0.0.1,localhost`.

## 4. Contracts and invariants

1. **The SSRF relaxation is triple-gated.** Environment flag, environment host list and gateway host list must all agree.
2. **The fake host never becomes a general private-address exception.** Metadata and unrelated private ranges remain blocked.
3. **Derived secrets must match on both sides.** Both implementations hash `fake-rails:<gatewayCode>:<purpose>` with the seeder token.
4. **Seeded environments are enabled and point only at the fake base URL.** The pass overwrites every existing base-url key.
5. **The synthetic seeder cannot run against real gateways.** Gate 4 rejects any non-fake host.
6. **Deployment production mode requires an explicit opt-in at both config and process level.**
7. **The fake rails host exposes only its portal/Nginx port.** Backend port stays loopback.

## 5. Data / API / config / deployment surface

- Core seeding: `seedFakeRails.ts`, `seedBlueprints.ts`.
- Core URL validation: `fakeRailsAllowlist.ts`, `ApiConsumer.ts`, `StepExecutor.ts`.
- Core seeder gate: `SeederSafetyGate.ts`, `fakeRailsBulkSyncClient.ts`.
- Deploy schema/planner: `configSchema.ts`, `hostPlanner.ts`.
- Deploy PKI/firewall: `pkiManager.ts`, `firewallConfigurator.ts`.
- Deploy pipeline/template: `deploy.ts`, `templates/nginx.fakerails.conf.tpl`.
- Checkout renderer: `EmbeddedWidgetRenderer.tsx`.
- Local stack: `scripts/deploy-localhost.sh`.

## 6. Operational usage

```bash
# Seed the fake gateway catalog in core-back
cd core-back
FAKE_RAILS_PUBLIC_BASE_URL=http://127.0.0.1:8444 \
FAKE_RAILS_SEEDER_TOKEN='0123456789abcdef0123456789abcdef' \
FAKE_RAILS_ALLOWED_HOSTS=127.0.0.1,localhost \
bun run seed-fake-rails

# Check the scoped allowlist test
bun test test/fake-rails-allowlist.test.ts

# Deploy only the fake rails role
cd deploy
bun run deploy.ts --only=fake-rails
```

- If the seeded base URL is wrong, rerun `seed-fake-rails`; it overwrites existing keys.
- If core cannot reach fake rails, check `ALLOW_FAKE_RAILS_HOSTS`, both host lists and the gateway environment's `allowed_hosts`.
- If the embedded widget does not load, inspect the checkout CSP, the renderer allowlist and `cspAdditions` before debugging the emulator.
- If the seeder blocks, read the gate name in the error; each gate has a stable prefix.

## 7. Status and deviations

### Implemented

- `seedFakeRails.ts` updates environments, widget URLs, webhook tokens and existing credential secrets.
- Deterministic HMAC secret derivation shared by both sides.
- Triple-gated SSRF allowlist with tests.
- Five synthetic-seeder safety gates.
- Deploy schema, host planning, certificate SAN, firewall rules, Nginx template and optional seeding.
- Local all-in-one script that starts and seeds the emulator.

### Partial

- Thirteen seeded core gateways versus twenty fake descriptors.
- `cbl_lypay` and `evo_pay` URL mismatches.
- Webhook token/path mismatch.
- Embedded widget blocked by CSP and renderer allowlist.
- Credential coverage only updates existing entries.
- Fake inbound requests are not verified.
- Statement channels not connected to a fetch flow.

### Missing / deferred

- Core blueprints for the seven unseeded fake rails.
- Automatic reconciliation pull from `/rails/:gateway/statement`.
- SRI generation and propagation for fake SDK scripts.
- A deployment smoke test that performs a full initiate/confirm/webhook flow through a seeded gateway.
- TLS verification of the fake rails certificate from core in the local script.

### Known bugs / risks

- **Code bug:** `cbl_lypay` and `evo_pay` cannot call their fake URLs.
- **Code bug:** default webhook URL path is invalid.
- **Code bug:** embedded widget loads are filtered out before CSP is even evaluated.
- **Security risk:** `ALLOW_FAKE_RAILS_HOSTS=true` plus a broad `FAKE_RAILS_ALLOWED_HOSTS` value weakens SSRF protection for every gateway that also lists the host. Keep the list to the fake host only.
- **Deployment risk:** the example uses HTTP; enabling HTTPS requires certificate trust in core.

## 8. Verification and tests

- `core-back/test/fake-rails-allowlist.test.ts` covers the triple gate, metadata refusal and empty-list refusal.
- `core-back/test/exhaustive/10-seeder-and-deploy/synthetic-seeder-safety-and-audit.test.ts` covers all five seeder gates, handshake failure and the 3.5-year timeline audit.
- `deploy/test/fakeRails.test.ts` covers host planning, production guard, credential requirement, port collision, synthetic-seed requirement, Arch/localhost support.
- `deploy/test/exhaustive-deploy-matrix.test.ts` covers one-, two-, five- and six-host topologies, firewall unions, PKI SANs and Nginx rendering.
- There is no test for `seedFakeRails.ts` itself, no full-flow test through a seeded core gateway, and no test that the embedded widget scripts load under the checkout CSP.

## 9. Source references

### Old design sections

- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 2.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 2.3 and 2.4.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 7.

### Code paths

- `core-back/prisma/seedFakeRails.ts`
- `core-back/prisma/seedBlueprints.ts`
- `core-back/engine/apiConsumer/fakeRailsAllowlist.ts`
- `core-back/engine/apiConsumer/ApiConsumer.ts`
- `core-back/engine/flow/StepExecutor.ts`
- `core-back/prisma/syntheticSeeder/SeederSafetyGate.ts`
- `core-back/prisma/syntheticSeeder/sync/fakeRailsBulkSyncClient.ts`
- `deploy/lib/configSchema.ts`
- `deploy/lib/hostPlanner.ts`
- `deploy/lib/pkiManager.ts`
- `deploy/deploy.ts`
- `deploy/templates/nginx.fakerails.conf.tpl`
- `checkout-front/src/components/renderers/EmbeddedWidgetRenderer.tsx`
- `scripts/deploy-localhost.sh`

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03: initial canonical part. Verified against `5a24f6f+working-tree`.

## Security hardening (2026-11-05)

Core's outbound URL compile now fails closed on an empty `allowed_hosts` (`HOST_ALLOWLIST_EMPTY`) unless `ALLOW_EMPTY_OUTBOUND_HOST_ALLOWLIST=true`, and blocks private/loopback/link-local literals unless `allowPrivateHosts`; the Fake Rails exception (three-part allowlist) is unchanged. Seed blueprints for generic `input.code`, `mpgs` and `mypay` set `timestampToleranceSec = 0` because they carry no timestamp field. In production deploys `FAKE_RAILS_ENABLED`, `IS_TEST_SERVER`, `FAKE_RAILS_ALLOW_IN_PRODUCTION=true` and the synthetic seeder are refused.

# fake-rails-back

Standalone payment-rails emulator and tester control plane. It is an optional
test/sandbox tier that lets `core-back`, the synthetic seeder and the exhaustive
rail suites exercise gateway-shaped HTTP flows without calling real switches.

This service is not a payment switch. The portal can approve payments without
money moving, forge callbacks, drop webhooks and return malformed payloads. Keep
it on an isolated test network.

## 1. Purpose and isolation

`fake-rails-back` is deliberately outside the gateway trust boundary:

- no PostgreSQL, Prisma or `pg` client;
- no `DATABASE_URL`, `KMS_MASTER_KEY` or gateway credential;
- no shared memory with `core-back`;
- its own SQLite WAL database under `FAKE_RAILS_DATA_DIR`;
- plain HTTP only; TLS is terminated by the deployment Nginx vhost.

It provides twenty rail descriptors, generated Moamalat/MPGS SDK scripts, a
single-tester login, a portal API, an SSE event stream, a chaos engine, a durable
outbound webhook queue and CSV/JSON/XLSX statement generation. `core-back` seed
integration is documented in
[`project-design/parts/06-fake-rails/03-core-integration.md`](../project-design/parts/06-fake-rails/03-core-integration.md).

## 2. Quick start

```bash
cd fake-rails-back
bun install

FAKE_RAILS_ADMIN_USER=tester_admin \
FAKE_RAILS_ADMIN_PASSWORD='Use-A-Strong-Tester-Pass-2026!' \
FAKE_RAILS_JWT_SECRET='0123456789abcdef0123456789abcdef' \
FAKE_RAILS_SEEDER_TOKEN='0123456789abcdef0123456789abcdef' \
bun run start
```

The default listener is `127.0.0.1:4104`.

```bash
curl http://127.0.0.1:4104/health
curl http://127.0.0.1:4104/hosted/health

curl -X POST http://127.0.0.1:4104/portal-api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"tester_admin","password":"Use-A-Strong-Tester-Pass-2026!"}'
```

The example tester password in `deploy/deploy.env.example`
(`ChangeMe-Strong-Tester-Pass-2026!`) is explicitly rejected by the service
guard. Replace it before enabling Fake Rails.

### Commands

| Command | Purpose |
| :--- | :--- |
| `bun run start` | Start the service once. |
| `bun run dev` | Start with Bun watch mode. |
| `bun test` | Run the backend tests. |
| `bun run typecheck` | Run `tsc --noEmit`. |

### Resetting state

Stop the process, then remove all SQLite files:

```bash
rm -f shared/data/fake-rails.sqlite shared/data/fake-rails.sqlite-wal shared/data/fake-rails.sqlite-shm
```

The schema is applied idempotently at startup. There is no migration mechanism
beyond `CREATE TABLE IF NOT EXISTS`.

## 3. Process and HTTP composition

`index.ts` exports `createApp()` and `start()`.

- Express 5, Zod 4 and `bun:sqlite`; no Redis, queue broker or database service.
- `x-powered-by` is disabled and `trust proxy` is enabled.
- The request logger records request-level metadata, not bodies or headers.
- `start()` opens the SQLite store, inserts default scenarios, wires the webhook
  dispatcher to the SSE hub, then listens on `HOST:PORT`.
- `SIGTERM`/`SIGINT` close the HTTP server and exit.

`api/index.ts` installs JSON, URL-encoded, text/XML and raw body parsers with a
raw-body capture hook. Multipart bodies are reduced to text fields by a small
RFC-7578 reader. The mounted surfaces are:

| Base path | Purpose |
| :--- | :--- |
| `/rails/:gatewayCode/*` | Emulated switch protocol endpoints. |
| `/sdk/:script` | Generated `moamalat-lightbox.js` and `mpgs-session.js`. |
| `/portal-api/*` | Tester, hosted and seeder APIs. |
| `/health` | Liveness. |
| `/hosted/health` | Hosted-page liveness. |

Errors use `{ code, message, details? }`. Zod body failures become
`400 INVALID_BODY`; unknown errors become `500 SERVER_ERROR` without a stack
trace.

## 4. Rails and protocol coverage

`engine/chaos/DefaultRailScenarios.ts` defines the twenty descriptors.
`resolveRail()` matches rail codes, gateway codes and aliases case-insensitively.

| Rail code | Gateway code | Modes | OTP length |
| :--- | :--- | :--- | ---: |
| `edfali` | `edfali` | `OTP_PULL` | 4 |
| `sadad` | `sadad` | `OTP_PULL` | 6 |
| `mobicash` | `mobicash` | `OTP_PULL`, `QR_DISPLAY` | 6 |
| `moamalat` | `moamalat` | `EMBEDDED`, `REDIRECT` | 6 |
| `ly_pay` | `cbl_lypay` | `QR_DISPLAY`, `PUSH_APPROVAL` | 6 |
| `onepay` | `onepay` | `QR_DISPLAY`, `PAY_CODE`, `OTP_PULL` | 6 |
| `tlync` | `tlync` | `REDIRECT` | 6 |
| `mypay` | `mypay` | `REDIRECT` | 6 |
| `dpay` | `dpay` | `REDIRECT`, `OTP_PULL`, `EMBEDDED` | 6 |
| `plutu` | `plutu` | `OTP_PULL`, `REDIRECT` | 6 |
| `yussor_pay` | `yussor` | `HYBRID`, `OTP_PULL`, `QR_DISPLAY`, `PAY_CODE` | 6 |
| `sahara_pay` | `sahara` | `HYBRID`, `OTP_PULL`, `QR_DISPLAY`, `PAY_CODE` | 6 |
| `masrefy_pay` | `masrefy` | `HYBRID`, `OTP_PULL`, `QR_DISPLAY`, `PAY_CODE` | 6 |
| `hawelli` | `hawelli` | `PUSH_APPROVAL`, `QR_DISPLAY`, `OTP_PULL`, `DEEP_LINK` | 6 |
| `gpay_libya` | `gpay_libya` | `PUSH_APPROVAL`, `QR_DISPLAY`, `OTP_PULL`, `DEEP_LINK` | 6 |
| `numo_pay` | `numo_pay` | `PUSH_APPROVAL`, `QR_DISPLAY`, `OTP_PULL`, `DEEP_LINK` | 6 |
| `libyana` | `libyana` | `PUSH_APPROVAL`, `QR_DISPLAY`, `OTP_PULL`, `DEEP_LINK` | 6 |
| `mpgs` | `mpgs` | `EMBEDDED`, `REDIRECT` | 6 |
| `evopay` | `evo_pay` | `QR_DISPLAY`, `PUSH_APPROVAL` | 6 |
| `neompay` | `neompay` | `HYBRID` | 6 |

### Implemented route map

| Gateway | Routes |
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
| `yussor` / `sahara` / `masrefy` | `POST /initiate`, `POST /confirm`, `GET /status/:ref`, `GET /statement` |
| `hawelli` / `gpay_libya` / `numo_pay` / `libyana` | `POST /request`, `POST /confirm`, `POST /cancel`, `GET /status/:ref`, `GET /statement` |
| `mpgs` | `POST /session`, `GET /order/:id`, `POST /order/:id/refund`, `POST /order/:id/confirm`, `GET /statement` |
| `evopay` | `POST /Payment`, `GET /Payment/:id`, `GET /statement` |
| `neompay` | `POST /payments/requests`, `POST /payments/:id/confirm`, `GET /payments/by-reference/:ref`, `POST /payments/:id/refund`, `GET /ledger-export`, `GET /statement` |

Route matching is exact after alias resolution: the method and path-segment
count must match, and `:param` matches one segment. A transaction is resolved by
gateway code plus our/provider/network reference; a new reference creates a row.

### Coverage limits

- Eight of the nine collection modes are labelled. `MANUAL` is absent. `HYBRID`
  is a label, not a distinct protocol.
- `INITIATE`, `SUBMIT`, `VERIFY` and `REFUND` are substantially implemented.
  `CANCEL` exists only for push wallets and hosted pages. `CREDENTIAL_CHECK`,
  `PRE_INITIATE`, `VOID`, `CAPTURE` and a core-driven `SETTLEMENT_FETCH` are
  missing.
- Responses use a shared gateway-shaped envelope rather than exact XML/SOAP or
  partner-specific payloads.
- Amount handling is text-only: Moamalat uses integer dirhams (`LYD * 1000`),
  LYPay/NeomPay use a 1,000 scale, and the other rails use a 100 scale.
- OTPs are deterministic: `deriveOtp(seederToken, railCode, reference, length)`.
- Inbound authorization, signatures, duplicate-reference conflicts and source-IP
  rules are not enforced.

### Route code mismatch

Two descriptors do not match their route registration:

- `ly_pay` has descriptor `gatewayCode: "cbl_lypay"`, while `qrAndPushRouter.ts`
  registers its routes under `gatewayCodes: ["ly_pay"]`.
- `evopay` has descriptor `gatewayCode: "evo_pay"`, while `qrAndPushRouter.ts`
  registers its routes under `gatewayCodes: ["evopay"]`.

The dispatcher resolves an alias and then matches on
`descriptor.gatewayCode`. Therefore the LYPay and Evo Pay route sets are
unreachable through both their rail and gateway aliases. Requests to the seeded
`/rails/cbl_lypay/*` and `/rails/evo_pay/*` paths return
`404 UNKNOWN_RAIL_ENDPOINT`. The statement router uses the same non-canonical
`ly_pay`/`evopay` keys, so those statement routes are unreachable too.

## 5. Chaos engine

The chaos model is persisted per rail in `fake_rail_scenarios`. A new transaction
rolls the configured failure chance once, samples a phase and a failure mode,
and pins both on the row. Repeated requests with the same reference reuse the
pinned fate, so multi-step flows stay coherent.

Priority order:

1. deterministic magic input for the current phase;
2. a disabled rail (`enabled=false` always yields the 503 outage path);
3. the pinned transaction fate when its phase matches;
4. normal handling.

### Failure modes

`TERMINAL_DECLINE_INSUFFICIENT_FUNDS`, `LIMIT_EXCEEDED_CUSTOMER_CEILING`,
`WRONG_OTP_RETRYABLE`, `HTTP_500_GATEWAY_FAULT`,
`TIMEOUT_HANG_ABOVE_STEP_TTL`, `SOCKET_RESET_MID_STREAM`,
`MALFORMED_OR_UNMAPPED_200_BODY`, `RATE_LIMIT_HTTP_429`,
`AMOUNT_ROUNDING_MISMATCH`, `CONFLICTING_WEBHOOK_VS_INQUIRY`.

Hard transport faults return an HTTP error or destroy the connection. Business
faults update the row and return a gateway-shaped failure. A timeout hang sleeps
`FAKE_RAILS_TIMEOUT_HANG_MS` (default 20 seconds) and returns 504.

### Magic inputs

| Input | Result |
| :--- | :--- |
| OTP `000000` or `0000` | retryable wrong OTP on `SUBMIT` |
| OTP `999999` | terminal insufficient funds |
| OTP `500500` | HTTP 500 gateway fault |
| OTP `408408` | timeout/hang |
| Phone ending `9901` | insufficient funds |
| Phone ending `9902` | customer ceiling exceeded |
| Phone ending `9905` | HTTP 500 gateway fault |
| Phone ending `9906` | timeout/hang |
| Phone ending `9907` | malformed 200 body |

Magic inputs are phase-scoped. The five phase weights (`INITIATE`, `SUBMIT`,
`VERIFY`, `WEBHOOK`, `REFUND`) and the ten failure-mode weights are persisted and
editable through the API. Latency is drawn per transaction/phase from the
configured range.

`autoApproveAsyncAfterSec` is stored but not scheduled. Async rails settle only
when a caller confirms, the hosted page approves or the tester acts.

### Presets

`healthy`, `flaky` (25 percent), `timeout_on_confirm` (100 percent submit
timeout) and `outage` (`enabled=false`). Presets can be applied to one rail or
globally.

### Webhooks

The dispatcher persists a delivery before scheduling it, resumes queued rows on
startup, and supports:

- initial delay;
- 1-5 duplicate copies;
- out-of-order `transaction.pending` two seconds after a paid event;
- corrupt-signature chance;
- retries with 1s, 2s and 4s backoff, up to three attempts;
- replay (with optional tamper), send-now and dispute.

Signature profile entries exist for DPay (timestamp dot raw body), MyPay (raw
body), LYPay (sorted key/value), Plutu (sorted values), Moamalat (sorted
key/value with hex-decoded secret) and MPGS (raw body). The profile is selected
by `transaction.gateway_code`; `cbl_lypay` and `evo_pay` therefore fall back to
the generic profile rather than the LYPay entry (and Evo Pay has no explicit
profile). Other gateways also use the generic sorted key/value HMAC-SHA256
profile. Webhook-phase chaos is not evaluated by the dispatcher; webhook
anomalies are controlled separately.

Default URL construction is currently wrong:

```text
${CORE_INBOUND_BASE_URL}/webhook/${gateway_code}/${env}/${gateway_code}-webhook
```

`core-back` expects `POST /api/v1/inbound/:gateway/:env/:pathToken`. The extra
`webhook` segment makes the literal string the `:gateway` segment, so default
deliveries do not reach the intended handler.

### Callback credentials

`CORE_INBOUND_BASE_URL` is only a base URL. The dispatcher hard-codes the final
path token as `${gateway_code}-webhook`; there is no environment variable for a
per-channel callback credential, no load of the seeded channel token, and no
verification of core-originated callbacks on the emulator side. Seeded tokens
such as `cbl-lypay-webhook` and `evo-pay-webhook` are not honoured by the
default URL. A caller can also supply `webhook_url`, which is posted without an
allowlist.

Outbound signatures are derived from `FAKE_RAILS_SEEDER_TOKEN` and the gateway
code. `seedFakeRails.ts` uses the same derivation for existing credential
entries.

## 6. Portal API

`/portal-api/*` is protected by `portalAuthGuard`:

- `/auth/login` and `/hosted/*` are public.
- `/internal/*` requires `x-fake-rails-seeder-token`.
- Everything else requires a Bearer token or `?token=` with
  `role=FAKE_RAILS_TESTER`.

| Router | Endpoints |
| :--- | :--- |
| Auth | `POST /portal-api/auth/login`, `GET /portal-api/auth/me` |
| Transactions | `GET /transactions`, `GET /transactions/stream`, `GET /transactions/summary`, `GET /transactions/:id`, `POST /transactions/:id/action`, `GET /transactions/:id/events` |
| Scenarios | `GET /scenarios`, `GET /scenarios/:railCode`, `PUT /scenarios/:railCode`, `POST /scenarios/preset/:railCode/:preset`, `POST /scenarios/global/:preset`, `POST /scenarios/reset`, `GET /scenarios/:railCode/audit` |
| Webhooks | `GET /webhooks`, `POST /webhooks/:transactionId/fire`, `POST /webhooks/:deliveryId/replay?tamper=true`, `POST /webhooks/:deliveryId/send-now`, `POST /webhooks/:transactionId/dispute` |
| Statements | `GET /statements`, `POST /statements/generate` |
| Internal | `POST /internal/seeder-handshake`, `POST /internal/bulk-seed` |
| Hosted | `GET /hosted/session/:id`, `POST /hosted/session/:id/action` |

Transaction actions are `APPROVE`, `REJECT`, `APPROVE_MISMATCH`,
`APPROVE_LATE`, `FORCE_OUTCOME` and `CANCEL`. Actions are written to
`fake_portal_audit`.

Hosted actions are `APPROVE`, `APPROVE_TAMPERED`, `DROP_WEBHOOK`, `ABANDON`,
`DECLINE` and `CANCEL`. `APPROVE_TAMPERED` changes the browser redirect while the
webhook still says `PAID`; `ABANDON` leaves the row awaiting action and sends a
paid webhook after 30 seconds. The hosted router is public because the payer is
not a tester.

The SSE stream is `GET /portal-api/transactions/stream` with a query-string JWT.
It emits `ready`, rail calls, webhook state, transaction actions, scenario
changes, statement generation, hosted actions, seeder bulk runs and webhook
replays. There is no replay cursor or per-client limit.

### Statements

`POST /portal-api/statements/generate` accepts `gatewayCode`, optional `from`/`to`,
`format` (`csv`, `json`, `xlsx`) and anomalies:

- `feeVariancePercent` with `feeVarianceAmount`;
- `omitOne`;
- `addUnrecorded`.

It filters paid/refunded rows, records metadata in `fake_statements`, and returns
a download. It does not push a file to `core-back`; core reconciliation remains
an admin upload.

## 7. SQLite store

The default database is `FAKE_RAILS_DATA_DIR/fake-rails.sqlite`. Tests can set
the undocumented `FAKE_RAILS_DB_PATH` escape hatch, including `:memory:`.

| Table | Purpose |
| :--- | :--- |
| `fake_rail_scenarios` | Per-rail chaos configuration. |
| `fake_transactions` | Emulated payment records, references, amounts and pinned fate. |
| `fake_step_events` | Raw request/response journal. |
| `fake_webhook_deliveries` | Durable webhook queue and responses. |
| `fake_statements` | Generated statement metadata. |
| `fake_portal_audit` | Tester action audit rows. |

WAL, `synchronous=NORMAL` and foreign keys are enabled. Amounts are decimal
strings, not SQLite floating-point columns. The process assumes a single writer;
horizontal scaling is not supported.

## 8. Environment

The Zod schema is `lib/env/index.ts`. It is parsed lazily on first access, and a
schema failure exits with code 1.

| Key | Default | Notes |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | `development`, `test`, `production`. |
| `HOST` / `PORT` | `127.0.0.1` / `4104` | Listener. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `FAKE_RAILS_ENABLED` | `true` | Must be true to start. |
| `FAKE_RAILS_ALLOW_IN_PRODUCTION` | `false` | Required when `NODE_ENV=production`. |
| `FAKE_RAILS_PUBLIC_BASE_URL` | `http://127.0.0.1:8444` | SDK and hosted URL base. |
| `FAKE_RAILS_DATA_DIR` | `shared/data` | SQLite parent directory. |
| `CORE_INBOUND_BASE_URL` | `http://127.0.0.1:4103/api/v1/inbound` | Default webhook base. |
| `FAKE_RAILS_ADMIN_USER` | required | 4-128 characters. |
| `FAKE_RAILS_ADMIN_PASSWORD` | required | 12-512 characters; default values rejected. |
| `FAKE_RAILS_JWT_SECRET` | required | 16-512 characters. |
| `FAKE_RAILS_SEEDER_TOKEN` | required | 16-512 characters. |
| `FAKE_RAILS_ALLOWED_CIDRS` | `127.0.0.1/32,10.0.0.0/8,192.168.0.0/16` | Deployment/firewall contract. |
| `FAKE_RAILS_WEBHOOK_TIMEOUT_MS` | `10000` | Outbound timeout, maximum 120000. |
| `FAKE_RAILS_MAX_BODY_BYTES` | `10485760` | Body limit, maximum 50 MiB. |
| `FAKE_RAILS_PORTAL_RATE_LIMIT` | `10` | Failed logins per window. |
| `FAKE_RAILS_PORTAL_RATE_WINDOW_MS` | `900000` | Login window. |

Undocumented runtime escape hatches:

- `FAKE_RAILS_DB_PATH` overrides the SQLite path (tests use `:memory:`).
- `FAKE_RAILS_TIMEOUT_HANG_MS` overrides the timeout-hang sleep, default 20000.

Startup guards:

- `FAKE_RAILS_PRODUCTION_GUARD_BLOCKED` when production lacks the opt-in.
- `FAKE_RAILS_DISABLED` when `FAKE_RAILS_ENABLED=false`.
- `FAKE_RAILS_WEAK_CREDENTIALS` for a listed default password or when the
  username and password are identical.

## 9. Security notes

- The portal login is a single username/password pair with SHA-256 digests and a
  constant-time comparison.
- The JWT is HS256, expires after 12 hours, and has no issuer, audience,
  revocation or refresh mechanism.
- Login rate limiting is in-process and resets on restart. It trusts
  `request.ip` with `trust proxy` enabled, so a misconfigured proxy chain can
  collapse or spoof client addresses.
- The service is plain HTTP. Nginx termination, the public port and the SPA are
  deployment concerns; the Bun listener has no TLS configuration.
- Rail routes do not authenticate or verify inbound signatures. Any reachable
  caller can create or mutate a transaction.
- Raw headers and bodies, including tester credentials and generated OTPs, are
  stored in `fake_step_events` without redaction.
- Hosted pages are public and can approve a transaction without a server-side
  payment. This is intentional for spoof testing and must never be reachable
  from an untrusted network.
- A caller-supplied `webhook_url` is not allowlisted. Keep the service isolated
  from internal metadata and production networks.
- SSE query-string tokens can appear in access logs and browser history.

## 10. Tests

| Suite | Coverage |
| :--- | :--- |
| `test/api.test.ts` (11) | Health, seeder, login, protected routes, OTP flow, chaos persistence, bulk seed, statement anomalies, SDK, hosted approval. |
| `test/chaos.test.ts` (7) | Descriptor count, aliases, magic triggers, deterministic fate, zero-percent health, outage, PRNG. |
| `test/crypto.test.ts` (5) | Canonicalisation, HMAC, timestamp-dot-raw-body, deterministic secret/OTP derivation. |
| `test/exhaustive/05-api-matrix/fake-rails-portal-and-chaos-api.test.ts` (30) | Auth, twenty-rail scenario CRUD, global presets, actions, webhooks, statement formats. |

Run with `bun test`. These suites use in-memory or `/tmp` SQLite and require no
PostgreSQL or Redis.

Not covered: an HTTP matrix over every route with the seeded gateway code, the
webhook URL shape, inbound auth, duplicate-reference refusal, Nginx/TLS, a
second process sharing the SQLite file, or SSE delivery.

## 11. Known gaps

### Integration bugs

- `ly_pay`/`evopay` route keys do not match descriptor gateway codes
  (`cbl_lypay`/`evo_pay`); the dispatcher matches the descriptor code, so those
  route sets and their statements are unreachable.
- The default webhook URL inserts an extra `/webhook` segment.
- The callback path token is hard-coded and does not use the seeded channel
  token; callback credentials are not configurable.
- Only thirteen core gateways are seeded. Seven descriptors (`dpay`, `plutu`,
  `masrefy`, `hawelli`, `gpay_libya`, `numo_pay`, `libyana`) have no core
  blueprint.
- Embedded Moamalat/MPGS widget loading is blocked by the checkout renderer
  allowlist and CSP; the seeder writes an empty SRI array.

### Protocol and behaviour gaps

- Inbound signature/auth, idempotency conflicts and source-IP rules are absent.
- Only `INITIATE`, `SUBMIT`, `VERIFY` and `REFUND` are substantially emulated;
  the declarative `CREDENTIAL_CHECK`, `PRE_INITIATE`, `VOID`, `CAPTURE` and
  core-driven `SETTLEMENT_FETCH` are missing.
- `autoApproveAsyncAfterSec` is never scheduled.
- Webhook-phase chaos is not consulted by the dispatcher.
- Statements are download-only and not consumed by core reconciliation.
- There is no state-machine enforcement; handlers can set any status.
- No SQLite migration mechanism, multi-instance support or SSE replay.

### Test gaps

- No test drives all twenty route sets over HTTP.
- No test asserts the webhook path, callback token, inbound authentication,
  duplicate-reference refusal or statement consistency with core.
- The Fake Rails Playwright surface suite only checks login geometry with mocked
  APIs.

## 12. Design links

Canonical design:

- [`project-design/parts/06-fake-rails/00-backend-architecture.md`](../project-design/parts/06-fake-rails/00-backend-architecture.md)
- [`project-design/parts/06-fake-rails/01-protocol-matrix.md`](../project-design/parts/06-fake-rails/01-protocol-matrix.md)
- [`project-design/parts/06-fake-rails/02-chaos-and-tester-portal.md`](../project-design/parts/06-fake-rails/02-chaos-and-tester-portal.md)
- [`project-design/parts/06-fake-rails/03-core-integration.md`](../project-design/parts/06-fake-rails/03-core-integration.md)
- [`project-design/appendices/env-and-config-matrix.md`](../project-design/appendices/env-and-config-matrix.md)

Historical reference only:

- [`design/fake_payment_rails_service_architecture.md`](../design/fake_payment_rails_service_architecture.md)

Related implementation:

- [`fake-rails-front/README.md`](../fake-rails-front/README.md)
- [`deploy/README.md`](../deploy/README.md)

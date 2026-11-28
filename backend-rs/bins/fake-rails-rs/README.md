# fake-rails-rs — Fake Payment Rails daemon (P9-T01)

Rust/ntex port of `fake-rails-back/` (the standalone Fake Payment Rails emulator). It is a
single-box, zero-install service with its own embedded SQLite store (WAL) and no dependency on the
gateway database.

- Entrypoint: `backend-rs/bins/fake-rails-rs` (`fake-rails-rs serve`).
- Contract: `design/14-rust-port/02_contracts_reference.md` §30 and the TypeScript service.
- Tracker: `backend-rs/IMPLEMENTATION_TRACKER.md` P9-T01 (not edited by this crate's agent).

## Run

```bash
cd backend-rs
cargo run -p fake-rails-rs -- serve          # PORT default 4104
cargo run -p fake-rails-rs -- db migrate     # create/upgrade the SQLite store
cargo run -p fake-rails-rs -- db reset       # delete the store (WAL/SHM too) and recreate it
```

Environment (validated before the listener starts; the process exits non-zero on failure):

| Key | Default | Notes |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | `production` requires the opt-in below |
| `HOST` / `PORT` | `127.0.0.1` / `4104` | TS default; deployments set `PORT` explicitly |
| `LOG_LEVEL` | `info` | tracing filter |
| `FAKE_RAILS_ENABLED` | `true` | `false` refuses to start |
| `FAKE_RAILS_ALLOW_IN_PRODUCTION` | `false` | required when `NODE_ENV=production` |
| `FAKE_RAILS_PUBLIC_BASE_URL` | `http://127.0.0.1:8444` | hosted links + SDK base |
| `FAKE_RAILS_DATA_DIR` | `shared/data` | used when `FAKE_RAILS_DB_PATH` is absent |
| `FAKE_RAILS_DB_PATH` | `<DATA_DIR>/fake-rails.sqlite` | `:memory:` is supported for tests |
| `CORE_INBOUND_BASE_URL` | `http://127.0.0.1:4103/api/v1/inbound` | default webhook target host |
| `FAKE_RAILS_ADMIN_USER` / `FAKE_RAILS_ADMIN_PASSWORD` | — | required; 4–128 / 12–512 chars |
| `FAKE_RAILS_JWT_SECRET` | — | required; 32–512 chars, non-placeholder, differs from the seeder token |
| `FAKE_RAILS_SEEDER_TOKEN` | — | required; 32–512 chars, non-placeholder |
| `FAKE_RAILS_CONTROL_TOKEN` | unset | when set, `/control/*` needs `x-fake-rails-control-token`; production refuses an unset token |
| `FAKE_RAILS_TRUST_PROXY` | `loopback` | parsed for config parity; the login limiter keys on the real peer |
| `FAKE_RAILS_PORTAL_ACCOUNT_LOCKOUT` | `5` | per-account failures before 429 |
| `FAKE_RAILS_ALLOWED_CIDRS` | `127.0.0.1/32,10.0.0.0/8,192.168.0.0/16` | real TCP peer allowlist (IPv4 + IPv6, IPv4-mapped unwrap) |
| `FAKE_RAILS_WEBHOOK_ALLOWED_HOSTS` | empty | extra `host` or `host:port` webhook targets (SSRF allowlist) |
| `FAKE_RAILS_WEBHOOK_TIMEOUT_MS` | `10000` | outbound delivery timeout |
| `FAKE_RAILS_MAX_BODY_BYTES` | `10485760` | request body cap |
| `FAKE_RAILS_PORTAL_RATE_LIMIT` / `..._WINDOW_MS` | `10` / `900000` | failed logins per source address |
| `FAKE_RAILS_TIMEOUT_HANG_MS` | `20000` | `TIMEOUT_HANG_ABOVE_STEP_TTL` fault delay |
| `FAKE_RAILS_TIMEZONE` | `Africa/Tripoli` | business date (fixed UTC+2; see deviations) |
| `FAKE_RAILS_AUTO_APPROVE_INTERVAL_MS` | `1000` | async-rail auto-approval loop |
| `APP_RELEASE` / `APP_COMMIT` | empty | echoed by `/health` |

Weak/placeholder secrets are rejected (same word/pattern/entropy rules as the TS service),
`JWT_SECRET == SEEDER_TOKEN` is refused and the tester username must differ from the password.

## Routes

### Health and SDK

- `GET /health` → `{"status":"ok","service":"fake-rails-back","release":…,"commit":…}`
- `GET /hosted/health` → `{"ok":true,"service":"fake-rails-hosted"}`
- `GET /sdk` → `{"scripts":[{"name","sri"}]}` (SRI is `sha384-<base64>` of the generated script)
- `GET /sdk/moamalat-lightbox.js`, `GET /sdk/mpgs-session.js`

### Rail protocol — `/rails/{gatewayCode}/…`

Gateway aliases: `lypay`/`ly_pay`/`cbl_lypay`, `gpay`/`gpay_libya`, `numo`/`numo_pay`,
`yussor`/`yussor_pay`, `sahara`/`sahara_pay`, `masrefy`/`masrefy_pay`,
`moamalat_card`/`moamalat`, `evopay`/`evo_pay`, `neompay_wallet`/`neompay`.

| Rail(s) | Endpoints |
| :--- | :--- |
| `edfali`, `sadad` | `POST /verify` (INITIATE), `POST /confirm` (SUBMIT), `GET /status/:ref` (VERIFY) |
| `mobicash` | `POST /open`, `POST /confirm`, `POST /qr`, `GET /status/:ref` |
| `onepay` | `POST /qr`, `POST /paycode`, `POST /verify`, `POST /confirm`, `GET /status/:ref` |
| `plutu` | `POST /edfali/verify`, `/edfali/confirm`, `/sadad/verify`, `/sadad/confirm`, `POST /tlync/create` |
| `moamalat` | `POST /FilterTransactions` (VERIFY), `POST /refund` (REFUND), `POST /confirm` |
| `mpgs` | `POST /session`, `GET /order/:id`, `POST /order/:id/refund`, `POST /order/:id/confirm` |
| `tlync` | `POST /payment/create`, `POST /receipt/transaction`, `POST /refund` |
| `mypay` | `POST /auth/token`, `POST /payment/create` |
| `dpay` | `POST /sessions/open`, `POST /sessions/:id/verify`, `GET /sessions/:id`, `POST /refund` |
| `ly_pay` / `cbl_lypay` | `POST /api/v1/auth/token`, `POST /api/v1/payments/funds-transfers`, `POST /api/v1/payments/funds-transfers/:uuid/confirm`, `GET /api/v1/payments/funds-transfers/enquiry` |
| `yussor`, `sahara`, `masrefy` | `POST /initiate`, `POST /confirm`, `GET /status/:ref` |
| `hawelli`, `gpay_libya`, `numo_pay`, `libyana` | `POST /request`, `POST /confirm`, `POST /cancel`, `GET /status/:ref` |
| `neompay` | `POST /payments/requests`, `POST /payments/:id/confirm`, `GET /payments/by-reference/:ref`, `POST /payments/:id/refund`, `GET /ledger-export` |
| `evopay` / `evo_pay` | `POST /Payment`, `GET /Payment/:id` |
| all 22 gateway codes above | `GET /statement?from=&to=&format=csv\|json` |

Every rail request resolves or creates its `fake_transactions` row (by path param, body reference
keys — including `invoice_no` and `merchantRef` — `Idempotency-Key`, or `X-Request-Id`), normalises
the amount per gateway (`moamalat` integer dirhams; `ly_pay`/`neompay`; default 2-dp wire), masks
the customer, records a step event, broadcasts `rail.request` on SSE and applies chaos.

Collection modes are expressed through the endpoints above: OTP pull (`verify`/`confirm`),
redirect/embedded (`payment/create`, `sessions/open`, `session`, `Payment`), QR/deep-link/pay-code
(`qr`, `initiate`, `request` → `qr_payload`, `deep_link`, `pay_code`), push approval (confirm /
portal action), hybrid (`initiate`/`confirm`) and NeomPay wallet (`payments/requests`).

### Tester portal — `/portal-api/…`

Public: `POST /auth/login`; `GET|POST /hosted/*`. `/internal/*` requires
`x-fake-rails-seeder-token`. `/transactions/stream` accepts a single-use `?ticket=`.

- `GET /auth/me`
- `GET /transactions?railCode=&gatewayCode=&status=&reference=&from=&to=&limit=&offset=`
- `POST /transactions/stream-ticket`, `GET /transactions/stream` (SSE: `ready` frame, events, 15 s
  ping comments), `GET /transactions/summary`, `GET /transactions/:id`,
  `POST /transactions/:id/action` (`APPROVE`, `REJECT`, `APPROVE_MISMATCH`, `APPROVE_LATE`,
  `FORCE_OUTCOME`, `CANCEL`), `GET /transactions/:id/events`
- `GET /scenarios`, `GET|PUT /scenarios/:rail`, `POST /scenarios/preset/:rail/:preset`,
  `POST /scenarios/reset`, `POST /scenarios/global/:preset`, `GET /scenarios/:rail/audit`
  (presets: `healthy`, `flaky`, `timeout_on_confirm`, `outage`)
- `GET /webhooks?transactionId=`, `POST /webhooks/:transactionId/fire`,
  `POST /webhooks/:deliveryId/replay?tamper=true`, `POST /webhooks/:deliveryId/send-now`,
  `POST /webhooks/:transactionId/dispute`
- `GET /statements`, `POST /statements/generate` (`csv`, `json`, `xlsx`; anomalies
  `feeVariancePercent`, `feeVarianceAmount`, `omitOne`, `addUnrecorded`)
- `GET|POST /accounts`, `POST /accounts/reset`, `GET|PATCH /accounts/:id`,
  `GET /accounts/:id/movements`, `GET /accounts/:id/holds`, `POST /accounts/:id/restore`
- `GET /checkout-helper/:reference`, `POST /checkout-helper/:reference/simulate-action`
  (`APPROVE_PUSH_OR_QR`, `DECLINE_PUSH_OR_QR`, `APPROVE_WITH_VARIANCE`, `FIRE_WEBHOOK_NOW`,
  `REPLAY_DUPLICATE_WEBHOOK`, `FIRE_TAMPERED_WEBHOOK`)
- `GET /clearing/pools`, `POST /clearing/generate-statement`, `POST /clearing/mark-included`,
  `POST /clearing/settle`
- `GET /hosted/session/:id` (public projection: no `expected_otp`, no `webhook_url`, plus a 15-min
  transaction-bound `action_token`), `POST /hosted/session/:id/action` (requires
  `x-hosted-action-token`: `APPROVE`, `APPROVE_TAMPERED`, `DROP_WEBHOOK`, `ABANDON`, `DECLINE`,
  `CANCEL`)
- `POST /internal/seeder-handshake`, `POST /internal/bulk-seed` (JSON batch, NDJSON text body, or a
  bare array; ≤ 5000 transactions + ≤ 5000 events; `webhook_url` is allowlist-checked)

### Sandbox control plane — `/control/…`

Service-to-service surface used by `pg-core-sandbox`; shares the accounts, transactions, scenarios,
webhooks and statements routes with the portal, without a tester JWT. It requires
`x-fake-rails-control-token` when `FAKE_RAILS_CONTROL_TOKEN` is set; in production an unset token is
`503 FAKE_RAILS_CONTROL_DISABLED` (development/test allow it unset, as TS does).

## Chaos, magic values and webhooks

- Deterministic mulberry32 PRNG (FNV-1a over UTF-16 units) and the ten failure modes with the TS
  phase/mode weights; a fate is rolled once per new transaction and pinned on its row, then magic
  inputs win, then the pinned fate, then the outage switch.
- Magic OTPs `0000`/`000000` (wrong OTP), `999999` (insufficient funds), `500500` (HTTP 500),
  `408408` (20 s hang / 504 by default); magic phone suffixes `9901`, `9902`, `9905`, `9906`,
  `9907`.
- Faults: 20 s hang then 504, 500/503 outage, 429, malformed 200, socket-reset (499 + close),
  amount rounding mismatch (+0.0500 settled), conflicting webhook vs inquiry (PAID + FAILED
  inquiry override).
- Webhook signatures: `dpay` (timestamp.raw body), `mypay` (raw body), `ly_pay`
  (sorted key/value, upper hex), `plutu` (sorted values, upper hex), `moamalat` (sorted key/value,
  hex secret, `SecureHash`), `mpgs` (raw body, `X-Notification-Secret`), default
  `X-Fake-Rails-Signature`. Delays, duplicates, out-of-order pending, corrupt signatures and the
  1 s/2 s/4 s retry backoff are reproduced. Targets are allowlisted at create **and** send time.
- Stateful accounts: 5 personas × 20 rails (rich 50,000 / standard 1,500 / low 5 / near-limit 50 /
  frozen), INITIATE hold, CAPTURE on PAID, RELEASE on FAILED/CANCELLED, REFUND capped at the
  captured total, per-merchant copies, clearing pools and statements.

## Persistence

`src/schema.sql` (embedded, 13 tables) with `journal_mode=WAL`, `synchronous=NORMAL`,
`foreign_keys=ON`, `busy_timeout=5000`. The connection is a single `Mutex<Connection>` (the TS Bun
SQLite driver is also a single connection). `fake_transactions`/`fake_step_events` keep the TS
column names; UUIDv7 ids and RFC 3339 millisecond timestamps match `uuidv7()`/`nowIso()`.

## Tests

```bash
cd backend-rs
cargo fmt -p fake-rails-rs -- --check
cargo clippy -p fake-rails-rs --all-targets -- -D warnings
cargo test -p fake-rails-rs
```

- 55 unit tests (PRNG/chaos/magic values, crypto canonicalisation/sign/verify/JWT, CIDR matcher,
  money/masking, schema migrations, accounts ledger/capture/refund/clearing, webhook allowlist and
  duplicate/out-of-order dispatch, statements CSV/XLSX, SDK SRI, SSE frames, auto-approval loop).
- 31 ntex `init_service` integration tests with a fresh `:memory:` SQLite store (plus one real
  temp-file restart test): health, auth/lockout/tickets, seeder handshake + JSON/NDJSON bulk seed,
  Edfali/Sadad OTP flows (incl. `invoice_no`, X-PG-Environment LIVE, wrong OTP, static account OTP,
  magic faults), 20-rail chaos catalogue/presets, transaction actions, webhooks
  duplicate/tamper/dispute, SSRF allowlist, statements CSV/JSON/XLSX, hosted token flow, accounts
  CRUD/restore/reset, clearing, checkout-helper simulation, control token, redirect/embedded/push/
  wallet protocol shapes, unknown gateway/endpoint errors and SQLite restart persistence.

## Implemented vs not implemented

Implemented: the 20 rail descriptors/aliases; OTP pull (Edfali + Sadad first, MobiCash/OnePay/Plutu/
DPay variants); redirect (T-LYNC, MyPay, DPay, Plutu); embedded/lightbox (Moamalat, MPGS); QR
display, pay-code and deep-link initiation; push-approval simulation; hybrid; NeomPay wallet and
ledger export; per-gateway statements; the full portal/control/seeder APIs; SSE; the SDK scripts;
stateful accounts/clearing; magic values; webhook anomalies; CIDR allowlist; the SQLite schema; the
XLSX writer.

Not implemented / deviations from the TS service:

1. **HTTPS webhook delivery**: the outbound client is plain HTTP/1.1 over `tokio::net::TcpStream`
   (no TLS client dependency is allowed). `https://` targets are queued and then failed with a
   clear "unsupported webhook scheme" error; they are never silently marked sent.
2. **`RSA_SHA256` signing** returns `501 UNSUPPORTED_SIGNING_ALGORITHM`. No webhook profile uses it;
   HMAC-SHA256/SHA512/SHA256 are implemented.
3. **`SOCKET_RESET_MID_STREAM`** cannot destroy the socket from the router, so it returns the same
   499 status with `Connection: close` and an empty body instead of a TCP RST.
4. **SSE transport** is a real streamed `text/event-stream` (ready frame, events, 15 s pings). The
   integration suite asserts the headers and single-use ticket without consuming the endless body;
   the frame bytes and client bookkeeping are unit-tested.
5. **`FAKE_RAILS_TIMEZONE`** only the `Africa/Tripoli` fixed UTC+2 business date is applied (no DST
   since 2013). Arbitrary IANA zones are not loaded.
6. **Trusted proxy**: `FAKE_RAILS_TRUST_PROXY` is parsed but the login limiter keys on the real peer
   address instead of `X-Forwarded-For` (stricter; the peer allowlist is never spoofable).
7. **Port default** follows TS: 4104.
8. **Validation details** carry `{path,message}` only; the Zod issue `code` is not faked.
9. **Legacy v1 account table rebuild**: an old store whose `fake_accounts` still has the v1
   table-level `UNIQUE(rail_code, identifier)` is not rebuilt into the partial unique indexes;
   fresh stores and TS v2 stores (which already have the partial indexes) work. Columns added by
   later TS versions are migrated idempotently.
10. **XLSX numeric cells** are inline strings (values are byte-identical text, not numeric cells);
    the ZIP/OOXML parts open in Excel/LibreOffice.
11. **Push notifications/payer device apps** are simulated (portal/hosted actions); the emulator
    emits `deep_link`, `qr_payload` and `pay_code` but does not run a real push channel (TS is the
    same; the payer UI lives in `fake-rails-front`).
12. **`sseClients`** is omitted from `/transactions/summary` (TS serialises `undefined`, which JSON
    drops) rather than emitted as `null`.
13. **Multipart parsing** keeps the TS minimal text-part parser (no file parts).

## Crate layout

| File | Port of |
| :--- | :--- |
| `config.rs` | `lib/env/index.ts` (+ `weakSecretReason`) |
| `crypto.rs` | `engine/crypto/FakeCryptoSigner.ts`, `lib/jwt.ts` |
| `chaos.rs` | `engine/chaos/{DefaultRailScenarios,ChaosEvaluator,prng,scenarioStore}.ts` |
| `db.rs` + `schema.sql` | `engine/db/index.ts` + `schema.sql` |
| `accounts.rs` | `engine/accounts/AccountLedgerService.ts` |
| `webhook.rs` | `engine/webhooks/WebhookDispatcher.ts`, `lib/webhookTarget.ts` |
| `rails.rs` | `api/rails/**` |
| `portal.rs` | `api/portal/**`, `api/control/index.ts` |
| `sdk.rs` | `api/sdk/**` |
| `statements.rs` | `api/portal/statements.ts`, `engine/statements/xlsx.ts` |
| `events.rs` | `api/portal/eventHub.ts` |
| `automation.rs` | `engine/chaos/AutoApprovalScheduler.ts` + hold sweeper |
| `http.rs` / `main.rs` | `api/index.ts`, `index.ts`, `lib/security/index.ts` |

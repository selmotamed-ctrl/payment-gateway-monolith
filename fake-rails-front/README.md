# fake-rails-front

Tester portal and hosted-checkout simulator for the optional Fake Payment Rails
tier. It is a Vue 3 + Vuetify 3 + TSX SPA built with Vite.

This is a developer/test surface, not a payer product. It can approve a payment
without money moving, forge webhook signatures, drop callbacks, show raw wire
bodies and generate anomalous statements.

## 1. What it does

The SPA has two roles:

1. A single-tester control room for the emulator: live feed, transaction
   inspection, chaos controls, webhook composition and statement generation.
2. Public hosted pages that emulate an upstream redirect checkout and an
   embedded Moamalat/MPGS widget.

It talks to `fake-rails-back` through the same origin. In development, Vite
proxies `/portal-api`, `/rails`, `/sdk` and `/hosted` to the backend; in a
deployment, the Fake Rails Nginx vhost proxies those paths and serves the built
`dist`.

## 2. Pages and routes

`src/router/index.ts` uses HTML5 history mode.

| Route | Page | Purpose |
| :--- | :--- | :--- |
| `/` | redirect | Sends the browser to `/dashboard`. |
| `/login` | `pages/login/index.tsx` | Single tester login. |
| `/dashboard` | `pages/dashboard/index.tsx` | KPI strip, live wire feed and pending actions. |
| `/transactions` | `pages/transactions/index.tsx` | Filter by reference/status, inspect a transaction, compose a webhook. |
| `/chaos-matrix` | `pages/chaos-matrix/index.tsx` | Per-rail chaos cards and global presets. |
| `/statements` | `pages/statements/index.tsx` | Generate and download CSV/JSON/XLSX statements with anomalies. |
| `/hosted/redirect/:sessionId` | `pages/hosted/redirect/[sessionId].tsx` | Interactive hosted redirect checkout. |
| `/hosted/widget-frame` | `pages/hosted/widget-frame.tsx` | Moamalat/MPGS iframe content. |

The router guard sends unauthenticated non-hosted routes to
`/login?redirect=<path>`. Hosted routes and `/login` are public.

The deployment must serve `index.html` for unknown history-mode paths and proxy
the four API prefixes to the backend.

## 3. Login and session

- Username is prefilled as `tester_admin`; the password is empty.
- `POST /portal-api/auth/login` returns a 12-hour HS256 JWT and a display user.
- The token is stored in `localStorage` under `fake-rails-token`; the user is
  stored under `fake-rails-user`.
- `utils/api.ts` attaches `Authorization: Bearer <token>`.
- A `401` clears the session and redirects to `/login`, except under `/hosted`.
- The SSE feed uses `?token=<jwt>` because `EventSource` cannot set headers.

The portal shell has four navigation links, an environment badge (`SANDBOX` or
`PRODUCTION TEST SERVER`) and logout. It is English-only and uses the fixed
portal theme; it does not use the admin/merchant i18n catalogues.

## 4. Dashboard

`pages/dashboard/index.tsx` loads `GET /portal-api/transactions/summary` and
shows:

- total, paid, awaiting-customer and failed/cancelled counts;
- a `LiveTransactionFeed` over `GET /portal-api/transactions/stream`;
- up to 50 pending `INITIATED`/`AWAITING_ACTION` transactions with the expected
  OTP and quick actions:
  - Approve;
  - Approve amount mismatch;
  - Approve late;
  - Reject.

The feed listens to `ready`, `rail.request`, `webhook.sent`, `webhook.failed`
and `transaction.action`. It is process-local and has no replay cursor; a
reconnect loses events emitted while disconnected.

## 5. Transactions and wire inspector

`pages/transactions/index.tsx` filters by reference and status and opens two
components:

### Wire inspector

`components/WireInspectorDrawer.tsx` loads
`GET /portal-api/transactions/:id` and shows:

- our reference, provider reference, rail, status and amount;
- expected OTP and pinned failure phase/mode;
- step events with method/path, response status, injected fault and the first
  400 characters of the raw request and response;
- webhook deliveries with state, signature-valid flag and response status.

It does not show the full header set, the complete raw body, the canonical
string used for HMAC, or the signature recipe. The backend stores those raw
values, but this drawer is deliberately compact.

### Webhook composer

`components/WebhookComposerModal.tsx` fires
`POST /portal-api/webhooks/:transactionId/fire` with:

- event (`payment.paid`, `payment.failed`, `payment.refunded`,
  `transaction.pending`, `DISPUTE_OPENED`);
- delay in seconds;
- duplicate count;
- forged-signature switch (100 percent corrupt chance);
- PENDING-after-PAID switch.

It can also open a dispute (`POST /portal-api/webhooks/:transactionId/dispute`).
Replay and send-now exist only on the portal API, not in this UI.

## 6. Chaos controls

`pages/chaos-matrix/index.tsx` loads `GET /portal-api/scenarios`, renders one
`RailChaosCard` per descriptor and offers global presets:

- Reset all rails (`healthy`);
- National switch instability (`flaky`, 25 percent);
- Timeout on confirm;
- Full outage.

Each card saves `PUT /portal-api/scenarios/:railCode` and can apply per-rail
presets (`healthy`, `flaky`, `timeout_on_confirm`, `outage`).

The card exposes:

- enabled/outage state;
- overall failure chance;
- latency minimum and maximum;
- one primary failure mode (sets that mode to weight 100 and all others to 0);
- duplicate webhooks (3 copies when enabled, otherwise 1);
- out-of-order PENDING after PAID;
- corrupt-signature chance.

The full `phaseBreakdown`, individual failure-mode weights, webhook delay and
`autoApproveAsyncAfterSec` are not edited in this UI. The save request carries
the existing phase/mode objects through, so raw API calls are still required for
fine-grained weights. The backend never schedules async auto-approval.

## 7. Hosted flows

### Redirect checkout

`/hosted/redirect/:sessionId` loads the public
`GET /portal-api/hosted/session/:id`. It displays the rail name, merchant
reference, amount, currency and status, then offers test actions:

| Action | Server effect | Browser effect |
| :--- | :--- | :--- |
| Approve & redirect | `PAID` plus paid webhook | Redirects to `return_url`. |
| Approve with tampered return URL | `PAID` plus paid webhook | Redirects with `status=failed&amount=0.01`. |
| Browser return only, drop webhook | Leaves `AWAITING_ACTION` | Redirects to `return_url`. |
| Close tab / abandon | Leaves `AWAITING_ACTION`, sends paid webhook after 30 seconds | Redirects to `return_url`. |
| Decline | `FAILED` plus failure webhook | Redirects to `cancel_url`. |
| Customer cancel | `CANCELLED` | Redirects to `cancel_url`. |

These actions are public by design because the payer is not a tester.

### Embedded widget frame

`/hosted/widget-frame` reads `MerchantReference`/`merchant_reference`/
`reference`/`our_reference`/`merchantTransInfo`, `AmountTrxn`/`amount` and
`rail` from the query string. It emulates a sandbox card page and posts:

- `fake-rails:complete` (with `PAID`);
- `fake-rails:error`;
- `fake-rails:cancel`.

"Complete card payment" calls the hosted approve action when a reference is
present. "Spoof browser callback without server payment" deliberately posts a
success without changing server state, so the checkout spoof tests can run. The
frame posts to `window.parent` with `targetOrigin="*"`.

The generated `/sdk/moamalat-lightbox.js` and `/sdk/mpgs-session.js` scripts open
this frame. Checkout's renderer allowlist and CSP currently block the fake SDK
origin, so the embedded flow is not usable end to end in the real checkout.

## 8. Statements

`pages/statements/index.tsx` posts to
`POST /portal-api/statements/generate` and downloads the result:

- gateway selector (the UI lists the descriptor URLs `ly_pay` and `evopay`, not
  the seeded core codes `cbl_lypay` and `evo_pay`);
- date window;
- CSV, XLSX or JSON;
- fee variance percentage with a fixed +0.150 LYD adjustment;
- omit one line;
- add one unrecorded line.

The recent-statements table reads `GET /portal-api/statements`. Generation is
download-only; it does not push a statement into core reconciliation.

## 9. Environment and build

The only frontend build/runtime input is:

| Key | Default | Purpose |
| :--- | :--- | :--- |
| `VITE_FAKE_RAILS_API` | `http://127.0.0.1:4104` | Dev-server proxy target. |

`vite.config.ts` also proxies `/portal-api`, `/rails`, `/sdk` and `/hosted`.
The dev server listens on port `5104`. The build has no runtime-config file; a
change to the API target requires a rebuild. In deployment the app is served by
the Fake Rails Nginx vhost, which proxies to `FAKE_RAILS_BACK_PORT`.

Commands:

```bash
cd fake-rails-front
bun install
bun run dev        # Vite dev server on :5104
bun run build      # production dist/
bun run preview    # preview the build
bun run type-check # vue-tsc --build
```

The deployment engine builds this SPA when `FAKE_RAILS_ENABLED=true` and copies
`dist` into the release.

## 10. Tests

There is no frontend unit-test script or component test suite in this workspace.
Coverage comes from:

- `tests/e2e/exhaustive/exhaustive-fake-rails-surface.spec.ts`, which visits
  `/login` across three viewports, two locales and two themes, mocks every portal
  API and asserts shell geometry, no `#app` transform and no horizontal
  overflow;
- the backend suites in `fake-rails-back/test/**`, which exercise the portal API
  behind these pages.

The Playwright suite does not exercise the dashboard, live SSE feed, chaos
matrix, transaction inspector, statements or hosted pages.

## 11. Known gaps

- The only e2e coverage is login geometry with mocked APIs; there is no real
  backend/frontend journey suite.
- No i18n/Arabic catalogue or theme switcher; the portal is fixed English and
  fixed theme.
- No runtime configuration; `VITE_FAKE_RAILS_API` is baked at build time.
- The chaos UI does not expose per-phase weights, per-mode weights, webhook
  delay, auto-approval or the full scenario object. Those require the raw API.
- Webhook replay and send-now are API-only; the UI can fire and dispute.
- The wire inspector truncates raw bodies and does not show the canonical
  signing string or signature recipe.
- The statement gateway options use `ly_pay`/`evopay` while seeded core
  gateways use `cbl_lypay`/`evo_pay`; generated statements for those core codes
  will not match the routes/seed data.
- Hosted pages are public and can approve without payment. The widget frame
  posts to `*` and the portal approves spoofed callbacks by design.
- The SSE stream loses events on reconnect and carries the JWT in the query
  string.
- The embedded widget cannot load under the checkout CSP/renderer allowlist, and
  the seeded SRI array is empty.
- The SPA has no frontend test runner, no visual regression suite and no
  accessibility gate.

## 12. Design links

Canonical design:

- [`project-design/parts/06-fake-rails/02-chaos-and-tester-portal.md`](../project-design/parts/06-fake-rails/02-chaos-and-tester-portal.md)
- [`project-design/parts/06-fake-rails/00-backend-architecture.md`](../project-design/parts/06-fake-rails/00-backend-architecture.md)
- [`project-design/parts/06-fake-rails/03-core-integration.md`](../project-design/parts/06-fake-rails/03-core-integration.md)
- [`project-design/appendices/env-and-config-matrix.md`](../project-design/appendices/env-and-config-matrix.md)

Historical reference only:

- [`design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md`](../design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md)

Related implementation:

- [`fake-rails-back/README.md`](../fake-rails-back/README.md)
- [`deploy/README.md`](../deploy/README.md)

## Security notes (2026-11-05)

The postMessage target is `VITE_CHECKOUT_ORIGIN` (otherwise the embedding parent's origin, never `*`) and `redirect_url` must be http(s) without credentials. The SSE token is still in the query string and `/hosted/*` is still public with no token on the action POST (open gap).

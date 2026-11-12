---
id: checkout-ui.flow
title: Checkout Payer Flow
status: partial
confidence: high
last_verified: 2026-11-09
verified_against: 5a24f6f+working-tree
code:
  - checkout-front/src/router/index.ts
  - checkout-front/src/layouts/checkout.tsx
  - checkout-front/src/utils/theme/index.ts
  - checkout-front/src/state/theme.ts
  - checkout-front/src/components/ThemeMenu/index.tsx
  - checkout-front/src/pages/pay/[linkKey]/index.tsx
  - checkout-front/src/components/rail-cards/index.tsx
  - checkout-front/src/components/rail-fields/index.tsx
  - checkout-front/src/components/renderers/**
  - checkout-front/src/utils/zReady.ts
  - checkout-front/src/utils/redirect.ts
  - checkout-front/src/constants/urlsMap/index.ts
design_sources:
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md
  - design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md
  - design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md
tests:
  - tests/e2e/checkout/pay.spec.ts
  - tests/e2e/checkout/a11y.spec.ts
  - tests/unit/checkout-redirect.test.ts
  - tests/e2e/exhaustive/exhaustive-checkout-surface.spec.ts
  - tests/unit/frontend-security-checkout.test.ts
gaps:
  - The checkout NotFound page links to a Dashboard route that does not exist in the checkout SPA, so the 404 recovery button loops back to the catch-all.
  - The `SUMMARY` phase is declared but never rendered as a distinct state; a successful load goes directly to `FORM`.
  - The status stream handles both named and default SSE frames and falls back to capped-backoff polling; a broken stream is not resumable.
  - `PushOrTransferRenderer` accepts an `onCancel` prop but does not render a cancel control.
  - Embedded scripts require SRI for external https providers; the loopback Fake Rails emulator is exempt because its script is dynamic.
  - The page has no dedicated home route; `/` redirects to the 404 page.
---

# Checkout Payer Flow

## 1. Purpose and scope

This part owns the public payer experience in `checkout-front`:

- The `/pay/:linkKey` page and its phase machine.
- Rail selection, field rendering, validation and client-action renderers.
- Attempt initiation, confirmation, resend, cancellation and client-event forwarding.
- SSE status consumption, amount breakdown, receipt and return-to-merchant behavior.
- The checkout 404 surface.

It does not own `checkout-back`, the core attempt engine, gateway protocols, or the checkout help content. It also does not claim that browser return/callback signals are trusted; the core only trusts server-verified channels.

## 2. Design intent (extracted and synthesized from ./design)

The checkout is deliberately narrow and zero-trust:

1. **The server owns the amount.** The SPA never sends `amount` or `currency` on initiate/confirm; `core-back` resolves both from the payment link.
2. **The payer sees one focused column.** The layout is centered on desktop and top-aligned on small screens.
3. **Rail selection is catalog-driven.** Visible rails, names, collection modes and fields come from the link summary.
4. **The rail's client action determines the next screen.** OTP form, redirect, embedded widget, QR/code, or push/transfer.
5. **The payer does not judge success.** Browser redirects and widget callbacks are hints; the authoritative status arrives through the server/SSE and core verification.
6. **Money is displayed as decimal strings.** The page never computes totals with floating point.
7. **Return is opt-in and allowlisted.** The return-to-merchant button appears only after success and only for an allowlisted redirect host.
8. **A failed link is a clear dead end.** The page shows a friendly unavailable/failed state rather than a raw error.

## 3. As-built architecture

### 3.1 Route and layout

- `/pay/:linkKey` (`Pay`) renders `pages/pay/[linkKey]/index.tsx`.
- `/` (`Home`) redirects to `NotFound`.
- `/:pathMatch(.*)*` (`NotFound`) renders the token-styled 404 page.
- `layouts/checkout.tsx` is a single `<main class="pg-checkout">` with an optional title.
- The page adds a max-width 560 px column with the merchant name, help button, three-mode theme menu (System/Light/Dark), language toggle, summary card, phase content and footer. The theme mode is persisted and resolved against `prefers-color-scheme`; `initialTheme()`/`initTheme()` apply it before mount, so the payer surface follows the OS theme and tracks OS changes live in System mode.

### 3.2 Phase machine

`type Phase = "SUMMARY" | "FORM" | "ACTION" | "CONFIRMING" | "RECEIPT" | "ERROR"`.

| Phase | Entered when | What renders |
| :--- | :--- | :--- |
| `SUMMARY` | Initial ref value | Declared but not used as a visible state; loading and load errors are separate. |
| `FORM` | `GET v1/pay/:linkKey` succeeds | Rail cards, per-rail banner, rail fields, "Pay Now". |
| `ACTION` | Initiate returns a client action | Countdown, renderer for the action kind. |
| `CONFIRMING` | Snapshot status is `VERIFYING`, `UNKNOWN` or `AUTHORIZING` | Spinner, status badge, reference, cancel. |
| `RECEIPT` | Snapshot status is `SUCCEEDED` | Payment complete, amount, reference, optional return button. |
| `ERROR` | Load failure, cancelled attempt, or terminal failure status (`FAILED`, `EXPIRED`, `CANCELLED`, `BLOCKED`) | Failure message, status, "Try Another Method". |

Loading and `loadError` are rendered outside the phase switch. A load error shows "This Payment Link Is No Longer Available" and "Cannot process this payment" in a card; it is not the router 404 page.

### 3.3 Summary and amount breakdown

`GET v1/pay/:linkKey` returns a `PayLinkSummary`:

- `linkKey`, `merchantTradeName`, optional logo/description.
- `amount`, `currency`.
- `feeBearerMode` (`MERCHANT_ABSORBS`, `PAYER_SURCHARGE`, `SPLIT`).
- `baseAmount`, `feeAmount`, `totalAmount`, `merchantAmount`.
- Optional `splitPercent`.
- `visibleRails`, optional `expiresAt`, `status`, `redirectUrl`, `allowlistedRedirectHosts`.
- Optional `supportConfig`.

The breakdown always shows the base amount and amount charged. It inserts a service-fee row only when the fee bearer is not `MERCHANT_ABSORBS`; for `SPLIT` the row label includes the split percentage. The amount charged is `totalAmount`.

`visibleRails` is computed by the backend's visible-rails resolver (merchant status, application/rail whitelist, route health/limits, credential state, amount/currency, and related predicates). The SPA does not recompute visibility.

### 3.4 Rail selection and fields

`RailCards`:

- Shows each visible rail's localized name and collection-mode pill.
- Uses a collection-mode icon.
- Selects the first rail by default after summary load.
- Resets form values and errors when the payer switches rails.

`RailFieldForm`:

- Renders every field in `rail.fields`.
- `select` uses a `VSelect`; all other input types use `VTextField`.
- PAN-sensitive fields render as password inputs.
- Labels/placeholders fall back between Arabic and English.
- Inputs use `autocomplete="off"`.

`zReady.ts` normalizes and validates:

- Arabic digits are normalized to ASCII.
- `phone` uses local `09` normalization.
- `numeric`/`otp` strip non-digit characters (numeric allows a decimal point in normalization, then validates digits with optional decimals).
- `wallet_id` expects `NP-` plus 12 digits.
- `otp` expects 4-8 digits.
- Required/min/max/regex rules from the rail field descriptor are applied.

The page validates with `schema.safeParse(normalized)` and maps the first issue per field into `formErrors`.

### 3.5 Initiate

`POST v1/pay/:linkKey/initiate` sends:

```json
{
  "railCode": "<selected rail>",
  "formData": { "<field>": "<normalized value>" },
  "idempotencyKey": "chk-<time>-<random>"
}
```

The client keeps one idempotency key per initiate intent and reuses it on retry; cancel and a rail change clear it (and the saved attempt) so the next click is a new intent. The response is `InitiateResponse` with `attemptId`, `reference`, `status`, optional `hold: true` and `clientAction`. The page stores the attempt, opens the SSE stream, starts a countdown if the action has `expires_at`, and sets phase `ACTION`.

A client-supplied `amount` or `currency` is outside this contract and is rejected by `checkout-back`/`core-back`.

### 3.6 Client-action renderers

| Action kind | Renderer | Behavior |
| :--- | :--- | :--- |
| `SHOW_OTP_FORM` | `OtpFormRenderer` | OTP input, attempt counter, resend, verify/pay; Enter submits. |
| `HTTP_REDIRECT` | `RedirectRenderer` | Auto-redirects on mount; GET query or POST form; blocks non-allowlisted hosts; manual retry button. |
| `RENDER_EMBEDDED` | `EmbeddedWidgetRenderer` | Loads allowlisted HTTPS scripts with SRI/crossOrigin, listens for postMessage callbacks, optional iframe sandbox, removes scripts on unmount. |
| `SHOW_QR_OR_CODE` | `QrOrCodeRenderer` | Renders QR data URL, optional pay code, bilingual instructions, deep link, expiry. |
| `SHOW_PUSH_OR_TRANSFER` | `PushOrTransferRenderer` | Shows destination/reference/wallet hint, instructions, optional proof upload, expiry. |

`OtpFormRenderer` limits the OTP to the action length and normalizes Arabic digits. `RedirectRenderer` requires a non-empty allowlist with no `*`, https only (http only for localhost in DEV), exact host match (`*.host` entries for subdomains) and no credentials. `EmbeddedWidgetRenderer` uses an allow-list of exact origins (https, plus loopback http for the local Fake Rails emulator), extends it with the server-configured `allowed_origins`, requires SRI for external https scripts (the loopback emulator is exempt), and uses a fail-closed postMessage bridge that also accepts script/SDK widgets without a local iframe when the origin is allowed.

### 3.7 Confirm, resend, cancel

- `confirmOtp` posts `{ otp, idempotencyKey }` to `POST .../confirm`, applies the returned snapshot, and moves to `CONFIRMING` for `VERIFYING`/`UNKNOWN`.
- `resendOtp` posts to `POST .../resend` and shows a notice; it does not reset the attempt.
- `cancelAttempt` posts to `POST .../cancel`, closes the stream, clears the initiate idempotency key/attempt id and moves to `ERROR`.
- `sendClientEvent` posts to `POST .../client-event` with `{ event, payload }`.

Client events are canonicalized through a local alias map:

- `ready`/`widget_ready`/`widget_ready_event` → `widgetEvent`.
- `closed`/`widget_closed` → `widgetEvent`.
- `complete`/`completed`/`complete_callback` → `completeCallback`.
- `error`/`error_callback`/`cancel`/`cancelled`/`cancel_callback` → `errorCallback`.
- `return`/`return_hint` → `returnHint`.

These events are hints. The core must still verify the payment through a trusted channel.

### 3.8 SSE status stream

The page listens for both the named `status` event and default `message` frames; a stream failure falls back to capped-backoff polling of the logs endpoint. A captured payment under an AML hold (`substatus: AML_HOLD`) moves to `CONFIRMING` and only shows the receipt after the compliance release settles it.

After initiate, the page creates:

```text
new EventSource("v1/pay/:linkKey/logs/:attemptId/status")
```

- `onmessage` parses `payload.attempt ?? payload`, applies the snapshot, updates client action/reference/status, and changes the phase for success, terminal failure, or confirming states.
- `onerror` closes the stream and sets it to null; the page does not reconnect or start polling.
- `onBeforeUnmount` closes the stream and clears the countdown.

`checkout-back` exposes the status route as an SSE proxy and `tests/e2e/checkout`/`tests/e2e-live` expect `text/event-stream`. The historical performance note that core SSE polls the database rather than subscribing to a transition bus is recorded in the edge/core parts; the SPA only knows the SSE contract.

The page also starts a one-second countdown from the client action's `expires_at`; it does not itself expire or cancel the server attempt.

### 3.9 Receipt and return

When the snapshot status becomes `SUCCEEDED`:

- Phase becomes `RECEIPT`.
- The stream closes.
- The page shows "Payment Receipt", a success badge, the total amount and the reference.

A "Return To Merchant" button appears only when `summary.redirectUrl` exists **and** `isAllowedRedirect(redirectUrl, allowlistedRedirectHosts)` is true. The allowlist must be non-empty; matching is exact host or subdomain. The button performs `window.location.assign`.

There is no automatic return redirect on success. The payer may remain on the receipt.

### 3.10 Error and unavailable states

- A load error shows "This Payment Link Is No Longer Available" and "Cannot process this payment".
- A terminal attempt status (`FAILED`, `EXPIRED`, `CANCELLED`, `BLOCKED`) moves to `ERROR` with the status badge and a "Try Another Method" button that returns to `FORM`.
- An `UNKNOWN`/`VERIFYING`/`AUTHORIZING` status moves to `CONFIRMING` and tells the payer not to pay again (the detailed guidance is in the help drawer).

### 3.11 404 bug

`checkout-front/src/pages/public/not-found/index.tsx` renders a 404 card with a button:

```text
<RouterLink to={{ name: "Dashboard" }}>
```

The checkout router has no `Dashboard` route. The link therefore resolves to the catch-all `NotFound` again. The intended recovery target is unclear because checkout has no home page; `/` itself redirects to `NotFound`. This is a real recovery bug, not a styling issue.

## 4. Contracts and invariants

1. **No client amount/currency.** Initiate and confirm payloads must not include `amount` or `currency`; the server rejects them.
2. **Idempotency keys are required for initiate/confirm.** The client generates one per action.
3. **The event/action contract is canonical.** Renderers consume the five `ClientAction` kinds; widget events are translated to canonical event names before posting.
4. **Browser hints are not trust.** Return URLs, redirects and widget callbacks never mark an attempt successful in the SPA.
5. **Redirect hosts must be allowlisted.** Empty allowlists deny all; `javascript:`/`data:` schemes are rejected.
6. **The SSE stream is display-only.** The server attempt state remains authoritative.
7. **Money is displayed, not calculated, as decimal strings.** The summary provides base/fee/total; the SPA does not sum floats.
8. **The receipt amount is the server total.** The page does not recompute it from the base amount.
9. **Return is opt-in.** Only an allowlisted `redirectUrl` produces a return button.
10. **Checkout is unauthenticated.** There is no payer account or session authority.

## 5. Data / API / config / deployment surface

| Operation | Endpoint |
| :--- | :--- |
| Load link summary | `GET v1/pay/:linkKey` |
| Initiate attempt | `POST v1/pay/:linkKey/initiate` |
| Attempt logs | `GET v1/pay/:linkKey/logs/:attemptId` |
| Status stream | `GET v1/pay/:linkKey/logs/:attemptId/status` (SSE) |
| Confirm OTP | `POST v1/pay/:linkKey/logs/:attemptId/confirm` |
| Resend OTP | `POST v1/pay/:linkKey/logs/:attemptId/resend` |
| Cancel | `POST v1/pay/:linkKey/logs/:attemptId/cancel` |
| Client event | `POST v1/pay/:linkKey/logs/:attemptId/client-event` |

Environment: `VITE_API_URL` (edge base), `VITE_SEND_NOT_FOUND_TRANSLATIONS`, `VITE_MY_TAILSCALE`. The SPA talks only to `checkout-back` under `/api`.

## 6. Operational usage

- Debug a stuck payer: check the attempt status badge and reference; `VERIFYING`/`UNKNOWN` means "do not pay again", not "failed".
- Debug a missing return button: confirm the link has a redirect URL and the host is in the application allowlist.
- Debug a redirect: inspect `HTTP_REDIRECT` action URL/method/form fields and the allowlist; the page does not bypass the host check.
- Debug an OTP: confirm the OTP length, attempt count and resend state; the SPA does not reveal whether the subscriber exists.
- Debug the status stream: confirm the SSE endpoint returns `text/event-stream` and the attempt id matches; the SPA does not poll after an SSE error.
- Debug a 404: do not use the recovery button until the route target is fixed; navigate manually to a valid `/pay/:linkKey`.

## 7. Status and deviations

### Implemented

- Summary load, amount breakdown, rail cards and rail-field validation.
- Initiate, OTP confirm/resend, cancel and client-event forwarding.
- Five client-action renderers with redirect/script allowlists.
- SSE status consumption and phase transitions.
- Receipt with server total and allowlisted return.
- Terminal/unavailable/error states.
- RTL/Arabic labels and responsive single-column layout.

### Partial

- `SUMMARY` is a declared but unused visible phase.
- SSE has no reconnect/backoff or polling fallback.
- Embedded widgets have a built-in provider allow-list; the server-configured `allowed_origins` extends it, so a new provider normally needs data (widget definition), not a code change.
- The 404 surface exists but has a broken recovery link.
- `PushOrTransferRenderer` has an `onCancel` prop with no rendered cancel control.

### Missing / deferred

- No dedicated checkout home/status lookup page.
- No payer-initiated receipt download/email.
- No reconnect/resume UX after a dropped SSE stream.
- No client-side handling for a late success after the page shows `ERROR` beyond a manual reload.

### Known bugs / risks

- **404 recovery bug:** the catch-all button targets a non-existent `Dashboard` route.
- **Status-stream risk:** if SSE drops, the page stops updating until reload; the payer may see `CONFIRMING` indefinitely.
- **SRI risk:** `EmbeddedWidgetRenderer` selects an SRI hash by the host allowlist index rather than the script URL index, so multiple scripts can receive the wrong hash.
- **Cancel gap:** push/transfer actions show no cancel control even though the renderer receives a callback.
- **Trust risk:** operators must not treat browser callbacks as proof; only the server-verified status is authoritative.
- **Documentation risk:** the checkout is not a general payment status portal; it is a single-link payer surface.

## 8. Verification and tests

- `tests/e2e/checkout/pay.spec.ts` renders the payer surface, checks no horizontal overflow on phone/desktop, and asserts `#app` has no transform.
- `tests/e2e/checkout/a11y.spec.ts` checks accessibility basics.
- `tests/unit/checkout-redirect.test.ts` covers empty allowlists, scheme rejection, exact/subdomain matching and wildcard behavior.
- `tests/e2e/exhaustive/exhaustive-checkout-surface.spec.ts` checks the `/pay/test-key` surface across viewports/locales/themes.
- `tests/e2e-live/live.spec.ts` exercises the live payer journey when the stack is available.

The Playwright/live suites require the running stack; the redirect unit test is pure and does not.

## 9. Source references

### Old design sections

- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` — checkout deployment/help context.
- `design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md` — collection modes, confirmation channels and trusted-success facts referenced by the guide.
- `design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md` — payer surface token/primitives intent.

### Code paths

- `checkout-front/src/router/index.ts`
- `checkout-front/src/layouts/checkout.tsx`
- `checkout-front/src/pages/pay/[linkKey]/index.tsx`
- `checkout-front/src/pages/public/not-found/index.tsx`
- `checkout-front/src/components/rail-cards/index.tsx`
- `checkout-front/src/components/rail-fields/index.tsx`
- `checkout-front/src/components/renderers/**`
- `checkout-front/src/utils/zReady.ts`
- `checkout-front/src/utils/redirect.ts`
- `checkout-front/src/constants/urlsMap/index.ts`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-09 — Added system/light/dark theme modes: persisted mode resolved against `prefers-color-scheme`, applied before mount, live OS tracking in System mode, and an explicit three-option `ThemeMenu` in the payer header. See `TRACKER.md`.
- 2026-11-03 — Initial canonical payer-flow part. Confirms the phase machine, five client-action renderers, SSE status stream, amount breakdown, receipt/return allowlist and the checkout 404 recovery bug.

## Security hardening (2026-11-05)

- **Status stream** is absolute under `/api` (`urlsMap.payStatusStream` uses `getBaseUrl`) with a capped-backoff polling fallback through `payLogs` (1.5 s up to 15 s, stopping on a terminal status).
- **Embedded widgets.** The allow-list holds exact origins (https, plus loopback http for the local Fake Rails emulator) and is extended by the server-configured `allowed_origins`; `iframe_src` gets the same check; iframe sandbox is intersected with allow-scripts/allow-forms/allow-popups; SRI is matched by index and required for external https scripts (the loopback emulator is exempt). The postMessage bridge fails closed on the origin; when this component owns an iframe, `event.source` must also match its `contentWindow`, while script/SDK widgets without a local iframe rely on the origin allow-list. Only a sanitized payload (including a nested `payload`) is forwarded.
- **Redirects:** no `*`, https only (http only for localhost in DEV), exact host match (`*.host` entries allow subdomains), no credentials.
- **Deep links:** https plus `moamalat:`, `evowallet:`, `numopay:` schemes, with `rel="noopener noreferrer"`.
- **Idempotency keys** use `crypto.randomUUID`, persisted per link in `sessionStorage`. The `attemptId` is persisted and a reload resumes from `payLogs`.
- **Errors** map to translated messages; raw server text is never shown. Dead bearer-token code was removed.
- Catalogue keys added (EN and AR): Network Error Try Again, Too Many Requests, Invalid Payment Details, Payment Attempt Expired, Payment Temporarily Unavailable. `.env.example` ships; copy to `.env`.
- Confirm sends only the OTP.

## Gap resolutions (2026-11-05)

- **XLSX and dependencies (GAP-029, RESOLVED).** `xlsx` is pinned to `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, `@types/xlsx` was dropped and the unused `@prisma/client` dependency was removed from `checkout-front/package.json`.

## Dark teleported overlays (2026-11-10)

Checkout dialogs/drawers use the shared overlay text-color rule (`color: rgb(var(--v-theme-on-surface))` on `.v-overlay__content` and `.v-navigation-drawer__content`), keeping custom modal content readable in dark mode.

## Sandbox Checkout Inspector (schema 38)

When the link summary has `env: "SANDBOX"` and the application inspector is
enabled, the payer page mounts `SandboxCheckoutInspector`. It fetches the
rail's Fake Rails accounts, auto-fills the form, adjusts balances, freezes
accounts, shows movements, reveals/auto-confirms the live OTP, and simulates
push/QR approval, decline, a variance, duplicate replay or a tampered webhook.
PIN-protected applications prompt for the inspector PIN (sent as
`x-pg-sandbox-pin`). The inspector never renders for a LIVE link; the endpoint
also refuses one server-side.

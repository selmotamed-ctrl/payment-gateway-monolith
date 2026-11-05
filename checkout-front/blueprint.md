<!-- GENERATED FILE. Edit project-design/parts/** instead. Do not hand-edit this file. -->

# checkout-front blueprint

Generated from: `checkout-ui.flow`, `checkout-ui.help`.

## Checkout Payer Flow

> Status: `partial` · Last verified: 2026-11-05

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
- The page adds a max-width 560 px column with the merchant name, help button, language toggle, summary card, phase content and footer.

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

The client generates a fresh idempotency key per initiate/confirm attempt. The response is `InitiateResponse` with `attemptId`, `reference`, `status` and `clientAction`. The page stores the attempt, opens the SSE stream, starts a countdown if the action has `expires_at`, and sets phase `ACTION`.

A client-supplied `amount` or `currency` is outside this contract and is rejected by `checkout-back`/`core-back`.

### 3.6 Client-action renderers

| Action kind | Renderer | Behavior |
| :--- | :--- | :--- |
| `SHOW_OTP_FORM` | `OtpFormRenderer` | OTP input, attempt counter, resend, verify/pay; Enter submits. |
| `HTTP_REDIRECT` | `RedirectRenderer` | Auto-redirects on mount; GET query or POST form; blocks non-allowlisted hosts; manual retry button. |
| `RENDER_EMBEDDED` | `EmbeddedWidgetRenderer` | Loads allowlisted HTTPS scripts with SRI/crossOrigin, listens for postMessage callbacks, optional iframe sandbox, removes scripts on unmount. |
| `SHOW_QR_OR_CODE` | `QrOrCodeRenderer` | Renders QR data URL, optional pay code, bilingual instructions, deep link, expiry. |
| `SHOW_PUSH_OR_TRANSFER` | `PushOrTransferRenderer` | Shows destination/reference/wallet hint, instructions, optional proof upload, expiry. |

`OtpFormRenderer` limits the OTP to the action length and normalizes Arabic digits. `RedirectRenderer` requires a non-empty allowlist with no `*`, https only (http only for localhost in DEV), exact host match (`*.host` entries for subdomains) and no credentials. `EmbeddedWidgetRenderer` uses an allow-list of bare https origins compared exactly to `new URL(src).origin`, and a fail-closed postMessage bridge (see Security hardening).

### 3.7 Confirm, resend, cancel

- `confirmOtp` posts `{ otp, idempotencyKey }` to `POST .../confirm`, applies the returned snapshot, and moves to `CONFIRMING` for `VERIFYING`/`UNKNOWN`.
- `resendOtp` posts to `POST .../resend` and shows a notice; it does not reset the attempt.
- `cancelAttempt` posts to `POST .../cancel`, closes the stream and moves to `ERROR`.
- `sendClientEvent` posts to `POST .../client-event` with `{ event, payload }`.

Client events are canonicalized through a local alias map:

- `ready`/`widget_ready`/`widget_ready_event` → `widgetEvent`.
- `closed`/`widget_closed` → `widgetEvent`.
- `complete`/`completed`/`complete_callback` → `completeCallback`.
- `error`/`error_callback`/`cancel`/`cancelled`/`cancel_callback` → `errorCallback`.
- `return`/`return_hint` → `returnHint`.

These events are hints. The core must still verify the payment through a trusted channel.

### 3.8 SSE status stream

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
- Embedded widgets depend on a hard-coded host allowlist; a new provider requires a code change.
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

- 2026-11-03 — Initial canonical payer-flow part. Confirms the phase machine, five client-action renderers, SSE status stream, amount breakdown, receipt/return allowlist and the checkout 404 recovery bug.

## Security hardening (2026-11-05)

- **Status stream** is absolute under `/api` (`urlsMap.payStatusStream` uses `getBaseUrl`) with a capped-backoff polling fallback through `payLogs` (1.5 s up to 15 s, stopping on a terminal status).
- **Embedded widgets.** The allow-list holds bare https origins compared exactly to `new URL(src).origin` (no credentials, no subdomain wildcard, test host only in non-production builds); `iframe_src` gets the same check; iframe sandbox is intersected with allow-scripts/allow-forms/allow-popups; SRI is matched by index and a script without a valid hash is rejected. The postMessage bridge fails closed: `event.origin` must be in `allowed_origins` and `event.source` must be the iframe's `contentWindow`; only a sanitized payload is forwarded.
- **Redirects:** no `*`, https only (http only for localhost in DEV), exact host match (`*.host` entries allow subdomains), no credentials.
- **Deep links:** https plus `moamalat:`, `evowallet:`, `numopay:` schemes, with `rel="noopener noreferrer"`.
- **Idempotency keys** use `crypto.randomUUID`, persisted per link in `sessionStorage`. The `attemptId` is persisted and a reload resumes from `payLogs`.
- **Errors** map to translated messages; raw server text is never shown. Dead bearer-token code was removed.
- Catalogue keys added (EN and AR): Network Error Try Again, Too Many Requests, Invalid Payment Details, Payment Attempt Expired, Payment Temporarily Unavailable. `.env.example` ships; copy to `.env`.
- Confirm sends only the OTP.

## Checkout Help Center

> Status: `partial` · Last verified: 2026-11-03

## 1. Purpose and scope

This part owns the payer-facing help center in `checkout-front`:

- The per-rail instructions banner on the payment form.
- The "Help & Support" slide-over drawer on the payer page.
- The `supportConfig` projection from the admin-managed platform setting.
- The per-rail `helpGuide` projection from the rail record.
- The state-aware guidance for in-flight, unknown, failed, expired and cancelled attempts.
- The actual hide behavior when the admin disables support.

It does not own the admin support settings page, merchant guide, admin guide, or the checkout phase machine. It documents the separation between the platform support configuration and the per-rail guides, and it records the gaps in the current authoring and visibility model.

## 2. Design intent (extracted and synthesized from ./design)

The checkout help center is data-driven rather than hard-coded:

1. **The payer never needs a second request for help.** Support details and per-rail walkthroughs travel with the payment-link summary.
2. **Help is contextual to the selected rail.** The banner and guide section explain the exact steps, prerequisites and troubleshooting for the rail the payer is using.
3. **Help is state-aware.** A `VERIFYING`/`UNKNOWN`/`FAILED`/`EXPIRED`/`CANCELLED` attempt gets a clear "do not pay again" or "safe to retry" message.
4. **Support is centrally controlled.** The admin edits one platform setting for support channels, working hours and FAQ; the change applies to all checkout links.
5. **The merchant contact is optional and separate.** The platform can show its own support channels, the merchant's contact details, both, or neither.
6. **Per-rail guides are content, not code.** The rail record carries bilingual steps/prerequisites/troubleshooting so operators can tune guidance per payment method.
7. **The payer can always copy the reference.** The drawer exposes the payment reference for support conversations.
8. **Disabling support should not break the payment flow.** It hides the contact block, not the payment or the attempt-state guidance.

## 3. As-built architecture

### 3.1 The two data sources

| Data | Source | Projection |
| :--- | :--- | :--- |
| Platform support config | `platform_settings` key `checkout.support_config` | `buildCheckoutSupportConfig` in `core-back/api/internal/checkout.ts` |
| Per-rail guide | `rails.help_guide_json` (seeded by `core-back/prisma/seedGuides.ts`) | Passed through `visibleRails[].helpGuide` in `GET v1/pay/:linkKey` |

The checkout page receives both in `PayLinkSummary.supportConfig` and `RailDescriptor.helpGuide`.

### 3.2 Support config shape

```text
SupportConfig {
  enabled: boolean
  working_hours_ar: string | null
  working_hours_en: string | null
  platform: { phone, whatsapp, email } | null
  merchant: { phone, email, tradeName } | null
  faq_items: Array<{ q_ar, a_ar, q_en, a_en }>
  channels: string[]
}
```

Projection rules in `buildCheckoutSupportConfig`:

- If the setting is absent, not an object, or `enabled !== true`, return `null`.
- If `show_platform_contact` is not false, include the platform phone/WhatsApp/email.
- If `show_merchant_contact` is not false, include the merchant phone/email/trade name from the loaded link.
- Pass through `working_hours_ar`/`working_hours_en`, FAQ items (all four fields, null-coalesced) and a flat `channels` list derived from non-empty platform channels.
- The projection deliberately excludes the setting's other fields; only the support-facing shape leaks.

The admin form defaults both `show_*` values to true and saves the `checkout.support_config` setting as a new immutable platform-setting version. The core handler writes `CHECKOUT_SUPPORT_UPDATED` and `CHECKOUT_SUPPORT_EDIT_CHECKLIST` audits. The admin page's live preview is not the actual drawer.

### 3.3 Per-rail help guide shape

```text
RailHelpGuide {
  steps_ar: string[]
  steps_en: string[]
  prerequisites_ar: string[]
  prerequisites_en: string[]
  troubleshooting_ar: Array<{ q_ar, a_ar }>
  troubleshooting_en: Array<{ q_en, a_en }>
}
```

`core-back/prisma/seedGuides.ts` defines `RAIL_HELP_GUIDES` for 14 seeded rails: `edfali`, `sadad`, `moamalat_card`, `cbl_lypay`, `lypay`, `mypay`, `tlync`, `mobicash`, `onepay`, `yussor`, `sahara`, `mpgs`, `evo_pay`, `neompay_wallet` (the comment above the map says 13, but the actual object has 14 keys). A rail without a guide returns `helpGuide: null`; the banner hides and the drawer omits the rail-guide section.

The admin portal has no rail-guide editor. Rails are seeded/updated from code and the admin Rails page manages rail catalog fields, not `helpGuideJson` content.

### 3.4 Per-rail banner

`checkout-front/src/components/help/PerRailInstructionsBanner.tsx` renders when `selectedRail.helpGuide` exists:

- A region titled "How to pay with <rail>".
- An expand/collapse button (default expanded).
- A help button that opens the drawer.
- Prerequisite pills (localized with fallback).
- Numbered step rows.
- Localized last-resort behavior: Arabic uses Arabic when present, otherwise English; English uses English when present, otherwise Arabic.

The banner is independent of `supportConfig.enabled`. Disabling support does not hide it.

### 3.5 State-aware drawer

`checkout-front/src/components/help/CheckoutHelpDrawer.tsx` is a `SlideOverDrawer` (width 440) titled "Help & Support". It composes:

1. **State guidance** for the current attempt status.
2. **Payment reference** with a copy action when a reference exists.
3. **Per-rail guide** from the selected rail's `helpGuide`.
4. **FAQ** from `supportConfig.faq_items`.
5. **Contact support** from `supportConfig.platform` and `supportConfig.merchant`.

State guidance:

| Status | Tone | Message summary |
| :--- | :--- | :--- |
| `VERIFYING` | info | The platform is verifying; do not pay again; status updates automatically. |
| `UNKNOWN` | warning | Could not confirm yet; do not pay again; wait/refresh; contact support with the reference. |
| `FAILED` | error | Attempt did not complete; try another method; if charged, contact support with the reference. |
| `EXPIRED` | warning | Payment window expired; do not use the old reference; start a new payment. |
| `CANCELLED` | warning | Payment was cancelled; if charged, contact support with the reference; otherwise start again. |
| Other | none | No state block. |

The drawer always shows the reference block when a reference exists, regardless of support configuration. The rail-guide section shows prerequisites, numbered steps and troubleshooting when a guide is present. The FAQ section renders only when there are complete localized FAQ items. The contact section renders only when `supportConfig.enabled` is true.

Contact behavior:

- Platform WhatsApp builds `https://wa.me/<digits>?text=<encoded help message>`.
- Platform phone uses `tel:` with whitespace removed.
- Platform email uses `mailto:` with a localized subject and a body containing the link key and reference.
- Merchant name/phone/email render when the merchant contact is present.
- If support is enabled but no channel and no working hours exist, the drawer shows "No contact details are available right now."
- The help message includes the link key and reference (or `N/A`).

The drawer does not close/reset the payment form. It is opened by the header help button and by the banner's help button.

### 3.6 Actual hide behavior

This is the important distinction between design intent and code:

- When `checkout.support_config.enabled` is false, `buildCheckoutSupportConfig` returns `null`.
- The drawer's `support` computed value is null, so:
  - **Contact support hides.**
  - **FAQ hides** (the FAQ is derived from `supportConfig`).
  - **Working hours hide** (inside the contact block).
- The following remain visible/usable:
  - The header "Help & Support" button and the drawer itself.
  - State guidance for the current attempt.
  - The payment reference and copy action.
  - The per-rail guide section (from `rail.helpGuide`).
  - The per-rail banner.
- Therefore the admin warning "Disabling this hides the Contact Us block on every checkout page" is accurate for the contact/FAQ block, but it does not remove the entire help center. The setting is a support-channel switch, not a global help kill switch.

### 3.7 Localization and fallback

- `currentLocale` comes from the checkout locale adapter (`ar` or `en`).
- Rail display names fall back between Arabic and English.
- Guide steps/prerequisites/troubleshooting use the selected language first, then the other language.
- FAQ questions/answers are filtered to complete localized pairs.
- Working hours fall back between languages.
- The drawer's section titles are bilingual inline.

### 3.8 Separation from admin/merchant help

- Admin contextual help uses `GUIDE_ROUTE_HELP` and the 12-book guide; it does not read `supportConfig`.
- Merchant contextual help uses M/D chapters; it does not read `supportConfig`.
- Checkout help uses `supportConfig` and `helpGuide`; it does not read admin/merchant guide content.
- The admin `/settings/checkout-help` page is the only authoring surface for the platform support config.
- Per-rail content is seeded from core code and has no admin authoring surface.

## 4. Contracts and invariants

1. **Help data travels with the payment-link summary.** No second help request is required.
2. **`enabled: false` returns `null` supportConfig.** The drawer must tolerate null and still render state/reference/rail help.
3. **Only enabled support exposes platform/merchant contacts and FAQ.** The projection enforces this; the UI does not re-enable hidden data.
4. **Merchant contact is link-derived.** It uses the loaded merchant's contact fields, not a merchant-supplied free-form block.
5. **Per-rail guides are bilingual arrays.** Missing entries fall back to the other language.
6. **The drawer never changes payment state.** It only displays status/reference and opens external contact links.
7. **The banner is independent of support enabled.** It is driven by `rail.helpGuide`.
8. **The reference copy is a UI convenience.** It does not prove payment.
9. **No secrets are shown.** Support details are business contact data; payment secrets/OTP/PAN are never placed in the drawer.
10. **The admin setting is versioned.** A change creates a new `checkout.support_config` version.

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Public summary + support/help projection | `GET v1/pay/:linkKey` in `core-back/api/internal/checkout.ts` |
| Support setting | `platform_settings` key `checkout.support_config` |
| Support seed | `DEFAULT_SUPPORT_CONFIG` in `core-back/prisma/seedGuides.ts` |
| Rail guides seed | `RAIL_HELP_GUIDES` in `core-back/prisma/seedGuides.ts` |
| Admin config page | `admin-front/src/pages/settings/checkout-help/index.tsx` |
| Admin endpoints | `v1/admin/settings/checkout-support`, `/history`, `/summary`, `/summary/export` |
| Payer banner | `checkout-front/src/components/help/PerRailInstructionsBanner.tsx` |
| Payer drawer | `checkout-front/src/components/help/CheckoutHelpDrawer.tsx` |
| Payer page mount | `checkout-front/src/pages/pay/[linkKey]/index.tsx` |

## 6. Operational usage

- Enable support: set `enabled`, configure at least one platform or merchant channel, set working hours, review FAQ, and save. The change creates a new version and affects new link fetches.
- Disable support: expect contact and FAQ to disappear; the drawer, state guidance, reference and rail guide remain. Update any support scripts accordingly.
- Add a per-rail guide: edit `RAIL_HELP_GUIDES` and reseed; there is no admin UI. Confirm the rail is visible and the `helpGuide` is present in the link summary.
- Debug missing contact: check `enabled`, `show_platform_contact`/`show_merchant_contact`, and whether the link has merchant contact data.
- Debug missing FAQ: check `enabled` and whether the selected-language question/answer pair is complete.
- Debug missing banner: check `selectedRail.helpGuide`; a null/absent guide hides the banner.
- Debug a support message: use the reference shown in the drawer; do not ask the payer for an OTP or PIN.

## 7. Status and deviations

### Implemented

- Data-driven `supportConfig` projection from `checkout.support_config`.
- Per-rail `helpGuide` projection from `rails.help_guide_json`.
- Per-rail banner with prerequisites, steps, collapse and help entry.
- Drawer with state guidance, reference copy, rail guide, FAQ and contact channels.
- Bilingual fallback behavior.
- WhatsApp/phone/email deep links with reference-aware messages.
- Admin support config with versioning, preview, history, diff and summary export.
- Seeded support config and 14 seeded rail guides (the seed comment says 13).

### Partial

- Support disabling hides contact/FAQ but not the whole help center; the UI warning can be read too broadly.
- Per-rail guide authoring is code/seed-only.
- The admin page subtitle mentions per-rail instructions but the page only edits support config.
- The help drawer has no analytics or feedback capture.
- The help center has no dedicated route; it is a drawer on `/pay/:linkKey`.

### Missing / deferred

- No admin editor for `helpGuideJson`.
- No per-merchant support override; support is platform-wide.
- No content version displayed to the payer.
- No help-content search or FAQ deep links.
- No guide v2 context/playbook/safeguard model for checkout.

### Known bugs / risks

- **Wording gap:** "per-rail instructions" in the admin subtitle implies an authoring capability that does not exist.
- **Visibility gap:** disabling support does not remove state guidance, reference, rail guide or banner.
- **Content risk:** per-rail guides are seeded code; a rail whose guide is stale or missing gives the payer less help than expected.
- **Support risk:** the merchant contact comes from link data; if the merchant's phone/email is missing or stale, the payer sees no merchant channel.
- **Security risk:** support flows must never ask for OTP/PIN; the guide and default FAQ reinforce this, but contact channels are external.
- **Future-doc risk:** guide v2 is not the current checkout help implementation.

## 8. Verification and tests

- `core-back/test/guides-support.test.ts` seeds support config and rail guides and asserts the public projection/help guide shape.
- `tests/e2e/checkout/pay.spec.ts` renders the payer surface.
- `tests/e2e/checkout/a11y.spec.ts` covers accessibility basics.
- `tests/e2e/exhaustive/exhaustive-checkout-surface.spec.ts` covers the checkout surface across viewports/locales/themes.

The core support test requires PostgreSQL/Redis; the Playwright suites require the running stack. There is no dedicated unit test for the support-disable hide matrix.

## 9. Source references

### Old design sections

- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` — checkout/help deployment context.
- `design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md` — collection-mode and trustworthy-confirmation terminology used by the payer guidance.
- `design/07-guides-and-academy/guide_system_design_and_content.md` — future guide workstream; not current checkout help behavior.

### Code paths

- `checkout-front/src/components/help/CheckoutHelpDrawer.tsx`
- `checkout-front/src/components/help/PerRailInstructionsBanner.tsx`
- `checkout-front/src/components/renderers/types.ts`
- `checkout-front/src/pages/pay/[linkKey]/index.tsx`
- `core-back/api/internal/checkout.ts`
- `core-back/prisma/seedGuides.ts`
- `admin-front/src/pages/settings/checkout-help/index.tsx`
- `core-back/test/guides-support.test.ts`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03 — Initial canonical checkout help part. Confirms the `supportConfig`/`helpGuide` projections, per-rail banner, state-aware drawer, the actual support-disable hide behavior, and the missing per-rail authoring surface.

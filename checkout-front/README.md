# checkout-front

Public hosted Checkout SPA for the payment gateway platform. It is a single-link payer surface: load the link, choose a visible rail, enter the required fields, complete the rail's client action, watch the server-verified status and show a receipt or a safe failure state.

Status: `partial`. The payer flow, five action renderers, SSE status consumption and help center are implemented, but the 404 recovery route, stream reconnection, per-rail help authoring and embedded-widget SRI handling remain gaps. See [the canonical checkout parts](../project-design/parts/05-checkout-front/) and the generated [blueprint.md](blueprint.md).

## 1. Purpose and trust boundary

- The checkout is unauthenticated. There is no payer account, session authority or general payment-status portal.
- The browser talks only to `checkout-back` under `/api`; it holds no database or core credential.
- Zero-trust amount rule: the checkout **never** sends `amount` or `currency` on initiate or confirm. `core-back` resolves both from the payment link (`payment_links` by `linkKey`); a client-supplied amount/currency is rejected.
- Browser redirects, widget callbacks and return URLs are hints only. They never make an attempt successful in the SPA. Only server-verified state, delivered through the attempt snapshot/SSE, is authoritative.
- Return to the merchant is opt-in: the button appears only after success and only when the link has a redirect URL whose host is in the application allowlist.
- The payer sees decimal strings from the summary. The SPA displays base/fee/total amounts; it does not sum them with floating point.
- The checkout help center is data-driven from the platform support setting and the selected rail's help guide. It contains no payment secrets, OTPs or PANs.

## 2. Stack and prerequisites

| Area | Implementation |
| :--- | :--- |
| Framework | Vue 3.5, Vuetify 3.10, TypeScript/TSX |
| Build | Vite (`rolldown-vite`) with `unplugin-vue-router`, auto-imports and Vuetify auto-import |
| Routing/state | `vue-router` 4, local reactive state under `src/state` |
| Data/i18n | Axios, `vue-i18n` 11, self-hosted Plus Jakarta Sans, Cairo and JetBrains Mono |
| Validation | Zod plus checkout field normalizers under `src/utils/zReady.ts` |
| Help | `supportConfig` plus per-rail `helpGuide` projections from the core checkout summary |

Prerequisites:

- Node `^20.19.0 || >=22.12.0` (from `engines` in `package.json`).
- Bun for install/scripts, consistent with `bun.lock`.
- A running `checkout-back` edge BFF reachable at the configured API URL. The dev server alone cannot load links, initiate attempts or serve status updates.
- No PostgreSQL, Redis or core certificate is required in the frontend workspace.

## 3. Install, run, build, lint and test

```bash
bun install
bun run dev          # Vite dev server on port 5103
bun run build        # rm -rf dist && parallel type-check + build-only
bun run build-only   # Vite build without the type-check
bun run preview      # serve the built dist
bun run type-check   # vue-tsc --build
bun run lint         # oxlint --fix followed by eslint --fix
bun run format       # prettier src/
```

- This workspace has **no** `test`/`test:unit` script. UI coverage lives in the repository `tests/` workspace.
- Browser coverage: `cd ../tests && bun run test:e2e -- checkout/pay.spec.ts`, `checkout/a11y.spec.ts` and the exhaustive checkout surface suite. These require the live stack.
- The pure redirect allowlist test lives at `tests/unit/checkout-redirect.test.ts` and runs through `cd ../tests && bun run test:unit`.
- `bun run lint` is auto-fixing. Use the individual `lint:oxlint`/`lint:eslint` scripts for a non-mutating check.

## 4. Environment and runtime configuration

`VITE_API_URL` is a development origin base. In dev the Axios base becomes `${VITE_API_URL}/api`; a production build always uses the same-origin `/api` path. The Vite dev server also proxies `/api` to `VITE_API_URL` (default `http://localhost:4103`). There is no runtime-config file or deploy-generated SPA flag.

| Key | Scope | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `VITE_API_URL` | Dev/build env | `http://localhost:4103/` in `.env` | Edge BFF origin used by the dev API client and the Vite `/api` proxy. Production ignores it and uses `/api`. |
| `VITE_SEND_NOT_FOUND_TRANSLATIONS` | Dev/build env | `NO` | When `YES` **and** running in dev mode, reports missing translation keys. No effect in production. |
| `VITE_MY_TAILSCALE` | Dev env | unset | Optional hostname appended to the Vite `allowedHosts` list for LAN/Tailscale development. |

Checkout help is configured through the admin portal, not through frontend environment variables:

- Platform support: `platform_settings` key `checkout.support_config`.
- Per-rail guidance: `rails.help_guide_json`, seeded from `core-back/prisma/seedGuides.ts`.
- Both are projected by `core-back` into `GET v1/pay/:linkKey` as `summary.supportConfig` and `visibleRails[].helpGuide`.

## 5. Route and page map

| Path | Route name | Behavior |
| :--- | :--- | :--- |
| `/` | `Home` | Redirects to `NotFound`. There is no checkout home page. |
| `/pay/:linkKey` | `Pay` | Payer summary, rail form, client action, confirming state, receipt or error. |
| `/:pathMatch(.*)*` | `NotFound` | Token-styled 404 page. Its Dashboard button targets a route that does not exist in this SPA. |

### 404 recovery bug

`src/pages/public/not-found/index.tsx` renders a button linking to `{ name: "Dashboard" }`. The checkout router has no `Dashboard` route, so the link resolves back to the catch-all `NotFound` page. The recovery button therefore loops. Because `/` also redirects to `NotFound`, there is no working in-app home destination; send payers to a valid `/pay/:linkKey` URL directly.

## 6. Payer flow

### 6.1 Load and summary

`GET v1/pay/:linkKey` returns a `PayLinkSummary` with:

- `linkKey`, `merchantTradeName`, optional logo/description.
- `amount`, `currency`, `feeBearerMode` (`MERCHANT_ABSORBS`, `PAYER_SURCHARGE`, `SPLIT`), `baseAmount`, `feeAmount`, `totalAmount`, `merchantAmount` and optional `splitPercent`.
- `visibleRails`, optional `expiresAt`, `status`, `redirectUrl`, `allowlistedRedirectHosts` and `supportConfig`.

The amount breakdown always shows the base amount and the amount charged (`totalAmount`). A service-fee row appears only when the fee bearer is not `MERCHANT_ABSORBS`; for `SPLIT` the row label includes the split percentage.

`visibleRails` is computed by the backend. The SPA does not recompute visibility; it renders the rail names, collection-mode pills and fields supplied by the summary. The first rail is selected by default, and switching rails resets field values and errors.

### 6.2 Phase machine

```text
type Phase = "SUMMARY" | "FORM" | "ACTION" | "CONFIRMING" | "RECEIPT" | "ERROR"
```

| Phase | Entered when | What renders |
| :--- | :--- | :--- |
| `SUMMARY` | Initial ref value | Declared but not used as a visible state. Loading and load errors render outside the phase switch. |
| `FORM` | Link summary loads | Rail cards, per-rail help banner, rail fields and "Pay Now". |
| `ACTION` | Initiate returns a client action | Countdown plus the renderer for the action kind. |
| `CONFIRMING` | Snapshot status is `VERIFYING`, `UNKNOWN` or `AUTHORIZING` | Spinner, status badge, reference and cancel. |
| `RECEIPT` | Snapshot status is `SUCCEEDED` | Payment complete, server total, reference and optional return button. |
| `ERROR` | Load failure, cancellation or terminal status (`FAILED`, `EXPIRED`, `CANCELLED`, `BLOCKED`) | Failure state, status and "Try Another Method". |

A successful link load goes directly to `FORM`; `SUMMARY` is not a visible screen. A load error shows "This Payment Link Is No Longer Available" / "Cannot process this payment" in a card, not the router 404 page.

### 6.3 Fields and validation

- `RailFieldForm` renders every field in `rail.fields`: `select` uses `VSelect`, and other types use `VTextField`.
- `PAN`-sensitive fields render as password inputs; inputs use `autocomplete="off"`.
- Labels/placeholders fall back between Arabic and English.
- `zReady.ts` normalizes Arabic digits to ASCII, applies local `09` phone normalization, strips non-digits for numeric/OTP values, expects `NP-` plus 12 digits for `wallet_id`, enforces 4-8 digit OTPs and applies required/min/max/regex rules.
- The page validates with `schema.safeParse(normalized)` and maps the first issue per field into `formErrors`.

### 6.4 Initiate, confirm, resend and cancel

`POST v1/pay/:linkKey/initiate` sends only:

```json
{
  "railCode": "<selected rail>",
  "formData": { "<field>": "<normalized value>" },
  "idempotencyKey": "chk-<time>-<random>"
}
```

No client `amount` or `currency` is sent. The response provides `attemptId`, `reference`, `status` and `clientAction`; the page stores the attempt, starts the countdown if the action has `expires_at`, opens the status stream and enters `ACTION`.

- **Confirm OTP**: `POST .../confirm` with `{ otp, idempotencyKey }`. The returned snapshot is applied; `VERIFYING`/`UNKNOWN` moves to `CONFIRMING`.
- **Resend OTP**: `POST .../resend`. It shows a notice but does not reset the attempt.
- **Cancel**: `POST .../cancel`, closes the stream and moves to `ERROR`.
- **Client events**: `POST .../client-event` with `{ event, payload }`. Widget events are canonicalized to `widgetEvent`, `completeCallback`, `errorCallback` or `returnHint` before posting.

Client events are hints. The core must still verify the payment through a trusted channel.

### 6.5 Rail renderers

| Action kind | Renderer | Behavior |
| :--- | :--- | :--- |
| `SHOW_OTP_FORM` | `OtpFormRenderer` | OTP input, attempt counter, resend and verify/pay; Enter submits; Arabic digits are normalized. |
| `HTTP_REDIRECT` | `RedirectRenderer` | Auto-redirect on mount using GET query or POST form; blocks non-allowlisted hosts; manual retry. |
| `RENDER_EMBEDDED` | `EmbeddedWidgetRenderer` | Loads allowlisted HTTPS scripts with SRI/crossOrigin, listens for postMessage callbacks, supports iframe sandbox and removes scripts on unmount. |
| `SHOW_QR_OR_CODE` | `QrOrCodeRenderer` | QR data URL, optional pay code, bilingual instructions, deep link and expiry. |
| `SHOW_PUSH_OR_TRANSFER` | `PushOrTransferRenderer` | Destination/reference/wallet hint, instructions, optional proof upload and expiry. It accepts an `onCancel` prop but does not render a cancel control. |

`RedirectRenderer` denies all when the allowlist is empty. Matching is exact host or subdomain, with a wildcard case that still rejects `javascript:`/`data:` URLs. `EmbeddedWidgetRenderer` uses a fixed provider host allowlist, so a new provider requires a code change.

### 6.6 SSE status stream

After initiate, the page opens an `EventSource` for the checkout attempt status route through `checkout-back`.

- `onmessage` parses `payload.attempt ?? payload`, applies the snapshot, updates the client action/reference/status and moves to `RECEIPT`, `ERROR` or `CONFIRMING` as appropriate.
- `onerror` closes the stream and sets it to null. The page does **not** reconnect, back off or fall back to polling, so a dropped stream can leave the payer on `CONFIRMING` until a reload.
- Unmount closes the stream and clears the countdown.
- The stream is display-only. Server attempt state remains authoritative.

### 6.7 Receipt and return

On `SUCCEEDED`, the page enters `RECEIPT`, closes the stream and shows the payment complete badge, the server `totalAmount`, the reference and an optional "Return To Merchant" button.

The return button appears only when `summary.redirectUrl` exists **and** `isAllowedRedirect(redirectUrl, allowlistedRedirectHosts)` passes. The allowlist must be non-empty. There is no automatic return redirect; the payer may stay on the receipt.

### 6.8 Errors and unavailable states

- Load failures show the unavailable-link card.
- A terminal attempt status moves to `ERROR` with the status badge and "Try Another Method", which returns to `FORM`.
- `VERIFYING`/`UNKNOWN`/`AUTHORIZING` moves to `CONFIRMING` and the help drawer tells the payer not to pay again.
- Failed, expired, cancelled and blocked attempts are not treated as successful by any browser hint.

## 7. Help center

### Data sources

| Data | Source | Projection |
| :--- | :--- | :--- |
| Platform support config | `platform_settings` key `checkout.support_config` | `PayLinkSummary.supportConfig` |
| Per-rail guide | `rails.help_guide_json` (seeded in core) | `RailDescriptor.helpGuide` |

The support projection returns `null` unless `enabled === true`. It includes platform and/or merchant contact fields, Arabic/English working hours, complete localized FAQ items and a derived flat `channels` list. It deliberately excludes other setting fields.

Per-rail guides contain bilingual prerequisites, numbered steps and troubleshooting. Fourteen seeded rails currently have guides; a rail without a guide returns `helpGuide: null`, hides the banner and omits the rail-guide section from the drawer.

### Per-rail banner

`PerRailInstructionsBanner` renders when the selected rail has a `helpGuide`. It shows "How to pay with <rail>", expand/collapse, a help button, prerequisite pills and numbered steps. It is independent of `supportConfig.enabled`; disabling support does not hide it.

### Help drawer

`CheckoutHelpDrawer` is a 440 px slide-over titled "Help & Support". It composes:

1. **State guidance** for `VERIFYING`, `UNKNOWN`, `FAILED`, `EXPIRED` and `CANCELLED`.
2. **Payment reference** with copy action when a reference exists.
3. **Per-rail guide** prerequisites, steps and troubleshooting.
4. **FAQ** from complete localized support items.
5. **Contact support** from platform and merchant contacts when support is enabled.

State guidance is explicit about not paying again for `VERIFYING`/`UNKNOWN`, checking with support if charged, and starting a new payment after `EXPIRED`/`CANCELLED`. Contact channels build WhatsApp (`wa.me` with an encoded message), phone (`tel:`) and email (`mailto:` with the link key/reference in the body). The drawer never asks for an OTP or PIN and never changes payment state.

### Actual disable behavior

When the admin disables support, `supportConfig` becomes `null`. The contact block, working hours and FAQ hide. The following remain available:

- The header help button and drawer.
- State guidance and attempt status.
- Payment reference and copy action.
- Per-rail guide and per-rail banner.

The setting is a support-channel switch, not a global help kill switch. There is no dedicated checkout help route or deep link; help is a drawer on the payer page. There is also no analytics, feedback capture or read tracking. Guide v2 is not the current checkout help model: its context map, safeguard cards, playbook and read-tracking workstream is future/unimplemented.

## 8. UI system and conventions

- Checkout uses the shared `--pg-*` token sheet and self-hosted Plus Jakarta Sans/Cairo/JetBrains Mono fonts. Vuetify defaults are flat cards, 36 px no-transform buttons, outlined compact fields, ripple off and RTL-aware locale.
- The payer layout is intentionally not the admin/merchant shell. `layouts/checkout.tsx` renders one `<main class="pg-checkout">`; the page adds a max-width 560 px column centered on desktop and top-aligned on small screens.
- The page composes a focused subset of primitives: `SurfaceCard`, `DescriptionList`, `MoneyDisplay`, `MonoRef`, `StatusBadge`, `EmptyState`, `SlideOverDrawer`, `MetaPill` and `FormField`.
- There is no table/export workflow on the payer surface. Shared table/XLSX packages exist in the workspace, but checkout does not expose spreadsheet export.
- Do not add page-local hard-coded palettes. Use the tokens, semantic status tones and shared primitives.
- The checkout must remain usable at phone width, in RTL and in both locales; the Playwright a11y/exhaustive suites cover these surfaces.

## 9. i18n and RTL

- Locales are Arabic (`ar`) and English (`en`). Arabic is the default: `locale-name` is treated as English only when stored as exactly `en`; otherwise the app starts in Arabic.
- The locale is stored in `localStorage`, applied to `<html lang>`/`dir` (`rtl` for Arabic, `ltr` for English) and passed to Vuetify's locale adapter.
- The payer header language toggle stores the next locale and reloads the page.
- User-facing text comes from `src/constants/i18nCatalogue.ts` as `[English, Arabic]` pairs plus Vuetify messages. Keep both in sync.
- Rail names, field labels/placeholders, help steps, prerequisites, troubleshooting, working hours and FAQ use selected-language-first fallback to the other language. FAQ items render only when the selected-language pair is complete.
- The drawer's section titles and state guidance are bilingual inline.

## 10. Deployment and runtime behavior

- The deploy engine builds `checkout-front` with `bun run build` and syncs `dist` to the checkout host.
- Nginx serves the SPA with history fallback and proxies `/api/` to `checkout-back`. The checkout host is public-facing with deploy-managed TLS (`certbot`, `custom` or `self_signed`).
- The production SPA uses same-origin `/api`; `VITE_API_URL` is a development convenience only.
- There is no `runtime-config.js` and no deploy-generated SPA flag for checkout-front. Checkout support visibility is controlled by the admin-managed platform setting, not an environment variable.
- `checkout-back` exposes `/pay`, `/return` and `/inbound`, proxies the payer status stream and calls `core-back` over mTLS. The browser never receives core credentials.

## 11. Testing and troubleshooting

### Recommended checks

```bash
bun run type-check
bun run lint
bun run build
```

Browser/unit coverage comes from the `tests/` workspace:

- `checkout/pay.spec.ts` for the payer surface and no horizontal overflow.
- `checkout/a11y.spec.ts` for accessibility basics.
- `exhaustive/exhaustive-checkout-surface.spec.ts` across viewports/locales/themes.
- `unit/checkout-redirect.test.ts` for empty allowlists, scheme rejection, exact/subdomain matching and wildcard behavior.
- `e2e-live/live.spec.ts` when the live stack is available.

### Common problems

| Symptom | Check |
| :--- | :--- |
| Link will not load | Confirm the link key, link status/expiry and `checkout-back` availability. A load error is not the router 404 page. |
| 404 recovery button loops | Known bug: the button targets the non-existent `Dashboard` route. Navigate directly to a valid `/pay/:linkKey`. |
| Amount or currency mismatch | The server resolves both from the link. The SPA never sends them; investigate the link record/backend, not browser code. |
| No return button after success | The link must have a redirect URL and a non-empty allowlist containing the exact host or a parent domain. An empty allowlist denies all. |
| Redirect is blocked | The action URL host is not allowlisted, or the scheme is not a real HTTP(S) host. Do not bypass the host check. |
| Payer stays on "Confirming" | The SSE stream may have dropped; the SPA does not reconnect or poll. Reload and check the server attempt status/reference. |
| OTP form rejects input | Confirm OTP length/attempt limits and that Arabic digits are normalized; the SPA does not reveal whether the subscriber exists. |
| Embedded widget fails to load | The provider host must be in the fixed allowlist. A new provider requires a code change; SRI hash selection is a known risk when multiple scripts are present. |
| Help contact/FAQ disappeared | The admin disabled checkout support or hid the relevant contact flags. State guidance, reference, rail guide and banner remain. |
| Rail instructions are missing | The selected rail has no `helpGuide`, or the link summary did not project one. Per-rail content is seed/code-managed; there is no admin editor. |
| Payer shows "do not pay again" | `VERIFYING`/`UNKNOWN` is not a failure. Wait, refresh/check support with the reference and do not initiate a second payment. |

## 12. References

- Generated workspace blueprint: [blueprint.md](blueprint.md)
- Canonical design parts:
  - [Checkout Payer Flow](../project-design/parts/05-checkout-front/00-payer-flow.md)
  - [Checkout Help Center](../project-design/parts/05-checkout-front/01-help-center.md)
- Generated appendices: [environment and config matrix](../project-design/appendices/env-and-config-matrix.md), [API route matrix](../project-design/appendices/api-route-matrix.md), [test inventory](../project-design/appendices/test-inventory.md)
- Related canonical surfaces: [Checkout edge BFF](../project-design/parts/02-edge-services/03-checkout-back.md), [Admin Checkout Help settings](../project-design/parts/03-admin-front/05-backups-settings-and-operations.md)

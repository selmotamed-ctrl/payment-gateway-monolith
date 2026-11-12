---
id: merchant-ui.portal
title: Merchant Portal
status: partial
confidence: high
last_verified: 2026-11-09
verified_against: d695518+working-tree
code:
  - merchant-front/src/router/index.ts
  - merchant-front/src/layouts/**
  - merchant-front/src/pages/**
  - merchant-front/src/components/**
  - merchant-front/src/constants/urlsMap/index.ts
  - merchant-front/src/state/**
  - merchant-front/src/utils/theme/index.ts
  - merchant-front/src/state/theme.ts
  - merchant-front/src/components/ThemeMenu/index.tsx
  - merchant-front/src/content/landing/landingModel.ts
  - merchant-front/src/constants/landingCatalogue.ts
design_sources:
  - design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md
  - design/06-ui/portal_ui_implementation_plan.md
  - design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md
  - design/06-ui/merchant_landing_page_redesign.md
tests:
  - tests/e2e/merchant/shell.spec.ts
  - tests/e2e/merchant/table-row-context-menu.spec.ts
  - tests/e2e/merchant/auth.spec.ts
  - tests/e2e/merchant/a11y.spec.ts
  - tests/e2e/exhaustive/exhaustive-merchant-surface.spec.ts
  - merchant-front/src/content/__tests__/content-completeness.test.ts
  - merchant-front/src/content/__tests__/landing-content.test.ts
  - tests/e2e/merchant/landing.spec.ts
  - tests/unit/frontend-security-merchant.test.ts
gaps:
  - The Statements route has no router-level authority entry, so direct navigation is allowed even when the navigation item is hidden.
  - Merchant guide and developer-guide routes are intentionally open to any authenticated merchant; this is a learning surface, not a data boundary.
  - Google OIDC login is represented in the API map but the backend returns 501; the portal does not support a working Google sign-in flow.
  - Merchant onboarding progress and guide checklist state are client-assisted; completion is not a server-issued activation authority.
  - The portal has no route-level maker-checker visualization for pending application changes beyond status badges and pending states.
  - The public landing page's developer CTA targets `/portal/guide/developers`, which requires sign-in; the login page always lands on the dashboard (no return-to), so a visitor must navigate to the guide again after signing in.
  - FIXED 2026-11-04: the developer guide content (D-01/D-04/D-05) and the code generator now use the real edge schema (`title`, `maxUses`, no `redirectUrl`/`applicationId`/`infiniteUse`) and the real `201` response (`key`, `state`, `visibleRails`). Remaining: the webhook sample in the generator is unverified (no outbound merchant webhooks are implemented).
  - POS screen stream uses fetch streaming with Authorization and reconnect backoff; the attempts-array mapping is covered by unit tests but not verified against a live merchant-back.
  - "Residual (GAP-019): the merchant session token lives in client storage unless the edge runs `SESSION_COOKIE_MODE=true`."
---

# Merchant Portal

## 1. Purpose and scope

This part owns the merchant-facing portal in `merchant-front`: its routes, authentication entry points, 248/56 shell, onboarding flow, wallet/application/link/POS/payment/dispute/cash-out/token/credential/team pages, and the guide surfaces that are implemented in this workspace.

It does not own the merchant edge API (`merchant-back`), the merchant external API (`/api/v1/external/*`), or the merchant guide content in detail. The guide and developer API are covered in `01-guide-and-developer-api.md`. Checkout is covered in `05-checkout-front/**`.

## 2. Design intent (extracted and synthesized from ./design)

The merchant portal is the self-service business workspace:

1. **One merchant identity, many applications.** A merchant owns wallets and applications; each application maps to a wallet and controls the rails/redirect domains used by its links.
2. **KYB before live money.** A merchant can prepare onboarding and use sandbox behavior while pending, but live activation follows KYB approval.
3. **Wallet balances are ledger-derived.** The portal shows available, pending and negative amounts; it never edits a balance column.
4. **Sensitive changes are governed.** Descriptive application/merchant fields can change directly; wallet assignment, rail whitelist and redirect allowlist are sensitive and require review.
5. **Links are server-priced.** The checkout cannot change the amount; the merchant link record is the price authority.
6. **POS is a real-time surface.** A paired screen reflects the current payment state and must not be treated as a payment authority.
7. **Disputes are evidence workflows.** The merchant uploads evidence before the deadline; money movement remains an admin finance action.
8. **API tokens are scoped secrets.** Tokens are shown once, can be revoked, and can be constrained by IP CIDR allowlists.
9. **Help is merchant-specific.** The shell exposes merchant guide search/help, not the admin 14-book guide.
10. **All money and spreadsheet output uses decimal.js and the shared XLSX pipeline.**

## 3. As-built architecture

### 3.1 Public and protected routes

`merchant-front/src/router/index.ts` defines:

- Public `/` (`Landing`), `/login` (`Login`), `/register` (`Register`), and a catch-all `NotFound`.
- A protected `/portal` parent using `layouts/default`, with 16 children.
- A visitor guard for login/register and a landing-to-dashboard redirect for authenticated users.
- A `routesAuthorities` check after authentication; missing/empty authority arrays mean no UI gate.
- A dynamic-import retry path using `localStorage`.

### 3.1a Public landing page (`/`, `Landing`)

`merchant-front/src/pages/public/landing/**` is the visitor-facing marketing page; authenticated users are redirected to the dashboard by the router guard. It was redesigned on 2026-11-04 (research and rationale: `design/06-ui/merchant_landing_page_redesign.md`).

| Section | Content | Implementation |
| :--- | :--- | :--- |
| Sticky header | Brand, anchor nav (How it works / Product / Developers / Security, hidden < 960 px), AR/EN toggle, theme menu (System/Light/Dark), Login, Get started | `index.tsx`; theme/locale switches run inside a View Transition when supported and motion is allowed. |
| Hero | Two-tone h1 "Collect on any rail. Reconcile every dinar.", lede, CTAs to `Register` and `Login`, three proof points | h1 is the LCP element and is never opacity-hidden. |
| Hero simulator | Interactive payment-link checkout: five checkout experiences (OTP, QR, push approval, bank redirect, card form = the five `RENDER` client actions), real statuses `AWAITING_CUSTOMER → VERIFYING → SUCCEEDED`, then an illustrative `PLATFORM_CLEARING` journal (Dr gateway clearing / Cr wallet / Cr platform commission) that balances, and a wallet count-up | `HeroDemo.tsx` + `content/landing/landingModel.ts` (decimal.js). Autoplay pauses off-screen, when the tab is hidden and on user pause; play/pause and next-step buttons; rail buttons are `aria-pressed` toggles. |
| How money moves | Link → hosted checkout → trusted confirmation → double-entry ledger → wallet & cash-out | Responsive horizontal/vertical track that fills on reveal; mirrors in RTL. |
| Product bento | Payment links & QR, live POS screens, fee preview, wallets & sealed statements, four-eyes changes, disputes, team roles, bring-your-own gateway (`MERCHANT_DIRECT`) | `FeePreview.tsx` computes `MERCHANT_ABSORBS` / `PAYER_SURCHARGE` / `SPLIT` exactly like `MerchantFeeCalculator` and accepts Arabic-Indic digits. |
| Stats | 5 ways to pay, 3 fee-bearer modes, 2 languages, 0 floating-point operations on money | Count-up on view; screen readers get the final value only. |
| Developers (lazy chunk) | Token, IP allowlist, decimal-string and verify-by-API points; cURL/TypeScript/Python snippet for `POST /api/v1/external/links` and the real `201` body | `DeveloperSection.tsx` is dynamically imported when the section is within 600 px of the viewport; the snippet fields are tested against core-back `linkCreateSchema`. |
| Security & compliance | Maker-checker, KYB/AML, mTLS 1.3 between edge and core, AES-256-GCM write-only secrets, append-only ledger, least-privilege teams | Static list + illustrative invariant panel. |
| Onboarding | The six steps from account creation to go-live (mirrors `/portal/onboarding`) | |
| FAQ | Commission, own gateway accounts, when to fulfil, what payers see, testing before live | Native `<details>`. |
| Final CTA and footer | `Register`, `Login`, `MerchantGuide`, `MerchantDeveloperGuide` | All CTAs are `VBtn :to` links (no `<a><button>` nesting). |

Rules:

- **No unverifiable claims.** The page shows no live system status, uptime, fixed commission rate or currency list; numbers in the simulator, statement and invariant panels are labelled or obviously illustrative.
- **Motion** is CSS-first (`landing.css`, loaded only with the landing chunk): IntersectionObserver reveals, `@property --pgl-sweep`, a scroll-timeline header hairline as progressive enhancement, and View Transitions. Content is only hidden when JS has set `data-motion="on"`; `prefers-reduced-motion: reduce` removes all animation/transitions, starts the simulator on its final state with autoplay off, and skips count-ups. Looping pulses are limited to six iterations.
- **RTL** uses logical properties; directional icons flip; code, URLs, amounts and the LTR code window carry `dir="ltr"`; Arabic headings have no letter-spacing; inline Latin tokens inside Arabic strings are isolated with U+2066/U+2069.
- **Copy** lives in `src/constants/landingCatalogue.ts` (EN/AR pairs) merged by `plugins/i18n.ts`; the app catalogue wins on collisions and the landing test forbids them.
- `document.title` and the meta description are set from the catalogue on mount and on locale change.

### 3.2 The 16 portal routes

| # | Path | Name | UI authority | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `/portal/dashboard` | `Dashboard` | `stats.read` | Wallet balance, period volume, success rate, pending cash-outs, charts and recent payments. |
| 2 | `/portal/onboarding` | `Onboarding` | `[]` (authenticated only) | Five-step KYB/onboarding: profile, owners, documents, payout, submit; revalidation requests. |
| 3 | `/portal/guide` | `MerchantGuide` | none | Merchant operations guide, role-filtered chapters, first-5 checklist, fee calculator, code generator, webhook checks. |
| 4 | `/portal/guide/developers` | `MerchantDeveloperGuide` | none | Developer API chapters D-01..D-05 with code templates. |
| 5 | `/portal/wallets` | `Wallets` | `wallets.read` | Wallet balances, pending/negative amounts, last use, create wallet, statements shortcut. |
| 6 | `/portal/statements` | `Statements` | **none (gap)** | Monthly statement by wallet/month, line items, snapshot hash and XLSX export. |
| 7 | `/portal/applications` | `Applications` | `applications.read` | Application list, profile edits, wallet assignment, rail whitelist and redirect allowlist proposals. |
| 8 | `/portal/links` | `Links` | `links.read` | Create/cancel links, QR, attempts inspector, redirect URL and rail whitelist. |
| 9 | `/portal/pos` | `PosTerminals` | `pos.manage` or `pos.operate` | Terminals, screens and pairing. |
| 10 | `/portal/pos/screen/:code` | `PosScreen` | `pos.manage` or `pos.operate` | Realtime customer-facing screen for a paired terminal. |
| 11 | `/portal/payments` | `Payments` | `payments.read` | Payment attempts, status, amount, commission, net and application. |
| 12 | `/portal/disputes` | `Disputes` | `payments.read` | Chargeback list, evidence deadline/status and evidence upload. |
| 13 | `/portal/cashouts` | `Cashouts` | `cashout.read` or `cashout.request` | Cash-out requests, wallet, amount and bank destination. |
| 14 | `/portal/developers/tokens` | `DeveloperTokens` | `tokens.read` | API token creation, one-time secret, scopes, IP allowlist and revocation. |
| 14a | `/portal/developers/webhooks` | `Webhooks` | `applications.read` (changes need `webhooks.manage`, projected from the core authority `application:manage`) | Webhook endpoints per application (HTTPS URL, event filter, status), one-time `whsec_` signing secret on create and rotate, send a test event, enable or disable, and the latest deliveries with a "Redeliver" action for parked or delivered events (AUTO-34). |
| 15 | `/portal/credentials` | `Credentials` | `credentials.manage` | Merchant-owned gateway credential sets and environments. |
| 16 | `/portal/team` | `Team` | `users.manage` | Team members, roles, scopes and authority editing. |

### 3.3 Shell and layout

`merchant-front/src/layouts/default.tsx` mirrors the admin 248/56 shell:

- 56 px app bar with menu toggle, brand, breadcrumbs, guide search, help, theme mode menu (System/Light/Dark), AR/EN language controls and account menu.
- 248 px drawer permanent on desktop and temporary on compact screens.
- Drawer sections: Overview, Money, Commerce, Developer.
- Active navigation uses `meta.parentName` or the longest matching path.
- Guide search pill and `Ctrl+K` open the merchant guide search modal.
- `?` opens the merchant contextual-help drawer.
- Operator card shows merchant role and maker/checker dots.
- Route loading bar and focused main content.
- Skip link and RTL-aware layout.

Public auth pages use `layouts/auth.tsx`, which carries the same three-mode theme menu in its top-right corner. The theme mode is persisted (`system` by default) and resolved against `prefers-color-scheme`; `initialTheme()`/`initTheme()` apply it before mount, so the login page follows the OS theme on first paint and tracks OS changes live in System mode. The POS screen page is still under the `/portal` layout but renders a focused full-height status surface.

### 3.4 Onboarding

`merchant-front/src/pages/onboarding/index.tsx` implements five steps:

1. **Business Profile** — legal/trade name, registration number, tax id, business category, address, contact phone/email, expected monthly volume, currency, website, sales-channel description.
2. **Beneficial Owners** — full name, ownership percent, national id, date of birth, nationality, PEP/controller flags; total ownership is displayed with decimal.js.
3. **Documents** — document type, file, expiry; uploads use multipart `POST v1/merchant/onboarding/kyb-documents`. Open revalidation requests get a replacement file and expiry.
4. **Bank Details** — bank name, account holder, IBAN, account number, SWIFT; payout account must match the approved corporate account policy.
5. **Review and Submit** — submit with acknowledgement through `POST v1/merchant/onboarding/submit`.

The page loads the current join request and open revalidations, supports profile save, owner creation, document upload and submit, and shows the join status and requested-info state. It is available to every authenticated merchant because `routesAuthorities.Onboarding = []`.

Onboarding completion is not an activation authority: the admin KYB/join-request process and `core-back` decide when a merchant is live.

### 3.5 Wallets and statements

`Wallets` (`/portal/wallets`):

- Lists wallet name, currency, balance, pending, amount due/negative balance, status and last use.
- Can create a wallet with application, label and currency.
- Links to the statements route for a wallet.
- Shows values through `MoneyDisplay`; calculations use decimal utilities.

`Statements` (`/portal/statements`):

- Loads wallets, selects a wallet and one of the last 12 months.
- Shows opening/closing balance, gross credits, commission, net credits, adjustments, cash-outs, snapshot hash and line items.
- Exports the statement through `GET v1/merchant/wallets/:id/statements/:month/export`.
- Uses the shared XLSX pipeline; export is unavailable until a wallet is selected.

The `Statements` route is hidden from navigation without `statements.read`/`statements.export` but has no `routesAuthorities` entry, so a direct URL is not redirected by the merchant router.

### 3.6 Applications

`Applications` (`/portal/applications`):

- Lists applications with status.
- Edits descriptive fields (display/name, sales-channel description, expected volume).
- Proposes sensitive changes: assigned wallet, rail whitelist and redirect-domain allowlist.
- Displays pending/approved status for sensitive proposals.
- Requires `applications.read`; mutation authority is enforced by the merchant API.

The UI reflects the maker-checker model but does not itself approve changes.

### 3.7 Payment links

`Links` (`/portal/links`):

- Lists links with amount, currency, use count, expiry, state and attempts.
- Creates a link with description, amount, currency, use count, expiry, redirect URL and rail whitelist.
- Shows a QR code for the link.
- Opens an attempts inspector for the link.
- Cancels a link through `POST v1/merchant/links/:id/cancel`.

The link amount is stored server-side; the checkout page never accepts a client amount or currency. A single-use link can lock its slot while an attempt is in progress.

### 3.8 POS terminals and screens

`PosTerminals` (`/portal/pos`):

- Lists terminals and paired screens.
- Creates a terminal with name and location.
- Creates/pairs a screen with a screen name and type.
- Shows screen role/status and actions.
- The shared table subsystem mirrors the admin copy: the action column is sticky to the inline end and `TableRowActions` opens the same actions from a row right-click or `Shift+F10` (primary action first, then the overflow items). The visible overflow button remains the touch path.

`PosScreen` (`/portal/pos/screen/:code`):

- Loads the screen state from `GET v1/merchant/pos/screens/:code/stream` and then opens an `EventSource` on the same path.
- Shows amount, status, rail code, screen code, reference and last update.
- Shows a live/pending badge and a manual refresh.
- Is a real-time display surface; it does not initiate or confirm a payment from the screen page.

### 3.9 Payments and disputes

`Payments` (`/portal/payments`):

- Searchable list of payment attempts.
- Shows reference, rail, status, amount, commission, net, application, creation and confirmation times.
- Uses `StatusBadge` with success/warning/danger mapping.

`Disputes` (`/portal/disputes`):

- Lists dispute reference, source, state, amount, reason code, evidence deadline and whether evidence was submitted.
- Opens an evidence dialog with a note and optional file.
- Submits multipart evidence to `POST v1/merchant/disputes/:id/evidence`.
- Does not move money; admin finance handles adjustments.

### 3.10 Cash-outs

`Cashouts` (`/portal/cashouts`):

- Lists cash-out state, wallet, amount, currency and request time.
- Requests a cash-out with wallet, amount, currency and bank details (bank name, account number, optional IBAN).
- Shows processing states and supports the maker/checker or finance processing status returned by the API.
- Requires `cashout.read` or `cashout.request` in the UI; the merchant API re-checks.

### 3.11 Developer tokens

`DeveloperTokens` (`/portal/developers/tokens`):

- Lists token name, status, IP-whitelist state and revocation state.
- Creates a token with name, scopes and optional IP CIDR allowlist.
- Shows the one-time secret in a dedicated card after creation.
- Revokes tokens through `DELETE v1/merchant/tokens/:id`.
- Updates IP allowlists through `PUT v1/merchant/tokens/:id/ips`.

Tokens authenticate the external API (`pg_live_...`); the portal session is separate.

### 3.12 Merchant credentials

`Credentials` (`/portal/credentials`):

- Lists merchant-owned gateway credential sets.
- Creates/edits credential name, gateway code, environment, settlement target, username, write-only secret, secret reference.
- Shows whether a secret exists (write-only) and environment/settlement posture.
- Requires `credentials.manage`.

This supports `MERCHANT_DIRECT` mode, where the merchant's own gateway credentials are used and the platform records commission receivable rather than holding principal cash.

### 3.13 Team and roles

`Team` (`/portal/team`):

- Lists merchant users, roles, status and authority posture.
- Invites a member with full name, email, phone, role and temporary password.
- Edits profile/status and scopes/authorities.
- Sends changes through `PATCH v1/merchant/users/:id` or `POST v1/merchant/users`.
- Requires `users.manage`.

### 3.14 Guide surfaces

The portal exposes two guide routes plus shell help/search:

- `/portal/guide` (`MerchantGuide`) — operations guide with first-5 checklist, role search/filter, chapter modal, fee calculator, code generator and webhook checks.
- `/portal/guide/developers` (`MerchantDeveloperGuide`) — D-01..D-05 chapter reader with code templates.
- Shell guide search (`Ctrl+K`) opens the merchant guide search modal and routes to the relevant chapter.
- Shell help (`?`) opens the merchant contextual-help drawer with the M/D mapping.
- The guide is a learning surface and has no route authority entry.

The content and tooling are documented in `01-guide-and-developer-api.md`.

## 4. Contracts and invariants

1. **The merchant SPA talks only to `merchant-back` under `/api`.** It holds no database or core credential.
2. **The external API uses `pg_live_` bearer tokens, not the portal session.**
3. **Sensitive application changes are maker-checker proposals.** The current configuration remains active until approved.
4. **Wallet balances are derived from the ledger.** The portal does not write balances.
5. **Payment-link amounts are server-authoritative.** The portal sends the intended amount at creation; checkout never supplies it.
6. **POS screens are display surfaces.** They reflect attempts; they do not create money movement.
7. **Evidence uploads are multipart and deadline-bound.**
8. **Credential secrets are write-only after save.**
9. **Money and exports use decimal.js and the shared XLSX pipeline.**
10. **The UI authority check is advisory.** `core-back` remains authoritative.
11. **English and Arabic catalogues remain in sync.**

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Merchant router | `merchant-front/src/router/index.ts` |
| Merchant navigation/gates | `merchant-front/src/layouts/sections.tsx` |
| Merchant shell | `merchant-front/src/layouts/default.tsx` |
| Auth layout | `merchant-front/src/layouts/auth.tsx` |
| Pages | `merchant-front/src/pages/**` |
| API map | `merchant-front/src/constants/urlsMap/index.ts` |
| Guide content | `merchant-front/src/content/guide/**` |
| Guide/help components | `merchant-front/src/components/guide/**` |
| Environment | `VITE_API_URL`, `VITE_SEND_NOT_FOUND_TRANSLATIONS`, `VITE_MY_TAILSCALE` |

The portal uses no admin checklist/help-panel flags. Its shell always exposes guide search and help.

## 6. Operational usage

- Start a merchant: register/login, complete onboarding, wait for KYB approval, then create a wallet/application/link or POS screen.
- Debug a missing page: check `routesAuthorities` for that route name, then confirm the backend authority. A hidden nav item does not prove the route is gated.
- Debug a link: use the attempts inspector; confirm the link state and slot behavior before creating a replacement link.
- Debug a POS screen: check the screen code, the live `EventSource` connection, and the terminal/screen pairing.
- Debug a dispute: confirm the evidence deadline and that the file is attached; an evidence note without a file may still be accepted but is weaker.
- Debug API integration: use the developer guide generator, then verify the token, IP allowlist and webhook signature checks.

## 7. Status and deviations

### Implemented

- 16 protected portal routes and four public routes.
- Redesigned public landing page with an interactive payment simulator, fee preview, lazy developer section, reduced-motion and RTL support.
- 248/56 merchant shell with RTL, theme, search, help and operator card.
- Onboarding, wallets, statements, applications, links, POS, payments, disputes, cash-outs, tokens, credentials and team pages.
- Merchant guide and developer guide surfaces.
- Sensitive application proposal UI and credential/token write-only handling.
- Shared XLSX export for statements.

### Partial

- `Statements` lacks a router-level authority gate.
- The guide/developer routes are open learning surfaces, which is intentional but means any authenticated merchant can read them.
- The portal shows maker/checker posture but does not provide a full pending-change diff workflow for every sensitive object.
- Google OIDC is listed in the API map but the actual merchant `/auth/google` endpoint returns 501, so no working Google flow ships.
- Merchant help and guide content are the 10+5 chapter baseline; the admin guide v2 is a separate implemented product.

### Missing / deferred

- No self-service activation override; KYB approval remains admin-controlled.
- No merchant-side certification/training gate for production authorities.
- No admin-guide-v2 context map/playbook/read tracking is reused for merchants.
- No working Google sign-in.

### Known bugs / risks

- **Authorization gap:** direct navigation to `/portal/statements` is not blocked by the router even when the UI would hide it.
- **Onboarding risk:** client-side progress and completion are convenience signals, not activation authority.
- **POS risk:** a displayed `SUCCEEDED` screen is a reflection; the merchant must still follow the server-confirmed payment status and settlement rules.
- **Documentation risk:** do not describe the portal as having a working Google login or a fully server-enforced route gate.
- **Guide risk:** merchant chapter content must not be conflated with the admin 14-book guide.

## 8. Verification and tests

- `tests/e2e/merchant/shell.spec.ts` checks the merchant shell, drawer, navigation rendering, locale re-translation, overflow, mobile behavior and removed scaling.
- `tests/e2e/merchant/auth.spec.ts` covers authentication entry behavior.
- `tests/e2e/merchant/a11y.spec.ts` covers accessibility basics.
- `tests/e2e/exhaustive/exhaustive-merchant-surface.spec.ts` enumerates the portal routes and viewport/locale/theme matrix.
- `merchant-front/src/content/__tests__/content-completeness.test.ts` checks the merchant guide chapter content and tools.
- `merchant-front/src/content/__tests__/landing-content.test.ts` checks the landing EN/AR catalogue (Arabic present, no collisions, every page literal translated), the fee formulas, the balanced demo journal, the snippet fields against `linkCreateSchema`, and that every landing route name exists.
- `tests/e2e/merchant/landing.spec.ts` checks the landing headings/CTA hrefs, Arabic RTL with no overflow at 360 px, locale/theme toggles, the keyboard-operable simulator, the fee preview and reduced-motion behavior. It needs only the merchant preview server (no API).

The shell/auth/a11y/landing suites run against `bun run preview` with mocked API routes. The content and landing tests are Bun tests (`bun run test:unit`).

## 9. Source references

### Old design sections

- `design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md` — shared portal tokens/primitives/shell intent.
- `design/06-ui/portal_ui_implementation_plan.md` — merchant rollout and shared table/primitives.
- `design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md` — merchant guide chapter baseline.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` — merchant portal/guide architecture.

### Code paths

- `merchant-front/src/router/index.ts`
- `merchant-front/src/layouts/default.tsx`
- `merchant-front/src/layouts/sections.tsx`
- `merchant-front/src/pages/onboarding/index.tsx`
- `merchant-front/src/pages/wallets/index.tsx`
- `merchant-front/src/pages/statements/index.tsx`
- `merchant-front/src/pages/applications/index.tsx`
- `merchant-front/src/pages/links/index.tsx`
- `merchant-front/src/pages/pos/index.tsx`
- `merchant-front/src/pages/pos/screen/[code].tsx`
- `merchant-front/src/pages/payments/index.tsx`
- `merchant-front/src/pages/disputes/index.tsx`
- `merchant-front/src/pages/cashouts/index.tsx`
- `merchant-front/src/pages/developers/tokens/index.tsx`
- `merchant-front/src/pages/credentials/index.tsx`
- `merchant-front/src/pages/team/index.tsx`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03 — Initial canonical merchant portal part. Confirms 16 portal routes, the 248/56 shell, onboarding and money/commerce/developer pages, guide surfaces, and the Statements/route authority and Google OIDC gaps.
- 2026-11-04 — Public landing page redesigned (§3.1a): hero payment simulator, money-flow track, product bento with fee preview, stats, lazy developer section with a schema-accurate snippet, security, onboarding, FAQ; EN/AR landing catalogue; motion/reduced-motion/RTL rules; new landing unit and e2e tests. Removed unverifiable claims from the old page (fixed "3.00%" commission, "LYD · USD · EUR", "Live"/"All systems operational" badges) and nested `<a><button>` CTAs. `SegmentedTabs` arrow keys now follow the rendered direction in RTL.
- 2026-11-09 — Added system/light/dark theme modes: persisted mode resolved against `prefers-color-scheme`, applied before mount so the login and landing pages follow the OS theme, live OS tracking in System mode, and an explicit three-option `ThemeMenu` in the shell, auth layout and landing header. See `TRACKER.md`.
- 2026-11-04 — Landing visual system v2 "Aurora Ledger" (design note §9): new type system (Inter/Geist/Instrument Serif/Readex Pro, self-hosted), aurora/grid/grain backdrop, glass header with scroll progress and active section, word-by-word headline, tilting product stage, rail ticker with pause control, spotlight bento, live BigInt ledger ticker, gradient CTA. Fixed: cramped word spacing (all four portals), dark theme painting only one screen, tiled backgrounds not repeating, RTL chip placement, light-theme contrast. axe-core 0 violations (6 configurations), Playwright merchant 17/17.

## Security hardening (2026-11-05)

- `X-Client-Channel` is `merchant`. The 401 handler exempts `/auth/login` and `/auth/mfa` and acts only when a token exists.
- **Cash-out:** an `idempotencyKey` per intent; amount validated against `^\d{1,14}(\.\d{1,4})?$` and greater than zero; a confirm dialog before submit.
- **Google login/register** send a fixed `redirectUri` path and payload; `payload.redirectUrl` must be https on `VITE_IDENTITY_HOSTS` (default `accounts.google.com`).
- **Checkout links** are built from `VITE_CHECKOUT_BASE_URL` (fallback `location.origin`).
- **POS screen stream** uses fetch streaming with `Authorization` and reconnect backoff; the `event: attempts` array is mapped to the screen snapshot (latest attempt amount/currency/status/reference) instead of being assigned as the state object.
- `resolveUploadPathWithMat` was removed. The landing page no longer names internal ledger accounts (`CUSTOMER_PAYMENT`, `YOUR_WALLET`, `PLATFORM_FEE`) or internal action names.
- New env: `VITE_CHECKOUT_BASE_URL` (injected by the deploy engine from `CHECKOUT_DOMAIN`/ports; fallback `location.origin`), `VITE_IDENTITY_HOSTS`. `.env.example` ships; copy to `.env`.
- **Authorities:** the Team page maps its group selectors to the closed core catalogue (`link:read`/`link:write`, `payment:read`, `wallet:create`, `cashout:read`/`cashout:request`, `application:manage`, `pos:manage`, `token:manage`, `credential:manage`, `user:manage`, `onboarding:write`, `dispute:respond`, `merchant:read`) instead of sending group names. The developer guide documents the canonical token scopes (`link:write`, `link:read`, `payment:read`); legacy scopes are accepted and normalised by core.
- Catalogue keys added (EN and AR): "Enter a valid amount greater than zero (up to 4 decimals).", "Confirm Cash-Out", landing "Customer payment" and "Illustrative".

## Gap resolutions (2026-11-05)

- **Logout and cookie sessions (GAP-019).** Logout calls the merchant-back logout route (server-side revoke, cookie cleared) and clears the local session; `utils/security/sessionToken.ts` supports the `cookie-session` sentinel and the `x-pg-csrf` header used when `SESSION_COOKIE_MODE=true`. The POS stream (`sseFetch`) and the API client use the same header helper.
- **XLSX 0.20.3 (GAP-029).** `xlsx` comes from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` and `@types/xlsx` was dropped.

## Dark teleported overlays (2026-11-10)

Merchant dialogs, menus and drawers share the admin shell rule: `.v-overlay__content` and `.v-navigation-drawer__content` inherit `color: rgb(var(--v-theme-on-surface))`, so custom `FormModal`/`SlideOverDrawer` content is readable in dark mode. See `admin-ui.system` and `tests/unit/dark-overlay-colors.test.ts`.

## Dispute evidence

Dispute evidence is uploaded as raw bytes to `POST /api/v1/merchant/disputes/:id/attachments` and listed/read/deleted through the matching attachment routes. The old base64 `POST /disputes/:id/evidence` remains only as a legacy JSON endpoint; the portal no longer uses it. Downloads are available only once the vault object is `ACTIVE` (AV clean).

## LIVE | SANDBOX switch and sandbox test accounts (schema 38)

`state/environment.ts` persists `pg_merchant_env`; the API interceptor adds
`X-Pg-Env` and the app bar shows `LIVE | SANDBOX`. A persistent warning banner
appears in SANDBOX. `Sandbox & Developers → Sandbox Test Accounts`
(`/portal/sandbox/accounts`) lists Fake Rails accounts and movements, edits
balances/limits/status, runs a settlement generator through the reconciliation
ingestor, creates three sample sandbox links and resets the sandbox workspace.
The page is reachable with `applications.read`; the core enforces the exact
mutation authorities (`application:manage`, `wallet:create`, `link:write`).

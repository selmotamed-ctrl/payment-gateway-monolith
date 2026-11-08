# merchant-front

Public Merchant Portal SPA for the payment gateway platform. It is the merchant self-service workspace for onboarding, wallets, statements, applications, payment links, POS, payments, disputes, cash-outs, API tokens, credentials, team management and the merchant/developer guides.

Status: `partial`. The 16 portal routes and the guide surfaces are implemented, but route-gating, onboarding-progress, Google sign-in and guide-v2 gaps remain. See [the canonical merchant parts](../project-design/parts/04-merchant-front/) and the generated [blueprint.md](blueprint.md).

## 1. Purpose and trust boundary

- The browser talks only to `merchant-back` under `/api`; it holds no database connection, core credential or KMS key.
- `merchant-back` calls `core-back` over mTLS. The portal session is separate from the external merchant API, which authenticates with scoped `pg_live_` bearer tokens.
- The merchant portal is public-facing. Login, registration, onboarding and the interactive guide are exposed to merchants; the portal APIs still enforce merchant scope and authority.
- UI authority checks and hidden navigation are advisory. `merchant-back`/`core-back` remain authoritative.
- Sensitive application changes are maker-checker proposals. The current configuration stays active until the change is reviewed and approved.
- Wallet balances are ledger-derived. The portal displays available, pending and negative amounts; it never edits a balance.
- Money and spreadsheet output use decimal.js and the shared XLSX pipeline. No floating-point money calculations.

## 2. Stack and prerequisites

| Area | Implementation |
| :--- | :--- |
| Framework | Vue 3.5, Vuetify 3.10, TypeScript/TSX |
| Build | Vite (`rolldown-vite`) with `unplugin-vue-router`, auto-imports and Vuetify auto-import |
| Routing/state | `vue-router` 4, local reactive state modules under `src/state` |
| Data/i18n | Axios, `vue-i18n` 11, self-hosted Plus Jakarta Sans, Cairo and JetBrains Mono |
| Tables/exports | Shared table subsystem and ExcelJS/XLSX under `src/utils/xlsx` |
| Other | Zod validation, decimal.js, QR code generation, ECharts |

Prerequisites:

- Node `^20.19.0 || >=22.12.0` (from `engines` in `package.json`).
- Bun for install/scripts, consistent with `bun.lock`.
- A running `merchant-back` edge BFF reachable at the configured API URL. The dev server alone does not provide authentication, merchant data or payments.
- No PostgreSQL, Redis or core certificate is required in the frontend workspace.

## 3. Install, run, build, lint and test

```bash
bun install
bun run dev          # Vite dev server on port 5102
bun run build        # rm -rf dist && parallel type-check + build-only
bun run build-only   # Vite build without the type-check
bun run preview      # serve the built dist
bun run type-check   # vue-tsc --build
bun run lint         # oxlint --fix followed by eslint --fix
bun run format       # prettier src/
bun run test:unit    # bun test src/content/__tests__
bun run test:unit:watch  # watch the Bun content tests
```

- `test:unit` covers the merchant guide content completeness test under `src/content/__tests__`. This workspace has no Vitest suite.
- The Playwright merchant suites live in the repository `tests/` workspace: `cd ../tests && bun run test:e2e -- merchant/shell.spec.ts`, `merchant/auth.spec.ts`, `merchant/a11y.spec.ts` and the exhaustive merchant surface suite. They require the live stack.
- `bun run lint` is auto-fixing. Use the individual `lint:oxlint`/`lint:eslint` scripts for a non-mutating check.

## 4. Environment and runtime configuration

`VITE_API_URL` is a development origin base. In dev the Axios base becomes `${VITE_API_URL}/api`; a production build always uses the same-origin `/api` path. The Vite dev server also proxies `/api` to `VITE_API_URL` (default `http://localhost:4102`). This workspace has no admin-style runtime-config flags.

| Key | Scope | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `VITE_API_URL` | Dev/build env | `http://localhost:4102/` in `.env` | Edge BFF origin used by the dev API client and the Vite `/api` proxy. Production ignores it and uses `/api`. |
| `VITE_SEND_NOT_FOUND_TRANSLATIONS` | Dev/build env | `NO` | When `YES` **and** running in dev mode, reports missing translation keys. No effect in production. |
| `VITE_MY_TAILSCALE` | Dev env | unset | Optional hostname appended to the Vite `allowedHosts` list for LAN/Tailscale development. |

There is no `runtime-config.js` for the merchant portal and no frontend flag that hides checklists or help. Deploy-level `MERCHANT_*` settings control host, ports, TLS and remote directory, not SPA behavior.

## 5. Route and page map

Public routes:

| Path | Route name | Behavior |
| :--- | :--- | :--- |
| `/` | `Landing` | Marketing/pricing landing page; authenticated users are redirected to the portal dashboard. |
| `/login` | `Login` | Merchant sign-in; visitor-only. |
| `/register` | `Register` | Merchant account registration; visitor-only. |
| `/:pathMatch(.*)*` | `NotFound` | Public 404 page. |

Protected `/portal` routes (16 children; `/portal` redirects to the dashboard):

| Path | Route name | UI gate | Purpose |
| :--- | :--- | :--- | :--- |
| `/portal/dashboard` | `Dashboard` | `stats.read` | Wallet, period volume, success rate, pending cash-outs, charts and recent payments. |
| `/portal/onboarding` | `Onboarding` | none (authenticated only) | Five-step KYB/onboarding profile, owners, documents, payout and submission. |
| `/portal/guide` | `MerchantGuide` | none (learning surface) | Operations guide, role-filtered chapters, first-5 checklist, fee calculator, code generator and webhook checks. |
| `/portal/guide/developers` | `MerchantDeveloperGuide` | none (learning surface) | Developer API chapters D-01 to D-05 with code templates. |
| `/portal/wallets` | `Wallets` | `wallets.read` | Wallet balances, pending/negative amounts, last use and wallet creation. |
| `/portal/statements` | `Statements` | **none (gap)** | Monthly statement, line items, snapshot hash and XLSX export. |
| `/portal/applications` | `Applications` | `applications.read` | Applications, environments, descriptive edits and sensitive wallet/rail/redirect proposals. |
| `/portal/links` | `Links` | `links.read` | Payment-link creation, QR, attempts inspector and cancellation. |
| `/portal/pos` | `PosTerminals` | `pos.manage` or `pos.operate` | Terminals, paired screens and pairing. |
| `/portal/pos/screen/:code` | `PosScreen` | `pos.manage` or `pos.operate` | Full-screen real-time customer display for a paired terminal. |
| `/portal/payments` | `Payments` | `payments.read` | Payment attempts, status, commission, net and application. |
| `/portal/disputes` | `Disputes` | `payments.read` | Chargeback list, evidence deadline/status and evidence upload. |
| `/portal/cashouts` | `Cashouts` | `cashout.read` or `cashout.request` | Cash-out requests, wallet, amount and bank destination. |
| `/portal/developers/tokens` | `DeveloperTokens` | `tokens.read` | API token creation, one-time secret, scopes, IP allowlist and revocation. |
| `/portal/credentials` | `Credentials` | `credentials.manage` | Merchant-owned gateway credential sets and environments. |
| `/portal/team` | `Team` | `users.manage` | Team members, roles, scopes and authorities. |

### Authority-gating gaps

- `Statements` is hidden from navigation without `statements.read`/`statements.export`, but it has **no `routesAuthorities` entry**. Direct navigation is not redirected by the router; the merchant API still enforces statement access.
- `Onboarding` intentionally has an empty gate because every authenticated merchant must be able to complete it.
- Guide and developer-guide routes are intentionally open learning surfaces. They contain no merchant data.
- Hiding a navigation item is not route protection. Verify both the hidden-navigation and direct-URL cases.

## 6. Key capabilities

### Onboarding (`/portal/onboarding`)

Five steps:

1. **Business profile** — legal/trade name, registration number, tax id, business category, address, contact phone/email, expected monthly volume, currency, website and sales-channel description.
2. **Beneficial owners** — full name, ownership percent, national id, date of birth, nationality and PEP/controller flags. Total ownership is displayed with decimal.js.
3. **Documents** — document type, file and expiry; uploads use multipart `POST v1/merchant/onboarding/kyb-documents`; open revalidation requests accept a replacement file and expiry.
4. **Bank details** — bank name, account holder, IBAN, account number and SWIFT. Payout details must follow the approved corporate-account policy.
5. **Review and submit** — acknowledgement and `POST v1/merchant/onboarding/submit`.

The page loads the current join request and open revalidations, saves the profile, creates owners, uploads documents and displays the join status/INFO_REQUESTED state. Onboarding completion is not an activation authority: admin KYB and `core-back` decide when the merchant is live.

### Wallets and statements

- **Wallets** lists name, currency, balance, pending, amount due/negative balance, status and last use; it can create a wallet with application, label and currency and links to statements.
- **Statements** selects a wallet and one of the last 12 months, then shows opening/closing balance, gross credits, commission, net credits, adjustments, cash-outs, snapshot hash and line items.
- Statement export calls `GET v1/merchant/wallets/:id/statements/:month/export` and converts the returned CSV into a styled XLSX workbook through the shared pipeline. Export is disabled until a wallet is selected.
- Balances are ledger-derived and displayed through `MoneyDisplay`; the portal never writes a balance.

### Applications

- Lists applications and their status.
- Edits descriptive fields (display/name, sales-channel description, expected volume) directly.
- Proposes sensitive changes for assigned wallet, rail whitelist and redirect-domain allowlist; those remain pending until reviewed and the current configuration stays active.
- Requires `applications.read` to open; mutation authority is enforced by the merchant API. The UI reflects the maker-checker model but does not approve changes itself.

### Payment links

- Lists amount, currency, use count, expiry, state and attempts.
- Creates a link with description, amount, currency, use count, expiry, redirect URL and rail whitelist.
- Shows a QR code, opens an attempts inspector and cancels through `POST v1/merchant/links/:id/cancel`.
- The link amount is stored server-side and is the checkout price authority. A single-use link can lock its slot while an attempt is in progress.

### POS terminals and screens

- **POS terminals** lists terminals and paired screens, creates a terminal with name/location, creates or pairs a screen and shows screen role/status.
- **POS screen** loads `GET v1/merchant/pos/screens/:code/stream` and then opens an `EventSource` on the same path. It shows amount, status, rail code, screen code, reference, last update and a live/pending badge, with a manual refresh.
- The POS screen is a real-time display surface. It does not initiate or confirm payments, and a displayed `SUCCEEDED` state must still be reconciled with the server-confirmed payment and settlement rules.

### Payments and disputes

- **Payments** is a searchable attempt list with reference, rail, status, amount, commission, net, application, creation and confirmation times, using `StatusBadge` tone mapping.
- **Disputes** lists dispute reference, source, state, amount, reason code, evidence deadline and whether evidence was submitted.
- Evidence upload is multipart with a note and optional file through `POST v1/merchant/disputes/:id/evidence`. Evidence is deadline-bound; money movement remains an admin finance action.

### Cash-outs

- Lists cash-out state, wallet, amount, currency and request time.
- Requests a cash-out with wallet, amount, currency and bank details (bank name, account number and optional IBAN).
- Shows processing states returned by the API. UI access requires `cashout.read` or `cashout.request`; the merchant API re-checks.

### Developer tokens

- Lists token name, status, IP-whitelist state and revocation state.
- Creates a token with name, scopes and optional IP CIDR allowlist.
- Shows the one-time `pg_live_` secret immediately after creation. The database stores only a hash and last four characters; the secret cannot be viewed again.
- Revokes tokens through `DELETE v1/merchant/tokens/:id` and updates IP allowlists through `PUT v1/merchant/tokens/:id/ips`.
- Tokens authenticate the external API. They are separate from the portal session and must never be placed in browser JavaScript, a bundled SPA, a mobile APK or source control.

### Merchant credentials

- Lists merchant-owned gateway credential sets.
- Creates/edits credential name, gateway code, environment, settlement target, username, write-only secret and secret reference.
- Shows whether a secret exists and the environment/settlement posture. Secrets are write-only after save.
- Requires `credentials.manage`. This supports `MERCHANT_DIRECT` mode, where the merchant's gateway credentials are used and the platform records commission receivable rather than holding principal cash.

### Team and roles

- Lists merchant users, roles, status and authority posture.
- Invites a member with full name, email, phone, role and temporary password.
- Edits profile/status and scopes/authorities through `PATCH v1/merchant/users/:id` or `POST v1/merchant/users`.
- Requires `users.manage`.

## 7. Guide, developer API and help

- `/portal/guide` contains 10 operations chapters (`M-01` to `M-10`) and embeds the five developer chapters. `/portal/guide/developers` is the dedicated D-01 to D-05 reader with code templates.
- The operations guide includes a first-5 checklist (KYB, first wallet, first application, first link, POS/API setup), progress bar, chapter search, role filter tabs, chapter modal and the fee/net settlement calculator.
- The first-5 checklist is stored in `localStorage` under `merchant-guide-checklist`. On mount the page calls onboarding, wallets, applications, links, POS terminals and tokens endpoints to auto-detect steps, and the user can still toggle steps manually. It is a training aid, not a server-issued activation record.
- The fee calculator uses decimal.js and supports `MERCHANT_ABSORBS`, `PAYER_SURCHARGE` and `SPLIT`, showing customer total, platform commission, estimated gateway fee and net wallet credit. The gateway-fee estimate is not the ledger truth.
- The developer code generator produces TypeScript/Node/Bun, PHP/Laravel, Python/httpx and cURL examples for creating/getting/cancelling links and reading payment status. Tokens in generated examples are placeholders; create a real scoped token in `/portal/developers/tokens`.
- The guide teaches five webhook checks: require `X-PG-Signature`, recompute over the raw body in constant time, verify amount/currency against the created payment, deduplicate by event id and return 2xx quickly while queueing slow work.
- Deep links: `/portal/guide?chapter=M-06`, `/portal/guide/developers?chapter=D-04`, and `?search=<term>` pre-fills search.
- The shell `Ctrl+K`/`Cmd+K` opens merchant guide search; `?` opens the merchant contextual-help drawer. The drawer maps all 16 routes to M/D chapters and uses the same content modules as the full guide.
- Guide v2 is **not** implemented. Merchant content remains the 10+5 baseline; the context map, safeguard cards, playbook and read tracking are future work.

## 8. UI system, tables and exports

- The merchant portal mirrors the admin design system: the same `--pg-*` token sheet, self-hosted Plus Jakarta Sans/Cairo/JetBrains Mono fonts, Vuetify defaults, flat surfaces, semantic status colors, 36 px buttons and outlined compact fields.
- The authenticated shell is a 56 px app bar plus a 248 px drawer (temporary on compact screens) with Overview, Money, Commerce and Developer sections, breadcrumbs, guide search, help, theme/language controls and an operator card showing merchant role plus maker/checker dots.
- The shared primitives are `PageHeader`, `StatusBadge`, `MoneyDisplay`, `MonoRef`, `MetricStrip`, `SurfaceCard`, `FormModal`, `FormField`, `SlideOverDrawer`, `DescriptionList`, `SegmentedTabs`, `EmptyState`, `JsonDiffViewer`, plus `SurfaceCardText`, `MetaPill`, `FormChecklist` and `SummaryExportCard`.
- Tables use the copied shared table subsystem: compact neutral rows, semantic badges, collapsible filters, one primary row action plus `TableRowActions` overflow, and shared XLSX export. Table-header exports follow the admin convention of exporting the rendered page only. The action column is sticky to the inline end and a row right-click / `Shift+F10` opens the same actions (primary action first), while the visible overflow button remains the touch path.
- Statement export and any other spreadsheet output go through the shared XLSX pipeline. Do not add a page-local spreadsheet library or floating-point money formatting.

## 9. i18n, RTL and authority conventions

- Locales are Arabic (`ar`) and English (`en`). Arabic is the default: `locale-name` is treated as English only when stored as exactly `en`; otherwise the app starts in Arabic.
- The locale is stored in `localStorage`, applied to `<html lang>`/`dir` (`rtl` for Arabic, `ltr` for English) and passed to Vuetify's locale adapter.
- User-facing text comes from `src/constants/i18nCatalogue.ts` as `[English, Arabic]` pairs plus Vuetify messages. Keep both catalogues in sync.
- Guide content has per-chapter English/Arabic titles and bodies; coverage is chapter-dependent, with fallback to the other language where the UI supports it.
- Route authorities use OR semantics. A missing/empty entry means no UI gate. Backend authorization and merchant scoping remain authoritative.
- The UI shows maker/checker posture but is not a complete pending-change diff workflow for every sensitive object.

## 10. Deployment and runtime behavior

- The deploy engine builds `merchant-front` with `bun run build` and syncs `dist` to the merchant host.
- Nginx serves the SPA with history fallback and proxies `/api/` to `merchant-back`. The merchant host is public-facing with deploy-managed TLS (`certbot`, `custom` or `self_signed`).
- The production SPA uses same-origin `/api`; `VITE_API_URL` is a development convenience only.
- There is no `runtime-config.js` and no deploy-generated SPA visibility flag for merchant-front. Merchant deploy variables cover host, ports, SSL/domain and remote directory.
- The browser never receives core credentials. `merchant-back` holds the mTLS client identity and forwards authorized/merchant-scoped requests to `core-back`.

## 11. Testing and troubleshooting

### Recommended checks

```bash
bun run type-check
bun run lint
bun run test:unit
bun run build
```

Relevant browser suites (from `tests/`): merchant shell, auth, accessibility and exhaustive merchant surface. They require the running stack.

### Common problems

| Symptom | Check |
| :--- | :--- |
| Login redirects or session drops | The API returned 401 or the app-suspended error; the client logs out. Confirm `merchant-back` is reachable at `/api` and `VITE_API_URL` points at port 4102 in dev. |
| A portal page is missing from navigation | The section item is filtered by authority. Hiding a nav item does not prove the route is protected. |
| Direct `/portal/statements` opens for a user without statement authority | Known router gap: the route has no `routesAuthorities` entry. The merchant API remains authoritative; do not treat the page shell as access. |
| Statement export does nothing | Select a wallet first. The export button is disabled until a wallet is selected. |
| Onboarding looks complete but live payments are blocked | Onboarding/client progress is not activation. Wait for admin KYB approval and `ACTIVE` status. |
| Guide checklist state is wrong | It is localStorage-backed and auto-detected from list calls; it can differ from the server. Verify the actual portal state. |
| POS screen stops updating | The screen consumes an SSE stream and exposes a manual refresh. A dropped stream is a display issue, not payment confirmation. |
| API token is lost | The plaintext secret is shown once. Revoke the token and create a new one. |
| Credential secret cannot be viewed | Secrets are write-only after save. Replace/rotate instead of expecting to read them back. |
| Google sign-in does not work | The API map includes `/auth/google`, but the backend returns 501 and no working Google flow ships. Use the supported login flow. |
| Guide v2 features are missing | Guide v2 is future/unimplemented; the current content is the 10 operations + 5 developer chapter baseline. |

## 12. References

- Generated workspace blueprint: [blueprint.md](blueprint.md)
- Canonical design parts:
  - [Merchant Portal](../project-design/parts/04-merchant-front/00-portal.md)
  - [Merchant Guide and Developer API](../project-design/parts/04-merchant-front/01-guide-and-developer-api.md)
- Generated appendices: [environment and config matrix](../project-design/appendices/env-and-config-matrix.md), [API route matrix](../project-design/appendices/api-route-matrix.md), [test inventory](../project-design/appendices/test-inventory.md)
- Related: [Admin Guide v2](../project-design/parts/03-admin-front/06-guide-v2.md) (admin portal only; the merchant guide is separate)

## Environment file (2026-11-05)

The real `.env` is no longer tracked. On a fresh clone run `cp .env.example .env`. Optional: `VITE_CHECKOUT_BASE_URL` (checkout link base; falls back to `location.origin`) and `VITE_IDENTITY_HOSTS` (https hosts allowed for Google sign-in redirects; default `accounts.google.com`). See `project-design/parts/` for the frontend security notes and `project-design/TRACKER.md` for open gaps.

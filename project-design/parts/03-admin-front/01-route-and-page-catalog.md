---
id: admin-ui.routes
title: Admin Route and Page Catalog
status: partial
confidence: high
last_verified: 2026-11-10
verified_against: 5a24f6f+working-tree
code:
  - admin-front/src/router/index.ts
  - admin-front/src/layouts/sections.tsx
  - admin-front/src/pages/**
  - merchant-front/src/router/index.ts
  - merchant-front/src/layouts/sections.tsx
  - merchant-front/src/pages/**
  - checkout-front/src/router/index.ts
  - checkout-front/src/pages/**
  - admin-front/src/utils/routeAuthorities.ts
  - admin-front/src/pages/wallets/**
  - admin-front/src/components/ledger/**
  - admin-front/src/pages/applications/**
  - admin-front/src/pages/transactions/**
  - admin-front/src/pages/credential-sets/**
  - admin-front/src/pages/finance/journal-entries/**
  - admin-front/src/pages/system/jobs-outbox/**
design_sources:
  - design/06-ui/portal_ui_implementation_plan.md
  - design/10-fixes/_0001_operator_cases.md
  - design/07-guides-and-academy/guide_system_design_and_content.md
tests:
  - tests/e2e/admin/shell.spec.ts
  - tests/e2e/admin/wallet-details.spec.ts
  - tests/unit/wallet-details.test.ts
  - tests/e2e/exhaustive/exhaustive-admin-surface.spec.ts
  - tests/e2e/exhaustive/exhaustive-merchant-surface.spec.ts
  - tests/e2e/exhaustive/exhaustive-checkout-surface.spec.ts
  - tests/e2e/admin/global-search.spec.ts
  - tests/unit/frontend-security-admin.test.ts
  - tests/unit/commerce-actions.test.ts
  - tests/unit/ledger-ops-ledger.test.ts
  - tests/unit/ledger-ops-operations.test.ts
gaps:
  - The merchant Statements route has no router-level authority entry even though navigation hides it without statement authority.
  - The checkout catch-all NotFound page links to a non-existent Dashboard route, so its recovery button returns to the catch-all.
  - The admin route table is advisory and must stay aligned with core authority names; a mismatch hides a page the server would allow (or shows one it denies).
---

# Admin Route and Page Catalog

## 1. Purpose and scope

This part records every protected admin route, the merchant portal routes, and the public checkout routes as they are defined in the router tables. It identifies each route's purpose, UI authority gate, role restriction, and contextual-help mapping, and it records where the UI gate is absent even though the backend still authorizes the request.

It does not define the backend authority matrix or duplicate the API surface. It also does not claim that a UI gate is a security boundary: `core-back` and the edge BFFs re-check every protected request.

## 2. Design intent (extracted and synthesized from ./design)

The route design follows five rules:

1. **One explicit router table per SPA.** Admin, merchant, and checkout use `createRouter` with explicit route records; admin does not use file-based routing.
2. **Navigation and route gates are separate.** `layouts/sections.tsx` decides what is visible; `routesAuthorities` decides whether a direct navigation is allowed. A hidden item is not automatically protected, and a missing route gate is not automatically denied.
3. **Parent names drive active state and help.** Detail routes set `meta.parentName` so the parent navigation item is highlighted and the contextual-help drawer resolves the parent's guide mapping.
4. **Roles are layered on authorities.** Admin AML routes additionally require a `COMPLIANCE` or `MLRO` role. No other admin route has a role restriction.
5. **The backend is authoritative.** UI checks are advisory and server-side authority checks remain the real boundary.

The historical operator-case design also expects a dedicated operator-case inquiry schedule route; that is implemented as `GatewayInquirySchedules` rather than a separate top-level module.

## 3. As-built architecture

### 3.1 Admin router composition

`admin-front/src/router/index.ts` defines:

- One protected parent at `/` using `layouts/default`, with 37 child route records.
- One visitor-only login route at `/login`.
- One catch-all `NotFound` route.
- A global `beforeEach` guard that redirects unauthenticated users to `Login` with a `redirect` query, redirects authenticated visitors to `Dashboard`, checks `routesAuthorities[name]`, and then checks `routesRoles[name]`.
- A global `afterEach` that clears route loading/error and dynamic-import retry state.
- A dynamic-import retry path for stale chunk errors.

`admin-front/src/layouts/sections.tsx` groups visible navigation into Overview, Onboarding, Governance, Operations, Finance, Gateways, and Learning. Sections and route items are filtered by their `if` callbacks. Empty sections are removed.

### 3.2 Admin protected routes (48)

The authority column is the UI gate. "None" means no effective `routesAuthorities` entry; the backend may still require an authority. Help shows the guide screen used by the generated context map; "none" means no mapping resolves.

| # | Path | Name | UI authority / role | Help | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `/dashboard` | `Dashboard` | `[]` (authenticated only) | 1 / 1.1 | Live platform health, volume, queues, recent activity, snapshot export. |
| 2 | `/join-requests` | `JoinRequests` | `joinrequests.review` | 9 / 9.1 | Onboarding application queue, SLA health, summary export. |
| 3 | `/join-requests/new` | `JoinRequestNew` | `joinrequests.review` | 9 / 9.1 via parent | Admin-assisted onboarding package creation. |
| 4 | `/join-requests/:id` | `JoinRequestDetail` | `joinrequests.review` | 9 / 9.1 | Review profile, owners, documents, checklist, decisions, audit. |
| 5 | `/kyb` | `KybReview` | `kyb.review` | 9 / 9.3 | KYB document queue, integrity, expiry and duplicate review. |
| 6 | `/kyb/:id` | `KybReviewDetail` | `kyb.review` | 9 / 9.3 | Document inspection and per-document disposition. |
| 7 | `/merchants` | `Merchants` | `merchants.read` or `support.read_merchant` | 9 / 9.4 (broken) | Merchant portfolio, risk/KYB posture, governed changes. |
| 8 | `/merchants/:id` | `MerchantDetail` | `merchants.read` or `support.read_merchant` | 9 / 9.4 (broken) | Merchant 360, transactions, wallets, finance, compliance, audit. |
| 9 | `/approvals` | `Approvals` | `approvals.approve` or `approvals.reject` | 2 / 2.4 | Maker-checker queue, diffs, approve/reject, bulk reject, export. |
| 10 | `/users` | `AdminUsers` | `[]` (none; backend `user:read`/`security:read`) | none | Admin operator list, invite, edit, status, authority posture. |
| 11 | `/users/:id` | `AdminUserDetail` | none (parent `AdminUsers`) | none | Operator identity, authorities and access history. |
| 12 | `/audit-logs` | `AuditLog` | `security:read` | none | Immutable operator/system activity, detail drawer, export. |
| 13 | `/aml/cases` | `AmlCases` | `aml.read_confidential` + role `COMPLIANCE`/`MLRO` | 10 / 10.1 | AML case investigation, proposal and escalation. |
| 14 | `/aml/screenings` | `AmlScreenings` | `aml.read_confidential` + role `COMPLIANCE`/`MLRO` | 10 / 10.1 | Sanctions/PEP screening queue and match disposition. |
| 15 | `/aml/rules` | `AmlRules` | `aml.read_confidential` + role `COMPLIANCE`/`MLRO` | 10 / 10.1 | AML rule versions, thresholds and maker-checker drafts. |
| 16 | `/aml/reports` | `AmlReports` | `aml.read_confidential` + role `COMPLIANCE`/`MLRO` | 10 / 10.1 | Regulatory report drafting, payload/output review, generation, submission and acknowledgement. |
| 17 | `/aml/reporting-studio` | `AmlReportingStudio` | `aml.read_confidential` + role `COMPLIANCE`/`MLRO` | 10 / 10.1 | Declarative XML/XLSX schema registry, compile/simulate, promotion and default bindings. |
| 18 | `/operator-cases` | `OperatorCases` | `case:read` or `operator:read` | 7 / 7.2 | UNKNOWN/conflict/reconciliation operator queue. |
| 19 | `/operator-cases/inquiries` | `GatewayInquirySchedules` | `case:read` or `operator:read` | 7 / 7.2 | Gateway inquiry schedule monitoring, run/retry/cancel. |
| 20 | `/operator-cases/:id` | `OperatorCaseDetail` | `case:read` or `operator:read` | 7 / 7.2 | Case evidence, step logs, inbound events, maker-checker resolution. |
| 21 | `/disputes` | `Disputes` | `dispute:read` | 11 / 11.1 | Chargeback queue, evidence deadlines, adjustment linkage. |
| 22 | `/adjustments` | `Adjustments` | `adjustments.propose` | 11 / 11.2 | Refund/manual adjustment drafting and review. |
| 23 | `/cashouts` | `CashOuts` | `cashout.process` | 12 / 12.1 | Cash-out processing with wallet, destination and AML checks. |
| 24 | `/reconciliation` | `Reconciliation` | `reconciliation.run` or `reconciliation.resolve` | 8 / 8.2 | Statement upload, run monitoring and variance resolution. |
| 25 | `/finance/pricing` | `PricingControls` | none (nav hides without `profit.read`/`liquidity.read`) | none | Commission profiles and velocity controls under governance. |
| 26 | `/finance/profitability` | `Profitability` | `profit.read` | 12 / 12.1 | Gross commission, gateway cost and net contribution. |
| 27 | `/finance/liquidity` | `Liquidity` | `liquidity.read` | 12 / 12.1 | Treasury cover, clearing ageing, cash-out demand and holds. |
| 28 | `/finance/invariant` | `Invariant` | `profit.read` or `liquidity.read` | 12 / 12.1 | Double-entry invariant, treasury cover and account balances. |
| 29 | `/gateways` | `Gateways` | `gateways.edit` | 6 / 6.1 | Gateway portfolio, version state, rollback and creation. |
| 30 | `/gateways/ai-import` | `GatewayAiImport` | none (direct URL; not in nav) | 6 / 6.2 | External-AI integration spec import with local/backend verification. |
| 31 | `/gateways/wizard/:id` | `GatewayWizard` | `gateways.edit` | 6 / 6.1 | Eight-step gateway version wizard. |
| 32 | `/rails` | `Rails` | `gateways.edit` | 3 / 3.2 | Rail catalog, collection modes and customer fields. |
| 33 | `/routes` | `GatewayRoutes` | `gateways.edit` | 3 / 3.2 | Route priority, limits, credential policy and circuit-breaker health. |
| 34 | `/guide` | `AdminGuide` | none (intentional) | 1 / 1.1 | Interactive admin system guide, glossary, simulators and checklists. |
| 35 | `/reports/catalog` | `ReportsCatalog` | `reports.run`/`reports.draft`/`report_engine:run`/`report_engine:author`/`report:review`/`report:approve`/`security:write` | none | Published report catalog, language prompt, typed inputs, preview and print. |
| 36 | `/reports/studio` | `ReportsStudio` | `reports.studio`/`reports.draft`/`report_engine:author`/`report:review`/`report:approve`/`security:write` | none | AI transcript, JSON spec editor, five-layer verification, authority override and publish. |
| 37 | `/reports/chrome` | `ReportsChrome` | `reports.studio` (projected from `report_engine:author`) | none | Reusable header/footer registry and single global default per type. |
| 38 | `/reports/merchant-reports` | `ReportsMerchantReports` | `report:review`/`report:approve`/`security:read`/`security:write` | none | Merchant-authored report registry, per-merchant execution history, Studio suspend/resume. |
| 38 | `/academy` | `AdminAcademy` | none (intentional learning) | 1 / 1.1 | Employee Academy home (full-width hero with the single Continue action and progress rings, tracks, certificates list, Guide reading). Sub-routes `AdminAcademyTracks`, `AdminAcademyTrack`, `AdminAcademyModule`, `AdminAcademyLesson`, `AdminAcademyLab`, `AdminAcademyExam`, `AdminAcademyCertificate`, `AdminAcademyHelp` (none gated) and `AdminAcademyTeam` (role `SECURITY_ADMIN`); see `03-guide-and-academy.md` §7. |
| 39 | `/settings/platform` | `AdminPlatformSettings` | none (backend `settings:read`/`settings:write`) | none | Versioned platform settings, backup export and restore preview. |
| 40 | `/settings/checkout-help` | `AdminCheckoutHelp` | none (backend `settings:read`/`settings:write`) | 4 / 4.2 | Checkout support config, preview, version history and diff. |
| 41 | `/system/backups` | `SystemBackups` | `security:read` or `gateway:read` | none | WAL/daemon/target health, backup history, drills and policy. |
| 42 | `/guide/book/:bookId` | `AdminGuideBook` | none (learning surface) | 1 / 1.1 | One guide book with ordered articles and progress. |
| 43 | `/guide/a/:articleId` | `AdminGuideArticle` | none (learning surface) | 1 / 1.1 | Guide article reader with glossary, TOC, widgets and read tracking. |
| 44 | `/guide/glossary/:slug?` | `AdminGuideGlossary` | none (learning surface) | 13 / 13.1 | A–Z glossary and deep-linkable term detail. |
| 45 | `/guide/tools/:tool?` | `AdminGuideTools` | none (learning surface) | 1 / 1.1 | Five client-only teaching simulators. |
| 46 | `/guide/playbook/:id?` | `AdminGuidePlaybook` | none (learning surface) | 10 / 10.1 | Symptom-to-action situation playbook. |
| 47 | `/guide/cards/:id?` | `AdminGuideCards` | none (learning surface) | 1 / 1.1 | Safeguard checklist card catalog. |
| 48 | `/guide/edge-cases` | `AdminGuideEdgeCases` | none (learning surface) | 13 / 13.5 | Filterable 140-case edge-case catalog. |

Public admin routes are `/login` (`Login`, visitor-only) and the catch-all `NotFound`. The root `/` redirects to `Dashboard`.

### 3.3 Merchant portal routes (16)

`merchant-front/src/router/index.ts` defines public `Landing`, `Login`, `Register`, and `NotFound`, plus 16 protected children under `/portal`.

| # | Path | Name | UI authority | Help chapter | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `/portal/dashboard` | `Dashboard` | `stats.read` | M-02 | Wallet, volume, success rate and recent payments. |
| 2 | `/portal/onboarding` | `Onboarding` | `[]` (authenticated only) | M-01 | Five-step KYB, owners, documents, payout and submission. |
| 3 | `/portal/guide` | `MerchantGuide` | none (learning surface) | M-01 | Merchant operations guide and fee/code tools. |
| 4 | `/portal/guide/developers` | `MerchantDeveloperGuide` | none (learning surface) | D-01 | Developer API chapter reader and code templates. |
| 5 | `/portal/wallets` | `Wallets` | `wallets.read` | M-07 | Wallet balances, pending/negative amounts and wallet creation. |
| 6 | `/portal/statements` | `Statements` | **none (gap)** | M-07 | Monthly wallet statement and XLSX export. |
| 7 | `/portal/applications` | `Applications` | `applications.read` | M-02 | Applications, environments, wallet assignment and sensitive proposals. |
| 8 | `/portal/links` | `Links` | `links.read` | M-03 | Payment-link creation, QR, attempts inspector and cancellation. |
| 9 | `/portal/pos` | `PosTerminals` | `pos.manage` or `pos.operate` | M-05 | Terminals and paired customer screens. |
| 10 | `/portal/pos/screen/:code` | `PosScreen` | `pos.manage` or `pos.operate` | M-05 | Full-screen live POS status via SSE. |
| 11 | `/portal/payments` | `Payments` | `payments.read` | M-06 | Payment list, status, commission and net. |
| 12 | `/portal/disputes` | `Disputes` | `payments.read` | M-08 | Chargeback list and evidence upload. |
| 13 | `/portal/cashouts` | `Cashouts` | `cashout.read` or `cashout.request` | M-07 | Cash-out requests and bank destination details. |
| 14 | `/portal/developers/tokens` | `DeveloperTokens` | `tokens.read` | D-02 | API token creation, scopes, revocation and IP allowlists. |
| 15 | `/portal/credentials` | `Credentials` | `credentials.manage` | M-09 | Merchant-owned gateway credential sets. |
| 16 | `/portal/team` | `Team` | `users.manage` | M-10 | Team members, roles, scopes and authorities. |

### 3.4 Checkout routes

`checkout-front/src/router/index.ts` defines three route records and no authentication guard:

| Path | Name | Behavior |
| :--- | :--- | :--- |
| `/` | `Home` | Redirects to `NotFound`. |
| `/pay/:linkKey` | `Pay` | Payer summary, rail form, action renderer, confirmation and receipt. |
| `/:pathMatch(.*)*` | `NotFound` | Token-styled 404 page; its `Dashboard` button targets a route that does not exist in this SPA. |

## 4. Contracts and invariants

1. **Protected route count is 38.** The generated catalog and tests must treat the 38 children under `/` as the protected admin surface; `/login` and `NotFound` are excluded.
2. **Merchant protected route count is 16.** Public landing/login/register/not-found are excluded.
3. **A UI gate exists only when the authority array is non-empty.** `[]`, `undefined`, and a missing key all behave as "no UI gate".
4. **Authority checks use OR semantics.** `hasOneOfAuthorities` accepts any listed authority.
5. **Role checks are additional.** AML routes require an allowed role after the authority check.
6. **Unauthenticated protected navigation goes to `Login`.** Admin preserves a `redirect` query; merchant does not.
7. **`meta.parentName` controls active navigation and contextual help.** Detail routes often use the parent's guide chapter.
8. **The backend re-checks authorities.** No UI route table is a security authority.

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Admin routes | `admin-front/src/router/index.ts` |
| Admin navigation and gates | `admin-front/src/layouts/sections.tsx` |
| Merchant routes | `merchant-front/src/router/index.ts` |
| Merchant navigation and gates | `merchant-front/src/layouts/sections.tsx` |
| Checkout routes | `checkout-front/src/router/index.ts` |
| Admin help map | `admin-front/src/content/guide/generated/context-map.json` |
| Merchant help map | `merchant-front/src/components/guide/ContextualHelpDrawer.tsx` |

### 5.1 Missing admin UI authority gates

| Route | Actual UI behavior | Backend evidence | Classification |
| :--- | :--- | :--- | :--- |
| `AdminUsers` | `routesAuthorities.AdminUsers = []`, so any authenticated admin can open it. | `/users` requires `user:read` or `security:read`; mutations require `user:write`/`security:write`. | Privilege gap. |
| `AdminUserDetail` | No entry; direct navigation is allowed. | `/users/:id` requires `user:read` or `security:read`. | Privilege gap. |
| `PricingControls` | No entry; only the nav item is hidden without `profit.read`/`liquidity.read`. | Commission/velocity endpoints require finance/commission/velocity authorities. | Privilege gap. |
| `GatewayAiImport` | No entry; it is reachable by URL even though it is not in the nav. | AI transcript/spec endpoints require `gateway:read`/`gateway:write`. | Privilege gap. |
| `AdminPlatformSettings` | No entry; any authenticated admin can open the page. | Settings reads require `settings:read`; writes require `settings:write`. | Privilege gap. |
| `AdminCheckoutHelp` | No entry; any authenticated admin can open the page. | Checkout-support reads require `settings:read`; writes require `settings:write`. | Privilege gap. |
| `AdminGuide` | No entry. | No business-data authority required. | Intentional learning surface. |
| `AdminAcademy*` | No entry (only `AdminAcademyTeam` has a role gate: `SECURITY_ADMIN`). | Progress and exams need only a back-office session; the team view requires the `SECURITY_ADMIN` role in admin-back and core-back. | Intentional learning surface; exams are server-graded. |

The merchant portal has a similar gap: `Statements` is shown in navigation only with `statements.read`/`statements.export`, but `routesAuthorities` has no `Statements` entry, so a direct URL is not redirected by the router. `Onboarding` intentionally has `[]` because every authenticated merchant must complete it.

## 6. Operational usage

- Adding an admin page: add the explicit router record, the navigation item, the authority entry, and a `context-map.json` screen/route-name entry in the same change.
- Adding a detail page: set `meta.parentName` so navigation/help resolve to the parent; if the parent has no context-map screen, add the route name to the owning screen or `General`.
- Adding a merchant page: add the route, section item, `routesAuthorities` entry (unless intentionally open), and the merchant `ROUTE_HELP` entry.
- Adding a checkout page: keep the router minimal; do not assume the `Dashboard` route exists.
- Testing a route: verify both the hidden-navigation case and the direct-URL case; a hidden nav item is not a route gate.

## 7. Status and deviations

### Implemented

- 37 protected admin routes with explicit components and names.
- 16 protected merchant routes plus public landing/login/register/not-found.
- Three checkout route records (home redirect, payer page, catch-all).
- Authority and role guards in admin and merchant routers.
- Parent-aware navigation, breadcrumbs, and contextual-help lookup.
- Admin dynamic-import retry and route error state.

### Partial

- Merchant `Statements` is not route-gated.
- Contextual help covers most admin routes but not all (see `04-contextual-help.md`).
- The admin route-authority table is advisory and must be kept in sync with core; the Guide/Academy reader routes are login-only and the Team page keeps its own `SECURITY_ADMIN` check.

### Missing / deferred

- No generated route-authority matrix test that fails when a protected route has no gate.
- No shared route metadata between the router, navigation, guide map, and tests.
- No checkout home page; `/` is a 404 redirect.

### Known bugs / risks

- **Checkout 404 recovery bug:** `checkout-front/src/pages/public/not-found/index.tsx` links to `{ name: "Dashboard" }`, but the checkout router has no `Dashboard` route. The recovery button leads back to the catch-all.
- **Admin help gap:** `Merchants` and `MerchantDetail` point to Book 9 Chapter 9.4, but the chapter object lives in Book 7's `chapters` array, so no chapter resolves.
- **Admin help gap:** `AdminUsers`, `AdminUserDetail`, `AuditLog`, `PricingControls`, `AdminPlatformSettings`, and `SystemBackups` have no effective help chapter.
- **Documentation gap:** the stale design claim of 36 admin routes / 15 merchant routes is superseded by the current 37 / 16 counts.

## 8. Verification and tests

- `tests/e2e/admin/shell.spec.ts` checks that every navigation destination renders, that role/authority-hidden sections behave, that direct access to a denied page redirects, and that the shell is responsive.
- `tests/e2e/exhaustive/exhaustive-admin-surface.spec.ts` enumerates the admin route list, including `/guide`, `/academy`, and `/settings/checkout-help`.
- `tests/e2e/exhaustive/exhaustive-merchant-surface.spec.ts` enumerates merchant portal routes.
- `tests/e2e/exhaustive/exhaustive-checkout-surface.spec.ts` enumerates the checkout surface.
- `tests/e2e/admin/global-search.spec.ts` verifies deep links to records open the expected drawers.

These suites require a running stack and are skipped without the live/edge services.

## 9. Source references

### Old design sections

- `design/06-ui/portal_ui_implementation_plan.md` — page and shell rollout.
- `design/10-fixes/_0001_operator_cases.md` — operator-case and inquiry workflow.
- `design/07-guides-and-academy/guide_system_design_and_content.md` — current guide routes, context map and content.

### Code paths

- `admin-front/src/router/index.ts`
- `admin-front/src/layouts/sections.tsx`
- `admin-front/src/pages/**`
- `merchant-front/src/router/index.ts`
- `merchant-front/src/layouts/sections.tsx`
- `merchant-front/src/pages/**`
- `checkout-front/src/router/index.ts`
- `checkout-front/src/pages/public/not-found/index.tsx`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/code-surface-map.md`

## 10. Change history

- 2026-11-03 — Initial canonical route catalog. Confirms 37 admin protected routes and 16 merchant portal routes, records missing UI authority gates, the broken 9.4 help chapter placement, and the checkout 404 recovery bug.

## Security hardening (2026-11-05)

The `VITE_AUTHORIZED` bypass was removed. The route authority table moved to `src/utils/routeAuthorities.ts` with a default-deny guard. `PUBLIC_FOR_AUTHENTICATED` covers Dashboard, every Guide reader route and every Academy route (the Team page keeps its own `SECURITY_ADMIN` check); `AUTHORITY_ALIASES` normalizes dotted and colon forms. AdminUsers/Detail accept `user:read`/`user:write`/`security:*`, AdminPlatformSettings accepts `settings:read`/`settings:write` (plus the security fallback), and PricingControls includes `liquidity.read`. These checks are advisory; core enforces authorities. Any route not in the table is denied to authenticated users unless it is in `PUBLIC_FOR_AUTHENTICATED`.

## Admin UI completion: six new routes (2026-11-06)

Six protected children were added to `admin-front/src/router/index.ts` (and the sidebar in `layouts/sections.tsx`, authorities in `utils/routeAuthorities.ts`, guide context-map screens). The numbered table in 3.2 and the "37" counts in this part predate the Guide/Academy routes; the router now has **60** protected children (the six below included), so treat the table as a historical catalog and this section as current for these routes.

| Path | Name | Sidebar section | UI authority | Backend authority | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `/wallets` | `Wallets` | Onboarding | `merchants.read` or `support.read_merchant` | `merchant:read` (freeze `merchant:write`) | Cross-merchant wallets: KPI strip, live/checkpoint balance ("Restricted" for non-financial roles), freeze (immediate) / unfreeze (approval) from the row menu. **Inspect** (or the wallet id) navigates to `WalletDetail`; `?open=<id>` redirects there. "Inspect GL account" still opens the GL drawer. |
| `/wallets/:id` | `WalletDetail` (`meta.parentName: Wallets`) | Onboarding | same as `Wallets` | `merchant:read` (freeze `merchant:write`) | Wallet details page replacing the old wallet drawer: header with status badge, frozen banner, pending approvals, Freeze/Request unfreeze, Refresh; metric strip (live, checkpoint, posted since checkpoint, pending cash-outs). `?tab=` (`overview` default, `statement`, `links`, `activity`): Overview (details card, shard table with a padded **Total** row and a shards-vs-live-balance integrity badge), Statement (`AccountLinesTable`: server-paginated posting lines with side/reference-type/date filters, search, totals of the whole filtered set, links to the source record and to the journal entry drawer), Links and cash-outs (assigned applications, last 10 cash-outs), Status history (`/wallets/:id/audit-events`: when, action, change, reason, by, approval). Merchant 360 and the application drawer link here. |
| `/applications` | `Applications` ("Applications & Channels") | Onboarding | same | `merchant:read` / `merchant:write` | Tabs Applications, Payment Links, POS Terminals; drawer with rail whitelist, redirect domains, API tokens (revoke), link cancel, terminal status; suspend immediate, reactivation and policy edits go to approval. `?tab=links\|pos`, `?open=<id>`. |
| `/transactions` | `Transactions` ("Transactions & Webhooks") | Operations | `merchants.read`, `support.read_merchant` or `attempt:read` | `attempt:read` (+`merchant:read`/`finance:read`) | Tabs Payment Attempts and Inbound Webhooks (verified / unmatched filters); the attempt drawer shows summary, step logs, inbound events and the checkout retry group as structured rows. |
| `/credential-sets` | `CredentialSets` | Gateways | `credentials.manage` or `gateways.edit` | `credential:read`/`gateway:read`, `credential:write` | Vault entries: create, rotate, verify, revoke (reason); secrets are write-only. `?highlight=<id>` (from search hits and Merchant 360). |
| `/finance/journal-entries` | `JournalEntries` | Finance | `profit.read` or `liquidity.read` | `finance:read` | Double-entry explorer: balanced badge, T-account drawer, GL account drawer; `?glAccountId=`, `?open=`. |
| `/system/jobs-outbox` | `JobsOutbox` ("Jobs & Outbox") | Operations | `security:read` | `security:read` / `security:write` | Outbox and audit-outbox monitors (no retry exists), background-job requeue, failed-notification retry. The metric strip also shows the ledger automation: shards behind their checkpoint (with the most pending lines), shards failing the checkpoint proof, and the last shard scaling. |

Existing routes that changed: `Invariant` is now "Ledger Audit & Invariant" with per-account actions (shards and lines, journal entries, checkpoint rollup); `MerchantDetail` shows the Wallets tab to every `merchant:read` role and gained interactive wallets/applications, structured beneficial owners, KYB revalidation, access rows and pending-change diffs; `Gateways` gained a route-health drawer; `Liquidity` shows route daily-cap utilisation; `GatewayRoutes`, `AdminPlatformSettings`, `Reconciliation`, `AmlRules`, `Rails`, `Approvals`, `AuditLog`, `Disputes`, `PricingControls` lost their raw-JSON views/inputs (see `admin-ui.system`). The GL account drawer (`GlAccountDrawer`) shows the routing width, a derived checkpoint status badge, a per-shard table (balance, lines, pending, checkpoint, checkpoint age, status, padded Total row), the paginated Lines table, "Run checkpoint rollup" (verifies every shard, names a failing one) and "Set shard count" (`finance:write`, reason, audited) and, per failed shard, **Repair** (`ShardRepairModal`: preview from the journal; an intact shard is recomputed at once with a reason, a damaged one is submitted to Approvals as `GL_SHARD_REPAIR`). Shared drawers are opened by id prop and clear themselves on `close`: `JournalEntryDrawer`, `GlAccountDrawer`, `WalletDetailDrawer`, `ApplicationDetailDrawer`. `attempt:read` was added to `AUTHORITY_ALIASES` (no portal equivalent).

Gaps: the dashboards/global search still route `payment_attempt` hits to Merchant 360's transactions tab (a test pins it; `Transactions?open=` would be a one-line change); approvals' "Open subject" has no target for `WALLET`/`APPLICATION`/`POS_TERMINAL`; merchant users open the `AdminUserDetail` route (works: `GET /users/:id` serves any user id).

## Remediation round 2 (2026-11-08): invitation route

`/accept-invitation` (`pages/public/auth/accept-invitation`) is a public route reached from the invitation message; the Users page creates users without a password and shows invitation state with a re-invite action; the login page links to nothing new.

## Reporting Studio completion, incidents and filing adapters (2026-11-10)

- `/reporting-studio` (`AmlReportingStudio`) now includes a workbook-template card on XLSX schemas: upload, analysis summary, named-range/sheet/column mapping and save; a rule-schema override panel that submits each rule's XML/XLSX/DOCX binding for approval; DOCX as a schema format with a narrative-JSON definition; and a "Filing adapters" route is available from the Compliance menu.
- `/incidents` (`Incidents`) is the expanded incident workspace: filters, severity/status metrics, create dialog and a detail drawer with Overview (timeline timestamps, impacted services, links), Timeline, Responders, Actions, Communications and Postmortem. Status transitions are offered only when the core lifecycle allows them; a regulatory report can be drafted from the incident.
- `/filing-adapters` (`FilingAdapters`) lists manual/HTTP adapters, shows authority/kind/status/endpoint/last use, creates an adapter with an HTTPS endpoint and optional encrypted auth secret, and disables an adapter. The AML report drawer offers an active HTTP adapter and a "File via adapter" action for an APPROVED report.

All three routes are gated by `aml.read_confidential` at the edge/UI; writes are re-checked by core.

## Final compliance UI sweep (2026-11-10)

- `Incidents` now uses the shared `ApiTable`/`TableRowActions` surface with server pagination, search, status/severity/category filters, correct server summary metrics, row actions, refresh and confidential badge. The detail drawer resets transient state, preserves the active tab on refresh, supports editing incident facts, commander/reporter names, affected merchant/attempt IDs, regulator notification, link removal, responder acknowledgement/release, full action status changes, communication bodies, postmortem due date and a link to the drafted report.
- `FilingAdapters` uses the shared table surface and exposes edit, re-enable/disable approval requests, secret-present state, endpoint display, confirmation and maker-checker messaging. The create/edit form never sends a blank secret (so an existing secret is kept).
- `AmlReports` filters include INCIDENT, the generic draft dialog no longer offers INCIDENT, and the drawer shows `filingChannel`, external submission history, adapter filing confirmation and reset-safe adapter selection. `AmlReportingStudio` labels DOCX correctly, preserves template analysis after upload, and offers analyze/download/remove plus narrative, total and prototype-row mappings.

## Object & Asset Storage route

| Route | Name | Page | Authorities |
| :--- | :--- | :--- | :--- |
| `/system/object-storage` | `SystemObjectStorage` | `pages/system/object-storage/index.tsx` | `system:storage:read`, `system:storage:admin`, `system:storage:legal-hold` | Operations |

The nav entry is under **Operations** ("Object & Asset Storage") and the route-authority
aliases normalize the colon names to `system.storage` for the UI guard. The page has server-paginated/filtered object and access-log tables, a real quarantine query, a full detail drawer, legal-hold approval requests and maintenance confirmation/results.

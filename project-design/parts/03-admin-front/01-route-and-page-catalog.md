---
id: admin-ui.routes
title: Admin Route and Page Catalog
status: partial
confidence: high
last_verified: 2026-11-03
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
design_sources:
  - design/ui/portal_ui_implementation_plan.md
  - design/fixes/_0001_operator_cases.md
  - design/guide_system_design_and_content (2).md
tests:
  - tests/e2e/admin/shell.spec.ts
  - tests/e2e/exhaustive/exhaustive-admin-surface.spec.ts
  - tests/e2e/exhaustive/exhaustive-merchant-surface.spec.ts
  - tests/e2e/exhaustive/exhaustive-checkout-surface.spec.ts
  - tests/e2e/admin/global-search.spec.ts
gaps:
  - Eight admin route names have no effective UI authority gate; AdminGuide and AdminAcademy are deliberate learning surfaces, while AdminUsers, AdminUserDetail, PricingControls, GatewayAiImport, AdminPlatformSettings, and AdminCheckoutHelp are privilege gaps.
  - The merchant Statements route has no router-level authority entry even though navigation hides it without statement authority.
  - The checkout catch-all NotFound page links to a non-existent Dashboard route, so its recovery button returns to the catch-all.
  - Several admin routes have no contextual-help mapping and no matching guide chapter.
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

### 3.2 Admin protected routes (37)

The authority column is the UI gate. "None" means no effective `routesAuthorities` entry; the backend may still require an authority. Help shows the book/chapter used by `GUIDE_ROUTE_HELP`; "none" means no mapping resolves.

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
| 16 | `/aml/reports` | `AmlReports` | `aml.read_confidential` + role `COMPLIANCE`/`MLRO` | 10 / 10.1 | Regulatory report drafting, submission and acknowledgement. |
| 17 | `/operator-cases` | `OperatorCases` | `case:read` or `operator:read` | 7 / 7.2 | UNKNOWN/conflict/reconciliation operator queue. |
| 18 | `/operator-cases/inquiries` | `GatewayInquirySchedules` | `case:read` or `operator:read` | 7 / 7.2 | Gateway inquiry schedule monitoring, run/retry/cancel. |
| 19 | `/operator-cases/:id` | `OperatorCaseDetail` | `case:read` or `operator:read` | 7 / 7.2 | Case evidence, step logs, inbound events, maker-checker resolution. |
| 20 | `/disputes` | `Disputes` | `dispute:read` | 11 / 11.1 | Chargeback queue, evidence deadlines, adjustment linkage. |
| 21 | `/adjustments` | `Adjustments` | `adjustments.propose` | 11 / 11.2 | Refund/manual adjustment drafting and review. |
| 22 | `/cashouts` | `CashOuts` | `cashout.process` | 12 / 12.1 | Cash-out processing with wallet, destination and AML checks. |
| 23 | `/reconciliation` | `Reconciliation` | `reconciliation.run` or `reconciliation.resolve` | 8 / 8.2 | Statement upload, run monitoring and variance resolution. |
| 24 | `/finance/pricing` | `PricingControls` | none (nav hides without `profit.read`/`liquidity.read`) | none | Commission profiles and velocity controls under governance. |
| 25 | `/finance/profitability` | `Profitability` | `profit.read` | 12 / 12.1 | Gross commission, gateway cost and net contribution. |
| 26 | `/finance/liquidity` | `Liquidity` | `liquidity.read` | 12 / 12.1 | Treasury cover, clearing ageing, cash-out demand and holds. |
| 27 | `/finance/invariant` | `Invariant` | `profit.read` or `liquidity.read` | 12 / 12.1 | Double-entry invariant, treasury cover and account balances. |
| 28 | `/gateways` | `Gateways` | `gateways.edit` | 6 / 6.1 | Gateway portfolio, version state, rollback and creation. |
| 29 | `/gateways/ai-import` | `GatewayAiImport` | none (direct URL; not in nav) | 6 / 6.2 | External-AI integration spec import with local/backend verification. |
| 30 | `/gateways/wizard/:id` | `GatewayWizard` | `gateways.edit` | 6 / 6.1 | Eight-step gateway version wizard. |
| 31 | `/rails` | `Rails` | `gateways.edit` | 3 / 3.2 | Rail catalog, collection modes and customer fields. |
| 32 | `/routes` | `GatewayRoutes` | `gateways.edit` | 3 / 3.2 | Route priority, limits, credential policy and circuit-breaker health. |
| 33 | `/guide` | `AdminGuide` | none (intentional) | 1 / 1.1 | Interactive admin system guide, glossary, simulators and checklists. |
| 34 | `/academy` | `AdminAcademy` | none (intentional learning; overview API needs `user:read`) | 1 / 1.1 | Employee academy, labs, quizzes, tracks and certifications. |
| 35 | `/settings/platform` | `AdminPlatformSettings` | none (backend `settings:read`/`settings:write`) | none | Versioned platform settings, backup export and restore preview. |
| 36 | `/settings/checkout-help` | `AdminCheckoutHelp` | none (backend `settings:read`/`settings:write`) | 4 / 4.2 | Checkout support config, preview, version history and diff. |
| 37 | `/system/backups` | `SystemBackups` | `security:read` or `gateway:read` | none | WAL/daemon/target health, backup history, drills and policy. |

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

1. **Protected route count is 37.** The generated catalog and tests must treat the 37 children under `/` as the protected admin surface; `/login` and `NotFound` are excluded.
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
| Admin help map | `admin-front/src/content/guide/index.ts` |
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
| `AdminAcademy` | No entry. | Self progress needs only authentication; team overview/export needs `user:read`. | Intentional learning surface, with a backend-gated reporting surface. |

The merchant portal has a similar gap: `Statements` is shown in navigation only with `statements.read`/`statements.export`, but `routesAuthorities` has no `Statements` entry, so a direct URL is not redirected by the router. `Onboarding` intentionally has `[]` because every authenticated merchant must complete it.

## 6. Operational usage

- Adding an admin page: add the explicit router record, the navigation item, the authority entry, and the `GUIDE_ROUTE_HELP` mapping in the same change.
- Adding a detail page: set `meta.parentName` so navigation/help resolve to the parent; if the parent has no help mapping, add both.
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

- Admin route authority coverage is incomplete: six privileged surfaces are ungated in the UI.
- Merchant `Statements` is not route-gated.
- Contextual help covers most admin routes but not all (see `04-contextual-help.md`).
- Admin `AdminUsers` explicitly uses an empty authority array while the backend requires `user:read`/`security:read`; this is a deliberate-looking but unsafe pattern.

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

- `design/ui/portal_ui_implementation_plan.md` — page and shell rollout.
- `design/fixes/_0001_operator_cases.md` — operator-case and inquiry workflow.
- `design/guide_system_design_and_content (2).md` — future guide route/context-map expectations (not current).

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

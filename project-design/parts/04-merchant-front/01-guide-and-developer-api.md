---
id: merchant-ui.guide
title: Merchant Guide and Developer API
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - merchant-front/src/content/guide/merchantOperationsGuide.ts
  - merchant-front/src/content/guide/merchantDeveloperApiGuide.ts
  - merchant-front/src/content/guide/types.ts
  - merchant-front/src/pages/guide/index.tsx
  - merchant-front/src/pages/guide/developers/index.tsx
  - merchant-front/src/components/guide/**
design_sources:
  - design/complete_zero_to_hero_guides_and_academy_specification.md
  - design/payment_gateway_deployment_and_guides_architecture.md
tests:
  - merchant-front/src/content/__tests__/content-completeness.test.ts
  - tests/e2e/exhaustive/exhaustive-merchant-surface.spec.ts
  - tests/e2e/merchant/shell.spec.ts
gaps:
  - The merchant guide ships the implemented 10 operations chapters and 5 developer chapters, not the future guide v2 model.
  - The first-5 checklist is stored in localStorage and auto-detected from list endpoints; completion is a convenience signal, not a server-issued onboarding status.
  - The fee calculator is client-side and estimates the gateway fee; it does not call the commission engine.
  - The code generator displays a sample bearer token in the browser; operators must use a real scoped token and never share it.
  - The guide does not include merchant account-specific live data by design, so troubleshooting still requires the portal/POS screens.
---

# Merchant Guide and Developer API

## 1. Purpose and scope

This part owns the merchant-facing interactive guide and developer API reference in `merchant-front`:

- The operations guide content (M-01 to M-10).
- The developer API content (D-01 to D-05).
- The guide page, role filtering, chapter search, first-5 checklist, fee/net settlement calculator, code generator, and webhook verification checks.
- The dedicated developer guide page and its code-template viewer.

It does not own the external API implementation or the merchant portal data pages. It also does not present the future guide v2 workstream as current.

## 2. Design intent (extracted and synthesized from ./design)

The merchant guide is intentionally practical:

1. **Ten operations chapters cover the merchant lifecycle.** Onboarding, wallets/applications, links, fees, POS, payment statuses, statements/cash-outs, disputes/refunds, merchant-owned credentials, and team/roles.
2. **Five developer chapters cover the integration lifecycle.** How the API works, authentication/IP allowlists, money precision and redirect rules, endpoint reference, and production code templates.
3. **Role-aware reading.** Chapters are tagged `MERCHANT_ADMIN`, `MERCHANT_STAFF`, `MERCHANT_CASHIER`, `DEVELOPER`, or `ALL`; the page filters by role.
4. **First-5 checklist.** A new merchant is guided through KYB, first wallet, first application, first link, and POS or API token.
5. **Interactive tooling.** The fee calculator explains the fee-bearer model with decimal.js; the code generator produces runnable TypeScript, PHP, Python and cURL snippets; webhook checks explain signature and replay safety.
6. **Deep links.** `?chapter=` and `?search=` open a specific chapter or filtered view from the shell search.
7. **The guide is content, not a live data console.** It explains rules and workflows; live troubleshooting uses the portal, POS screen and API.

## 3. As-built architecture

### 3.1 Content modules

| Module | Contents |
| :--- | :--- |
| `merchant-front/src/content/guide/types.ts` | `MerchantGuideChapter`, roles, code languages and chapter shape. |
| `merchant-front/src/content/guide/merchantOperationsGuide.ts` | M-01 to M-10. |
| `merchant-front/src/content/guide/merchantDeveloperApiGuide.ts` | D-01 to D-05, including code templates. |

Chapters have an id, number, role, English/Arabic title and body, tags, and optional code templates. The operations guide is the business manual; the developer guide is the integration reference.

### 3.2 Operations chapters (10)

| Id | Role | Title | Core content |
| :--- | :--- | :--- | :--- |
| M-01 | `MERCHANT_ADMIN` | Getting Started — Completing Your KYB Onboarding & Activating Live Payments | KYB, business profile, owners, documents, payout IBAN, review status, resubmission. |
| M-02 | `MERCHANT_ADMIN` | Understanding Wallets & Applications — How Your Store Is Organized | Wallet/ledger relationship, application-to-wallet assignment, descriptive versus sensitive edits. |
| M-03 | `ALL` | Creating Single-Use & Multi-Use Payment Links (`/links`) | Single-use slot lock, multi-use quota, infinite links, redirect allowlist. |
| M-04 | `MERCHANT_ADMIN` | How Commissions & Fee Bearers Work (`MERCHANT_ABSORBS`, `PAYER_SURCHARGE`, `SPLIT`) | Customer total, platform commission, net wallet credit and split examples. |
| M-05 | `MERCHANT_CASHIER` | In-Store Point of Sale (POS) Terminals & Realtime Cashier/Customer Screens (`/pos`) | Terminal creation, screen pairing, live payment display, idle/reconnect behavior. |
| M-06 | `ALL` | Understanding Payment Statuses — When Is It Safe to Hand Over the Goods? | `SUCCEEDED`, `AWAITING_CUSTOMER`, `VERIFYING`/`UNKNOWN`, `FAILED`/`EXPIRED`/`CANCELLED`. |
| M-07 | `MERCHANT_ADMIN` | Reading Your Wallet Balance, Monthly Statements & Requesting Cash-Outs (`/wallets` & `/cashouts`) | Balances, monthly statement, hash-sealed export, cash-out stages. |
| M-08 | `MERCHANT_STAFF` | Responding to Customer Disputes & Refunds (`/disputes` & `/payments`) | Evidence deadlines, reserve, won/lost outcomes, negative-balance ceiling. |
| M-09 | `DEVELOPER` | Using Your Own Gateway Credentials (`MERCHANT_DIRECT` Mode — `/credentials`) | Merchant-owned credential sets, settlement target, commission receivable. |
| M-10 | `MERCHANT_ADMIN` | Managing Your Team, Roles, Application Scopes & Security (`/team`) | Team invitations, roles, scopes, authority principle of least privilege. |

### 3.3 Developer chapters (5)

| Id | Title | Core content |
| :--- | :--- | :--- |
| D-01 | How the API Works From Zero (For Beginners & Architects) | Request/response model, server-side amount authority, payment-link life cycle, idempotency. |
| D-02 | Authentication (`pg_live_` Bearer Tokens) & IP CIDR Allowlists (`/developers/tokens`) | Bearer token creation/revocation, scopes, IP allowlists, secret handling. |
| D-03 | Money Precision Rules & Redirect Allowlists (Avoid These 3 Common Mistakes) | Decimal strings, no floating point, redirect-domain allowlists, no trust in browser return. |
| D-04 | Complete Endpoint Reference (`/api/v1/external/*`) | Create/get/cancel links and get payment status; error envelope and status codes. |
| D-05 | Copy-Pasteable Production Code Templates (Interactive Code Generator) | TypeScript/Node/Bun, PHP/Laravel, Python/httpx, cURL; webhook verification guidance. |

### 3.4 Operations guide page

`merchant-front/src/pages/guide/index.tsx` renders:

- `PageHeader` with the guide title and subtitle.
- A first-5 checklist card:
  1. Pass KYB verification.
  2. Create the first LYD wallet.
  3. Create the first application and connect the wallet.
  4. Create and share a payment link.
  5. Set up a POS screen or an API token.
- A completion progress bar.
- A chapter search field.
- Role filter tabs: All, Business Owner, Manager/Accountant, In-Store Cashier, Developer (API).
- Responsive chapter cards with role badge, tags and a plain-text excerpt.
- A chapter modal with full Markdown render and optional code templates.
- The fee/net settlement calculator.
- The developer API code generator.
- The webhook sample and five verification checks.

#### First-5 checklist behavior

- Persisted in `localStorage` key `merchant-guide-checklist`.
- On mount, the page calls onboarding, wallets, applications, links, POS terminals and tokens list endpoints.
- Auto-detects completed steps from successful list responses and the onboarding status (`APPROVED`, `ACTIVE` or `COMPLETED`).
- Writes the detected state back to localStorage when possible.
- The user can manually toggle a step; storage failures fall back to in-memory state.

This checklist is a guide aid. It does not grant activation and does not replace the server's onboarding/KYB state.

#### Deep links

- `?search=<term>` pre-fills the search field; `?search=1` is treated as an empty search.
- `?chapter=<id>` opens that chapter modal if the id exists.
- The shell guide search routes to `MerchantGuide` with `?chapter=<id>`.

### 3.5 Fee and net settlement calculator

`merchant-front/src/components/guide/MerchantFeeCalculator.tsx` uses `decimal.js` through `toDecimal` and supports:

- Amount, rail, commission percent, gateway fee percent, platform share for split mode.
- Fee bearers: `MERCHANT_ABSORBS`, `PAYER_SURCHARGE`, `SPLIT`.
- Results: customer total, platform commission, estimated gateway fee, exact net wallet credit, and payer share in split/surcharge mode.

Formulas:

- Commission = amount × commission%.
- `MERCHANT_ABSORBS`: customer total = amount; net = amount − commission.
- `PAYER_SURCHARGE`: customer total = amount + commission; net = amount; payer share = commission.
- `SPLIT`: payer share = commission × platform share%; customer total = amount + payer share; net = amount − (commission − payer share).

The gateway fee is estimated on the customer total and shown for transparency. The actual wallet credit follows the selected fee-bearer formula and the server's commission/ledger logic. The calculator is local and does not call the commission engine.

### 3.6 Developer API code generator

The operations guide includes a generator with:

- Application ID, bearer token and payment reference inputs.
- Amount and fee bearer taken from the calculator.
- Language tabs: TypeScript/Node/Bun, PHP/Laravel, Python/httpx, cURL.
- Generated calls:
  - `POST /api/v1/external/links` with `applicationId`, decimal amount, `currency: "LYD"`, `feeBearer`, `infiniteUse`, `useCount`, `redirectUrl`.
  - `GET /api/v1/external/links/:key` to check `state` and `confirmedCount`.
  - `GET /api/v1/external/payments/:reference`.
- A sample webhook request with `X-PG-Signature` and a JSON payload.

The generated token is a placeholder/sample and is displayed in the browser. A real token must be created in `/portal/developers/tokens`, scoped, stored server-side, and never committed or shared.

### 3.7 Webhook checks

The guide lists five checks:

1. Reject any webhook without a valid `X-PG-Signature` header.
2. Recompute the signature over the raw request body and compare in constant time.
3. Compare amount and currency with the payment you created before fulfilling the order.
4. Deduplicate by event id so a retried delivery cannot post twice.
5. Return a 2xx quickly and move slow work to a queue.

The guide also demonstrates the raw-body signing concern: a parsed/re-serialized JSON body can change bytes and break signature verification.

### 3.8 Dedicated developer guide page

`merchant-front/src/pages/guide/developers/index.tsx` renders:

- A PageHeader.
- A pill list of all five D chapters.
- The selected chapter title, id badge and Markdown body.
- A language selector and ready-to-run code templates when present.
- `?chapter=<id>` deep links.

The page uses the same D-01..D-05 content as the operations guide's developer chapter cards, so the two surfaces stay consistent.

### 3.9 Shell search and contextual help

- The merchant shell `Ctrl+K` opens `GlobalGuideSearchModal`, which searches M/D chapters and routes to the appropriate guide route with `?chapter=`.
- The shell `?` opens the merchant contextual-help drawer with the route's M/D mapping.
- The drawer and full guide use the same content modules; the drawer is a narrower, route-specific view.

## 4. Contracts and invariants

1. **Merchant guide content is 10 operations chapters + 5 developer chapters.** Do not split or merge them without updating the content test and the role mapping.
2. **Roles filter, not authorize.** A role tag controls presentation; the portal route authorities and backend decide access.
3. **Money calculations use decimal.js.** No floating point in the calculator or generated examples.
4. **The calculator is illustrative.** It does not replace server commission calculation or ledger posting.
5. **The code generator is illustrative.** It must not embed a real secret in source control.
6. **The external API amount is a decimal string.** The generator uses the calculator amount and the server remains authoritative.
7. **Redirect URLs must be allowlisted.** The guide teaches this; the external API and checkout enforce it.
8. **Webhook verification uses the raw body.** The guide's signature checks are normative integration guidance.
9. **First-5 checklist state is local.** It is not a server permission or activation record.
10. **Guide v2 is not current.** Merchant content remains the 10+5 baseline until a future implementation lands.

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Operations content | `merchant-front/src/content/guide/merchantOperationsGuide.ts` |
| Developer content | `merchant-front/src/content/guide/merchantDeveloperApiGuide.ts` |
| Content types | `merchant-front/src/content/guide/types.ts` |
| Operations guide page | `merchant-front/src/pages/guide/index.tsx` |
| Developer guide page | `merchant-front/src/pages/guide/developers/index.tsx` |
| Fee calculator | `merchant-front/src/components/guide/MerchantFeeCalculator.tsx` |
| Code block renderer | `merchant-front/src/components/guide/GuideCodeBlock.tsx` |
| Shell search/help | `merchant-front/src/layouts/default.tsx`, `components/guide/**` |
| External API routes | `/api/v1/external/links`, `/api/v1/external/links/:key`, `/api/v1/external/payments/:reference` |
| Local storage | `merchant-guide-checklist` |

## 6. Operational usage

- Onboarding a merchant: point them at M-01 first; use the first-5 checklist as a training aid, then verify the actual portal state.
- Debugging an API integration: open D-02, confirm the token and CIDR allowlist, then D-04 and the code generator for the exact request shape.
- Explaining a payout amount: use the fee calculator with the real commission/fee-bearer configuration; do not treat the estimated gateway fee as the ledger posting.
- Explaining a dispute: use M-08 and the disputes page; evidence is deadline-bound and money movement remains an admin action.
- Adding content: extend the typed content modules and keep the role/tag/code-template shape; update the content test when counts change.
- Deep-linking: use `/portal/guide?chapter=M-06` or `/portal/guide/developers?chapter=D-04` from support messages.

## 7. Status and deviations

### Implemented

- 10 operations chapters and 5 developer chapters with role tags and bilingual titles/bodies where supplied.
- First-5 checklist with localStorage persistence and API-based auto-detection.
- Role-filtered chapter search and modal reader.
- Decimal.js fee/net settlement calculator with all three fee bearers.
- Four-language code generator and external API examples.
- Five webhook verification checks and a raw-body signature example.
- Dedicated developer guide page with code templates.
- Shell guide search and contextual help integration.

### Partial

- Arabic coverage is chapter-dependent; some bodies/titles are bilingual and some are not.
- The calculator's gateway fee is an estimate based on the customer total, not the exact gateway cost.
- The code generator is a teaching aid; it does not validate the token, scopes or CIDR at generation time.
- The first-5 checklist can disagree with the server if a list call is stale or fails silently.

### Missing / deferred

- No guide v2 content, context map, safeguard cards, playbook or read tracking for merchants.
- No server-side checklist/progress record for the first-5 flow.
- No interactive API sandbox that executes calls against a sandbox token.
- No generated SDK package.

### Known bugs / risks

- **Security risk:** the token field is a plaintext browser input; a real token can be exposed on screen or in a screenshot. Use a scoped test token and rotate it.
- **Accuracy risk:** the fee calculator's gateway-fee estimate is not the ledger truth.
- **Training risk:** the first-5 checklist is local and can be manually toggled; it must not be used as proof of activation.
- **Doc risk:** the 10+5 baseline is current; guide v2 is future and must not be described as shipped.

## 8. Verification and tests

- `merchant-front/src/content/__tests__/content-completeness.test.ts` asserts the merchant guide chapter counts and required content lengths.
- `tests/e2e/exhaustive/exhaustive-merchant-surface.spec.ts` includes `/portal/guide` in the merchant surface matrix.
- `tests/e2e/merchant/shell.spec.ts` checks the shell search/help entry points and navigation.

The content test is a Bun test; the Playwright suites require the live stack.

## 9. Source references

### Old design sections

- `design/complete_zero_to_hero_guides_and_academy_specification.md` — merchant operations and developer API content baseline.
- `design/payment_gateway_deployment_and_guides_architecture.md` — merchant guide/portal architecture context.

### Code paths

- `merchant-front/src/content/guide/merchantOperationsGuide.ts`
- `merchant-front/src/content/guide/merchantDeveloperApiGuide.ts`
- `merchant-front/src/content/guide/types.ts`
- `merchant-front/src/pages/guide/index.tsx`
- `merchant-front/src/pages/guide/developers/index.tsx`
- `merchant-front/src/components/guide/MerchantFeeCalculator.tsx`
- `merchant-front/src/components/guide/GuideCodeBlock.tsx`
- `merchant-front/src/components/guide/ContextualHelpDrawer.tsx`
- `merchant-front/src/layouts/default.tsx`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03 — Initial canonical merchant guide/developer API part. Confirms 10 operations chapters, 5 developer chapters, first-5 checklist, decimal.js fee calculator, four-language code generator, and five webhook checks.

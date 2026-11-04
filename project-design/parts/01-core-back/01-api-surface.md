---
id: core.api
title: Core API Surface
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - core-back/api/index.ts
  - core-back/api/internal/admin.ts
  - core-back/api/internal/merchant.ts
  - core-back/api/internal/checkout.ts
  - core-back/api/internal/backups.ts
  - core-back/api/internal/reconciliationUpload.ts
  - core-back/api/internal/json.ts
  - core-back/api/public/index.ts
  - core-back/api/middleware/authDoubleCheck.ts
  - core-back/api/middleware/makerCheckerGuard.ts
  - core-back/lib/listQuery.ts
  - core-back/lib/approvalQueue.ts
  - core-back/engine/governance/GovernanceExecution.ts
design_sources:
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#16-complete-multi-service-api-surface-mapping
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#161-checkout-back-public-api-apiv1pay-apiv1inbound--forwards-to-core-back-internalcheckout
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#162-merchant-back-public-api-apiv1merchant-apiv1external--forwards-to-core-back-internalmerchant
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#163-admin-back-lan-only-api-apiv1admin--forwards-to-core-back-internaladmin
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#14-the-8-step-admin-add-a-gateway-wizard--6-stage-delivery-plan
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#154-the-four-eyes-action-matrix
  - design/10-fixes/_0001_operator_cases.md
tests:
  - core-back/test/internal-routes.test.ts
  - core-back/test/list-query.test.ts
  - core-back/test/approval-queue.test.ts
  - core-back/test/governance-execution.test.ts
  - core-back/test/checkout-confirm-concurrency.test.ts
  - core-back/test/checkout-cancel.test.ts
  - core-back/test/backup-admin/backup-admin-routes.test.ts
  - core-back/test/exhaustive/05-api-matrix/admin-endpoints-rbac-fuzz.test.ts
  - core-back/test/exhaustive/05-api-matrix/list-query-filters-all-27-endpoints.test.ts
gaps:
  - APPLICATION approvals have no executable handler and remain pending.
  - Cashout processing, some settings writes, commission creation and velocity-rule creation execute without the approval queue.
  - Merchant routes do not enforce per-endpoint authorities or API-token scopes.
  - Pagination is offset-based (skip/take), not keyset.
  - Inbound webhooks are verified and processed synchronously before the ack.
  - The resend endpoint only refreshes a cooldown; it does not call the gateway.
  - Attempt log GET returns hard-coded null clientAction and empty publicOutputs.
  - /api/public has no routes.
---

# Core API Surface

## 1. Purpose and scope

This part maps the actual HTTP surface of `core-back`: the internal namespaces and every route group they expose, the authentication and authority behavior, the shared list/export/summary contract, the maker-checker proposal and decision routes, and the concrete gaps between the design and the implementation.

The canonical inventory is generated in `project-design/appendices/api-route-matrix.md`. The matrix below is the narrative map, grouped by namespace and domain. Counts are from the source at verification time: 243 routes in `api/internal/admin.ts`, 5 backup routes mounted under the admin namespace, 62 in `api/internal/merchant.ts`, 12 in `api/internal/checkout.ts`, and no routes in `api/public/index.ts`.

## 2. Design intent (extracted and synthesized from ./design)

The historical design defines three machine surfaces and one optional public surface:

- **Admin internal API** at `/internal/admin/*`, called only by `admin-back` over mTLS. It is the operator back office: users, join requests, KYB, merchants, approvals, AML, gateways/rails/routes, credentials, reconciliation, disputes, adjustments, cash-outs, commissions, velocity, finance, settings, audit logs and backups.
- **Merchant internal API** at `/internal/merchant/*`, called only by `merchant-back`. It covers auth, authenticated onboarding, wallets, applications, links, payments, disputes, cash-outs, tokens, credential sets, users, POS and stats. The external API at `/api/v1/external/*` uses `pg_live_` bearer tokens with scopes and optional IP CIDRs.
- **Checkout internal API** at `/internal/checkout/*`, called only by `checkout-back`. It resolves a link, initiates an attempt, confirms/resends/cancels, handles browser hints and returns, and accepts raw inbound webhooks. It never accepts a client-supplied amount or currency.
- **Public API** at `/api/public/*` was reserved but is not part of the designed checkout/merchant/admin paths.

The design expects:

- A stable error envelope.
- Zod validation at the edge and again in core.
- Stable list contracts with server-side filters, sorting and pagination.
- Export and summary variants for the admin tables.
- Maker-checker for every sensitive decision, with maker != checker.
- Authority checks on every admin operation.
- Idempotency for money-moving client calls.
- Asynchronous webhook processing with a fast ack where possible.
- No hidden handlers: every proposal route should have an execution path.

## 3. As-built architecture

### 3.1 Namespace mounting and authentication

| Namespace | Core prefix | Edge caller | Transport identity | Bearer behavior |
| :--- | :--- | :--- | :--- | :--- |
| Admin | `/internal/admin` | `admin-back` | client cert CN `admin-back` | `requireAuthentication` after `/health`; per-route authorities |
| Merchant | `/internal/merchant` | `merchant-back` | client cert CN `merchant-back` | public auth routes before `requireAuthentication`; onboarding and business routes require a session or `pg_live_` token |
| Checkout | `/internal/checkout` | `checkout-back` | client cert CN `checkout-back` | no bearer; link key/attempt token capability |
| Public | `/api/public` | none | mTLS server still requires a client cert | no routes |
| Backups | `/internal/admin/system/backups` | `admin-back` | admin channel | admin auth plus `security:*` |

The edge maps its public paths to these prefixes:

- Admin edge `/api/v1/admin/*` -> `/internal/admin/*`.
- Merchant edge `/api/v1/merchant/*` -> `/internal/merchant/*`; `/api/v1/external/*` -> `/internal/merchant/external/*`.
- Checkout edge `/api/v1/pay/*` -> `/internal/checkout/pay/*`; `/api/v1/return/*` -> `/internal/checkout/return/*`; `/api/v1/inbound/*` -> `/internal/checkout/inbound/*`.

### 3.2 Admin namespace

The admin router is the largest surface. `/health`, `/auth/login`, `/auth/mfa` and `/auth/me` are registered before `router.use(requireAuthentication)`. Every route after that line requires a valid bearer credential. `GET /auth/me` is before the guard and returns static platform data.

The domain groups below list every route in `api/internal/admin.ts`. The authority column is the guard used by the group; where a group mixes read/write, the split is shown.

#### Auth, search, stats, options

| Routes | Authority |
| :--- | :--- |
| `POST /auth/login`, `POST /auth/mfa` | none (before auth) |
| `GET /auth/me` | none (before auth) |
| `POST /search` | authenticated; no explicit authority |
| `GET /stats/recent-activity`, `GET /stats/recent-activity/export` | `security:read` |
| `GET /stats/overview` | authenticated; no explicit authority |
| `POST /stats/export-audit` | authenticated; no explicit authority |
| `GET /options/:kind` | authenticated; no explicit authority |
| `GET /health` | mTLS channel only |

#### Users

| Routes | Authority |
| :--- | :--- |
| `GET /users`, `GET /users/export`, `GET /users/summary`, `GET /users/summary/export`, `GET /users/:id` | `user:read` or `security:read` |
| `POST /users`, `PATCH /users`, `PATCH /users/:id` | `user:write` or `security:write` |

`POST /users`, `PATCH /users` and `PATCH /users/:id` create `USER` approval requests in the pending path and return `202`; the approval handler executes the change.

#### Join requests and onboarding

| Routes | Authority |
| :--- | :--- |
| `GET /join-requests`, `GET /join-requests/export`, `GET /join-requests/summary`, `GET /join-requests/summary/export`, `GET /join-requests/:id` | `kyb:read` or `compliance:read` |
| `POST /join-requests/admin-assisted` | `kyb:write` or `compliance:write` |
| `PATCH /join-requests/:id/profile`, `POST /join-requests/:id/beneficial-owners`, `PATCH /join-requests/:id/beneficial-owners/:ownerId`, `DELETE /join-requests/:id/beneficial-owners/:ownerId`, `POST /join-requests/:id/kyb-documents`, `DELETE /join-requests/:id/kyb-documents/:docId`, `POST /join-requests/:id/submit`, `POST /join-requests/:id/withdraw`, `PATCH /join-requests/:id/checklist`, `POST /join-requests/:id/screening/retry`, `POST /join-requests/:id/assign`, `POST /join-requests/:id/request-info`, `POST /join-requests/:id/decide` | `kyb:write` or `compliance:write` |
| `GET /kyb-documents/:id/content` | `kyb:read` or `compliance:read` |

Some decision paths create `JOIN_REQUEST` approvals; the approve/reject route executes them.

#### KYB documents

| Routes | Authority |
| :--- | :--- |
| `GET /kyb-documents`, `GET /kyb-documents/export`, `GET /kyb-documents/summary`, `GET /kyb-documents/summary/export`, `GET /kyb-documents/:id` | `kyb:read` or `compliance:read` |
| `POST /kyb-documents/:id/review`, `POST /kyb-documents/:id/request-replacement`, `POST /kyb-documents/:id/request-revalidation` | `kyb:write` or `compliance:write` |

#### Merchants and applications

| Routes | Authority |
| :--- | :--- |
| `GET /merchants`, `GET /merchants/export`, `GET /merchants/summary`, `GET /merchants/summary/export`, `GET /merchants/:id/summary/export`, `GET /merchants/:id`, `GET /merchants/:id/transactions`, `GET /merchants/:id/applications`, `GET /merchants/:id/wallets`, `GET /merchants/:id/cashouts`, `GET /merchants/:id/disputes`, `GET /merchants/:id/adjustments`, `GET /merchants/:id/notifications`, `GET /merchants/:id/audit-events`, `GET /merchants/:id/stats`, `GET /merchants/:id/pending-changes`, `GET /merchants/:id/detail-changes` | `merchant:read` |
| `PATCH /merchants/:id/descriptive`, `POST /merchants/:id/propose-edit`, `POST /merchants/:id/suspend`, `POST /merchants/:id/reinstate`, `POST /merchants/:id/close`, `POST /merchants/:id/pending-changes/:approvalId/withdraw` | `merchant:write` |

Sensitive merchant changes create `MERCHANT` approvals. Suspension has an emergency path that can take effect immediately and be ratified later; reinstatement/close require approval. `APPLICATION` sensitive changes are created in the merchant router, not here.

#### Approvals

| Routes | Authority |
| :--- | :--- |
| `GET /approvals`, `GET /approvals/export`, `GET /approvals/summary`, `GET /approvals/summary/export`, `GET /approvals/:id` | `approval:read` |
| `POST /approvals/:id/approve`, `POST /approvals/:id/reject` | `approval:check` or `approval:write` + checker authority |

The approve/reject routes call `actorFromRequest`, `assertCheckerAuthority` and `assertCheckerIsNotMaker`. The approve route also handles `BACKUP_POLICY` out of band and dispatches every other subject to `executeApprovalSubject`.

#### AML and compliance

| Routes | Authority |
| :--- | :--- |
| `GET /aml/screenings`, `/export`, `/summary`, `/summary/export`, `GET /aml/screenings/:id` | confidential AML role or authority |
| `POST /aml/matches/:id/disposition` | confidential AML role or authority |
| `GET /aml/cases`, `/export`, `/summary`, `/summary/export`, `GET /aml/cases/:id` | confidential AML role or authority |
| `POST /aml/cases/:id/propose` | confidential AML role or authority; creates an `AML_CASE` approval |
| `GET /aml/rules`, `/export`, `/summary`, `/summary/export`, `GET /aml/rules/:id` | confidential AML role or authority |
| `POST /aml/rules` | confidential AML role or authority; creates an `AML_RULE` approval |
| `GET /aml/reporting-rules`, `POST /aml/reporting-rules` | confidential AML role or authority |
| `POST /aml/reporting-rules/:id/promote` | reporting authority; creates a `REPORTING_RULE` approval |
| `GET /aml/reports`, `/export`, `/summary`, `/summary/export`, `GET /aml/reports/:id` | confidential AML role or authority |
| `POST /aml/reports` | confidential AML role or authority; creates a `REGULATORY_REPORT` approval |
| `POST /aml/reports/:id/submit`, `POST /aml/reports/:id/acknowledge` | reporting authority (`MLRO`/`COMPLIANCE` role or `report:approve`/`report:review` authority) |

`assertConfidential` uses `hasConfidentialAmlAccess`; `assertReportingAuthority` additionally requires an MLRO/COMPLIANCE role or a reporting authority when a user is neither.

#### Operator cases, inquiries and attempts

| Routes | Authority |
| :--- | :--- |
| `GET /operator-cases`, `/export`, `/summary`, `/summary/export`, `GET /operator-cases/:id` | `case:read` or `operator:read` |
| `POST /operator-cases/bulk-inquire`, `POST /operator-cases/bulk-assign`, `POST /operator-cases/bulk-state`, `PATCH /operator-cases/:id`, `POST /operator-cases/:id/resolve` | `case:write` or `operator:write` |
| `GET /gateway-inquiries`, `GET /gateway-inquiries/summary`, `GET /gateway-inquiries/:id` | `case:read` or `operator:read` |
| `POST /gateway-inquiries/:id/cancel`, `/run-now`, `/retry` | `case:write` or `operator:write` |
| `GET /attempts/:id` | `attempt:read` |
| `POST /attempts/:id/inquire` | `attempt:inquire` |

`POST /operator-cases/:id/resolve` proposes an `OPERATOR_CASE` approval; execution is handled by the approval route.

#### Gateways, versions, credential sets

| Routes | Authority |
| :--- | :--- |
| `GET /gateways/ai-transcript` | `gateway:read` |
| `POST /gateways/spec-verify`, `POST /gateways/spec-import` | `gateway:write` |
| `GET /gateways`, `/export`, `/summary`, `/summary/export`, `GET /gateways/:id`, `GET /gateways/:id/versions`, `GET /gateway-versions/:vid` | `gateway:read` |
| `POST /gateways`, `PATCH /gateways/:id`, `POST /gateways/:id/versions`, `POST /gateway-versions/:vid/clone`, `POST /gateways/:id/rollback` | `gateway:write` |
| `GET /credential-sets`, `GET /credential-sets/:id` | `credential:read` or `gateway:read` |
| `POST /credential-sets`, `PUT /credential-sets/:id`, `POST /credential-sets/:id/verify`, `POST /credential-sets/:id/revoke` | `credential:write` or `gateway:write` |
| `PUT /gateway-versions/:vid/environments`, `/auth`, `/settings`, `/crypto-profiles`, `/flows`, `/channels`, `/status-rules`, `/error-maps` | `gateway:write` |
| `POST /gateway-versions/:vid/dry-run`, `/run-suite` | `gateway:test` |
| `POST /gateway-versions/:vid/submit-approval` | `gateway:write`; creates a `GATEWAY_VERSION` approval |
| `PUT /gateway-versions/:vid/rollback-version` | `gateway:write` |

The spec importer route runs the four verification layers, materializes a DRAFT version in one transaction and then runs a live credential check; a failed check marks the credential set `FAILING` but keeps the draft.

#### Rails, routes and assets

| Routes | Authority |
| :--- | :--- |
| `GET /rails`, `/export`, `/summary`, `/summary/export`, `GET /rails/:id` | `gateway:read` |
| `POST /rails`, `PATCH /rails/:id`, `PUT /rails/:id/fields` | `gateway:write` |
| `GET /routes`, `/export`, `/summary`, `/summary/export`, `GET /routes/:id` | `gateway:read` |
| `POST /routes`, `PATCH /routes/:id`, `POST /routes/:id/state` | `gateway:write` |
| `GET /assets`, `GET /assets/:id` | `gateway:read` |
| `POST /assets` | `gateway:write` |

#### Reconciliation

| Routes | Authority |
| :--- | :--- |
| `GET /reconciliation/sources` | `reconciliation:read` |
| `POST /reconciliation/sources`, `PATCH /reconciliation/sources/:id` | `reconciliation:write` |
| `GET /reconciliation/runs`, `GET /reconciliation/summary`, `GET /reconciliation/summary/export`, `GET /reconciliation/runs/:id`, `GET /reconciliation/runs/:id/export` | `reconciliation:read` |
| `POST /reconciliation/upload` | `reconciliation:write`; raw multipart/body, enqueues a `RECONCILIATION_RUN` |

#### Disputes, adjustments, cash-outs, commissions and velocity

| Routes | Authority |
| :--- | :--- |
| `GET /disputes`, `/export`, `/summary`, `/summary/export`, `GET /disputes/:id` | `dispute:read` |
| `POST /disputes/:id/evidence`, `POST /disputes` | `dispute:write` |
| `GET /adjustments`, `/export`, `/summary`, `/summary/export`, `GET /adjustments/:id` | `finance:read` |
| `POST /adjustments` | `finance:write`; creates an `ADJUSTMENT` approval and a `PENDING_REVIEW` adjustment |
| `GET /cashouts`, `/export`, `/summary`, `/summary/export`, `GET /cashouts/:id` | `cashout:read` |
| `POST /cashouts/:id/process` | `cashout:review` or `finance:write`; executes the cash-out state/money transition directly |
| `GET /commission-profiles`, `GET /commission-profiles/summary`, `GET /commission-profiles/:id/history` | `commission:read` or `finance:read` |
| `POST /commission-profiles` | `commission:write`; creates an active profile directly |
| `POST /commission-profiles/:id/expire` | `commission:write`; creates a `COMMISSION_PROFILE` approval |
| `GET /velocity-rules`, `GET /velocity-rules/:id/history`, `GET /velocity-rules/summary` | `velocity:read` or `compliance:read` |
| `POST /velocity-rules` | `velocity:write` or `compliance:write`; creates an active rule directly |
| `POST /velocity-rules/:id/deactivate` | `velocity:write` or `compliance:write`; creates a `VELOCITY_RULE` approval |

#### Finance, settings, academy and audit

| Routes | Authority |
| :--- | :--- |
| `GET /finance/profitability`, `/export`, `GET /finance/route-caps`, `GET /finance/liquidity`, `/export`, `GET /finance/invariant-check`, `/export` | `finance:read` |
| `GET /settings/checkout-support`, `/history`, `/summary`, `/summary/export` | `settings:read` |
| `PUT /settings/checkout-support` | `settings:write`; direct versioned write |
| `GET /academy/progress`, `PUT /academy/progress` | authenticated; current user only |
| `GET /academy/progress/overview`, `/summary`, `/export`, `/summary/export` | `user:read` |
| `GET /audit-logs`, `/export`, `/summary`, `/summary/export`, `GET /audit-logs/:id` | `security:read` |
| `GET /settings` | `settings:read` |
| `POST /settings/restore-preview` | `settings:read` |
| `POST /settings/restore-apply`, `PUT /settings` | `settings:write`; direct writes |
| `GET /settings/export`, `/summary`, `/summary/export` | `settings:read` |

#### Backups (`/system/backups`)

| Routes | Authority |
| :--- | :--- |
| `GET /overview` | `security:read` or `gateway:read` |
| `POST /trigger` | `security:write` |
| `POST /drill` | `security:write` |
| `PUT /policy` | `security:write`; creates or executes a `BACKUP_POLICY` approval |
| `GET /catalog` | `security:read` or `gateway:read` |

### 3.3 Merchant namespace

| Domain | Routes |
| :--- | :--- |
| Health | `GET /health` |
| Auth (public within channel) | `POST /auth/register`, `/auth/verify-identity`, `/auth/accept-invitation`, `/auth/login`, `/auth/google` (501), `/auth/mfa/verify`, `GET /auth/me` |
| Options | `GET /options/:kind` |
| Onboarding | `GET/PUT /onboarding/join-request`, `GET /onboarding/kyb-revalidations`, `POST /onboarding/kyb-documents`, `GET/POST /onboarding/beneficial-owners`, `DELETE /onboarding/beneficial-owners/:id`, `POST /onboarding/submit` |
| Wallets | `GET/POST /wallets`, `GET /wallets/:id`, `GET /wallets/:id/balance`, `GET /wallets/:id/statements`, `GET /wallets/:id/statements/:month/export` |
| Applications | `GET/POST /applications`, `GET/PATCH /applications/:id` |
| Links | `GET/POST /links`, `GET /links/:id`, `POST /links/:id/cancel`, `GET /links/:id/attempts` |
| Payments | `GET /payments` |
| Disputes | `GET /disputes`, `GET /disputes/:id`, `POST /disputes/:id/evidence` |
| Cash-outs | `GET/POST /cashouts` |
| Tokens | `GET/POST /tokens`, `PUT /tokens/:id/ips`, `DELETE /tokens/:id` |
| Credential sets | `GET/POST /credential-sets`, `PUT/GET /credential-sets/:id`, `POST /credential-sets/:id/verify` |
| Users | `GET/POST /users`, `PATCH /users`, `PATCH /users/:id` |
| POS | `GET/POST /pos/terminals`, `GET/PATCH /pos/terminals/:id`, `POST /pos/terminals/:id/screens`, `GET /pos/screens/:screenCode/stream` |
| Stats | `GET /stats/overview` |
| External (requires `pg_live_`) | `POST /external/links`, `GET /external/links/:key`, `POST /external/links/:key/cancel`, `GET /external/payments/:reference` |

Authentication behavior:

- All routes except `/health` and the six auth routes before `router.use(requireAuthentication)` require a bearer credential. Onboarding is authenticated; it is mounted under the edge public router for routing convenience, not because it is anonymous.
- The principal must have a `merchantId`; `merchantIdOf` rejects otherwise with `403 MERCHANT_CONTEXT_REQUIRED`.
- Queries are scoped by `merchantId`; a merchant cannot read another merchant's wallet/application/link.
- API tokens are bound to a merchant and optionally an application; the token hash, revocation and CIDR checks happen in core.
- There is no per-route `requireAuthorities` call. API-token scopes and session authorities do not gate individual merchant endpoints.
- Sensitive application changes (`assignedWalletId`, `railWhitelist`, `redirectDomainAllowlist`) create an `APPLICATION` approval instead of applying directly.

### 3.4 Checkout namespace

| Route | Behavior |
| :--- | :--- |
| `GET /health` | channel health |
| `GET /pay/:linkKey` | resolves link, merchant, fee breakdown, visible rails, excluded reasons, support config and rail fields |
| `POST /pay/:linkKey/initiate` | validates rail/form/idempotency, resolves visible route, runs guard pipeline, creates attempt, calls engine initiate; rejects client amount/currency at the edge |
| `GET /pay/:linkKey/logs/:attemptId` | attempt state summary; `clientAction: null` and `publicOutputs: {}` are hard-coded |
| `GET /pay/:linkKey/logs/:attemptId/status` | SSE stream that polls the database every 2 seconds for up to 10 minutes |
| `POST /pay/:linkKey/logs/:attemptId/confirm` | atomic claim, engine SUBMIT, trusted-success facts, ledger post |
| `POST /pay/:linkKey/logs/:attemptId/resend` | checks AWAITING_CUSTOMER and cooldown, updates `lastOtpSentAt`; does not call the gateway |
| `POST /pay/:linkKey/logs/:attemptId/cancel` | atomic cancel, release slot, before point of no return |
| `POST /pay/:linkKey/logs/:attemptId/client-event` | untrusted hint; always triggers engine inquiry |
| `GET /return/:attemptToken` | resolves attempt by reference/gateway reference, runs inquiry, returns redirect path |
| `POST /return/:attemptToken` | same as GET |
| `POST /inbound/:gateway/:env/:pathToken` | raw bytes, channel/environment checks, dedupe, inbox row, synchronous verification, ack template |

Checkout has no bearer auth. The link key and attempt id are capabilities. The route never accepts amount or currency; the edge additionally rejects monetary fields before forwarding.

### 3.5 Public namespace

`api/public/index.ts` creates a router, installs a 15-request/hour `express-rate-limit` middleware and exports it with no route. It is mounted at `/api/public`. Every path under that prefix falls through to the Express 404 after the limiter. There is no public health or discovery endpoint.

### 3.6 List, export and summary pattern

`core-back/lib/listQuery.ts` is the shared contract:

- `parseListQuery`: `page >= 1`, `pageSize` clamped to 1..200, `sortDirection` `asc|desc`, scalar query keys copied.
- `buildListQuery(raw, spec)`:
  - `search`: OR over configured paths with case-insensitive `contains`.
  - `contains`: query key -> one/many paths, OR within the key.
  - `equals`: exact path equality.
  - `in`: comma-separated values.
  - `booleans`: `"true"`/`"false"`.
  - `dates`: `from`/`to` or `<name>From`/`<name>To`; date-only `from` is start-of-day UTC and `to` is end-of-day UTC.
  - `ranges`: `amountMin/amountMax`, `minScore/maxScore`; decimals use `Prisma.Decimal`.
  - `sortable`: allowlist of client sort keys -> model paths.
  - `defaultSort`, `orderBy` with `id desc` tie-break.
  - `skip = (page - 1) * pageSize`, `take = pageSize`.
- `listResponse(key, rows, total, built)` returns `{ [key]: rows, total, page, pageSize }`.

Offset pagination is used everywhere. There is no keyset/cursor contract despite the historical design.

Export endpoints follow a repeated shape:

- Reuse the same `buildListQuery` spec as the list.
- Fetch up to 5000 rows with `take: 5000` and no `skip`.
- Include the total count and `exported`, sometimes `truncated`.
- Write an audit row for the export before responding.
- Return JSON, not a server-generated XLSX binary. The portals consume the JSON through the shared frontend export pipeline.

Summary endpoints are domain-specific aggregates (counts by status/role/severity/etc.) and have a `summary/export` variant that returns the snapshot plus `exportedAt` and writes an audit row. Not every summary endpoint has all four variants.

### 3.7 Maker-checker endpoints and execution coverage

Proposal/decision routes:

| Flow | Maker/proposal route | Checker/decision route | Execution handler |
| :--- | :--- | :--- | :--- |
| Generic approval | created by each subject route | `POST /approvals/:id/approve`, `/reject` | `executeApprovalSubject` or backup-specific branch |
| Adjustment | `POST /adjustments` | approve | `executeAdjustment` |
| Merchant edit/suspend/reinstate/close | `POST /merchants/:id/propose-edit`, `/suspend`, `/reinstate`, `/close` | approve | `executeMerchantPatch` or lifecycle handler |
| Join request decision | `POST /join-requests/:id/decide` | approve | `activateApprovedJoinRequest` / rejection branch |
| User authority change | `POST/PATCH /users` | approve | `executeUserAuthorityChange` |
| Gateway version go-live | `POST /gateway-versions/:vid/submit-approval` | approve | `activateGatewayVersionInTransaction` |
| AML case resolution | `POST /aml/cases/:id/propose` | approve | `executeAmlCaseResolution` |
| AML rule activation | `POST /aml/rules` | approve | AML rule update |
| Reporting rule promotion | `POST /aml/reporting-rules/:id/promote` | approve | reporting rule confirmation |
| Regulatory report | `POST /aml/reports` | approve, then submit/acknowledge | report approval/submission |
| Commission expiry | `POST /commission-profiles/:id/expire` | approve | `executeCommissionProfileExpiry` |
| Velocity deactivation | `POST /velocity-rules/:id/deactivate` | approve | `executeVelocityRuleDeactivation` |
| Operator case resolution | `POST /operator-cases/:id/resolve` | approve | `executeOperatorCaseResolution` |
| Backup policy | `PUT /system/backups/policy` | approve (or policy route with `approvalRequestId`) | daemon `updatePolicy` |

`executeApprovalSubject` handles: `AML_CASE`, `OPERATOR_CASE`, `ADJUSTMENT`, `REGULATORY_REPORT`, `REPORTING_RULE`, `AML_RULE`, `JOIN_REQUEST`, `MERCHANT`, `COMMISSION_PROFILE`, `VELOCITY_RULE`, `USER`, `GATEWAY_VERSION`. Anything else throws `409 NO_EXECUTABLE_SUBJECT`.

`application` sensitive changes create an `APPLICATION` approval in `core-back/api/internal/merchant.ts:1537`, but `executeApprovalSubject` has no `APPLICATION` branch. `CASHOUT_REQUEST`, `GATEWAY`, `CREDENTIAL_SET`, `KYB_DOCUMENT` and `PLATFORM_SETTING` are in the approval domain map but have no generic handler either. `BACKUP_POLICY` is handled by the approve route.

The following money-adjacent routes bypass the approval queue and execute under a single actor:

- `POST /cashouts/:id/process` (cash-out approval/rejection).
- `POST /commission-profiles` (creates an active profile).
- `POST /velocity-rules` (creates an active rule).
- `PUT /settings`, `PUT /settings/checkout-support`, `POST /settings/restore-apply`.
- `POST /disputes`, `POST /disputes/:id/evidence` (intake/evidence, not a ledger movement).
- `POST /gateway-versions/:vid/dry-run` and `/run-suite` (test execution).

This is narrower than the historical four-eyes matrix, which expects commission changes, velocity/AML rule changes and platform compliance settings to be checked.

### 3.8 Checkout and webhook behavior

- `GET /pay/:linkKey` resolves visible rails using the same formula as the engine (`VisibleRailsResolver`) and includes `excludedRails` with reasons.
- `POST /initiate`:
  - Enforces link usability and a per-link idempotency key lookup for an existing attempt.
  - Resolves the visible rail and the top-ranked route.
  - Requires a live gateway version.
  - Validates rail fields before any outbound call.
  - Computes `expiresAt = min(platformCeiling, gateway.sessionTtlSeconds)` and a 24-hour grace.
  - Runs the guard pipeline inside a transaction that creates the attempt and reserves the slot.
  - Returns `403`/`409` for BLOCK, `202` for HOLD, otherwise calls `engine.initiate` with `slotReserved`.
- `POST /confirm`:
  - Accepts `AUTHORIZING`/`CREATED`/`INITIATING`/`AWAITING_CUSTOMER`/`VERIFYING`/`UNKNOWN`.
  - Computes an idempotency hash and uses the atomic claim.
  - Returns the persisted status and sets `x-pg-min-lsn` when the engine produced a commit LSN.
- `POST /client-event` never trusts the browser event; it runs `engine.inquire`.
- `POST /return` also runs `engine.inquire` and returns a redirect path.
- `POST /inbound`:
  - Resolves the channel by path token and checks gateway code and enabled environment.
  - Dedupes by SHA-256 of channel id + raw body, creating `inbound_events`.
  - Correlates the attempt by the channel selector.
  - Verifies the callback synchronously with the full headers and processes it before responding.
  - Updates `verified`, `verificationError`, `processedAt` and `processingResult`.
  - Returns the channel's ack status/body template.

The inbound worker also exists and can drain unprocessed inbox rows, but the live route already completes verification before the ack. The design's "queue and ack fast" behavior is not the current request path.

## 4. Contracts and invariants

1. **Internal routes require the channel certificate.** There is no bearer-only access from a non-edge caller.
2. **Admin business routes check authorities.** The semantics are OR over the required list; `*` satisfies.
3. **Merchant routes are merchant-scoped, not authority-scoped.** The merchant id on the principal is the tenant boundary.
4. **Checkout does not accept money fields.** The amount and currency come from the payment link.
5. **Checkout confirm is single-winner.** The atomic claim allows only one SUBMIT; duplicates return the persisted state.
6. **Resend is cooldown-only.** It does not send an OTP.
7. **List filters are server-side.** Pagination is offset-based with a hard page-size cap of 200.
8. **Exports are capped.** Most export routes take at most 5000 rows and audit the export.
9. **Error envelope is stable.** `ApiError` -> `{code,message,reference?,details?}`.
10. **Maker-checker is enforced on the approve route.** But not every sensitive route uses the queue.

## 5. Data / API / config / deployment surface

### 5.1 Route counts

| Namespace | Declarations | Notes |
| :--- | ---: | :--- |
| Admin (`api/internal/admin.ts`) | 243 | includes health/auth/search/stats and all back-office domains |
| Admin backups (`api/internal/backups.ts`) | 5 | mounted at `/internal/admin/system/backups` |
| Merchant (`api/internal/merchant.ts`) | 62 | includes health/auth/onboarding and external |
| Checkout (`api/internal/checkout.ts`) | 12 | includes health, pay, return, inbound |
| Public (`api/public/index.ts`) | 0 | limiter only |
| **Total core declarations** | **322** | before method/path expansion of edge routes |

### 5.2 Edge mapping

| Edge path | Core path | Edge file |
| :--- | :--- | :--- |
| `POST /api/v1/admin/auth/login`, `/mfa`; `GET /me` | `/internal/admin/auth/*` | `admin-back/api/public/auth.ts` |
| `/api/v1/admin/*` | `/internal/admin/*` | `admin-back/api/protected/**` |
| `/api/v1/admin/system/backups/*` | `/internal/admin/system/backups/*` | `admin-back/api/protected/backups.ts` |
| `/api/v1/merchant/auth/*` | `/internal/merchant/auth/*` | `merchant-back/api/public/auth.ts` |
| `/api/v1/merchant/onboarding/*` | `/internal/merchant/onboarding/*` | `merchant-back/api/public/onboarding.ts` |
| `/api/v1/merchant/*` | `/internal/merchant/*` | `merchant-back/api/protected/**` |
| `/api/v1/external/*` | `/internal/merchant/external/*` | `merchant-back/api/external/index.ts` |
| `/api/v1/pay/*` | `/internal/checkout/pay/*` | `checkout-back/api/public/pay.ts` |
| `/api/v1/return/*` | `/internal/checkout/return/*` | `checkout-back/api/public/return.ts` |
| `/api/v1/inbound/*` | `/internal/checkout/inbound/*` | `checkout-back/api/public/inbound.ts` |

### 5.3 List/export/summary spec keys

Most admin list endpoints define a subset of:

- `search`: paths.
- `contains`, `equals`, `in`, `booleans`.
- `dates` with `createdAt`, `updatedAt`, `submittedAt`, `slaDueAt`, `lastUsedAt`, etc.
- `ranges` for amount/score.
- `sortable`.
- `defaultSort`, `defaultPageSize` (often 20 or 50).

The generated route matrix is the complete method/path inventory. The route groups above are complete at the domain level; use the appendix for a one-row-per-route listing.

## 6. Operational usage

### 6.1 Exercise an admin route

```bash
curl --cert certs/admin-back-client.crt \
     --key certs/admin-back-client.key \
     --cacert certs/internal-ca.crt \
     -H "Authorization: Bearer $ADMIN_SESSION" \
     "https://127.0.0.1:4000/internal/admin/merchants?page=1&pageSize=20&sortKey=createdAt&sortDirection=desc"
```

A wrong channel certificate fails at the CN guard. A missing/invalid session fails at `requireAuthentication`. A missing authority fails with `403 AUTHORITY_REQUIRED` and `details.required`.

### 6.2 Exercise checkout

1. `GET /internal/checkout/pay/:linkKey` -> visible rails.
2. `POST /internal/checkout/pay/:linkKey/initiate` with `railCode`, `formData`, `idempotencyKey`.
3. Poll `GET .../logs/:attemptId/status` or wait for the gateway webhook.
4. `POST .../confirm` with OTP/evidence if the rail requires it.
5. `POST .../cancel` only before the point of no return.

### 6.3 Add a new admin list endpoint

1. Define a `ListSpec`.
2. Call `buildListQuery` and `listResponse`.
3. Add the `/export`, `/summary` and `/summary/export` variants if the domain uses the pattern.
4. Add `requireAuthorities` and a `git diff --check`/test update.
5. Regenerate `api-route-matrix.md`; do not hand-edit it.

### 6.4 Add an approval subject

1. Create the approval request with a stable subject type.
2. Add the subject to `APPROVAL_DOMAIN_SUBJECT_TYPES` if it belongs to a domain.
3. Implement a branch in `executeApprovalSubject` with the maker/checker re-check.
4. Add a test that proves maker != checker and that approval executes atomically.

Without step 3 the request remains pending and returns `409 NO_EXECUTABLE_SUBJECT` on approve.

## 7. Status and deviations

### Implemented

- Complete admin, merchant and checkout route groups with Zod validation.
- Channel CN guard and admin authority checks.
- Session and `pg_live_` authentication.
- Offset list/export/summary patterns.
- Maker-checker proposal/decision routes and database/middleware enforcement.
- Checkout link resolution, initiate, confirm, cancel, client-event, return and inbound.
- Backup overview/trigger/drill/policy/catalog.
- Raw upload routes for KYB and reconciliation.
- Audit writes on exports and sensitive actions.

### Partial

- **Approval execution.** `APPLICATION` and several other approval subject types have no executable handler.
- **Maker-checker coverage.** Cash-out process, commission create, velocity create and settings writes bypass the queue.
- **Merchant authorization.** No per-route authority or token-scope enforcement.
- **Pagination.** Offset only; no keyset.
- **Webhook processing.** Synchronous verification/processing before ack; the worker is secondary.
- **Exports.** JSON-only server responses with a 5000-row cap; no server-side XLSX generation in core.
- **Idempotency.** Attempts have an idempotency key; link creation accepts one but does not use it.
- **Checkout status.** SSE polls the primary database every 2 seconds instead of subscribing to the transition bus.

### Missing / deferred

- Handlers for `APPLICATION`, `CASHOUT_REQUEST`, `GATEWAY`, `CREDENTIAL_SET`, `KYB_DOCUMENT` and `PLATFORM_SETTING` approvals.
- A true `resend` flow that calls the gateway.
- Keyset pagination and cursor contracts.
- A public API surface under `/api/public`.
- A gateway-wire/step log route for operators beyond the current attempt data.
- A dedicated `clientAction`/`publicOutputs` read model on the attempt log endpoint.
- Per-endpoint merchant authorities and token-scope enforcement.

### Known bugs / risks

- **Code gap:** `GET /internal/checkout/pay/:linkKey/logs/:attemptId` returns `clientAction: null` and `publicOutputs: {}` even when the attempt row has them.
- **Code gap:** `POST .../resend` only updates `lastOtpSentAt`; the payer may see a cooldown but no new OTP.
- **Code gap:** `POST /internal/admin/stats/overview`, `POST /stats/export-audit` and `GET /options/:kind` require authentication but no specific authority.
- **Code gap:** `GET /internal/admin/auth/me` and the merchant `GET /auth/me` are static and not protected by the same business authority model.
- **Code gap:** the webhook route verifies synchronously; a slow verifier delays the ack, which is the opposite of the design's fast-ack goal.
- **Risk:** the inbox stores only content-type/content-length; replay through the worker has less signature context than the live path.
- **Risk:** export audit writes happen after the data read, so a failed audit write does not prevent the export response in every route.
- **Documentation gap:** historical route counts and API lists are superseded by the generated matrix and this part.

## 8. Verification and tests

- `core-back/test/internal-routes.test.ts` verifies mount points, health and core routing.
- `core-back/test/list-query.test.ts` covers filters, date ranges, decimals, sorting and pagination.
- `core-back/test/approval-queue.test.ts` covers approval listing, state and age.
- `core-back/test/governance-execution.test.ts` covers executable subject handlers and maker/checker refusals.
- `core-back/test/checkout-confirm-concurrency.test.ts` covers the atomic confirm claim and duplicate behavior.
- `core-back/test/checkout-cancel.test.ts` covers cancellation and slot release.
- `core-back/test/backup-admin/backup-admin-routes.test.ts` covers the backup route contract.
- `core-back/test/exhaustive/05-api-matrix/admin-endpoints-rbac-fuzz.test.ts` covers admin authority fuzzing.
- `core-back/test/exhaustive/05-api-matrix/list-query-filters-all-27-endpoints.test.ts` covers list filters across endpoints.

No build or test was run for this documentation change. Database-backed route tests require PostgreSQL.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` §16.1 checkout, §16.2 merchant, §16.3 admin.
- `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md` §14.1 wizard, §15.4 four-eyes matrix.
- `design/10-fixes/_0001_operator_cases.md` for the operator-case route family.
- `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md` §15 API surface and observability.

### Code paths

- `core-back/api/index.ts`, `core-back/api/internal/index.ts`.
- `core-back/api/internal/admin.ts`, `merchant.ts`, `checkout.ts`, `backups.ts`, `reconciliationUpload.ts`.
- `core-back/api/middleware/authDoubleCheck.ts`, `makerCheckerGuard.ts`.
- `core-back/lib/listQuery.ts`, `approvalQueue.ts`.
- `core-back/engine/governance/GovernanceExecution.ts`.
- `admin-back/api/protected/**`, `merchant-back/api/**`, `checkout-back/api/public/**` for the edge mapping.

### Generated appendices

- `project-design/appendices/api-route-matrix.md` (authoritative one-row-per-route inventory)
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/stale-claims-register.md` (SC-011, SC-027)

## 10. Change history

- 2026-11-03: Initial canonical core API part written against `5a24f6f+working-tree`; records the complete namespace map, the approval-handler gap and the synchronous webhook path.

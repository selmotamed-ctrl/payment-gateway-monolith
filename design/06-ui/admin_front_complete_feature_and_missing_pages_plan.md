# Admin Portal (`admin-front`) Ground-Truth Audit & Complete Feature Implementation Plan (Branch `db-rearch-3`)

> **Target Branch:** `db-rearch-3` (`payment-gateway-monolith`)  
> **Target Execution Agent:** OpenCode (`DeepSeek V4.1 Flash Max`)  
> **Strict Visual Constraint:** Preserve 100% of the existing visual design language (`src/styles/fintech-minimal.css` tokens `--pg-*`, `ScreenContainer`, `PageHeader`, `MetricStrip`, `SurfaceCard`, `SegmentedTabs`, `SlideOverDrawer`, `FormModal`, `FormField`, `SectionFields`, `DescriptionList`, `StatusBadge`, `MoneyDisplay`, `MonoRef`, `ApiTable`, `TableRowActions`, and `FormChecklist`). Never introduce raw Vuetify `<VCard>` wrappers or unstyled `<pre>{JSON.stringify(...)}</pre>` dumps for operational data.

---

## 1. Ground-Truth Forensic Audit of Branch `db-rearch-3`

A complete, model-by-model and file-by-file audit of `core-back/prisma/schema.prisma` (52 models), `core-back/api/internal/admin.ts`, `admin-back/api/protected/`, and `admin-front/src/` on branch `db-rearch-3` reveals both the missing pages you noticed (`Wallets`, `Applications`, `Ledger Audit`, `Journal Entries`) and **all logically required operational features, drawers, quick-actions, and orphaned backend routes/models** across the platform.

### 1.1 Why Wallets & Applications Were Missing / Unusable
1. **No Global Sidebar Pages or Cross-Merchant Endpoints:**
   - `admin-front/src/pages/` has **no** `/wallets` (`pages/wallets/index.tsx`) and **no** `/applications` (`pages/applications/index.tsx`).
   - `core-back/api/internal/admin.ts` only exposes merchant-scoped `GET /merchants/:id/wallets` (line 4944) and `GET /merchants/:id/applications` (line 4881); it has no global `GET /wallets`, `GET /wallets/:id`, `POST /wallets/:id/status`, `GET /applications`, `GET /applications/:id`, `PATCH /applications/:id`, or `POST /applications/:id/tokens/:tokenId/revoke`.
2. **Hidden & Non-Interactive Inside Merchant 360 (`admin-front/src/pages/merchants/[id].tsx`):**
   - In `merchants/[id].tsx` (line 412), the **Wallets** tab is completely hidden from `segmentedTabItems` unless `canFinancial` (`merchant:write`, `finance:read`, `finance:write`) is true—even though `GET /merchants/:id/wallets` in `core-back` (line 4945) only requires `merchant:read` and already safely redacts `balance` and `checkpointBalance` when `!flags.canFinancial`.
   - In `merchants/[id].tsx`, both `applicationHeaders` (lines 257–284) and `walletHeaders` (lines 286–303) render inside `<MerchantResourceTable>` with **zero row actions, zero click handlers, zero drawers, and zero modals**:
     - Clicking an **Application** row does nothing. Furthermore, `core-back` (line 4929) strips `railWhitelist` down to `railWhitelistMode` + `railWhitelistCount`, so the table only shows `"All"`, `"None"`, or `"3 rails"` and a redirect domain count (`2`), with no way to see which rails are whitelisted, what redirect URLs are allowed, which `AccessToken` keys/IP allowlists belong to that application, or its `PaymentLink` and `PosTerminal` records.
     - Clicking a **Wallet** row does nothing. You cannot open a Wallet Statement drawer to inspect its `JournalLine` history, its `GlAccountShard` rows, its `checkpointBalance` vs `liveBalance`, or freeze/unfreeze the wallet.

### 1.2 Why Ledger Audit & Journal Entries Were Missing / Hidden
1. **Ledger Audit Is Disguised as "Invariant" (`admin-front/src/pages/finance/invariant/index.tsx`):**
   - Located at `/finance/invariant` and labeled `"Invariant"` in `src/layouts/sections.tsx` (line 63), gated by `["profit.read", "liquidity.read"]`.
   - Calls `GET v1/admin/finance/invariant-check` (`core-back/api/internal/admin.ts` line 15147), which returns `ok`, `drift`, `sides`, and `accounts` (`accountId`, `accountType`, `liveBalance`, `naturalBalance`).
   - **What is missing on `/finance/invariant`:** Clicking an account row in the `Account balances` table does nothing. There is no `GlAccountDrawer` to inspect the account's `GlAccountShard` fan-out rows (`gl_account_shards`), `checkpointBalance`, `checkpointAt`, or recent `JournalLine` entries, and no action to run a shard checkpoint rollup.
2. **Journal Entries Page Does Not Exist at All:**
   - While `JournalEntry` (line 1122) and `JournalLine` (line 1139) exist in `core-back/prisma/schema.prisma`, there is **no** `/finance/journal-entries` page in `admin-front` and **no** `/finance/journal-entries` endpoint in `admin-back` or `core-back`.
   - Even where `journalEntryId`, `ledgerEntryId`, or `adjustmentJournalEntryId` is displayed (`MerchantTransactionDialog.tsx` line 103, `merchants/[id].tsx` line 326, `adjustments/index.tsx` line 714, `cashouts/index.tsx` line 637, `disputes/index.tsx` line 685), it is a static `<MonoRef>` with no click handler to open a double-entry T-Account drawer.

### 1.3 Every Other Logically Required Feature, Model & Endpoint Missing in `db-rearch-3`
Beyond Wallets, Applications, Ledger Audit, and Journal Entries, auditing all 52 Prisma models in `core-back/prisma/schema.prisma` and all routes in `core-back/api/internal/admin.ts` uncovered **10 additional operational gaps** that a production payment gateway admin portal logically requires:

1. **Orphaned Backend Endpoints That Already Exist in `db-rearch-3` But Have ZERO Frontend UI:**
   - **Credential Sets Vault (`v1/admin/credential-sets`):** `core-back/api/internal/admin.ts` (lines 10180–10340), `admin-back/api/protected/credentialSets.ts`, and `urlsMap` (`credentialSetsList`, `credentialSetDetail`, `credentialSetVerify` on lines 169–171) are already implemented, and `GlobalSearchPalette.tsx` (line 213) already receives `credential_set` search hits—but routes them to `/gateways` because `pages/credential-sets/index.tsx` was never built.
   - **Live Route Daily Caps Utilization (`GET v1/admin/finance/route-caps`):** `core-back/api/internal/admin.ts` (line 14873), `admin-back/api/protected/finance.ts`, and `urlsMap.financeRouteCaps` (line 138) already compute live business-day cap usage (`dailyCapAmount`, `dailyProcessedAmount`, `dailyCapRemaining`, `capExhausted`, `exclusionReason: "DAILY_CAP_EXCEEDED"`, `utilisation %`), yet **nothing in `admin-front` calls `urlsMap.financeRouteCaps`**.
   - **AML Reporting Rules (`v1/admin/aml/reporting-rules`):** `core-back/api/internal/admin.ts` (lines 7202–7278) and `urlsMap.amlReportingRules` (line 95) already implement `GET/POST /aml/reporting-rules` and `POST /aml/reporting-rules/:id/promote` (`PROVISIONAL -> CONFIRMED`), but `pages/aml/rules/index.tsx` only shows `AmlRule` and has no tab for `ReportingRule`.
   - **Rail & Gateway Logo Assets (`v1/admin/assets`):** `core-back/api/internal/admin.ts` (lines 12801–12865), `admin-back/api/protected/assets.ts`, and `urlsMap.assetsList` (line 188) already exist, but `pages/rails/index.tsx` has no asset upload/picker dialog to set `logoAssetId`.
   - **Merchant Pending Changes (`GET v1/admin/merchants/:id/pending-changes`):** `urlsMap.merchantPendingChanges` (line 64) exists in `urlsMap` and `core-back` (line 5700), but `merchants/[id].tsx` never calls it and never renders `<JsonDiffViewer>` on pending changes (`merchants/[id].tsx` lines 938–958).

2. **Global Transactions & Inbound Webhooks Explorer (`/transactions` -> `pages/transactions/index.tsx`):**
   - Currently, `PaymentAttempt` records can only be viewed one merchant at a time inside `/merchants/:id` or when escalated to an `OperatorCase`.
   - Worse, `InboundEvent` (`schema.prisma` line 2034 — incoming gateway webhooks/callbacks) is only visible inside an `OperatorCase`! If a webhook arrives with an invalid signature (`signatureValid === false`) or cannot be matched to an attempt (`attemptId === null`), operators have **zero visibility** into it anywhere in `admin-front`.
   - Furthermore, `MerchantTransactionDialog.tsx` (lines 1–145) only displays static summary fields from the table row! It never calls `GET /attempts/:id` (and `core-back` line 9222 doesn't include `stepLogs`, `inboundEvents`, or `attemptGroup`), so operators inspecting a transaction cannot see its **Attempt Step Logs (`AttemptStepLog`)**, its **Inbound Webhooks (`InboundEvent`)**, its **Checkout Attempt Group retries (`AttemptGroup`)**, or trigger **Quick Actions** (`Create Refund/Adjustment`, `Open/Create Operator Case`, `Record Dispute`, `Inspect Ledger Entry`).

3. **Payment Links (`PaymentLink`) & POS Terminals (`PosTerminal` / `PosScreen`) Governance (`/channels` or Merchant/Application Drawers):**
   - `PaymentLink` (`schema.prisma` line 1027: `slug`, `state`: `ACTIVE | PAUSED | EXPIRED | ARCHIVED`, `amount`, `allowCustomAmount`, `usesCount`, `maxUses`) and `PosTerminal` + `PosScreen` (`schema.prisma` lines 1060–1091: `name`, `location`, `status`: `ACTIVE | SUSPENDED | REVOKED`, `deviceSerial`, `lastSeenAt`) are core payment acceptance channels.
   - Currently, if a merchant publishes a fraudulent/phishing `PaymentLink` or a physical `PosTerminal` is compromised, admins have **no page, drawer, or endpoint** to inspect, pause/archive a `PaymentLink`, or suspend/revoke a `PosTerminal`.

4. **Merchant 360 Post-Onboarding Compliance & Access Actions (`src/pages/merchants/[id].tsx` lines 938–1055):**
   - In `merchants/[id].tsx`:
     - **Beneficial Owners (`entry.beneficialOwners`, line 1018):** Rendered as plain 1-line text (`owner.fullNameEn · owner.role · owner.ownershipPercent%`) with **no ability to add, edit, deactivate, or re-screen a Beneficial Owner after onboarding** (those endpoints currently only exist on `/join-requests/:id/beneficial-owners`, not `/merchants/:id/beneficial-owners`!).
     - **KYB Documents & Revalidations (`entry.kybDocuments`, line 999):** If a merchant needs periodic KYB revalidation or a new document upload after onboarding, there is no `Trigger KYB Revalidation` button or `revalidations` card on Merchant 360.
     - **AML Cases (`entry.amlCases`, line 975):** Lists AML cases on the merchant without an `"Open Case"` button to jump to `/aml/cases`.
     - **Merchant Users, Access Tokens & Credential Sets (`lines 1033–1055`):** Hidden behind `canWrite` and rendered as unclickable plain text strings with no actions to view user detail (`/users/:id`), lock/unlock user, reset MFA, revoke an `AccessToken`, or inspect/rotate a `CredentialSet`.

5. **Gateway Health Telemetry (`GatewayHealthSample`) & Daily Route Volume (`RmRouteDailyVolume`):**
   - `GatewayHealthSample` (`schema.prisma` line 2213: `state`, `successRate`, `p95LatencyMs`, `sampleWindowStart`, `sampleWindowEnd`) and `RmRouteDailyVolume` (`schema.prisma` line 2787) are stored in the database, but `/gateways` (`src/pages/gateways/index.tsx`) has no **Health & Latency Telemetry Drawer** to show historical uptime, `p95LatencyMs` spikes, and `successRate` trends per gateway.

6. **Notification Templates (`NotificationTemplate`) & Outbound Notification Delivery Center (`Notification`):**
   - `NotificationTemplate` (`schema.prisma` line 2613: `key`, `channel`: `EMAIL | SMS | IN_APP | WEBHOOK`, `lang`: `AR | EN`, `subject`, `body`, `confidentiality`) has **no admin endpoint or UI** in `admin-front`!
   - `Notification` (`schema.prisma` line 2631: `status`: `QUEUED | SENT | FAILED`, `errorDetail`) has no retry/resend action or template management tab.

7. **System Outbox, Audit Outbox & Background Jobs Monitor (`/system/jobs-outbox`):**
   - `BackgroundJob` (line 2167), `OutboxEvent` (line 2686), and `AuditOutbox` (line 2701) power the transactional outbox and async workers, yet operators have no UI to inspect failed/stuck `OutboxEvent` rows, `AuditOutbox` lag, or failed `BackgroundJob` executions.

8. **Navigation Authority & Table Registry Bugs (`src/layouts/sections.tsx` & `src/constants/tableRegistry.ts`):**
   - `AdminPlatformSettings` and `AdminCheckoutHelp` are listed in `sections.tsx` (lines 89–90) but are **missing from `routesAuthorities` and `routesRoles`** in `sections.tsx`, so `canAccessRoute()` returns `true` for every role.
   - `AdminSystemBackups`, `AdminPlatformSettings`, and `AdminCheckoutHelp` are missing from `src/constants/tableRegistry.ts`.
   - `src/components/JsonPatchDiff/index.tsx` is a legacy duplicate of `src/components/ui/JsonDiffViewer.tsx` that still renders raw `<pre>` blocks (lines 94, 111).

### 1.4 Complete Inventory of Raw JSON Views & Raw JSON Textareas to Replace
Every place in `admin-front/src/` where operational data is displayed or edited as raw JSON on `db-rearch-3`:

| File Path & Exact Lines | Current Raw JSON Defect | Required Structured Replacement |
| :--- | :--- | :--- |
| `src/pages/routes/index.tsx` (lines 268–269, 422–435, 430) | Table column `costModel` renders `JSON.stringify(row.costModel ?? {})`. Edit Route modal uses `<VTextarea>` for `Cost model (JSON)` and `Scope (JSON)`, and lacks `mismatchPolicy` & `maintenanceWindows`. | Render formatted cost pill (`1.50% + 0.250 LYD`) in table; replace both `<VTextarea>` inputs with structured `CostModelBuilder` and `RouteScopeBuilder` + `mismatchPolicy` select + `MaintenanceWindowsBuilder`. |
| `src/pages/settings/platform/index.tsx` (lines 62–78, 299, 370, 401, 424–431) | Setting cards render `jsonPreview(entry.latest.valueJson)`. Edit modal uses a 12-row raw `<VTextarea label="JSON value">`. | Replace raw JSON preview with typed `DescriptionList` pills; replace `<VTextarea>` with schema-driven `PlatformSettingTypedEditor` per setting key (`risk.*`, `cashout.*`, `reconciliation.*`, `ledger.*`, `security.*`, `storage.*`). |
| `src/pages/reconciliation/index.tsx` (lines 410, 519–526, 591) | Statement Sources table column `mapping` renders `JSON.stringify(row.columnMapping ?? {})`. Edit Source modal uses an 8-row `<VTextarea label="Parser config JSON">`. | Render column mapping summary badges in table; replace `<VTextarea>` with structured `StatementParserConfigForm` (delimiter, header row, date/amount format, column mapping inputs). |
| `src/pages/aml/rules/index.tsx` (lines 386–391, 402–403, 591–593) | Table column `params` renders `JSON.stringify(row.params ?? {})`. Drawer renders `<pre>{JSON.stringify(scope)}</pre>` and `<pre>{JSON.stringify(params)}</pre>`. Draft modal uses `<VTextarea label="Scope JSON">` and `<VTextarea label="Params JSON">`. | Render human summary badges in table & `DescriptionList` in drawer; replace both `<VTextarea>` inputs in Draft modal with category-aware `AmlRuleScopeAndParamsForm`. |
| `src/pages/finance/pricing/index.tsx` (lines 325–328, 516) | History modal renders `JSON.stringify(entry.afterJson ?? {}).slice(0, 240)` (line 516). Create Commission Profile modal uses `<VTextarea label="Tiers JSON">` (line 326) and omits `minFee`, `maxFee`, `feeBearerDefault`, `roundingMode`, `merchantId`, `applicationId`. | Render `<JsonDiffViewer>` in history modal; replace `<VTextarea label="Tiers JSON">` with dynamic `CommissionTiersEditor` table and add the missing profile fields. |
| `src/pages/approvals/index.tsx` (line 1023), `src/components/ui/JsonDiffViewer.tsx` (lines 72–145), & `src/components/JsonPatchDiff/index.tsx` | When `payloadDiff` is an object instead of an RFC-6902 array, `approvals/index.tsx` falls back to `<pre>{jsonText(selected.value.payloadDiff)}</pre>`. `JsonDiffViewer.tsx` displays raw slash paths (`/payoutBankDetailsJson`) and stringifies nested objects inside cells. | Enhance `JsonDiffViewer.tsx` to normalize both RFC-6902 arrays and plain object payloads, flatten nested object keys into human labels (`Payout Bank · IBAN`), format money/badges cleanly, and re-export `JsonDiffViewer` from `JsonPatchDiff/index.tsx`. |
| `src/pages/aml/cases/index.tsx` (lines 735–736) | Drawer renders `selected.value.severityInputs` in `<pre>{JSON.stringify(selected.value.severityInputs ?? {}, null, 2)}</pre>`. | Replace `<pre>` with a structured `DescriptionList` / metric grid showing rule triggers, risk score components, velocity counters, and match weights. |
| `src/pages/aml/screenings/index.tsx` (line 556) | Drawer renders `{ label: t("List versions"), value: JSON.stringify(selected.value.lists ?? {}) }`. | Format `selected.value.lists` as structured `StatusBadge` chips (`OFAC: 2026-11`, `UN: 2026-11`, `EU: 2026-11`) or a compact key-value list. |
| `src/pages/disputes/index.tsx` (lines 690–692) | Drawer renders `selected.value.evidenceJson` in `<pre>{JSON.stringify(selected.value.evidenceJson, null, 2)}</pre>`. | Replace `<pre>` with a structured `DescriptionList` of evidence attributes (receipt reference, customer proof, operator notes, timestamps, attachment links) AND replace the raw JSON evidence submission input with structured fields (`receiptRef`, `customerProofSummary`, `merchantResponse`, `notes`). |
| `src/pages/audit-logs/index.tsx` (lines 161–162, 214), `src/pages/merchants/[id].tsx` (line 665), `src/pages/operator-cases/[id].tsx` (line 1016) | Table column `change` and operator case audit timeline render raw `JSON.stringify(beforeJson)` / `JSON.stringify(afterJson)`. | Replace raw JSON strings in table cells with a `summarizeAuditChange(beforeJson, afterJson)` helper (`legalName, riskTier (+2 more)`) and render `<JsonDiffViewer>` in the detail drawer/timeline. |

---

## 2. Architecture & Design System Rules for OpenCode

All new and updated files in `admin-front` **must** follow the exact conventions established in `db-rearch-3`:

1. **Component Authoring Pattern (`kt-dc` + Vue JSX):**
   - Always use `import { dc } from "kt-dc";` (`export default dc(() => { ... })` for pages, `export const ComponentName = dc((props: ...) => { ... }, { props: [...] })` for reusable components).
   - Use `useLocale()` from `"vuetify"` (`const { t } = useLocale()`), `api` from `@/state/api`, and `showSnackBar` from `@/utils/snackBar`.
2. **Standard Page Skeleton:**
   - Wrap every top-level screen in `<ScreenContainer>` with `<PageHeader title={...} subtitle={...} badge={...} badgeTone={...} end={() => (...)} />`.
   - Use `<MetricStrip items={[...]} />` for top-of-page KPI counters.
   - Use `<ApiTable tableKey="..." url={...} headers={...} rowActions={...} />` for server-paginated tables and register every new `tableKey` in `src/constants/tableRegistry.ts`.
   - Use `<SlideOverDrawer width={580} modelValue={...} title={...} subtitle={...}>` for row inspection and `<FormModal>` + `<SectionFields>` + `<FormField>` + `<FormChecklist>` for mutations.

---

## 3. Phase 1 — Backend & API Map Additions (`core-back`, `admin-back`, `urlsMap`)

Before adding the missing frontend pages and drawers, add the missing admin read/action endpoints in `core-back/api/internal/admin.ts`, forward them in `admin-back/api/protected/`, and register them in `admin-front/src/constants/urlsMap/index.ts`.

### 3.1 `core-back/api/internal/admin.ts` New & Enhanced Endpoints

Add the following routes to `core-back/api/internal/admin.ts`:

#### A. Global & Detail Wallets Endpoints (`/wallets`)
- `GET /wallets` (`requireAuthorities(request, ["merchant:read"])`):
  - Uses `buildListQuery` with `search: ["id", "glAccountId", "merchant.legalName", "merchant.displayName"]`, `in: { status: "status", currency: "currency" }`, `equals: { merchantId: "merchantId" }`, `dates: { createdAt: { path: "createdAt" } }`.
  - Returns paginated wallets with `merchant: { id, legalName, displayName }`, `currency`, `status`, `glAccountId`, `liveBalance` (computed via `GlAccountShard` sum + `checkpointBalance` when `canFinancial`), `checkpointBalance`, `applicationCount`, `paymentLinkCount`, `pendingCashoutCount`, `createdAt`.
- `GET /wallets/summary` (`requireAuthorities(request, ["merchant:read"])`):
  - Returns `{ totalWallets, activeWallets, frozenWallets, totalBalanceByCurrency, pendingCashoutWallets }`.
- `GET /wallets/:id` (`requireAuthorities(request, ["merchant:read"])`):
  - Returns full wallet detail + `merchant` + `glAccount` (including `glAccount.shards` from `client.glAccountShard.findMany({ where: { glAccountId: wallet.glAccountId }, orderBy: { shardIndex: "asc" } })`) + assigned `applications` + recent `cashoutRequests` (last 10) + recent `statementLines` (last 25 `JournalLine` rows for `glAccountId` with `journalEntry: { id, entryType, referenceType, referenceId, memo, postedAt }`).
- `POST /wallets/:id/status` (`requireAuthorities(request, ["merchant:write"])`):
  - Body: `{ status: "ACTIVE" | "FROZEN" | "CLOSED", reason: string }`. Updates `wallet.status`, writes an `AuditLog` (`action: "WALLET_STATUS_CHANGED"`), and returns the updated wallet.

#### B. Global & Detail Applications, Payment Links & POS Terminals Endpoints (`/applications`, `/payment-links`, `/pos-terminals`)
- Update existing `GET /merchants/:id/applications` (line 4881) to include `railWhitelist: Array.isArray(application.railWhitelist) ? application.railWhitelist : null` in the returned item so Merchant 360 has the actual rail codes, not just `railWhitelistCount`.
- `GET /applications` & `GET /applications/summary` (`requireAuthorities(request, ["merchant:read"])`):
  - Lists applications across all merchants with `merchant: { id, legalName, displayName }`, `assignedWallet`, `status`, `expectedMonthlyVolume`, `railWhitelist`, `railWhitelistMode`, `railWhitelistCount`, `redirectDomains`, `accessTokenCount`, `paymentLinkCount`, `posTerminalCount`, `createdAt`.
- `GET /applications/:id` (`requireAuthorities(request, ["merchant:read"])`):
  - Returns full application detail including `merchant`, `assignedWallet`, `railWhitelist`, `redirectDomainAllowlist`, `accessTokens` (`id`, `name`, `lastFour`, `scopes`, `expiresAt`, `revokedAt`, `lastUsedAt`, `createdAt`, `ipAllowlist: { id, cidr, note }[]` — never returning `secretHash`), `paymentLinks` (latest 25 with `id`, `key`, `titleAr`, `titleEn`, `amount`, `allowCustomAmount`, `currency`, `state`, `usesCount`, `maxUses`, `expiresAt`), and `posTerminals` (latest 25 with `id`, `name`, `location`, `deviceSerial`, `status`, `lastSeenAt`, `screens`).
- `PATCH /applications/:id` (`requireAuthorities(request, ["merchant:write"])`):
  - Body: `{ status?: "ACTIVE" | "FROZEN" | "CLOSED", assignedWalletId?: string, railWhitelist?: string[] | null, redirectDomainAllowlist?: string[], reason: string }`. Updates the application and logs `APPLICATION_UPDATED` to `AuditLog`.
- `POST /applications/:id/tokens/:tokenId/revoke` (`requireAuthorities(request, ["merchant:write"])`):
  - Body: `{ reason: string }`. Sets `revokedAt: new Date()` on `AccessToken` and logs `ACCESS_TOKEN_REVOKED`.
- `GET /payment-links` & `POST /payment-links/:id/state` (`requireAuthorities(request, ["merchant:read"])` / `["merchant:write"]`):
  - Global/merchant-filterable list of `PaymentLink` records (`key`, `titleEn`, `titleAr`, `merchant`, `application`, `wallet`, `amount`, `currency`, `state`, `usesCount`, `maxUses`, `expiresAt`) and state transition action (`ACTIVE | PAUSED | ARCHIVED` with mandatory `reason`).
- `GET /pos-terminals` & `POST /pos-terminals/:id/status` (`requireAuthorities(request, ["merchant:read"])` / `["merchant:write"]`):
  - Global/merchant-filterable list of `PosTerminal` records (`id`, `name`, `location`, `deviceSerial`, `merchant`, `application`, `status`, `lastSeenAt`, `screens`) and status transition action (`ACTIVE | SUSPENDED | REVOKED` with mandatory `reason`).

#### C. Post-Onboarding Merchant Compliance Endpoints (`/merchants/:id/beneficial-owners` & `/merchants/:id/revalidations`)
- `POST /merchants/:id/beneficial-owners`, `PATCH /merchants/:id/beneficial-owners/:ownerId`, `DELETE /merchants/:id/beneficial-owners/:ownerId` (`requireAuthorities(request, ["merchant:write", "kyb:write"])`):
  - Mirrors the JoinRequest beneficial owner CRUD so compliance officers can add, update, deactivate, or trigger sanctions screening on a `BeneficialOwner` after onboarding.
- `POST /merchants/:id/revalidations` (`requireAuthorities(request, ["kyb:write"])`):
  - Body: `{ docType: KybDocumentType, dueAt: string, message: string }`. Creates a `KybRevalidationRequest` for the merchant and queues a merchant notification.

#### D. Global Transactions, Enriched Attempt Detail & Inbound Webhooks (`/transactions`, `/attempts/:id`, `/inbound-events`)
- Upgrade existing `GET /attempts/:id` (line 9222) to include:
  - `merchant: { select: { id, displayName, legalName } }`, `application: { select: { id, name } }`, `rail: { select: { id, code, nameEn } }`, `gateway: { select: { id, code, name } }`,
  - `stepLogs: { orderBy: { stepOrder: "asc" } }` (redacting any raw secrets via `redactedRequestJson` / `redactedResponseText`),
  - `inboundEvents: { orderBy: { receivedAt: "desc" } }`,
  - `attemptGroup: { include: { attempts: { select: { id, status, railId, gatewayId, requestedAmount, createdAt } } } }`,
  - `operatorCases: { select: { id, kind, state, priority, slaDueAt } }`,
  - `disputes: { select: { id, status, disputedAmount, reasonCode, createdAt } }`,
  - `adjustments: { select: { id, type, state, amount, createdAt, journalEntryId } }`.
- `GET /transactions` & `GET /transactions/summary` (`requireAuthorities(request, ["attempt:read", "merchant:read", "finance:read"])`):
  - Queries `client.paymentAttempt` across all merchants with filters for `search` (`id`, `reference`, `providerReference`, `gatewayReference`, `networkReference`), `status`, `railId`, `gatewayId`, `merchantId`, `applicationId`, `currency`, `createdAt` date range, and amount range.
- `GET /inbound-events` (`requireAuthorities(request, ["attempt:read", "operations:read"])`):
  - Queries `client.inboundEvent` with filters for `gatewayId`, `signatureValid` (`true | false`), `unmatchedOnly` (`attemptId: null`), `canonicalStatus`, and `receivedAt` date range so operators can inspect dropped or signature-failed webhooks.

#### E. Double-Entry Journal Entries & GL Account Shards Endpoints (`/finance/journal-entries` & `/finance/gl-accounts/:id`)
- `GET /finance/journal-entries` & `GET /finance/journal-entries/summary` (`requireAuthorities(request, ["finance:read"])`):
  - Queries `client.journalEntry` with `search: ["id", "referenceId", "memo", "idempotencyKey"]`, `in: { referenceType: "referenceType" }`, `dates: { postedAt: { path: "postedAt" } }`, plus optional filter `glAccountId` (via `lines: { some: { glAccountId } }`).
  - Includes `lines: { include: { glAccount: { select: { id, accountType, ownerId, currency } } } }` and computes `totalDebit`, `totalCredit`, `balanced: totalDebit === totalCredit`.
- `GET /finance/journal-entries/:id` (`requireAuthorities(request, ["finance:read"])`):
  - Returns full `JournalEntry` with all `JournalLine` items, linked `GlAccount` metadata, and resolved entity link (`referenceType` + `referenceId`).
- `GET /finance/gl-accounts/:id` (`requireAuthorities(request, ["finance:read"])`):
  - Returns `GlAccount` + `shards: GlAccountShard[]` (`shardIndex`, `balance`, `updatedAt`) + `liveBalance` + `checkpointBalance` + `checkpointAt` + last 30 `JournalLine` rows for that account.
- `POST /finance/gl-accounts/:id/checkpoint` (`requireAuthorities(request, ["finance:write"])`):
  - Runs checkpoint rollup for the specified `GlAccount` (consolidating `GlAccountShard` deltas into `checkpointBalance`), writes an `AuditLog` (`GL_ACCOUNT_CHECKPOINT_TRIGGERED`), and returns the refreshed account snapshot.

#### F. Gateway Health Telemetry (`GET /gateways/:id/health`)
- `GET /gateways/:id/health` (`requireAuthorities(request, ["gateway:read"])`):
  - Returns the last 100 `GatewayHealthSample` rows (`state`, `successRate`, `p95LatencyMs`, `sampleWindowStart`, `sampleWindowEnd`) and last 30 days of `RmRouteDailyVolume` for the gateway's routes.

#### G. System Outbox, Background Jobs & Notification Templates (`/system/jobs-outbox` & `/settings/notification-templates`)
- `GET /system/jobs-outbox/summary`, `GET /system/jobs`, `GET /system/outbox`, `POST /system/outbox/:id/retry`, `POST /system/notifications/:id/retry` (`requireAuthorities(request, ["system:read"])` / `["system:write"]`):
  - Exposes `BackgroundJob` runs, `OutboxEvent` rows (`publishedAt: null` vs published), `AuditOutbox` queue depth, and failed `Notification` rows (`status: "FAILED"`) with retry support.
- `GET /settings/notification-templates` & `PUT /settings/notification-templates/:id` (`requireAuthorities(request, ["settings:read"])` / `["settings:write"]`):
  - Lists and updates `NotificationTemplate` records (`key`, `channel`, `lang`, `subject`, `body`, `confidentiality`).

### 3.2 `admin-back/api/protected/` Proxy Additions
Forward the new endpoints in `admin-back/api/protected/merchants.ts`, `finance.ts`, `operations.ts`, `gateways.ts`, `backups.ts`, and `settings.ts` using `coreForward`.

### 3.3 `admin-front/src/constants/urlsMap/index.ts` Additions
Add the following keys to `urlsMap` in `admin-front/src/constants/urlsMap/index.ts`:
```ts
    // Global Wallets, Applications, Payment Links & POS Terminals
    walletsList: "v1/admin/wallets",
    walletsSummary: "v1/admin/wallets/summary",
    walletDetail: (id: string) => `v1/admin/wallets/${id}`,
    walletStatus: (id: string) => `v1/admin/wallets/${id}/status`,
    applicationsList: "v1/admin/applications",
    applicationsSummary: "v1/admin/applications/summary",
    applicationDetail: (id: string) => `v1/admin/applications/${id}`,
    applicationRevokeToken: (id: string, tokenId: string) => `v1/admin/applications/${id}/tokens/${tokenId}/revoke`,
    paymentLinksList: "v1/admin/payment-links",
    paymentLinkState: (id: string) => `v1/admin/payment-links/${id}/state`,
    posTerminalsList: "v1/admin/pos-terminals",
    posTerminalStatus: (id: string) => `v1/admin/pos-terminals/${id}/status`,

    // Post-onboarding Merchant Compliance
    merchantBeneficialOwners: (id: string) => `v1/admin/merchants/${id}/beneficial-owners`,
    merchantBeneficialOwner: (id: string, ownerId: string) => `v1/admin/merchants/${id}/beneficial-owners/${ownerId}`,
    merchantRevalidations: (id: string) => `v1/admin/merchants/${id}/revalidations`,

    // Global Transactions & Inbound Webhooks
    transactionsList: "v1/admin/transactions",
    transactionsSummary: "v1/admin/transactions/summary",
    inboundEventsList: "v1/admin/inbound-events",

    // Journal Entries & GL Accounts
    financeJournalEntries: "v1/admin/finance/journal-entries",
    financeJournalEntriesSummary: "v1/admin/finance/journal-entries/summary",
    financeJournalEntryDetail: (id: string) => `v1/admin/finance/journal-entries/${id}`,
    financeGlAccountDetail: (id: string) => `v1/admin/finance/gl-accounts/${id}`,
    financeGlAccountCheckpoint: (id: string) => `v1/admin/finance/gl-accounts/${id}/checkpoint`,

    // Gateway Health & Credential Sets
    gatewayHealth: (id: string) => `v1/admin/gateways/${id}/health`,
    credentialSetRevoke: (id: string) => `v1/admin/credential-sets/${id}/revoke`,

    // AML Reporting Rules promote
    amlReportingRulePromote: (id: string) => `v1/admin/aml/reporting-rules/${id}/promote`,

    // System Jobs, Outbox & Notification Templates
    systemJobsOutboxSummary: "v1/admin/system/jobs-outbox/summary",
    systemJobsList: "v1/admin/system/jobs",
    systemOutboxList: "v1/admin/system/outbox",
    systemOutboxRetry: (id: string) => `v1/admin/system/outbox/${id}/retry`,
    systemNotificationRetry: (id: string) => `v1/admin/system/notifications/${id}/retry`,
    notificationTemplatesList: "v1/admin/settings/notification-templates",
    notificationTemplateDetail: (id: string) => `v1/admin/settings/notification-templates/${id}`,
```

---

## 4. Phase 2 — Wallets, Applications, Payment Links & POS Terminals (Global Pages + Merchant 360 Upgrade)

### 4.1 Reusable `WalletDetailDrawer.tsx` (`src/pages/merchants/components/WalletDetailDrawer.tsx`)
Create `WalletDetailDrawer.tsx` used by both `/wallets` and `/merchants/[id].tsx`:
- Opens a `<SlideOverDrawer width={600}>` calling `GET urlsMap.walletDetail(walletId)`.
- **Header Actions:**
  - If `canWrite` (`merchant:write`), renders a **Freeze Wallet** (`status === "ACTIVE"`) or **Unfreeze Wallet** (`status === "FROZEN"`) button that opens a `<FormModal>` requiring a mandatory `reason` and calling `POST urlsMap.walletStatus(wallet.id)`.
- **Drawer Sections (via `<SegmentedTabs>`):**
  1. **Overview & Shards (`overview`):**
     - `<DescriptionList>` showing `Wallet ID` (`<MonoRef>`), `Merchant` (router link to `/merchants/:id`), `Currency`, `Status` (`<StatusBadge>`), `GL Account ID` (clickable `<MonoRef>` that opens `GlAccountDrawer`), `Live Balance` (`<MoneyDisplay>`), `Checkpoint Balance` (`<MoneyDisplay>`), `Pending Cashouts`, and `Created At`.
     - **Shards Breakdown Table (`gl_account_shards`):** Displays the wallet's `GlAccountShard` rows (`shardIndex`, `balance`, `updatedAt`) so operators can inspect hot-account shard distribution in real time.
  2. **Statement / Journal Lines (`statement`):**
     - Compact table of the wallet's recent `JournalLine` entries (`Posted At`, `Reference Type`, `Debit`, `Credit`, `Reference ID`, `Journal Entry ID`).
     - Clicking any row's `Journal Entry ID` opens `<JournalEntryDrawer entryId={line.journalEntryId} />`.
  3. **Assigned Applications & Cashouts (`links`):**
     - Lists applications assigned to this wallet and recent `CashoutRequest` records with status badges.

### 4.2 Reusable `ApplicationDetailDrawer.tsx` (`src/pages/merchants/components/ApplicationDetailDrawer.tsx`)
Create `ApplicationDetailDrawer.tsx` used by both `/applications` and `/merchants/[id].tsx`:
- Opens a `<SlideOverDrawer width={640}>` calling `GET urlsMap.applicationDetail(applicationId)`.
- **Header Actions:**
  - If `canWrite` (`merchant:write`), renders **Edit Application Policy** (opens `<FormModal>` to update `status` `ACTIVE | FROZEN | CLOSED`, `assignedWalletId`, `railWhitelist` multi-select using `urlsMap.options("rails")`, and `redirectDomainAllowlist` chip list) calling `PATCH urlsMap.applicationDetail(app.id)`.
- **Drawer Sections (via `<SegmentedTabs>`):**
  1. **Configuration & Allowlists (`config`):**
     - `<DescriptionList>` with `Application ID` (`<MonoRef>`), `Name`, `Status` (`<StatusBadge>`), `Assigned Wallet` (`<MonoRef>` + currency), `Expected Monthly Volume` (`<MoneyDisplay>`), `Created At`.
     - **Rail Whitelist Section:** Renders `"All active rails allowed"` badge when `railWhitelist === null`, `"No rails allowed"` warning badge when `[]`, or individual rail code chips (`ly_sadad`, `ly_mobicash`, etc.) when populated.
     - **Redirect Domain Allowlist Section:** Renders each allowed redirect domain/URL as a monospace pill (`https://shop.example.ly/callback`).
  2. **API Access Tokens (`tokens`):**
     - Lists every `AccessToken` for the application (`Name`, `****LastFour`, `Scopes` chips, `IP Allowlist CIDRs` chips, `Last Used At`, `Expires At`, `Status`: `ACTIVE | REVOKED | EXPIRED`).
     - Includes a **Revoke Token** row action (`POST urlsMap.applicationRevokeToken(app.id, token.id)`) with a mandatory reason modal.
  3. **Payment Links (`payment-links`):**
     - Table of the application's `PaymentLink` records (`Key`, `Title`, `Amount`, `Custom Amount Allowed`, `Uses / Max Uses`, `State`, `Expires At`) with a **Pause / Activate / Archive Link** action (`POST urlsMap.paymentLinkState(link.id)`).
  4. **POS Terminals (`pos-terminals`):**
     - Table of the application's `PosTerminal` records (`Name`, `Device Serial`, `Location`, `Status`, `Last Seen`, `Screens Count`) with a **Suspend / Activate / Revoke Terminal** action (`POST urlsMap.posTerminalStatus(terminal.id)`).

### 4.3 Upgrade `src/pages/merchants/[id].tsx` (Merchant 360 Complete Overhaul)
Modify `admin-front/src/pages/merchants/[id].tsx`:
1. **Always show the Wallets tab** in `segmentedTabItems` (remove the `canFinancial ? ... : []` hiding on line 412 so `merchant:read` roles can view wallet statuses, counts, and metadata while balances remain redacted by the backend when `!canFinancial`).
2. **Make Applications & Wallets tabs interactive:**
   - Pass `rowActions` to `<MerchantResourceTable>` on the **Applications** tab (`Inspect Application`, `Edit Allowlists & Status`) opening `<ApplicationDetailDrawer>`.
   - Display actual rail code badges in the `railWhitelist` column when `row.railWhitelist` is a list of ≤3 codes, plus a click action to view all.
   - Pass `rowActions` to `<MerchantResourceTable>` on the **Wallets** tab (`View Statement & Shards`, `Freeze / Unfreeze Wallet`) opening `<WalletDetailDrawer>`.
3. **Make `journalEntryId` clickable on the Adjustments, Cashouts & Transactions tabs:**
   - Clicking a `journalEntryId` / `ledgerEntryId` opens `<JournalEntryDrawer>`.
4. **Complete the Overview Tab Cards (`lines 938–1055`):**
   - **Pending Changes Card (line 938):** Render `<JsonDiffViewer diff={change.payloadDiff} />` inside each pending change card and add an `"Open in Approvals"` button (`/approvals?highlight=${change.id}`).
   - **AML Cases Card (line 975):** Add an `"Open Case"` button on each case row navigating to `/aml/cases?highlight=${amlCase.id}`.
   - **KYB Evidence & Revalidations Card (line 999):** Always show this card when `show("compliance")` is active (even if `kybDocuments.length === 0`) and add a **`Request KYB Revalidation`** button (`POST urlsMap.merchantRevalidations(merchantId.value)`) so compliance officers can request fresh documents at any time.
   - **Beneficial Owners Card (line 1018):** Replace the plain text list with a structured table showing `Full Name (EN/AR)`, `Role`, `Ownership %`, `Nationality`, `PEP Badge`, `Screening Status`, and action buttons to **Add Beneficial Owner**, **Edit Owner**, or **Deactivate Owner** (`urlsMap.merchantBeneficialOwners`).
   - **Merchant Users, Access Tokens & Credential Sets Card (line 1033):** Replace the plain `<ThemedText>` lines with structured action rows: clicking a User navigates to `/users/:id`; clicking an Access Token opens the revocation modal; clicking a Credential Set navigates to `/credential-sets?highlight=${credential.id}`.

### 4.4 Create Global Wallets Page (`src/pages/wallets/index.tsx`) & Global Applications Page (`src/pages/applications/index.tsx`)
1. **`src/pages/wallets/index.tsx` (`route: "AdminWallets"`, `/wallets`):**
   - `<MetricStrip>` from `urlsMap.walletsSummary`: `Total Wallets`, `Active Wallets`, `Frozen Wallets`, `Pending Cashout Wallets`.
   - `<ApiTable tableKey="wallets" url={urlsMap.walletsList}>` with columns: `Wallet ID` (`<MonoRef>`), `Merchant` (clickable link to `/merchants/:id`), `Currency`, `Status` (`<StatusBadge>`), `Live Balance` (`<MoneyDisplay>`), `Checkpoint Balance` (`<MoneyDisplay>`), `GL Account` (`<MonoRef>`), `Applications`, `Pending Cashouts`, `Created`.
   - Row actions: `Inspect Statement & Shards` (opens `<WalletDetailDrawer>`), `Inspect GL Account` (opens `<GlAccountDrawer>`), `Freeze / Unfreeze Wallet`.
2. **`src/pages/applications/index.tsx` (`route: "AdminApplications"`, `/applications`):**
   - Top `<SegmentedTabs>` switching between:
     - **`Applications` (`applications`):** `<ApiTable tableKey="applications" url={urlsMap.applicationsList}>` with columns: `Application` (`name` + `<MonoRef value={row.id} />`), `Merchant` (link to `/merchants/:id`), `Status` (`<StatusBadge>`), `Assigned Wallet` (`<MonoRef>`), `Monthly Volume` (`<MoneyDisplay>`), `Rail Whitelist` (badges), `Redirect Domains`, `API Tokens`, `Links / POS`, `Created`. Row actions open `<ApplicationDetailDrawer>`.
     - **`Payment Links` (`payment-links`):** `<ApiTable tableKey="payment-links" url={urlsMap.paymentLinksList}>` allowing support/risk operators to search any `PaymentLink` across the platform by `key` or merchant and pause/archive abusive links.
     - **`POS Terminals` (`pos-terminals`):** `<ApiTable tableKey="pos-terminals" url={urlsMap.posTerminalsList}>` allowing operators to search any physical/virtual `PosTerminal` by `deviceSerial` or merchant and suspend/revoke compromised terminals.

---

## 5. Phase 3 — Ledger Audit (`Invariant`), GL Account Shards & Double-Entry Journal Entries

### 5.1 Create Reusable `JournalEntryDrawer.tsx` (`src/components/ledger/JournalEntryDrawer.tsx`)
Create a global double-entry inspector drawer that can be opened from `/finance/journal-entries`, `/finance/invariant`, `/merchants/[id]`, `/adjustments`, `/cashouts`, `/disputes`, and `MerchantTransactionDialog`:
- Calls `GET urlsMap.financeJournalEntryDetail(entryId)`.
- **Header & Summary:**
  - Displays `Entry ID` (`<MonoRef>`), `Reference Type` (`<StatusBadge>`), `Posted At`, `Idempotency Key` (`<MonoRef>`), `Reference ID` (clickable link to the transaction, adjustment, cashout, or dispute), `Memo`, and a **Balanced Check Badge** (`Σ Debits = Σ Credits` in emerald green).
- **Double-Entry T-Account Lines Table:**
  - Columns: `Line #`, `GL Account` (clickable `<MonoRef>` that opens `GlAccountDrawer`), `Account Type` (`MERCHANT_WALLET`, `PLATFORM_COMMISSION_REVENUE`, `GATEWAY_CLEARING`, `TREASURY`, `CASHOUT_SUSPENSE`, `AML_HOLD`, `CHARGEBACK_RESERVE`, etc.), `Currency`, `Debit` (`<MoneyDisplay>` if `direction === "DEBIT"`, else `—`), `Credit` (`<MoneyDisplay>` if `direction === "CREDIT"`, else `—`).
  - Footer row showing bold `Total Debits` and `Total Credits`.

### 5.2 Create Reusable `GlAccountDrawer.tsx` (`src/components/ledger/GlAccountDrawer.tsx`)
Create a GL Account & Shards inspector drawer:
- Calls `GET urlsMap.financeGlAccountDetail(accountId)`.
- Shows `Account ID`, `Account Type`, `Owner ID`, `Currency`, `Live Balance` (`<MoneyDisplay>`), `Checkpoint Balance` (`<MoneyDisplay>`), and `Last Checkpoint At`.
- **Shards Breakdown Section (`gl_account_shards`):**
  - Displays every `GlAccountShard` row (`Shard Index #0..N`, `Shard Delta Balance`, `Last Updated At`) so operators can verify the Postgres 18 hot-account sharded ledger state.
  - Includes a **Run Manual Checkpoint Rollup** button (`POST urlsMap.financeGlAccountCheckpoint(accountId)`, gated by `finance:write`) to consolidate shard deltas into `checkpointBalance`.
- **Recent Account Journal Lines:**
  - Lists the last 30 `JournalLine` rows posted to this GL account; clicking any line opens `<JournalEntryDrawer>`.

### 5.3 Create Journal Entries Explorer Page (`src/pages/finance/journal-entries/index.tsx`)
- Route: `name: "AdminFinanceJournalEntries"`, path: `/finance/journal-entries`, under the `Finance` sidebar section right above `Ledger Audit & Invariant`.
- `<MetricStrip>` from `urlsMap.financeJournalEntriesSummary`: `Total Journal Entries`, `Entries (24h)`, `Total Volume Posted (24h)`, `Unbalanced Entries (0)`.
- `<ApiTable tableKey="finance-journal-entries" url={urlsMap.financeJournalEntries}>`:
  - Filters: Search (`id`, `referenceId`, `memo`, `idempotencyKey`), `referenceType` select (`ATTEMPT`, `ADJUSTMENT`, `CASHOUT`, `RECONCILIATION`, `FEE_SETTLEMENT`), `glAccountId` filter, `postedAt` date range.
  - Columns: `Entry ID` (`<MonoRef>`), `Reference Type` (`<StatusBadge>`), `Reference ID` (`<MonoRef>`), `Memo`, `Lines Count`, `Total Debit` (`<MoneyDisplay>`), `Total Credit` (`<MoneyDisplay>`), `Balance Status` (`BALANCED` badge), `Posted At`.
  - Clicking a row or its `Inspect T-Account` action opens `<JournalEntryDrawer>`.

### 5.4 Upgrade `/finance/invariant` (`src/pages/finance/invariant/index.tsx`) into Full Ledger Audit & Shards Inspector
Update `admin-front/src/pages/finance/invariant/index.tsx`:
- Rename page header and sidebar label from `"Invariant"` to **`"Ledger Audit & Invariant"`** (`t("Ledger Audit & Invariant")`).
- Add row actions on the `Account balances` table:
  - `Inspect Shards & Lines` -> opens `<GlAccountDrawer accountId={row.accountId} />`.
  - `View Journal Entries` -> navigates to `/finance/journal-entries?glAccountId=${row.accountId}`.
  - `Run Checkpoint Rollup` -> triggers `POST urlsMap.financeGlAccountCheckpoint(row.accountId)`.

---

## 6. Phase 4 — Transactions & Webhooks Explorer, Enriched Transaction Drawer, Route Caps, Gateway Health & System Monitors

### 6.1 Upgrade `MerchantTransactionDialog.tsx` into a Full Transaction Lifecycle Drawer
Update `src/pages/merchants/components/MerchantTransactionDialog.tsx`:
- When opened for a transaction, fetch `GET urlsMap.attemptDetail(tx.id)` to load full telemetry (`stepLogs`, `inboundEvents`, `attemptGroup`, `disputes`, `adjustments`).
- Render `<SegmentedTabs>` inside the drawer:
  1. **`Summary & Financial Split` (`summary`):** Existing payment & amount breakdown, with clickable `Ledger Entry` (opens `<JournalEntryDrawer>`), clickable `Application` (opens `<ApplicationDetailDrawer>`), and clickable `Operator Cases`, `Disputes`, and `Adjustments`.
  2. **`Step Logs & Wire Trace` (`steps`):** Timeline of `AttemptStepLog` records (`stepOrder`, `phase`, `stepCode`, `httpMethod`, `targetUrl`, `responseStatus`, `durationMs`, and collapsible redacted request/response payload).
  3. **`Inbound Webhooks` (`webhooks`):** List of `InboundEvent` callbacks (`receivedAt`, `signatureValid` badge, `canonicalStatus`, `providerEventId`, collapsible headers/body).
  4. **`Checkout Retry Group` (`group`):** Shows all sibling attempts in `attemptGroup` so operators can see if a customer failed on one rail and succeeded on another.
- **Footer Quick Actions:**
  - `Schedule Gateway Inquiry` (`POST urlsMap.attemptInquire(tx.id)`) when `status` is `UNKNOWN` or `VERIFYING`.
  - `Create Refund / Adjustment` (navigates to `/adjustments?attemptId=${tx.id}&merchantId=${tx.merchantId}`).
  - `Record Dispute` (navigates to `/disputes?attemptId=${tx.id}`).

### 6.2 Create Global Transactions & Inbound Webhooks Page (`src/pages/transactions/index.tsx`)
- Route: `name: "AdminTransactions"`, path: `/transactions` (placed at the top of the `Operations` sidebar section).
- `<SegmentedTabs>` switching between:
  1. **`Payment Attempts` (`attempts`):**
     - `<MetricStrip>` from `urlsMap.transactionsSummary`: `Total Attempts (24h)`, `Settled`, `In-Flight / Verifying`, `Failed`, `Escalated to Case`.
     - `<ApiTable tableKey="transactions" url={urlsMap.transactionsList}>` with filters for `status`, `railId`, `gatewayId`, `merchantId`, `currency`, and date range.
     - Row actions open the upgraded `<MerchantTransactionDialog>` or trigger `POST urlsMap.attemptInquire(row.id)`.
  2. **`Inbound Webhooks` (`inbound-events`):**
     - `<ApiTable tableKey="inbound-events" url={urlsMap.inboundEventsList}>` with filters for `gatewayId`, `signatureValid` (`false` to spot forged/broken webhooks), and `unmatchedOnly` (`true` to spot orphan callbacks).

### 6.3 Wire `urlsMap.financeRouteCaps` into `/routes` (`src/pages/routes/index.tsx`) & `/finance/liquidity`
- In `src/pages/routes/index.tsx` and `src/pages/finance/liquidity/index.tsx`, call `GET urlsMap.financeRouteCaps`:
  - Display each route's `dailyProcessedAmount` / `dailyCapAmount`, `dailyCapRemaining`, `utilisation %`, and a `DAILY_CAP_EXCEEDED` warning badge when `capExhausted === true`.

### 6.4 Create Credential Sets Vault Page (`src/pages/credential-sets/index.tsx`)
- Route: `name: "AdminCredentialSets"`, path: `/credential-sets` (under the `Gateways` sidebar section).
- Update `GlobalSearchPalette.tsx` (line 213) so `case "credential_set":` routes to `{ name: "AdminCredentialSets", query: { highlight: item.id } }`.
- `<ApiTable tableKey="credential-sets" url={urlsMap.credentialSetsList}>` with actions for **Create Credential Set**, **Rotate Secret Keys**, **Verify Connectivity** (`POST urlsMap.credentialSetVerify(row.id)`), and **Revoke Credential Set** (`POST urlsMap.credentialSetRevoke(row.id)`).

### 6.5 Add Gateway Health Telemetry Drawer to `/gateways` (`src/pages/gateways/index.tsx`)
- Add a **`Health & Telemetry`** row action on `src/pages/gateways/index.tsx` that opens a `<SlideOverDrawer>` calling `GET urlsMap.gatewayHealth(row.id)`:
  - Renders `<EChart>` charts for `Success Rate (%)` and `p95 Latency (ms)` across recent `GatewayHealthSample` windows plus 30-day route volume (`RmRouteDailyVolume`).

### 6.6 Add `Reporting Rules` Tab to `src/pages/aml/rules/index.tsx` & Logo Asset Picker to `src/pages/rails/index.tsx`
- In `src/pages/aml/rules/index.tsx`, add `<SegmentedTabs>` for `Detection Rules (AmlRule)` and `Reporting Rules (ReportingRule)` (wired to `GET/POST urlsMap.amlReportingRules` and `POST urlsMap.amlReportingRulePromote(row.id)`).
- In `src/pages/rails/index.tsx`, wire `urlsMap.assetsList` so operators can upload or select an SVG/PNG logo asset (`logoAssetId`) when creating or editing a rail.

### 6.7 Create System Jobs, Outbox & Notification Center (`src/pages/system/jobs-outbox/index.tsx`) & Notification Templates Tab (`src/pages/settings/platform/index.tsx`)
- **`src/pages/system/jobs-outbox/index.tsx` (`/system/jobs-outbox`):**
  - `<MetricStrip>` from `urlsMap.systemJobsOutboxSummary`: `Unpublished Outbox Events`, `Audit Outbox Queue`, `Background Jobs (24h)`, `Failed Notifications`.
  - `<SegmentedTabs>` for `Transactional Outbox (OutboxEvent)`, `Background Jobs (BackgroundJob)`, and `Failed Notifications (Notification)` with retry buttons.
- **Notification Templates Tab in `src/pages/settings/platform/index.tsx`:**
  - Add a `<SegmentedTabs>` switch in `src/pages/settings/platform/index.tsx` between `Platform Parameters (PlatformSetting)` and `Notification Templates (NotificationTemplate)` (wired to `GET/PUT urlsMap.notificationTemplatesList` so admins can edit Arabic/English email, SMS, and webhook templates with variable placeholders).

---

## 7. Phase 5 — Eliminating Every Raw JSON View & Raw JSON Form Input

Replace every raw `<pre>{JSON.stringify(...)}</pre>` and `<VTextarea label="... JSON">` identified in Section 1.4 with purpose-built, validated UI components:

### 7.1 `src/components/ui/JsonDiffViewer.tsx`, `src/components/JsonPatchDiff/index.tsx`, & `src/pages/approvals/index.tsx`
1. **Upgrade `JsonDiffViewer.tsx`:**
   - Accept `diff: unknown` (handling RFC-6902 patch arrays `[{ op, path, fromValue, value }]`, `{ before, after }` pairs, and plain object payloads used by `DRAFT_AML_RULE`, `CREATE_ADJUSTMENT`, `PUBLISH_GATEWAY_VERSION`, etc.).
   - Convert camelCase / slash paths (`/payoutBankDetailsJson/iban`, `/commissionReceivableCeiling`) into clean human labels (`Payout Bank Details · IBAN`, `Commission Receivable Ceiling`).
   - Flatten nested object values into individual sub-rows instead of calling `JSON.stringify(value, null, 2)` inside a table cell.
   - Format numeric money fields (`*Amount`, `*Ceiling`, `*Fee`, `*Balance`, `*Volume`) with `<MoneyDisplay>` and status strings with `<StatusBadge>`.
2. **Unify `src/components/JsonPatchDiff/index.tsx`:**
   - Replace the `<pre>` implementation in `src/components/JsonPatchDiff/index.tsx` with a thin wrapper around `<JsonDiffViewer>` so all callers share the same human-readable renderer.
3. **Update `src/pages/approvals/index.tsx` (line 1023):**
   - Remove the `<pre>{jsonText(selected.value.payloadDiff)}</pre>` fallback and pass `selected.value.payloadDiff` directly to `<JsonDiffViewer diff={selected.value.payloadDiff} />`.

### 7.2 `src/pages/routes/index.tsx` — Structured Cost Model, Scope & Maintenance Windows Builder
1. **Table Column `costModel` (line 430):**
   - Replace `JSON.stringify(row.costModel ?? {})` with a human-readable formatter: e.g., `1.25% + 0.500 LYD (min 0.500, max 25.000)`.
2. **Edit Route Modal (lines 422–435):**
   - Delete both `<VTextarea>` fields (`costModel` and `scope`) and replace them with:
     - **Cost Model Section (`<SectionFields title={t("Gateway Cost Model")}>`):**
       - `Fee Type` (`<VSelect items={["FLAT", "PERCENTAGE", "BLENDED", "TIERED"]} />`), `Percentage Rate (bps or %)`, `Fixed Fee Amount`, `Minimum Fee`, `Maximum Fee`, `Cost Currency`.
     - **Route Scope & Constraints Section (`<SectionFields title={t("Routing Scope & Constraints")}>`):**
       - `Allowed Currencies` (multi-select chips), `Allowed Merchant Risk Tiers` (multi-select chips), `Min Transaction Amount`, `Max Transaction Amount`, `Mismatch Policy` (`HOLD_FOR_REVIEW | AUTO_REFUND | ACCEPT_WITH_ALERT | REJECT`).
     - **Maintenance Windows Builder:** Dynamic row list to add/remove scheduled maintenance windows (`dayOfWeek`, `startTimeUtc`, `endTimeUtc`, `reason`).

### 7.3 `src/pages/settings/platform/index.tsx` — Schema-Driven Platform Settings Editor
1. **Setting Cards & History Table (lines 299, 370, 401):**
   - Replace `jsonPreview(entry.latest.valueJson)` with a structured `<DescriptionList>` rendering each key-value pair in `valueJson` with human labels, boolean `<StatusBadge>` pills (`Enabled` / `Disabled`), and formatted numbers/durations.
2. **Edit Setting Modal (lines 424–431):**
   - Replace the 12-row `<VTextarea label="JSON value">` with `<PlatformSettingTypedEditor settingKey={editTarget.value.key} modelValue={editParsedValue.value} />` that renders typed `<VSwitch>`, `<VTextField type="number">`, `<VSelect>`, and chip inputs based on the setting key namespace (`risk.*`, `cashout.*`, `reconciliation.*`, `ledger.*`, `security.*`, `storage.*`).

### 7.4 `src/pages/reconciliation/index.tsx` — Structured Statement Source Parser & Column Mapper
1. **Statement Sources Table Column `mapping` (line 591):**
   - Replace `JSON.stringify(row.columnMapping ?? {})` with compact mapping badges (`Ref → col_1`, `Amount → col_3`, `Date → col_0`).
2. **Create / Edit Statement Source Modal (lines 519–526):**
   - Replace `<VTextarea label="Parser config JSON">` with structured `<SectionFields>`:
     - **File Format Settings:** `Delimiter` (`,`, `;`, `\t`, `|`), `Skip Header Rows` (`number`), `Date Format` (`YYYY-MM-DD`, `DD/MM/YYYY`, `ISO_8601`), `Amount Format` (`DECIMAL`, `MINOR_UNITS`, `SIGNED_DEBIT_CREDIT`), `Encoding` (`UTF-8`, `WINDOWS-1256`).
     - **Column Mapping Fields:** Explicit `<VTextField>` inputs for `Gateway Reference Column`, `Transaction Date Column`, `Gross Amount Column`, `Fee Amount Column`, `Currency Column`, and `Status Column`.

### 7.5 `src/pages/aml/rules/index.tsx`, `src/pages/aml/cases/index.tsx`, `src/pages/aml/screenings/index.tsx`, & `src/pages/disputes/index.tsx`
1. **`src/pages/aml/rules/index.tsx` (lines 386–391, 402–403, 591–593):**
   - Replace `JSON.stringify(row.params)` in the table and `<pre>{JSON.stringify(scope/params)}</pre>` in the drawer with formatted human summaries (`Window: 24h · Max Count: 10 · Max Amount: 50,000 LYD`).
   - In the **Draft AML Rule** modal, replace `<VTextarea label="Scope JSON">` and `<VTextarea label="Params JSON">` with structured inputs driven by `form.value.category` (`VELOCITY`, `STRUCTURING`, `HIGH_VALUE`, `GEOGRAPHY`, `SANCTIONS`).
2. **`src/pages/aml/cases/index.tsx` (lines 735–736):**
   - Replace `<pre>{JSON.stringify(selected.value.severityInputs ?? {}, null, 2)}</pre>` with a structured `<DescriptionList>` displaying each key in `severityInputs` (`Triggered Rule`, `Match Score`, `Velocity 24h`, `Merchant Risk Tier`, `Prior Cases Count`).
3. **`src/pages/aml/screenings/index.tsx` (line 556):**
   - Replace `JSON.stringify(selected.value.lists ?? {})` with inline `<StatusBadge>` pills for each screening list and version (`OFAC`, `UN`, `EU`, `LOCAL_CBL`).
4. **`src/pages/disputes/index.tsx` (lines 690–692 & 720–735):**
   - Replace `<pre>{JSON.stringify(selected.value.evidenceJson, null, 2)}</pre>` in the drawer with a structured `<DescriptionList>` and replace the raw JSON evidence `<VTextarea>` in the Submit Evidence modal with structured fields (`Receipt / RRN Reference`, `Customer Proof Summary`, `Merchant Explanation`, `Supporting Document URLs / Notes`).

### 7.6 `src/pages/finance/pricing/index.tsx` — Interactive Commission Tiers Table & Diff History
1. **Audit History Modal (line 516):**
   - Replace `JSON.stringify(entry.afterJson ?? {}).slice(0, 240)` with `<JsonDiffViewer diff={{ before: entry.beforeJson, after: entry.afterJson }} />`.
2. **New Commission Profile Modal (lines 325–328):**
   - Replace `<VTextarea label="Tiers JSON">` with a dynamic `CommissionTiersEditor` table (`Min Volume`, `Max Volume`, `Percentage (bps)`, `Fixed Fee`, `+ Add Tier` / `Remove`) and add form inputs for `minFee`, `maxFee`, `feeBearerDefault` (`MERCHANT | CUSTOMER | SPLIT`), `roundingMode` (`HALF_UP | HALF_EVEN | FLOOR | CEIL`), `merchantId`, and `applicationId`.

### 7.7 `src/pages/audit-logs/index.tsx`, `src/pages/merchants/[id].tsx`, & `src/pages/operator-cases/[id].tsx`
- Create a shared helper `summarizeAuditChange(before: unknown, after: unknown): string[]` in `src/utils/auditSummary.ts` that extracts the human-readable names of changed top-level keys (`["Status", "Risk Tier", "Payout Bank"]`).
- Render up to 3 compact chips (`Status`, `Risk Tier`, `+2 more`) in the `change` column of `src/pages/audit-logs/index.tsx` (line 214) and `src/pages/merchants/[id].tsx` (line 665) instead of raw `JSON.stringify(...)`.
- In `src/pages/operator-cases/[id].tsx` (line 1016), replace `<pre style={preStyle}>{jsonText({ before: audit.beforeJson, after: audit.afterJson })}</pre>` with `<JsonDiffViewer diff={{ before: audit.beforeJson, after: audit.afterJson }} />`.

---

## 8. Phase 6 — Router, Sidebar Navigation & Table Registry Updates

### 8.1 `admin-front/src/router/index.ts`
Register the 6 new routes inside the authenticated layout children in `src/router/index.ts`:
- `/wallets` -> `name: "AdminWallets"`, `component: () => import("@/pages/wallets/index.tsx")`
- `/applications` -> `name: "AdminApplications"`, `component: () => import("@/pages/applications/index.tsx")`
- `/transactions` -> `name: "AdminTransactions"`, `component: () => import("@/pages/transactions/index.tsx")`
- `/credential-sets` -> `name: "AdminCredentialSets"`, `component: () => import("@/pages/credential-sets/index.tsx")`
- `/finance/journal-entries` -> `name: "AdminFinanceJournalEntries"`, `component: () => import("@/pages/finance/journal-entries/index.tsx")`
- `/system/jobs-outbox` -> `name: "AdminSystemJobsOutbox"`, `component: () => import("@/pages/system/jobs-outbox/index.tsx")`

### 8.2 `admin-front/src/layouts/sections.tsx`
1. Add the new sidebar entries under their logical sections:
   - **Merchants:** `Merchants`, `Wallets` (`AdminWallets`), `Applications & Channels` (`AdminApplications`), `Join Requests`, `KYB Review`.
   - **Operations:** `Transactions & Webhooks` (`AdminTransactions`), `Operator Cases`, `Inquiry Schedules`, `Reconciliation`, `Disputes`, `Adjustments`, `Cashouts`.
   - **Gateways:** `Gateways`, `Credential Sets` (`AdminCredentialSets`), `AI Spec Import`, `Rails`, `Routes`.
   - **Finance:** `Pricing & Velocity`, `Profitability`, `Liquidity`, `Journal Entries` (`AdminFinanceJournalEntries`), `Ledger Audit & Invariant` (`AdminFinanceInvariant`).
   - **System:** `Users`, `Audit Logs`, `Jobs & Outbox` (`AdminSystemJobsOutbox`), `Backups & DR`, `Platform Settings`, `Checkout Help`.
2. **Fix `routesAuthorities` and `routesRoles` in `src/layouts/sections.tsx`:**
   - Add authority mappings for `AdminWallets`, `AdminApplications`, `AdminTransactions`, `AdminCredentialSets`, `AdminFinanceJournalEntries`, `AdminSystemJobsOutbox`, AND fix the missing entries for `AdminPlatformSettings` (`["settings.read", "settings.write"]`) and `AdminCheckoutHelp` (`["settings.read", "settings.write"]`).

### 8.3 `admin-front/src/constants/tableRegistry.ts`
Register `wallets`, `applications`, `payment-links`, `pos-terminals`, `transactions`, `inbound-events`, `credential-sets`, `finance-journal-entries`, `system-jobs-outbox`, `system-backups`, `platform-settings`, and `checkout-help` in `TABLE_REGISTRY`.

---

## 9. Verification & Acceptance Checklist for OpenCode

1. **Zero Raw Operational JSON Check:**
   - Run `grep -rnE "JSON\.stringify|<pre" admin-front/src/pages/` and verify that no operational table cell, drawer metadata section, or form modal input uses raw `JSON.stringify` or `<Textarea label="... JSON">` (only `gateways/ai-import/index.tsx` and `operator-cases/[id].tsx` raw HTTP wire logs may use monospace `<pre>` blocks).
2. **Wallets, Applications, Payment Links & POS Terminals Verification:**
   - Verify `/wallets` and `/applications` (with `Applications`, `Payment Links`, and `POS Terminals` tabs) load in the sidebar, render KPI strips and filterable tables, and open `WalletDetailDrawer` (with live `GlAccountShard` breakdown, `JournalLine` statement, and Freeze/Unfreeze action) and `ApplicationDetailDrawer` (with rail whitelist badges, redirect domain pills, API token revoke action, Payment Links state controls, and POS Terminals status controls).
   - Verify `/merchants/:id` shows the `Wallets` and `Applications` tabs for all users with `merchant:read`, opens the exact same drawers when clicking rows, and supports post-onboarding `BeneficialOwner` CRUD and `KybRevalidationRequest` creation.
3. **Ledger Audit & Journal Entries Verification:**
   - Verify `/finance/journal-entries` lists double-entry `JournalEntry` rows, verifies `Σ Debits = Σ Credits`, and opens `JournalEntryDrawer` on click.
   - Verify clicking any account in `/finance/invariant` opens `GlAccountDrawer` showing `GlAccountShard` rows and manual checkpoint rollup.
   - Verify clicking any `journalEntryId` / `ledgerEntryId` on Transactions, Adjustments, Cashouts, or Disputes opens `JournalEntryDrawer`.
4. **Transactions, Webhooks, Route Caps & Gateway Health Verification:**
   - Verify `/transactions` displays both `Payment Attempts` and `Inbound Webhooks` (`InboundEvent`), and opening `MerchantTransactionDialog` shows `AttemptStepLog`, `InboundEvent`, and `AttemptGroup` tabs plus quick actions.
   - Verify `/routes` and `/finance/liquidity` display live daily route cap utilization from `GET /finance/route-caps`.
   - Verify `/gateways` opens the `GatewayHealthSample` telemetry drawer.
5. **Typecheck & Build Verification:**
   - Run `pnpm --filter admin-front typecheck && pnpm --filter admin-front build` and `pnpm --filter core-back typecheck && pnpm --filter admin-back typecheck` with zero errors.
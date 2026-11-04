# GLOBAL DEEP SEARCH & DECLARATIVE PLUGIN REGISTRY ARCHITECTURE — MASTER SPECIFICATION FOR OPENCODE (`DeepSeek V4.1 Flash Max`)

**Target Repository:** `selmotamed-ctrl/payment-gateway-monolith`  
**Target Workspaces:** `core-back` · `admin-back` · `admin-front`  
**Design Paradigm:** Two-Sided Declarative Search Plugin Registry (`SearchProviderRegistry` on Backend + `ClientSearchRegistry` on Frontend) + Universal One-Shot Deep-Link Hook (`useOpenQuery`)  
**Target Implementation Agent:** OpenCode (`DeepSeek V4.1 Flash Max`) — Zero-Ambiguity, Drop-In TypeScript/TSX Specification

## 1. Executive Summary & Why a Declarative Plugin Architecture Is Required

A payment gateway back-office spans dozens of operational domains: merchants, payment attempts, KYB documents, four-eyes approvals, double-entry adjustments, disputes, cash-outs, statement reconciliation runs, confidential AML screenings/cases/reports, gateways, rails, routes, and future modules (such as Voucher Campaigns, AI Rail Onboarding Sessions, Settlement Batches, Velocity Rules, and Commission Profiles).

If global search is built as a hardcoded procedural script with giant `switch (type)` blocks scattered across `core-back`, `admin-back`, `targets.ts`, and `GlobalSearchPalette.tsx`, every future feature addition requires surgery across **8+ files** and increases the risk of permission leaks, broken deep links, or ranking drift.

This specification upgrades the Deep Search Implementation Plan into a **Declarative Two-Sided Plugin Architecture** while preserving **100% of the v1 functional, security, performance, and file-path contracts**:

1. **Backend `SearchProviderRegistry` (`core-back/lib/globalSearch.ts` + `core-back/lib/search/`):**
   - Each searchable domain is registered as a self-contained `SearchProviderPlugin<TRow>` via `defineSearchProvider()`.
   - A plugin declares only **what makes that entity unique**: its `type` slug, display `order`, `canAccess(actor)` authority predicate, optional `supportsTokenKind(parsedQuery)` pre-filter, bounded Prisma `fetchCandidates()` (`select`-only), `extractMatchSignals(row)`, and safe `toResultItem(row)` mapper.
   - The core engine (`executeGlobalSearch`) automatically handles **authority pre-filtering**, **smart token parsing** (Libyan phone normalization, SHA-256 hex detection, reference/ID detection, optional `type:`/`status:`/`merchant:` prefix scoping), **parallel `Promise.allSettled` execution**, **in-memory deterministic ranking** (`exact` > `prefix` > `substring` > `newest`), **truncation slicing**, **PII/secret leak redaction assertions**, and **per-provider latency telemetry**.
2. **Frontend `ClientSearchRegistry` (`admin-front/src/components/search/`):**
   - Each record type is registered via `defineSearchTargetPlugin()` in `targets.ts`, declaring its bilingual group title, row kind badge, icon, frontend authority/route-visibility guard (`routesAuthorities`, `routesRoles`, and `useSections()` visibility), and declarative deep-link resolver (`openDrawerTarget`, `routeParamTarget`, `merchantAttemptTarget`, or custom fallback).
   - Local palette sources (`Pages` from `useSections()`, `Guide` from `searchGuide()`, and any future local sources like `Quick Actions` or `Academy Lessons`) plug in via `defineLocalCommandSource()` in `localCommands.ts`.
3. **Universal One-Shot Deep-Link Composable (`useOpenQuery`):**
   - Standardizes `?open=<id>` handling across all 13+ drawer/dialog pages so selecting a search result opens the exact record once, checks in-memory table rows first before fetching by ID, cleans up stale query triggers so browser refresh/back-button navigation never re-opens drawers in an infinite loop, and degrades gracefully if a record is missing.
4. **One-File Future Extensibility Guarantee:**
   - Adding a new searchable entity in the future (or activating any of the 4 deferred v1 entities: `commission_profile`, `velocity_rule`, `credential_set`, `platform_setting`) requires **zero modifications** to the search orchestrator, ranking engine, BFF proxy, rate limiter, or `GlobalSearchPalette.tsx` component.

### 1.1 Non-Negotiable Execution Rules for OpenCode (`DeepSeek V4.1 Flash Max`)

| Rule ID | Strict Enforcement Rule |
| :--- | :--- |
| **`DS-RULE-01`** | **POST-Only Search Transport:** Never expose a `GET` endpoint with `?q=` or `?query=` for global search. `admin-back` logs `req.originalUrl`; using `POST /api/v1/admin/search` -> `POST /internal/admin/search` keeps PII (emails, phone numbers, national IDs, names) out of URL access logs. Never log `req.body.query` in server logs. |
| **`DS-RULE-02`** | **Pre-Query Authority Gating (Zero Leakage):** Every provider's `canAccess(actor)` MUST run *before* `fetchCandidates()`. Unauthorized groups MUST NOT be queried, MUST NOT appear in `groups` (not even as an empty array), and MUST NOT contribute to `total` or UI group counts. |
| **`DS-RULE-03`** | **Prisma `select`-Only Projection:** Every provider in `core-back` MUST use explicit Prisma `select: { ... }` clauses. Using `include` without `select` or returning full model rows is strictly forbidden. Never select `ciphertext`, `secret`, `password`, `payoutAccount`, `matchListName`, `beforeJson`, `afterJson`, or `rawPayload`. |
| **`DS-RULE-04`** | **Sensitive Merchant Field Redaction:** In the `merchant` provider, `taxId` (`taxNumber`) and `commercialRegistryNumber` (`regNumber`) may ONLY be searched and matched when `hasMerchantSensitiveAccess(actor)` is `true` (never for `SUPPORT`), and raw tax/registration numbers must NEVER be returned in `subtitle` or `reference`. |
| **`DS-RULE-05`** | **Zero `v-html` in Frontend Palette:** Highlighting matched query substrings in `GlobalSearchPalette.tsx` / `SearchResultRow.tsx` MUST use a pure TSX token splitter (`highlightSegments(text, query)`) rendering `<mark class="pg-search-highlight">` VNodes. Using `v-html` or `innerHTML` is strictly forbidden (XSS vector). |
| **`DS-RULE-06`** | **Local History Stores Query Strings Only:** `localStorage` recent searches (`recents.ts`) MUST store only trimmed query strings (capped at 8 items). Storing record IDs, merchant names, or server result payloads in `localStorage` or `sessionStorage` is strictly forbidden. |
| **`DS-RULE-07`** | **No Database Migration in v1:** Do not alter `schema.prisma` or create migrations for v1 Deep Search. Reuse existing indexes and bounded `take = limit * 3` queries. |
| **`DS-RULE-08`** | **Register Static Routes Before `:id` Params:** When adding `GET /internal/admin/audit-logs/:id` and `GET /api/v1/admin/audit-logs/:id`, register `/:id` strictly *after* static sub-routes such as `/export` so `/audit-logs/export` is never captured as `id = "export"`. |

## 2. Product Behavior & UX Contract

### 2.1 App-Bar Trigger vs. Navigation Drawer Guide Trigger

1. **Top App-Bar Global Search Trigger (`admin-front/src/layouts/default.tsx` lines 226–233):**
   - Replace the existing app-bar guide search button with `.pg-global-search-trigger`:
     - **Desktop (`>= 640px`):** Pill button displaying magnifying glass icon (`mdi-magnify`), label `Search everything…` (`ابحث في كل شيء…` in Arabic), and keyboard shortcut badge `<kbd class="pg-command-kbd">Ctrl K</kbd>` (or `⌘K` on macOS).
     - **Compact / Mobile (`< 640px`):** Icon-only `32px × 32px` button with `aria-label="Search everything (Ctrl+K)"`.
2. **Navigation Drawer Guide Search (`admin-front/src/layouts/default.tsx`):**
   - Keep `GlobalGuideSearchModal` and the navigation drawer search button intact for dedicated documentation lookup.
   - Relabel the drawer search button from `Search guide, rails, cases…` to **`Search guide…`** (`ابحث في الدليل…`).
   - **Remove** the `Ctrl K` badge from the drawer button so there is zero ambiguity about which overlay `Ctrl+K` opens.
3. **Global Keyboard Shortcuts (`admin-front/src/layouts/default.tsx` lines 135–141):**
   - `Ctrl+K` / `Cmd+K` opens (or focuses if already open) `GlobalSearchPalette` from anywhere in `admin-front`.
   - `Escape` closes only the topmost active overlay/dialog and restores focus to the trigger element that opened it.
   - `?` (when not focused inside an `<input>`, `<textarea>`, or `[contenteditable]`) retains its existing help/guide shortcut behavior.

### 2.2 Palette Organization & Interactive States

The `GlobalSearchPalette` (`VDialog`, `max-width: 780px`, top-aligned at `margin-top: 8vh`) organizes results into three top-level semantic sections filterable via interactive scope chips (`All`, `Records`, `Pages`, `Guide`):

1. **`Pages` (Local Navigation Commands):**
   - Instant client-side filtering over the user's permission-filtered `useSections()` navigation items.
   - Displays page icon, localized title, parent section breadcrumb, and route jump action.
2. **`Records` (Permission-Filtered Server Results via Plugin Registry):**
   - Debounced (`250ms`, minimum `2` characters after trimming) server results from `POST /api/v1/admin/search`.
   - Grouped by `SearchType` in canonical registry priority order, showing group header, localized group title, returned count (and `+` indicator if `truncated: true`), row icon, title, monospace reference chip (`<MonoRef />`), subtitle, `<StatusBadge />`, and entity kind label.
3. **`Guide` (Local Embedded Guide & Academy Search):**
   - Instant client-side results from `searchGuide(query)` opening the guide modal/route at `?entry=<id>`.

| Palette State | Required UX Behavior |
| :--- | :--- |
| **Empty Query (`query.trim().length === 0`)** | Shows **Recent Searches** (up to 8 query strings from `localStorage` with one-click re-run, individual delete `×`, and `Clear all` button) followed by **Quick Page Links** (top 6 accessible pages from `useSections()`). |
| **1-Character Query (`query.trim().length === 1`)** | Filters local **Pages** and **Guide** immediately; shows a subtle inline hint under Records: `"Type at least 2 characters to search platform records…"`. |
| **Loading (`query.trim().length >= 2`)** | Shows a thin `2px` indeterminate progress bar along the bottom of the search input header while preserving previous or local results cleanly (no layout jump). |
| **Partial Results (`response.partial === true`)** | Displays all succeeded record groups plus a subtle inline banner at the bottom of the palette: `"Some record groups could not be reached. Showing partial results."` with a **Retry** button. |
| **Total Server Error / Timeout** | Still shows matching local **Pages** and **Guide** results! Inside the **Records** section, renders an inline error card with a **Retry** button — **never** spam global snackbars/toasts on search network errors. |
| **No Results (`total === 0` & no local hits)** | Renders `.pg-command-empty` distinguishing `"No matching records, pages, or guides for '<query>'"` with suggestions (check reference spelling, remove filter chip restriction). |

## 3. API Contract & Shared Security Predicates

### 3.1 Request & Response Wire Contract

- **Frontend -> Admin BFF:** `POST /api/v1/admin/search`
- **Admin BFF -> Core Service:** `POST /internal/admin/search`
- **Response Headers:** `Cache-Control: no-store, no-cache, must-revalidate`

```ts
// Shared Wire Contract: core-back/lib/search/types.ts & admin-front/src/components/search/types.ts

export const V1_SEARCH_TYPES = [
  'merchant',
  'payment_attempt',
  'join_request',
  'kyb_document',
  'user',
  'approval',
  'audit_log',
  'aml_case',
  'aml_screening',
  'aml_rule',
  'aml_report',
  'operator_case',
  'gateway_inquiry',
  'dispute',
  'adjustment',
  'cashout',
  'reconciliation_run',
  'gateway',
  'rail',
  'route',
] as const;

export type BuiltinSearchType = (typeof V1_SEARCH_TYPES)[number];

/**
 * Extensible SearchType: supports all 20 v1 types plus any future plugin registered via SearchProviderRegistry.
 */
export type SearchType = BuiltinSearchType | (string & {});

export interface GlobalSearchRequest {
  /** Raw search string; server trims and enforces 2..120 characters */
  query: string;
  /** Optional allow-list of SearchType slugs to restrict server execution */
  types?: SearchType[];
  /** Per-group item cap, integer 1..10, default 5 */
  limit?: number;
}

export interface SearchResultItem {
  id: string;
  title: string;
  subtitle?: string;
  reference?: string;
  status?: string;
  merchantId?: string;
  operatorCaseId?: string;
  /**
   * Extensible metadata bag (scalar strings/numbers/booleans only) so future plugins
   * can pass deep-link context keys (e.g. tab, parentId, gatewayCode) without changing the top-level schema.
   */
  meta?: Record<string, string | number | boolean | null>;
}

export interface SearchResultGroup {
  type: SearchType;
  items: SearchResultItem[];
  truncated: boolean;
}

export interface GlobalSearchResponse {
  query: string;
  groups: SearchResultGroup[];
  total: number;
  tookMs: number;
  partial: boolean;
}
```

### 3.2 Complete Authority & Match Field Matrix (All 20 Built-In Providers)

| Order | `SearchType` (`type`) | Core Authority Predicate (`canAccess`) | Primary Match Fields (Ranked: Exact > Prefix > Substring > Newest) | Safe Returned Fields (`SearchResultItem`) |
| :--- | :--- | :--- | :--- | :--- |
| `10` | `merchant` | `hasAuthority(actor, 'merchant:read')` | `id`, `legalNameEn`, `legalNameAr`, `tradeNameEn`, `tradeNameAr`, `displayName`, `contactEmail`, `contactPhone`; plus `taxNumber` & `commercialRegistryNumber` **ONLY IF** `hasMerchantSensitiveAccess(actor)` | `id`, `title` (trade/display name), `subtitle` (legal name + city/tier), `reference` (merchant code/id), `status` |
| `20` | `payment_attempt` | `hasAuthority(actor, 'attempt:read') && hasAuthority(actor, 'merchant:read')` | `id`, `ourReference`, `providerReference`, `networkReference`, `gatewayReference`, `idempotencyKey` | `id`, `title` (`ourReference` + amount LYD), `subtitle` (merchant trade name + rail code), `reference` (`ourReference`), `status`, `merchantId` |
| `30` | `operator_case` | `hasAnyAuthority(actor, ['case:read', 'operator:read'])` | `id`, `caseReference`, `attemptReference`, `reconciliationRunId`, merchant names (`tradeNameEn`/`Ar`) | `id`, `title` (case ref + category), `subtitle` (merchant + priority), `reference`, `status`, `merchantId` |
| `40` | `gateway_inquiry` | `hasAnyAuthority(actor, ['case:read', 'operator:read'])` | `id`, `inquiryReference`, `attemptReference`, `providerReference`, merchant names | `id`, `title` (inquiry ref + gateway code), `subtitle` (attempt ref + merchant), `reference` (`attemptReference`), `status`, `operatorCaseId`, `merchantId` |
| `50` | `approval` | `hasAuthority(actor, 'approval:read')` | `id`, `subjectId`, `subjectType`, `actionType`, `makerUser.email`, `checkerUser.email` | `id`, `title` (`actionType` + `subjectType`), `subtitle` (`makerEmail` + subjectId), `reference` (`subjectId`), `status` |
| `60` | `join_request` | `hasAnyAuthority(actor, ['kyb:read', 'compliance:read'])` | `id`, `applicationReference`, `legalNameEn`, `legalNameAr`, `tradeNameEn`, `tradeNameAr`, `contactEmail`, `contactPhone` | `id`, `title` (trade/legal name), `subtitle` (contact email/phone + risk tier), `reference` (`id`), `status`, `merchantId` |
| `70` | `kyb_document` | `hasAnyAuthority(actor, ['kyb:read', 'compliance:read'])` | `id`, `fileName`, `sha256Hash`, `documentType`, merchant `tradeNameEn`/`Ar`, `legalNameEn`/`Ar` | `id`, `title` (`documentType` — `fileName`), `subtitle` (merchant name + short SHA-256 prefix), `reference` (`sha256Hash` 12-char prefix), `status`, `merchantId` |
| `80` | `dispute` | `hasAuthority(actor, 'dispute:read')` | `id`, `externalDisputeRef`, `reasonCode`, `paymentAttempt.ourReference`, `merchant.tradeNameEn`/`Ar` | `id`, `title` (`externalDisputeRef` + `reasonCode`), `subtitle` (merchant + attempt ref + amount), `reference` (`externalDisputeRef`), `status`, `merchantId` |
| `90` | `adjustment` | `hasAuthority(actor, 'finance:read')` | `id`, `adjustmentReference`, `reason`, `disputeRef`, `providerRefundRef`, `sourceAttempt.ourReference` | `id`, `title` (`type` + amount LYD), `subtitle` (`reason` + attempt ref), `reference` (`providerRefundRef` or `id`), `status`, `merchantId` |
| `100` | `cashout` | `hasAuthority(actor, 'cashout:read')` | `id`, `cashoutReference`, `walletId`, `bankTransferRef`, `merchant.tradeNameEn`/`Ar` | `id`, `title` (cashout ref + amount LYD), `subtitle` (merchant trade name + walletId), `reference` (`cashoutReference` or `id`), `status`, `merchantId` |
| `110` | `reconciliation_run` | `hasAuthority(actor, 'reconciliation:read')` | `id`, `statementFileName`, `gateway.code`, `gateway.nameEn` | `id`, `title` (`gateway.code` — `statementFileName`), `subtitle` (statement date + matched/unmatched counts), `reference` (`id`), `status` |
| `120` | `aml_case` | `hasConfidentialAmlAccess(actor)` | `id`, `caseNumber`, `subjectId`, `triggerReason`, `rule.code`, `rule.name`, `reviewerUser.email` | `id`, `title` (`caseNumber` — `triggerReason`), `subtitle` (`subjectType` `subjectId` + rule code), `reference` (`caseNumber` or `id`), `status` |
| `130` | `aml_screening` | `hasConfidentialAmlAccess(actor)` | `id`, `subjectId`, `providerCode`, `providerRequestRef` | `id`, `title` (`providerCode` screening), `subtitle` (`subjectType` `subjectId`), `reference` (`providerRequestRef`), `status` |
| `140` | `aml_rule` | `hasConfidentialAmlAccess(actor)` | `id`, `code`, `name`, `category` | `id`, `title` (`code` — `name`), `subtitle` (`category` + severity), `reference` (`code`), `status` |
| `150` | `aml_report` | `hasConfidentialAmlAccess(actor)` | `id`, `reportReference`, `subjectId`, `submissionReference`, `reportType` | `id`, `title` (`reportReference` — `reportType`), `subtitle` (`subjectId` + submission ref), `reference` (`reportReference`), `status` |
| `160` | `gateway` | `hasAuthority(actor, 'gateway:read')` | `id`, `code`, `nameEn`, `nameAr`, `operatorName` | `id`, `title` (`nameEn` / `nameAr`), `subtitle` (`operatorName`), `reference` (`code`), `status` |
| `170` | `rail` | `hasAuthority(actor, 'gateway:read')` | `id`, `code`, `nameEn`, `nameAr` | `id`, `title` (`nameEn` / `nameAr`), `subtitle` (category / payment flow), `reference` (`code`), `status` |
| `180` | `route` | `hasAuthority(actor, 'gateway:read')` | `id`, `rail.code`, `rail.nameEn`, `gatewayVersion.gateway.code`, `gatewayVersion.gateway.nameEn` | `id`, `title` (`rail.code` → `gateway.code`), `subtitle` (`priority` + `healthStatus`), `reference` (`id`), `status` |
| `190` | `user` | `hasAnyAuthority(actor, ['user:read', 'security:read'])` | `id`, `email`, `phone`, `fullName` | `id`, `title` (`email` or `phone`), `subtitle` (`role` + `userType`), `reference` (`id`), `status` |
| `200` | `audit_log` | `hasAuthority(actor, 'security:read')` | `id`, `action`, `entityType`, `entityId`, `actorEmail`, `requestId` | `id`, `title` (`action` on `entityType`), `subtitle` (`actorEmail` · `entityId`), `reference` (`entityId`), `status` |

## 4. Server-Side Plugin Architecture (`core-back`)

### 4.1 Shared Confidential & Sensitive Access Helper (`core-back/lib/auth/confidentialAccess.ts`)

Extract the AML confidential predicate and merchant sensitive-field predicate into a single shared module so `core-back/api/internal/admin.ts` and `core-back/lib/globalSearch.ts` can never drift:

```ts
// core-back/lib/auth/confidentialAccess.ts

export interface AuthenticatedAdminActor {
  id: string;
  email?: string | null;
  role: string;
  authorities: readonly string[] | Set<string>;
}

const normalizeAuthorities = (actor: AuthenticatedAdminActor): Set<string> => {
  if (!actor || !actor.authorities) return new Set();
  return actor.authorities instanceof Set ? actor.authorities : new Set(actor.authorities);
};

export function hasAuthority(actor: AuthenticatedAdminActor, required: string): boolean {
  const auths = normalizeAuthorities(actor);
  if (auths.has('*') || auths.has('admin:*')) return true;
  return auths.has(required);
}

export function hasAnyAuthority(actor: AuthenticatedAdminActor, requiredList: readonly string[]): boolean {
  return requiredList.some((req) => hasAuthority(actor, req));
}

export function hasAllAuthorities(actor: AuthenticatedAdminActor, requiredList: readonly string[]): boolean {
  return requiredList.every((req) => hasAuthority(actor, req));
}

/**
 * Shared Confidential AML Predicate.
 * Used identically by core-back/api/internal/admin.ts and core-back/lib/globalSearch.ts.
 * Grants access ONLY to MLRO / COMPLIANCE roles or actors holding explicit confidential AML authorities.
 */
export function hasConfidentialAmlAccess(actor: AuthenticatedAdminActor): boolean {
  if (!actor) return false;
  const role = (actor.role ?? '').toUpperCase();
  if (role === 'SUPPORT' || role === 'OPERATOR' || role === 'FINANCE') {
    // Support, standard Operators, and Finance never receive confidential AML access unless explicitly granted MLRO/aml:confidential
    const auths = normalizeAuthorities(actor);
    return auths.has('aml:confidential') || auths.has('aml:read');
  }
  if (role === 'MLRO' || role === 'COMPLIANCE') {
    return hasAnyAuthority(actor, ['aml:read', 'aml:confidential', 'compliance:read']);
  }
  return hasAnyAuthority(actor, ['aml:read', 'aml:confidential']);
}

/**
 * Shared Merchant Sensitive Field Predicate (Tax ID / Commercial Registration Number).
 * SUPPORT staff can search merchants by name/email/phone/ID, but NEVER by tax ID or registration number.
 */
export function hasMerchantSensitiveAccess(actor: AuthenticatedAdminActor): boolean {
  if (!actor) return false;
  const role = (actor.role ?? '').toUpperCase();
  if (role === 'SUPPORT') return false;
  return hasAnyAuthority(actor, [
    'merchant:sensitive',
    'merchant:write',
    'kyb:read',
    'compliance:read',
    'finance:read',
  ]);
}
```

### 4.2 Smart Query Parser & Deterministic Ranking Engine (`core-back/lib/search/engine.ts`)

This module gives every registered plugin automatic support for:
1. **Optional power-user prefix filters** (e.g., `type:attempt PG-1029`, `merchant:mer_01`, `status:UNKNOWN`) while treating standard queries as pure search text.
2. **Libyan phone number & hex hash detection** (normalizing `091-234-5678`, `218912345678`, and `+218912345678` into equivalent search variants so operators don't miss phone matches due to country-code formatting).
3. **Deterministic 4-tier in-memory ranking** (`Exact Match = 1000` -> `Prefix Match = 700` -> `Substring Match = 400` -> `Timestamp Newest Tie-Breaker`).
4. **Forbidden field runtime sanitizer** (`sanitizeResultItem`) guaranteeing no plugin can ever accidentally emit sensitive fields.

```ts
// core-back/lib/search/engine.ts
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedAdminActor } from '../auth/confidentialAccess';
import type { SearchResultItem, SearchType } from './types';

export type QueryTokenKind =
  | 'SHA256_HEX'
  | 'EMAIL'
  | 'PHONE'
  | 'ID_OR_REF'
  | 'FREE_TEXT';

export interface ParsedSearchQuery {
  /** Original trimmed query */
  raw: string;
  /** Core search term after extracting optional key:value tokens (falls back to raw if empty) */
  term: string;
  /** Lowercased search term for case-insensitive matching */
  termLower: string;
  /** Normalized phone variants if term looks like a phone number */
  phoneVariants: string[];
  /** Detected token shape for provider optimization */
  tokenKind: QueryTokenKind;
  /** Optional inline scope directives (e.g. type:merchant, status:UNKNOWN, merchant:mer_123) */
  scopedTypeAliases: string[];
  scopedStatus?: string;
  scopedMerchantId?: string;
}

const SHA256_REGEX = /^[a-fA-F0-9]{16,64}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CHARS_REGEX = /^[+\d][\d\s()-]{5,18}$/;
const ID_OR_REF_REGEX = /^[A-Za-z0-9_.:-]{4,64}$/;

export function parseSearchQuery(rawInput: string): ParsedSearchQuery {
  const raw = rawInput.trim().slice(0, 120);
  const tokens = raw.split(/\s+/);
  const scopedTypeAliases: string[] = [];
  let scopedStatus: string | undefined;
  let scopedMerchantId: string | undefined;
  const remainingTokens: string[] = [];

  for (const token of tokens) {
    const match = /^([a-zA-Z]+):(.+)$/.exec(token);
    if (match && tokens.length > 1) {
      const key = match[1].toLowerCase();
      const val = match[2].trim();
      if ((key === 'type' || key === 'is' || key === 'kind') && val) {
        scopedTypeAliases.push(val.toLowerCase());
        continue;
      }
      if (key === 'status' && val) {
        scopedStatus = val.toUpperCase();
        continue;
      }
      if (key === 'merchant' && val) {
        scopedMerchantId = val;
        continue;
      }
    }
    remainingTokens.push(token);
  }

  const term = (remainingTokens.join(' ').trim() || raw).slice(0, 120);
  const termLower = term.toLowerCase();

  // Build normalized Libyan & international phone variants when query looks numeric/phone-like
  const phoneVariants: string[] = [];
  if (PHONE_CHARS_REGEX.test(term)) {
    const digitsOnly = term.replace(/[^\d+]/g, '');
    const strippedPlus = digitsOnly.replace(/^\+/, '');
    phoneVariants.push(digitsOnly);
    if (strippedPlus.startsWith('09') && strippedPlus.length === 10) {
      // Libyan local 091xxxxxxx -> +21891xxxxxxx and 21891xxxxxxx
      const withoutZero = strippedPlus.slice(1);
      phoneVariants.push(`+218${withoutZero}`, `218${withoutZero}`, strippedPlus);
    } else if (strippedPlus.startsWith('2189') && strippedPlus.length === 12) {
      const localPart = strippedPlus.slice(3);
      phoneVariants.push(`+${strippedPlus}`, strippedPlus, `0${localPart}`);
    } else if (strippedPlus.startsWith('002189') && strippedPlus.length === 14) {
      const localPart = strippedPlus.slice(5);
      phoneVariants.push(`+218${localPart}`, `218${localPart}`, `0${localPart}`);
    }
  }

  let tokenKind: QueryTokenKind = 'FREE_TEXT';
  if (SHA256_REGEX.test(term) && term.length >= 16) {
    tokenKind = 'SHA256_HEX';
  } else if (EMAIL_REGEX.test(term)) {
    tokenKind = 'EMAIL';
  } else if (phoneVariants.length > 0) {
    tokenKind = 'PHONE';
  } else if (ID_OR_REF_REGEX.test(term) && !term.includes(' ')) {
    tokenKind = 'ID_OR_REF';
  }

  return {
    raw,
    term,
    termLower,
    phoneVariants: Array.from(new Set(phoneVariants)),
    tokenKind,
    scopedTypeAliases,
    scopedStatus,
    scopedMerchantId,
  };
}

export interface SearchMatchSignals {
  /** Highest-priority exact identifiers: id, reference, code, email, phone, sha256 */
  exactFields: Array<string | null | undefined>;
  /** Primary display titles / names: legalName, tradeName, displayName, title */
  primaryTextFields?: Array<string | null | undefined>;
  /** Secondary context fields: reason, operator, category, actorEmail */
  secondaryTextFields?: Array<string | null | undefined>;
  /** Record creation/update timestamp for tie-breaking (newest first) */
  timestamp?: Date | string | number | null;
}

/**
 * Deterministic scoring function:
 * - Exact match on exactFields (or phone variant exact match): 1000 pts
 * - Exact match on primaryTextFields: 900 pts
 * - Prefix match on exactFields: 750 pts
 * - Prefix match on primaryTextFields: 650 pts
 * - Substring match on exactFields: 450 pts
 * - Substring match on primaryTextFields: 350 pts
 * - Exact/Prefix/Substring on secondaryTextFields: 250 / 200 / 150 pts
 * - Default fallback if returned by DB query: 100 pts
 */
export function computeMatchScore(signals: SearchMatchSignals, parsed: ParsedSearchQuery): number {
  const q = parsed.termLower;
  const phoneSet = new Set(parsed.phoneVariants.map((p) => p.toLowerCase()));
  let bestScore = 0;

  const scoreField = (
    rawVal: string | null | undefined,
    weights: { exact: number; prefix: number; substring: number }
  ) => {
    if (!rawVal) return;
    const val = rawVal.trim().toLowerCase();
    if (!val) return;

    if (val === q || (phoneSet.size > 0 && phoneSet.has(val.replace(/[\s()-]/g, '')))) {
      if (weights.exact > bestScore) bestScore = weights.exact;
      return;
    }
    if (val.startsWith(q)) {
      if (weights.prefix > bestScore) bestScore = weights.prefix;
      return;
    }
    if (val.includes(q)) {
      if (weights.substring > bestScore) bestScore = weights.substring;
    }
  };

  for (const f of signals.exactFields) {
    scoreField(f, { exact: 1000, prefix: 750, substring: 450 });
  }
  for (const f of signals.primaryTextFields ?? []) {
    scoreField(f, { exact: 900, prefix: 650, substring: 350 });
  }
  for (const f of signals.secondaryTextFields ?? []) {
    scoreField(f, { exact: 250, prefix: 200, substring: 150 });
  }

  return bestScore > 0 ? bestScore : 100;
}

const FORBIDDEN_RESULT_KEYS = new Set([
  'ciphertext',
  'nationalIdCiphertext',
  'secret',
  'secretCiphertext',
  'password',
  'passwordHash',
  'payoutAccount',
  'ibanCiphertext',
  'matchListName',
  'beforeJson',
  'afterJson',
  'taxNumber',
  'commercialRegistryNumber',
]);

export function sanitizeResultItem(item: SearchResultItem): SearchResultItem {
  const clean: SearchResultItem = {
    id: String(item.id),
    title: String(item.title),
  };
  if (item.subtitle !== undefined && item.subtitle !== null && item.subtitle !== '') {
    clean.subtitle = String(item.subtitle);
  }
  if (item.reference !== undefined && item.reference !== null && item.reference !== '') {
    clean.reference = String(item.reference);
  }
  if (item.status !== undefined && item.status !== null && item.status !== '') {
    clean.status = String(item.status);
  }
  if (item.merchantId) clean.merchantId = String(item.merchantId);
  if (item.operatorCaseId) clean.operatorCaseId = String(item.operatorCaseId);
  if (item.meta) {
    const safeMeta: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(item.meta)) {
      if (!FORBIDDEN_RESULT_KEYS.has(k) && !k.toLowerCase().includes('secret') && !k.toLowerCase().includes('cipher')) {
        safeMeta[k] = v;
      }
    }
    if (Object.keys(safeMeta).length > 0) clean.meta = safeMeta;
  }
  return clean;
}

export interface SearchProviderContext {
  prisma: PrismaClient;
  parsed: ParsedSearchQuery;
  actor: AuthenticatedAdminActor;
  take: number;
}

export interface SearchProviderPlugin<TRow = any> {
  readonly type: SearchType;
  readonly aliases?: readonly string[];
  readonly order: number;
  readonly canAccess: (actor: AuthenticatedAdminActor) => boolean;
  readonly fetchCandidates: (ctx: SearchProviderContext) => Promise<TRow[]>;
  readonly extractMatchSignals: (row: TRow, actor: AuthenticatedAdminActor) => SearchMatchSignals;
  readonly toResultItem: (row: TRow, actor: AuthenticatedAdminActor) => SearchResultItem;
}

export function defineSearchProvider<TRow>(
  plugin: SearchProviderPlugin<TRow>
): SearchProviderPlugin<TRow> {
  return Object.freeze(plugin);
}

export function rankAndSliceCandidates<TRow>(
  rows: TRow[],
  plugin: SearchProviderPlugin<TRow>,
  parsed: ParsedSearchQuery,
  actor: AuthenticatedAdminActor,
  limit: number
): { items: SearchResultItem[]; truncated: boolean } {
  const seenIds = new Set<string>();
  const scored: Array<{ row: TRow; item: SearchResultItem; score: number; timeMs: number }> = [];

  for (const row of rows) {
    const rawItem = plugin.toResultItem(row, actor);
    if (!rawItem || !rawItem.id || seenIds.has(rawItem.id)) continue;
    seenIds.add(rawItem.id);

    const signals = plugin.extractMatchSignals(row, actor);
    const score = computeMatchScore(signals, parsed);
    const ts = signals.timestamp
      ? signals.timestamp instanceof Date
        ? signals.timestamp.getTime()
        : new Date(signals.timestamp).getTime()
      : 0;

    scored.push({
      row,
      item: sanitizeResultItem(rawItem),
      score,
      timeMs: Number.isFinite(ts) ? ts : 0,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.timeMs !== a.timeMs) return b.timeMs - a.timeMs;
    return a.item.id.localeCompare(b.item.id);
  });

  const truncated = scored.length > limit;
  const items = scored.slice(0, limit).map((entry) => entry.item);
  return { items, truncated };
}
```

### 4.3 The Backend Plugin Registry & All 20 Built-In Providers (`core-back/lib/globalSearch.ts`)

Below is the complete implementation of `core-back/lib/globalSearch.ts`. Notice how:
- `SearchProviderRegistry` manages all registered providers and allows dynamic registration (`registerSearchProvider`) for tests or future expansion modules.
- All 20 v1 providers use strict `select`-only Prisma queries, `limit * 3` candidate fetching, in-memory ranking, and `Promise.allSettled` fault isolation.

```ts
// core-back/lib/globalSearch.ts
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  type AuthenticatedAdminActor,
  hasAllAuthorities,
  hasAnyAuthority,
  hasAuthority,
  hasConfidentialAmlAccess,
  hasMerchantSensitiveAccess,
} from './auth/confidentialAccess';
import {
  defineSearchProvider,
  parseSearchQuery,
  rankAndSliceCandidates,
  type SearchProviderPlugin,
} from './search/engine';
import type {
  GlobalSearchRequest,
  GlobalSearchResponse,
  SearchResultGroup,
  SearchType,
} from './search/types';

// ---------------------------------------------------------------------------
// 1. Declarative Provider Registry
// ---------------------------------------------------------------------------

export class SearchProviderRegistry {
  private readonly providers = new Map<SearchType, SearchProviderPlugin<any>>();

  public register<TRow>(plugin: SearchProviderPlugin<TRow>): this {
    this.providers.set(plugin.type, plugin);
    return this;
  }

  public unregister(type: SearchType): boolean {
    return this.providers.delete(type);
  }

  public get(type: SearchType): SearchProviderPlugin<any> | undefined {
    return this.providers.get(type);
  }

  public getAllOrdered(): SearchProviderPlugin<any>[] {
    return Array.from(this.providers.values()).sort((a, b) => a.order - b.order);
  }

  public getRegisteredTypes(): Set<string> {
    return new Set(this.providers.keys());
  }

  public resolveAliasToTypes(alias: string): SearchType[] {
    const clean = alias.toLowerCase().trim();
    const matches: SearchType[] = [];
    for (const p of this.providers.values()) {
      if (p.type.toLowerCase() === clean || p.aliases?.some((a) => a.toLowerCase() === clean)) {
        matches.push(p.type);
      }
    }
    return matches;
  }
}

export const defaultSearchRegistry = new SearchProviderRegistry();

// ---------------------------------------------------------------------------
// 2. Built-In 20 Search Provider Plugins (v1 Production Set)
// ---------------------------------------------------------------------------

// 1. MERCHANT (merchant:read; tax/reg only with sensitive access)
const merchantProvider = defineSearchProvider({
  type: 'merchant',
  aliases: ['merchants', 'mer', 'store'],
  order: 10,
  canAccess: (actor) => hasAuthority(actor, 'merchant:read'),
  fetchCandidates: async ({ prisma, parsed, actor, take }) => {
    const q = parsed.term;
    const allowSensitive = hasMerchantSensitiveAccess(actor);
    const phoneOr = parsed.phoneVariants.map((p) => ({ contactPhone: { contains: p } }));

    return prisma.merchant.findMany({
      where: {
        ...(parsed.scopedStatus ? { status: parsed.scopedStatus as any } : {}),
        OR: [
          { id: { contains: q } },
          { legalNameEn: { contains: q } },
          { legalNameAr: { contains: q } },
          { tradeNameEn: { contains: q } },
          { tradeNameAr: { contains: q } },
          { displayName: { contains: q } },
          { contactEmail: { contains: q } },
          { contactPhone: { contains: q } },
          ...phoneOr,
          ...(allowSensitive
            ? [
                { taxNumber: { contains: q } },
                { commercialRegistryNumber: { contains: q } },
              ]
            : []),
        ],
      },
      select: {
        id: true,
        legalNameEn: true,
        legalNameAr: true,
        tradeNameEn: true,
        tradeNameAr: true,
        displayName: true,
        contactEmail: true,
        contactPhone: true,
        status: true,
        riskTier: true,
        updatedAt: true,
        ...(allowSensitive
          ? { taxNumber: true, commercialRegistryNumber: true }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row, actor) => {
    const allowSensitive = hasMerchantSensitiveAccess(actor);
    return {
      exactFields: [
        row.id,
        row.contactEmail,
        row.contactPhone,
        ...(allowSensitive ? [row.taxNumber, row.commercialRegistryNumber] : []),
      ],
      primaryTextFields: [
        row.displayName,
        row.tradeNameEn,
        row.tradeNameAr,
        row.legalNameEn,
        row.legalNameAr,
      ],
      timestamp: row.updatedAt,
    };
  },
  toResultItem: (row) => ({
    id: row.id,
    title: row.displayName || row.tradeNameEn || row.tradeNameAr || row.legalNameEn || row.id,
    subtitle: [row.legalNameEn || row.legalNameAr, row.contactEmail, row.riskTier]
      .filter(Boolean)
      .join(' · '),
    reference: row.id,
    status: row.status,
    merchantId: row.id,
  }),
});

// 2. PAYMENT ATTEMPT (attempt:read + merchant:read)
const paymentAttemptProvider = defineSearchProvider({
  type: 'payment_attempt',
  aliases: ['attempt', 'attempts', 'tx', 'transaction', 'payment'],
  order: 20,
  canAccess: (actor) =>
    hasAllAuthorities(actor, ['attempt:read', 'merchant:read']),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.paymentAttempt.findMany({
      where: {
        ...(parsed.scopedMerchantId ? { merchantId: parsed.scopedMerchantId } : {}),
        ...(parsed.scopedStatus ? { status: parsed.scopedStatus as any } : {}),
        OR: [
          { id: { contains: q } },
          { ourReference: { contains: q } },
          { providerReference: { contains: q } },
          { networkReference: { contains: q } },
          { gatewayReference: { contains: q } },
        ],
      },
      select: {
        id: true,
        ourReference: true,
        providerReference: true,
        networkReference: true,
        gatewayReference: true,
        amountLyd: true,
        status: true,
        merchantId: true,
        railCode: true,
        createdAt: true,
        merchant: {
          select: {
            tradeNameEn: true,
            tradeNameAr: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [
      row.id,
      row.ourReference,
      row.providerReference,
      row.networkReference,
      row.gatewayReference,
    ],
    primaryTextFields: [row.merchant?.tradeNameEn, row.merchant?.tradeNameAr],
    secondaryTextFields: [row.railCode],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.ourReference} · ${Number(row.amountLyd ?? 0).toFixed(2)} LYD`,
    subtitle: [
      row.merchant?.tradeNameEn || row.merchant?.tradeNameAr || row.merchantId,
      row.railCode?.toUpperCase(),
      row.providerReference ? `Prov: ${row.providerReference}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    reference: row.ourReference,
    status: row.status,
    merchantId: row.merchantId,
  }),
});

// 3. OPERATOR CASE (case:read or operator:read)
const operatorCaseProvider = defineSearchProvider({
  type: 'operator_case',
  aliases: ['case', 'cases'],
  order: 30,
  canAccess: (actor) => hasAnyAuthority(actor, ['case:read', 'operator:read']),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.operatorCase.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { caseReference: { contains: q } },
          { attemptReference: { contains: q } },
          { reconciliationRunId: { contains: q } },
          { merchant: { tradeNameEn: { contains: q } } },
          { merchant: { tradeNameAr: { contains: q } } },
        ],
      },
      select: {
        id: true,
        caseReference: true,
        category: true,
        priority: true,
        status: true,
        attemptReference: true,
        reconciliationRunId: true,
        merchantId: true,
        createdAt: true,
        merchant: { select: { tradeNameEn: true, tradeNameAr: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.caseReference, row.attemptReference, row.reconciliationRunId],
    primaryTextFields: [row.merchant?.tradeNameEn, row.merchant?.tradeNameAr],
    secondaryTextFields: [row.category, row.priority],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.caseReference || row.id} · ${row.category}`,
    subtitle: [
      row.priority,
      row.merchant?.tradeNameEn || row.merchant?.tradeNameAr,
      row.attemptReference ? `Ref: ${row.attemptReference}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    reference: row.caseReference || row.attemptReference || row.id,
    status: row.status,
    merchantId: row.merchantId ?? undefined,
  }),
});

// 4. GATEWAY INQUIRY (case:read or operator:read)
const gatewayInquiryProvider = defineSearchProvider({
  type: 'gateway_inquiry',
  aliases: ['inquiry', 'inquiries'],
  order: 40,
  canAccess: (actor) => hasAnyAuthority(actor, ['case:read', 'operator:read']),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.gatewayInquiry.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { attemptReference: { contains: q } },
          { providerReference: { contains: q } },
          { merchant: { tradeNameEn: { contains: q } } },
          { merchant: { tradeNameAr: { contains: q } } },
        ],
      },
      select: {
        id: true,
        attemptReference: true,
        providerReference: true,
        gatewayCode: true,
        status: true,
        operatorCaseId: true,
        merchantId: true,
        createdAt: true,
        merchant: { select: { tradeNameEn: true, tradeNameAr: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.attemptReference, row.providerReference],
    primaryTextFields: [row.merchant?.tradeNameEn, row.merchant?.tradeNameAr],
    secondaryTextFields: [row.gatewayCode],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `Inquiry ${row.attemptReference || row.id}`,
    subtitle: [
      row.gatewayCode?.toUpperCase(),
      row.merchant?.tradeNameEn || row.merchant?.tradeNameAr,
    ]
      .filter(Boolean)
      .join(' · '),
    reference: row.attemptReference || row.providerReference || row.id,
    status: row.status,
    operatorCaseId: row.operatorCaseId ?? undefined,
    merchantId: row.merchantId ?? undefined,
  }),
});

// 5. APPROVAL (approval:read)
const approvalProvider = defineSearchProvider({
  type: 'approval',
  aliases: ['approvals', 'maker_checker'],
  order: 50,
  canAccess: (actor) => hasAuthority(actor, 'approval:read'),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.approvalRequest.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { subjectId: { contains: q } },
          { subjectType: { contains: q } },
          { makerEmail: { contains: q } },
          { checkerEmail: { contains: q } },
        ],
      },
      select: {
        id: true,
        subjectType: true,
        subjectId: true,
        actionType: true,
        status: true,
        makerEmail: true,
        checkerEmail: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.subjectId, row.makerEmail, row.checkerEmail],
    primaryTextFields: [row.subjectType, row.actionType],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.actionType || 'Approval'} · ${row.subjectType}`,
    subtitle: [`Subject: ${row.subjectId}`, `Maker: ${row.makerEmail}`].filter(Boolean).join(' · '),
    reference: row.subjectId || row.id,
    status: row.status,
  }),
});

// 6. JOIN REQUEST (kyb:read or compliance:read)
const joinRequestProvider = defineSearchProvider({
  type: 'join_request',
  aliases: ['onboarding', 'join', 'kyb'],
  order: 60,
  canAccess: (actor) => hasAnyAuthority(actor, ['kyb:read', 'compliance:read']),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    const phoneOr = parsed.phoneVariants.map((p) => ({ contactPhone: { contains: p } }));
    return prisma.joinRequest.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { legalNameEn: { contains: q } },
          { legalNameAr: { contains: q } },
          { tradeNameEn: { contains: q } },
          { tradeNameAr: { contains: q } },
          { contactEmail: { contains: q } },
          { contactPhone: { contains: q } },
          ...phoneOr,
        ],
      },
      select: {
        id: true,
        legalNameEn: true,
        legalNameAr: true,
        tradeNameEn: true,
        tradeNameAr: true,
        contactEmail: true,
        contactPhone: true,
        status: true,
        merchantId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.contactEmail, row.contactPhone],
    primaryTextFields: [row.tradeNameEn, row.tradeNameAr, row.legalNameEn, row.legalNameAr],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: row.tradeNameEn || row.tradeNameAr || row.legalNameEn || row.id,
    subtitle: [row.contactEmail, row.contactPhone].filter(Boolean).join(' · '),
    reference: row.id,
    status: row.status,
    merchantId: row.merchantId ?? undefined,
  }),
});

// 7. KYB DOCUMENT (kyb:read or compliance:read)
const kybDocumentProvider = defineSearchProvider({
  type: 'kyb_document',
  aliases: ['doc', 'docs', 'document'],
  order: 70,
  canAccess: (actor) => hasAnyAuthority(actor, ['kyb:read', 'compliance:read']),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.kybDocument.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { fileName: { contains: q } },
          { sha256Hash: { contains: q } },
          { merchant: { tradeNameEn: { contains: q } } },
          { merchant: { tradeNameAr: { contains: q } } },
          { merchant: { legalNameEn: { contains: q } } },
          { merchant: { legalNameAr: { contains: q } } },
        ],
      },
      select: {
        id: true,
        documentType: true,
        fileName: true,
        sha256Hash: true,
        status: true,
        merchantId: true,
        createdAt: true,
        merchant: { select: { tradeNameEn: true, tradeNameAr: true, legalNameEn: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.sha256Hash, row.fileName],
    primaryTextFields: [
      row.merchant?.tradeNameEn,
      row.merchant?.tradeNameAr,
      row.merchant?.legalNameEn,
    ],
    secondaryTextFields: [row.documentType],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.documentType} · ${row.fileName}`,
    subtitle: [
      row.merchant?.tradeNameEn || row.merchant?.tradeNameAr || row.merchantId,
      row.sha256Hash ? `SHA256: ${row.sha256Hash.slice(0, 12)}…` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    reference: row.sha256Hash ? row.sha256Hash.slice(0, 12) : row.id,
    status: row.status,
    merchantId: row.merchantId,
  }),
});

// 8. DISPUTE (dispute:read)
const disputeProvider = defineSearchProvider({
  type: 'dispute',
  aliases: ['disputes', 'chargeback'],
  order: 80,
  canAccess: (actor) => hasAuthority(actor, 'dispute:read'),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.dispute.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { externalDisputeRef: { contains: q } },
          { reasonCode: { contains: q } },
          { attemptReference: { contains: q } },
          { merchant: { tradeNameEn: { contains: q } } },
          { merchant: { tradeNameAr: { contains: q } } },
        ],
      },
      select: {
        id: true,
        externalDisputeRef: true,
        reasonCode: true,
        attemptReference: true,
        amountLyd: true,
        status: true,
        merchantId: true,
        createdAt: true,
        merchant: { select: { tradeNameEn: true, tradeNameAr: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.externalDisputeRef, row.attemptReference, row.reasonCode],
    primaryTextFields: [row.merchant?.tradeNameEn, row.merchant?.tradeNameAr],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `Dispute ${row.externalDisputeRef || row.id} (${row.reasonCode})`,
    subtitle: [
      row.merchant?.tradeNameEn || row.merchant?.tradeNameAr,
      row.attemptReference ? `Attempt: ${row.attemptReference}` : null,
      `${Number(row.amountLyd ?? 0).toFixed(2)} LYD`,
    ]
      .filter(Boolean)
      .join(' · '),
    reference: row.externalDisputeRef || row.attemptReference || row.id,
    status: row.status,
    merchantId: row.merchantId,
  }),
});

// 9. ADJUSTMENT (finance:read)
const adjustmentProvider = defineSearchProvider({
  type: 'adjustment',
  aliases: ['adjustments', 'refund', 'fee_adjustment'],
  order: 90,
  canAccess: (actor) => hasAuthority(actor, 'finance:read'),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.adjustment.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { reason: { contains: q } },
          { disputeReference: { contains: q } },
          { providerRefundRef: { contains: q } },
          { sourceAttemptReference: { contains: q } },
        ],
      },
      select: {
        id: true,
        type: true,
        amountLyd: true,
        reason: true,
        disputeReference: true,
        providerRefundRef: true,
        sourceAttemptReference: true,
        status: true,
        merchantId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [
      row.id,
      row.providerRefundRef,
      row.disputeReference,
      row.sourceAttemptReference,
    ],
    primaryTextFields: [row.reason, row.type],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.type} · ${Number(row.amountLyd ?? 0).toFixed(2)} LYD`,
    subtitle: [
      row.reason,
      row.sourceAttemptReference ? `Attempt: ${row.sourceAttemptReference}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    reference: row.providerRefundRef || row.sourceAttemptReference || row.id,
    status: row.status,
    merchantId: row.merchantId ?? undefined,
  }),
});

// 10. CASHOUT (cashout:read)
const cashoutProvider = defineSearchProvider({
  type: 'cashout',
  aliases: ['cashouts', 'payout', 'withdrawal'],
  order: 100,
  canAccess: (actor) => hasAuthority(actor, 'cashout:read'),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    // Note: Never select payout account IBAN/ciphertext!
    return prisma.cashout.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { walletId: { contains: q } },
          { merchant: { tradeNameEn: { contains: q } } },
          { merchant: { tradeNameAr: { contains: q } } },
        ],
      },
      select: {
        id: true,
        walletId: true,
        amountLyd: true,
        status: true,
        merchantId: true,
        createdAt: true,
        merchant: { select: { tradeNameEn: true, tradeNameAr: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.walletId],
    primaryTextFields: [row.merchant?.tradeNameEn, row.merchant?.tradeNameAr],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `Cash-out ${Number(row.amountLyd ?? 0).toFixed(2)} LYD`,
    subtitle: [
      row.merchant?.tradeNameEn || row.merchant?.tradeNameAr,
      `Wallet: ${row.walletId}`,
    ]
      .filter(Boolean)
      .join(' · '),
    reference: row.id,
    status: row.status,
    merchantId: row.merchantId,
  }),
});

// 11. RECONCILIATION RUN (reconciliation:read)
const reconciliationRunProvider = defineSearchProvider({
  type: 'reconciliation_run',
  aliases: ['recon', 'reconciliation', 'statement'],
  order: 110,
  canAccess: (actor) => hasAuthority(actor, 'reconciliation:read'),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.reconciliationRun.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { fileName: { contains: q } },
          { gatewayCode: { contains: q } },
          { gatewayName: { contains: q } },
        ],
      },
      select: {
        id: true,
        fileName: true,
        gatewayCode: true,
        gatewayName: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.fileName, row.gatewayCode],
    primaryTextFields: [row.gatewayName],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.gatewayCode?.toUpperCase()} · ${row.fileName}`,
    subtitle: row.gatewayName || undefined,
    reference: row.id,
    status: row.status,
  }),
});

// 12. AML CASE (Confidential AML access)
const amlCaseProvider = defineSearchProvider({
  type: 'aml_case',
  aliases: ['aml'],
  order: 120,
  canAccess: (actor) => hasConfidentialAmlAccess(actor),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.amlCase.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { subjectId: { contains: q } },
          { triggerReason: { contains: q } },
          { ruleCode: { contains: q } },
          { ruleName: { contains: q } },
          { reviewerEmail: { contains: q } },
        ],
      },
      select: {
        id: true,
        subjectType: true,
        subjectId: true,
        triggerReason: true,
        ruleCode: true,
        ruleName: true,
        reviewerEmail: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.subjectId, row.ruleCode, row.reviewerEmail],
    primaryTextFields: [row.triggerReason, row.ruleName],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `AML Case · ${row.ruleCode || row.triggerReason}`,
    subtitle: [`Subject: ${row.subjectId}`, row.reviewerEmail].filter(Boolean).join(' · '),
    reference: row.id,
    status: row.status,
  }),
});

// 13. AML SCREENING (Confidential AML access; NEVER select matchListName!)
const amlScreeningProvider = defineSearchProvider({
  type: 'aml_screening',
  aliases: ['screening'],
  order: 130,
  canAccess: (actor) => hasConfidentialAmlAccess(actor),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.amlScreening.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { subjectId: { contains: q } },
          { providerCode: { contains: q } },
          { providerRequestRef: { contains: q } },
        ],
      },
      select: {
        id: true,
        subjectType: true,
        subjectId: true,
        providerCode: true,
        providerRequestRef: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.subjectId, row.providerRequestRef, row.providerCode],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `Screening · ${row.providerCode}`,
    subtitle: `Subject: ${row.subjectId}`,
    reference: row.providerRequestRef || row.id,
    status: row.status,
  }),
});

// 14. AML RULE (Confidential AML access)
const amlRuleProvider = defineSearchProvider({
  type: 'aml_rule',
  aliases: ['aml_rules'],
  order: 140,
  canAccess: (actor) => hasConfidentialAmlAccess(actor),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.amlRule.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { code: { contains: q } },
          { name: { contains: q } },
        ],
      },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.code],
    primaryTextFields: [row.name],
    timestamp: row.updatedAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.code} · ${row.name}`,
    reference: row.code,
    status: row.status,
  }),
});

// 15. AML REPORT / REGULATORY REPORT (Confidential AML access)
const amlReportProvider = defineSearchProvider({
  type: 'aml_report',
  aliases: ['str', 'sar', 'regulatory_report'],
  order: 150,
  canAccess: (actor) => hasConfidentialAmlAccess(actor),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.regulatoryReport.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { reportReference: { contains: q } },
          { subjectId: { contains: q } },
          { submissionReference: { contains: q } },
        ],
      },
      select: {
        id: true,
        reportReference: true,
        reportType: true,
        subjectId: true,
        submissionReference: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.reportReference, row.subjectId, row.submissionReference],
    primaryTextFields: [row.reportType],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.reportReference || row.id} · ${row.reportType}`,
    subtitle: [`Subject: ${row.subjectId}`, row.submissionReference].filter(Boolean).join(' · '),
    reference: row.reportReference || row.submissionReference || row.id,
    status: row.status,
  }),
});

// 16. GATEWAY (gateway:read)
const gatewayProvider = defineSearchProvider({
  type: 'gateway',
  aliases: ['gateways', 'gw'],
  order: 160,
  canAccess: (actor) => hasAuthority(actor, 'gateway:read'),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.gateway.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { code: { contains: q } },
          { nameEn: { contains: q } },
          { nameAr: { contains: q } },
          { operatorName: { contains: q } },
        ],
      },
      select: {
        id: true,
        code: true,
        nameEn: true,
        nameAr: true,
        operatorName: true,
        status: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.code],
    primaryTextFields: [row.nameEn, row.nameAr, row.operatorName],
    timestamp: row.updatedAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.nameEn}${row.nameAr ? ` (${row.nameAr})` : ''}`,
    subtitle: row.operatorName || undefined,
    reference: row.code,
    status: row.status,
  }),
});

// 17. RAIL (gateway:read)
const railProvider = defineSearchProvider({
  type: 'rail',
  aliases: ['rails'],
  order: 170,
  canAccess: (actor) => hasAuthority(actor, 'gateway:read'),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.rail.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { code: { contains: q } },
          { nameEn: { contains: q } },
          { nameAr: { contains: q } },
        ],
      },
      select: {
        id: true,
        code: true,
        nameEn: true,
        nameAr: true,
        status: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.code],
    primaryTextFields: [row.nameEn, row.nameAr],
    timestamp: row.updatedAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.nameEn}${row.nameAr ? ` (${row.nameAr})` : ''}`,
    reference: row.code,
    status: row.status,
  }),
});

// 18. ROUTE (gateway:read)
const routeProvider = defineSearchProvider({
  type: 'route',
  aliases: ['routes', 'rail_route'],
  order: 180,
  canAccess: (actor) => hasAuthority(actor, 'gateway:read'),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.railRoute.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { railCode: { contains: q } },
          { gatewayCode: { contains: q } },
        ],
      },
      select: {
        id: true,
        railCode: true,
        gatewayCode: true,
        priority: true,
        status: true,
        healthStatus: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.railCode, row.gatewayCode],
    timestamp: row.updatedAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.railCode} → ${row.gatewayCode}`,
    subtitle: `Priority ${row.priority} · Health: ${row.healthStatus}`,
    reference: row.id,
    status: row.status,
  }),
});

// 19. USER (user:read or security:read)
const userProvider = defineSearchProvider({
  type: 'user',
  aliases: ['users', 'staff', 'admin'],
  order: 190,
  canAccess: (actor) => hasAnyAuthority(actor, ['user:read', 'security:read']),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    const phoneOr = parsed.phoneVariants.map((p) => ({ phone: { contains: p } }));
    return prisma.user.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { email: { contains: q } },
          { phone: { contains: q } },
          ...phoneOr,
        ],
      },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.email, row.phone],
    secondaryTextFields: [row.role],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: row.email || row.phone || row.id,
    subtitle: [row.role, row.phone && row.email ? row.phone : null].filter(Boolean).join(' · '),
    reference: row.id,
    status: row.status,
  }),
});

// 20. AUDIT LOG (security:read; NEVER select beforeJson / afterJson!)
const auditLogProvider = defineSearchProvider({
  type: 'audit_log',
  aliases: ['audit', 'logs'],
  order: 200,
  canAccess: (actor) => hasAuthority(actor, 'security:read'),
  fetchCandidates: async ({ prisma, parsed, take }) => {
    const q = parsed.term;
    return prisma.auditLog.findMany({
      where: {
        OR: [
          { id: { contains: q } },
          { action: { contains: q } },
          { entityType: { contains: q } },
          { entityId: { contains: q } },
          { actorEmail: { contains: q } },
        ],
      },
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        actorEmail: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },
  extractMatchSignals: (row) => ({
    exactFields: [row.id, row.entityId, row.actorEmail, row.action],
    primaryTextFields: [row.entityType],
    timestamp: row.createdAt,
  }),
  toResultItem: (row) => ({
    id: row.id,
    title: `${row.action} (${row.entityType})`,
    subtitle: [row.actorEmail, row.entityId ? `Target: ${row.entityId}` : null]
      .filter(Boolean)
      .join(' · '),
    reference: row.entityId || row.id,
  }),
});

// Register all 20 built-in providers in defaultSearchRegistry
[
  merchantProvider,
  paymentAttemptProvider,
  operatorCaseProvider,
  gatewayInquiryProvider,
  approvalProvider,
  joinRequestProvider,
  kybDocumentProvider,
  disputeProvider,
  adjustmentProvider,
  cashoutProvider,
  reconciliationRunProvider,
  amlCaseProvider,
  amlScreeningProvider,
  amlRuleProvider,
  amlReportProvider,
  gatewayProvider,
  railProvider,
  routeProvider,
  userProvider,
  auditLogProvider,
].forEach((p) => defaultSearchRegistry.register(p));

// ---------------------------------------------------------------------------
// 3. Request Validation & Orchestrator (executeGlobalSearch)
// ---------------------------------------------------------------------------

export const globalSearchRequestSchema = z.object({
  query: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(2, 'Query must be at least 2 characters').max(120, 'Query max 120 chars')),
  types: z.array(z.string().min(1).max(64)).max(30).optional(),
  limit: z.number().int().min(1).max(10).optional().default(5),
});

export interface ExecuteGlobalSearchDeps {
  prisma: PrismaClient;
  actor: AuthenticatedAdminActor;
  requestId?: string;
  logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  registry?: SearchProviderRegistry;
}

export async function executeGlobalSearch(
  rawBody: unknown,
  deps: ExecuteGlobalSearchDeps
): Promise<GlobalSearchResponse> {
  const startTime = performance.now();
  const registry = deps.registry ?? defaultSearchRegistry;

  // Validate request body independently in core-back
  const validated = globalSearchRequestSchema.parse(rawBody);
  const registeredTypes = registry.getRegisteredTypes();

  if (validated.types && validated.types.some((t) => !registeredTypes.has(t))) {
    const invalid = validated.types.filter((t) => !registeredTypes.has(t));
    const err = new Error(`Unsupported search types: ${invalid.join(', ')}`);
    (err as any).statusCode = 400;
    throw err;
  }

  const parsed = parseSearchQuery(validated.query);
  const limit = validated.limit;
  const take = limit * 3;

  // Resolve optional inline type: aliases + request.types allow-list
  let allowedTypeSet: Set<string> | null = validated.types ? new Set(validated.types) : null;
  if (parsed.scopedTypeAliases.length > 0) {
    const aliasMatched = new Set<string>();
    for (const alias of parsed.scopedTypeAliases) {
      for (const matchedType of registry.resolveAliasToTypes(alias)) {
        aliasMatched.add(matchedType);
      }
    }
    if (aliasMatched.size > 0) {
      allowedTypeSet = allowedTypeSet
        ? new Set([...allowedTypeSet].filter((t) => aliasMatched.has(t)))
        : aliasMatched;
    }
  }

  // Filter providers by authority BEFORE querying DB!
  const authorizedProviders = registry.getAllOrdered().filter((plugin) => {
    if (allowedTypeSet && !allowedTypeSet.has(plugin.type)) return false;
    return plugin.canAccess(deps.actor);
  });

  // Execute all authorized provider queries in parallel via Promise.allSettled
  const settledResults = await Promise.allSettled(
    authorizedProviders.map(async (plugin) => {
      const rows = await plugin.fetchCandidates({
        prisma: deps.prisma,
        parsed,
        actor: deps.actor,
        take,
      });
      const { items, truncated } = rankAndSliceCandidates(
        rows,
        plugin,
        parsed,
        deps.actor,
        limit
      );
      return {
        type: plugin.type,
        items,
        truncated,
      } satisfies SearchResultGroup;
    })
  );

  const groups: SearchResultGroup[] = [];
  let total = 0;
  let partial = false;

  settledResults.forEach((res, idx) => {
    const plugin = authorizedProviders[idx];
    if (res.status === 'fulfilled') {
      if (res.value.items.length > 0) {
        groups.push(res.value);
        total += res.value.items.length;
      }
    } else {
      partial = true;
      // Log provider failure with requestId, NEVER logging the raw PII search query!
      deps.logger?.error('Global search provider failed', {
        requestId: deps.requestId,
        providerType: plugin.type,
        actorId: deps.actor.id,
        error: res.reason instanceof Error ? res.reason.message : String(res.reason),
      });
    }
  });

  const tookMs = Math.max(1, Math.round(performance.now() - startTime));
  if (tookMs > 750) {
    deps.logger?.warn('Slow global search execution detected', {
      requestId: deps.requestId,
      tookMs,
      providerCount: authorizedProviders.length,
      totalReturned: total,
      partial,
    });
  }

  return {
    query: validated.query,
    groups,
    total,
    tookMs,
    partial,
  };
}
```

### 4.4 Core Internal Route Wiring (`core-back/api/internal/admin.ts`)

Register `POST /internal/admin/search` and `GET /internal/admin/audit-logs/:id` in `core-back/api/internal/admin.ts` immediately after `requireAuthentication` (at line 674), ensuring `GET /audit-logs/:id` is registered **after** static routes such as `/audit-logs/export`:

```ts
// core-back/api/internal/admin.ts (Insert after requireAuthentication middleware at line 674)
import { executeGlobalSearch } from '../../lib/globalSearch';
import { hasAuthority } from '../../lib/auth/confidentialAccess';

// 1. Global Deep Search Endpoint (POST keeps PII out of URL logs)
router.post('/search', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const actor = req.adminActor; // populated by requireAuthentication
    if (!actor) {
      return res.status(401).json({ error: 'UNAUTHENTICATED' });
    }

    const result = await executeGlobalSearch(req.body, {
      prisma: req.prisma,
      actor,
      requestId: req.headers['x-request-id'] as string | undefined,
      logger: req.log,
    });

    return res.status(200).json(result);
  } catch (err: any) {
    if (err?.name === 'ZodError' || err?.statusCode === 400) {
      return res.status(400).json({
        error: 'INVALID_SEARCH_REQUEST',
        message: err.message,
      });
    }
    return next(err);
  }
});

// 2. Audit Log Single-Record Detail Endpoint (Registered AFTER /audit-logs/export!)
router.get('/audit-logs/:id', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const actor = req.adminActor;
    if (!actor || !hasAuthority(actor, 'security:read')) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    const logId = String(req.params.id || '').trim();
    if (!logId) {
      return res.status(400).json({ error: 'INVALID_AUDIT_LOG_ID' });
    }

    const record = await req.prisma.auditLog.findUnique({
      where: { id: logId },
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        actorId: true,
        actorEmail: true,
        actorRole: true,
        ipAddress: true,
        userAgent: true,
        requestId: true,
        beforeJson: true,
        afterJson: true,
        metadataJson: true,
        createdAt: true,
      },
    });

    if (!record) {
      return res.status(404).json({ error: 'AUDIT_LOG_NOT_FOUND' });
    }

    return res.status(200).json({ data: record });
  } catch (err) {
    return next(err);
  }
});
```

## 5. Admin BFF Layer (`admin-back`)

### 5.1 Dedicated Search Proxy & Token-Hashed Rate Limiter (`admin-back/api/protected/search.ts`)

Create `admin-back/api/protected/search.ts` with:
1. A dedicated sliding-window / token-bucket limiter allowing **120 requests/minute per session**, keyed by a **SHA-256 hash of the session token** (so raw tokens are never held in limiter keys and concurrent admins behind the same corporate NAT IP never throttle each other).
2. Independent Zod request body validation.
3. Strict `Cache-Control: no-store` header and zero query logging.

```ts
// admin-back/api/protected/search.ts
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { coreInternalClient } from '../../lib/coreInternalClient';

const searchRouter = Router();

const bffSearchSchema = z.object({
  query: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(2).max(120)),
  types: z.array(z.string().min(1).max(64)).max(30).optional(),
  limit: z.number().int().min(1).max(10).optional().default(5),
});

// Per-session-hash rate limiter: 120 requests per 60,000 ms
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const sessionBuckets = new Map<string, { count: number; resetAt: number }>();

function hashSessionKey(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex').slice(0, 32);
}

export function resetSearchRateLimiterForTests(): void {
  sessionBuckets.clear();
}

function checkSearchRateLimit(sessionKey: string, now = Date.now()): {
  allowed: boolean;
  retryAfterSec: number;
} {
  // Periodic cleanup of expired buckets when map grows
  if (sessionBuckets.size > 2000) {
    for (const [k, v] of sessionBuckets.entries()) {
      if (v.resetAt <= now) sessionBuckets.delete(k);
    }
  }

  const bucket = sessionBuckets.get(sessionKey);
  if (!bucket || bucket.resetAt <= now) {
    sessionBuckets.set(sessionKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfterSec: 0 };
  }

  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { allowed: false, retryAfterSec };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}

searchRouter.post('/', async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  const rawSessionToken =
    (req.cookies?.admin_session as string | undefined) ||
    (req.headers.authorization as string | undefined) ||
    req.ip ||
    'anonymous';
  const sessionKey = hashSessionKey(rawSessionToken);

  const rateStatus = checkSearchRateLimit(sessionKey);
  if (!rateStatus.allowed) {
    res.setHeader('Retry-After', String(rateStatus.retryAfterSec));
    return res.status(429).json({
      error: 'SEARCH_RATE_LIMIT_EXCEEDED',
      message: 'Too many search requests. Please wait a moment and try again.',
      retryAfterSec: rateStatus.retryAfterSec,
    });
  }

  const parsedBody = bffSearchSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: 'INVALID_SEARCH_BODY',
      details: parsedBody.error.flatten(),
    });
  }

  try {
    const coreResponse = await coreInternalClient.post(
      '/internal/admin/search',
      parsedBody.data,
      {
        headers: {
          'x-request-id': (req.headers['x-request-id'] as string) ?? '',
          'x-admin-session': rawSessionToken,
        },
        timeout: 7500,
      }
    );

    return res.status(coreResponse.status).json(coreResponse.data);
  } catch (err: any) {
    if (err?.response) {
      return res.status(err.response.status).json(err.response.data);
    }
    return next(err);
  }
});

export default searchRouter;
```

### 5.2 Mount `/search` & Audit-Log Detail Proxy (`admin-back/api/protected/index.ts` & `auditLogs.ts`)

```ts
// 1. admin-back/api/protected/index.ts
// Mount /search BEFORE any root-level wildcard or parameter routers:
import searchRouter from './search';

protectedRouter.use('/search', searchRouter);
```

```ts
// 2. admin-back/api/protected/auditLogs.ts
// Register GET /:id strictly AFTER static routes such as GET /export:

auditLogsRouter.get('/export', async (req, res, next) => {
  // ... existing export handler ...
});

auditLogsRouter.get('/:id', async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = encodeURIComponent(String(req.params.id || '').trim());
  try {
    const response = await coreInternalClient.get(`/internal/admin/audit-logs/${id}`, {
      headers: {
        'x-request-id': (req.headers['x-request-id'] as string) ?? '',
        'x-admin-session':
          (req.cookies?.admin_session as string | undefined) ||
          (req.headers.authorization as string | undefined) ||
          '',
      },
    });
    return res.status(response.status).json(response.data);
  } catch (err: any) {
    if (err?.response) {
      return res.status(err.response.status).json(err.response.data);
    }
    return next(err);
  }
});
```

## 6. Frontend Plugin Registry & Global Command Palette (`admin-front`)

### 6.1 URL Map Additions (`admin-front/src/constants/urlsMap/index.ts`)

Add the search and audit-log detail endpoints to `admin-front/src/constants/urlsMap/index.ts`:

```ts
// admin-front/src/constants/urlsMap/index.ts
export const urlsMap = {
  // ... existing entries ...
  globalSearch: '/api/v1/admin/search',
  auditLogDetail: (id: string) => `/api/v1/admin/audit-logs/${encodeURIComponent(id)}`,
} as const;
```

### 6.2 Search Client with 60s Session Cache, Sequence Guard & AbortController (`admin-front/src/components/search/api.ts`)

```ts
// admin-front/src/components/search/api.ts
import { api } from '@/services/api';
import { urlsMap } from '@/constants/urlsMap';
import type { GlobalSearchRequest, GlobalSearchResponse } from './types';

interface CacheEntry {
  response: GlobalSearchResponse;
  expiresAt: number;
}

const SESSION_CACHE_TTL_MS = 60_000;
const searchCache = new Map<string, CacheEntry>();

let activeController: AbortController | null = null;
let latestSequenceId = 0;

function makeCacheKey(req: GlobalSearchRequest): string {
  const q = req.query.trim().toLowerCase();
  const limit = req.limit ?? 5;
  const types = req.types ? [...req.types].sort().join(',') : '*';
  return `${q}::${limit}::${types}`;
}

export function clearGlobalSearchCache(): void {
  searchCache.clear();
}

export function cancelPendingGlobalSearch(): void {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
}

export async function fetchGlobalSearchResults(
  request: GlobalSearchRequest,
  options?: { bypassCache?: boolean }
): Promise<{ data: GlobalSearchResponse; stale: boolean }> {
  const key = makeCacheKey(request);
  const now = Date.now();

  if (!options?.bypassCache) {
    const cached = searchCache.get(key);
    if (cached && cached.expiresAt > now) {
      return { data: cached.response, stale: false };
    }
  }

  cancelPendingGlobalSearch();
  const controller = new AbortController();
  activeController = controller;
  const seq = ++latestSequenceId;

  const response = await api.post<GlobalSearchResponse>(
    urlsMap.globalSearch,
    {
      query: request.query.trim(),
      limit: request.limit ?? 5,
      ...(request.types && request.types.length > 0 ? { types: request.types } : {}),
    },
    {
      timeout: 8000,
      signal: controller.signal,
    }
  );

  if (seq !== latestSequenceId) {
    return { data: response.data, stale: true };
  }

  // Only cache complete (non-partial) responses
  if (!response.data.partial) {
    searchCache.set(key, {
      response: response.data,
      expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
    });
  }

  return { data: response.data, stale: false };
}
```

### 6.3 Privacy-First Recent Queries Store (`admin-front/src/components/search/recents.ts`)

Stores **only** trimmed query strings (capped at 8). Never stores record IDs or server payloads:

```ts
// admin-front/src/components/search/recents.ts
const STORAGE_KEY = 'pg_admin_recent_search_queries_v1';
const MAX_RECENTS = 8;

export function getRecentSearchQueries(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && s.length <= 120)
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

export function saveRecentSearchQuery(query: string): string[] {
  const clean = query.trim().slice(0, 120);
  if (clean.length < 2) return getRecentSearchQueries();
  try {
    const existing = getRecentSearchQueries().filter(
      (q) => q.toLowerCase() !== clean.toLowerCase()
    );
    const next = [clean, ...existing].slice(0, MAX_RECENTS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
}

export function removeRecentSearchQuery(query: string): string[] {
  const clean = query.trim().toLowerCase();
  try {
    const next = getRecentSearchQueries().filter((q) => q.toLowerCase() !== clean);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
}

export function clearRecentSearchQueries(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}
```

### 6.4 Frontend Declarative Target Plugin Registry (`admin-front/src/components/search/targets.ts`)

This is the frontend counterpart to `SearchProviderRegistry`. Every `SearchType` is registered via `defineSearchTargetPlugin()`.
- It provides **reusable target resolution factories** (`openDrawerTarget`, `routeParamTarget`, `searchPrefillTarget`) so adding a new entity takes 6 lines of declarative configuration.
- It enforces **frontend route authority, role, and navigation section visibility filtering** (`canNavigateToTarget`) so a user never sees a search result that leads to a route hidden by the UI.

```ts
// admin-front/src/components/search/targets.ts
import type { RouteLocationRaw } from 'vue-router';
import type { SearchResultGroup, SearchResultItem, SearchType } from './types';

export interface FrontendAccessContext {
  role: string;
  authorities: Set<string>;
  visibleRouteNames: Set<string>;
  routesAuthorities?: Record<string, string[]>;
  routesRoles?: Record<string, string[]>;
}

export interface SearchTargetPlugin {
  readonly type: SearchType;
  readonly order: number;
  readonly icon: string;
  readonly groupLabel: { en: string; ar: string };
  readonly kindLabel: { en: string; ar: string };
  /** Primary destination route name checked against routesAuthorities / routesRoles / visibleRouteNames */
  readonly primaryRouteName: string;
  /** Optional fallback route names if the item conditionally routes elsewhere (e.g. gateway_inquiry -> operatorCases) */
  readonly additionalRouteNames?: readonly string[];
  /** Resolves the exact Vue Router target location */
  readonly resolveTarget: (item: SearchResultItem, rawQuery: string) => RouteLocationRaw | null;
}

export function defineSearchTargetPlugin(plugin: SearchTargetPlugin): SearchTargetPlugin {
  return Object.freeze(plugin);
}

// Declarative Target Resolution Helpers for zero-boilerplate plugins:
export const openDrawerTarget =
  (routeName: string, queryKey = 'open') =>
  (item: SearchResultItem): RouteLocationRaw => ({
    name: routeName,
    query: { [queryKey]: item.id },
  });

export const routeParamTarget =
  (routeName: string, paramName = 'id') =>
  (item: SearchResultItem): RouteLocationRaw => ({
    name: routeName,
    params: { [paramName]: item.id },
  });

export class ClientSearchTargetRegistry {
  private readonly plugins = new Map<SearchType, SearchTargetPlugin>();

  public register(plugin: SearchTargetPlugin): this {
    this.plugins.set(plugin.type, plugin);
    return this;
  }

  public get(type: SearchType): SearchTargetPlugin | undefined {
    return this.plugins.get(type);
  }

  public getAllOrdered(): SearchTargetPlugin[] {
    return Array.from(this.plugins.values()).sort((a, b) => a.order - b.order);
  }
}

export const clientSearchRegistry = new ClientSearchTargetRegistry();

// Register all 20 Built-In Search Target Plugins:
[
  defineSearchTargetPlugin({
    type: 'merchant',
    order: 10,
    icon: 'mdi-storefront-outline',
    groupLabel: { en: 'Merchants', ar: 'التجار' },
    kindLabel: { en: 'Merchant', ar: 'تاجر' },
    primaryRouteName: 'merchant-detail',
    resolveTarget: routeParamTarget('merchant-detail', 'id'),
  }),
  defineSearchTargetPlugin({
    type: 'payment_attempt',
    order: 20,
    icon: 'mdi-credit-card-Check-outline',
    groupLabel: { en: 'Payment Attempts', ar: 'محاولات الدفع' },
    kindLabel: { en: 'Attempt', ar: 'محاولة دفع' },
    primaryRouteName: 'merchant-detail',
    resolveTarget: (item, rawQuery) => {
      if (!item.merchantId) return null;
      return {
        name: 'merchant-detail',
        params: { id: item.merchantId },
        query: {
          tab: 'transactions',
          reference: item.reference || rawQuery.trim(),
        },
      };
    },
  }),
  defineSearchTargetPlugin({
    type: 'operator_case',
    order: 30,
    icon: 'mdi-briefcase-Alert-outline',
    groupLabel: { en: 'Operator Cases', ar: 'حالات العمليات' },
    kindLabel: { en: 'Case', ar: 'حالة عمليات' },
    primaryRouteName: 'operator-cases',
    resolveTarget: openDrawerTarget('operator-cases', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'gateway_inquiry',
    order: 40,
    icon: 'mdi-radar',
    groupLabel: { en: 'Gateway Inquiries', ar: 'استعلامات البوابات' },
    kindLabel: { en: 'Inquiry', ar: 'استعلام بوابة' },
    primaryRouteName: 'gateway-inquiries',
    additionalRouteNames: ['operator-cases'],
    resolveTarget: (item, rawQuery) => {
      if (item.operatorCaseId) {
        return {
          name: 'operator-cases',
          query: { open: item.operatorCaseId },
        };
      }
      return {
        name: 'gateway-inquiries',
        query: { search: item.reference || rawQuery.trim() },
      };
    },
  }),
  defineSearchTargetPlugin({
    type: 'approval',
    order: 50,
    icon: 'mdi-shield-Check-outline',
    groupLabel: { en: 'Approvals (Four-Eyes)', ar: 'الموافقات الثنائية' },
    kindLabel: { en: 'Approval', ar: 'طلب موافقة' },
    primaryRouteName: 'approvals',
    resolveTarget: openDrawerTarget('approvals', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'join_request',
    order: 60,
    icon: 'mdi-domain-plus',
    groupLabel: { en: 'Join Requests (KYB)', ar: 'طلبات الانضمام' },
    kindLabel: { en: 'Join Request', ar: 'طلب انضمام' },
    primaryRouteName: 'join-requests',
    resolveTarget: openDrawerTarget('join-requests', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'kyb_document',
    order: 70,
    icon: 'mdi-file-certificate-outline',
    groupLabel: { en: 'KYB Documents', ar: 'مستندات التحقق KYB' },
    kindLabel: { en: 'KYB Doc', ar: 'مستند KYB' },
    primaryRouteName: 'kyb-documents',
    additionalRouteNames: ['merchant-detail'],
    resolveTarget: (item) => {
      if (item.merchantId) {
        return {
          name: 'merchant-detail',
          params: { id: item.merchantId },
          query: { tab: 'kyb', openDoc: item.id },
        };
      }
      return { name: 'kyb-documents', query: { open: item.id } };
    },
  }),
  defineSearchTargetPlugin({
    type: 'dispute',
    order: 80,
    icon: 'mdi-scale-balance',
    groupLabel: { en: 'Disputes & Chargebacks', ar: 'النزاعات وطلبات الاسترداد' },
    kindLabel: { en: 'Dispute', ar: 'نزاع' },
    primaryRouteName: 'disputes',
    resolveTarget: openDrawerTarget('disputes', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'adjustment',
    order: 90,
    icon: 'mdi-cash-sync',
    groupLabel: { en: 'Adjustments & Refunds', ar: 'التسويات والمرتجعات' },
    kindLabel: { en: 'Adjustment', ar: 'تسوية مالية' },
    primaryRouteName: 'adjustments',
    resolveTarget: openDrawerTarget('adjustments', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'cashout',
    order: 100,
    icon: 'mdi-bank-transfer-out',
    groupLabel: { en: 'Cash-outs', ar: 'السحوبات البنكية' },
    kindLabel: { en: 'Cash-out', ar: 'سحب بنكي' },
    primaryRouteName: 'cashouts',
    resolveTarget: openDrawerTarget('cashouts', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'reconciliation_run',
    order: 110,
    icon: 'mdi-file-compare',
    groupLabel: { en: 'Reconciliation Runs', ar: 'دورات المطابقة المالية' },
    kindLabel: { en: 'Recon Run', ar: 'مطابقة' },
    primaryRouteName: 'reconciliation',
    resolveTarget: openDrawerTarget('reconciliation', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'aml_case',
    order: 120,
    icon: 'mdi-shield-alert-outline',
    groupLabel: { en: 'AML Cases', ar: 'حالات مكافحة غسل الأموال' },
    kindLabel: { en: 'AML Case', ar: 'حالة AML' },
    primaryRouteName: 'aml-cases',
    resolveTarget: openDrawerTarget('aml-cases', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'aml_screening',
    order: 130,
    icon: 'mdi-account-search-outline',
    groupLabel: { en: 'AML Screenings', ar: 'فحوصات القوائم الرقابية' },
    kindLabel: { en: 'Screening', ar: 'فحص AML' },
    primaryRouteName: 'aml-screenings',
    resolveTarget: openDrawerTarget('aml-screenings', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'aml_rule',
    order: 140,
    icon: 'mdi-tune-variant',
    groupLabel: { en: 'AML Rules', ar: 'قواعد مكافحة غسل الأموال' },
    kindLabel: { en: 'AML Rule', ar: 'قاعدة AML' },
    primaryRouteName: 'aml-rules',
    resolveTarget: openDrawerTarget('aml-rules', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'aml_report',
    order: 150,
    icon: 'mdi-file-send-outline',
    groupLabel: { en: 'Regulatory Reports (STR/LTR)', ar: 'التقارير الرقابية' },
    kindLabel: { en: 'AML Report', ar: 'تقرير رقابي' },
    primaryRouteName: 'aml-reports',
    resolveTarget: openDrawerTarget('aml-reports', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'gateway',
    order: 160,
    icon: 'mdi-server-network',
    groupLabel: { en: 'Gateways', ar: 'بوابات الدفع' },
    kindLabel: { en: 'Gateway', ar: 'بوابة دفع' },
    primaryRouteName: 'gateway-detail',
    resolveTarget: routeParamTarget('gateway-detail', 'id'),
  }),
  defineSearchTargetPlugin({
    type: 'rail',
    order: 170,
    icon: 'mdi-contactless-payment-circle-outline',
    groupLabel: { en: 'Payment Rails', ar: 'قنوات الدفع' },
    kindLabel: { en: 'Rail', ar: 'قناة دفع' },
    primaryRouteName: 'rails',
    resolveTarget: openDrawerTarget('rails', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'route',
    order: 180,
    icon: 'mdi-transit-connection-variant',
    groupLabel: { en: 'Rail Routes', ar: 'مسارات التوجيه' },
    kindLabel: { en: 'Route', ar: 'مسار توجيه' },
    primaryRouteName: 'routes',
    resolveTarget: openDrawerTarget('routes', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'user',
    order: 190,
    icon: 'mdi-account-badge-outline',
    groupLabel: { en: 'Users & Staff', ar: 'المستخدمون والموظفون' },
    kindLabel: { en: 'User', ar: 'مستخدم' },
    primaryRouteName: 'users',
    resolveTarget: openDrawerTarget('users', 'open'),
  }),
  defineSearchTargetPlugin({
    type: 'audit_log',
    order: 200,
    icon: 'mdi-history',
    groupLabel: { en: 'Audit Logs', ar: 'سجل التدقيق الأمني' },
    kindLabel: { en: 'Audit Log', ar: 'سجل تدقيق' },
    primaryRouteName: 'audit-logs',
    resolveTarget: openDrawerTarget('audit-logs', 'open'),
  }),
].forEach((p) => clientSearchRegistry.register(p));

/**
 * Verifies whether a route name is accessible given the current user's role, authorities, and visible sections.
 */
export function isRouteAccessibleToUser(
  routeName: string,
  access: FrontendAccessContext
): boolean {
  if (!routeName) return false;

  // Check role restriction if configured in routesRoles
  const allowedRoles = access.routesRoles?.[routeName];
  if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(access.role)) {
    return false;
  }

  // Check authority restriction if configured in routesAuthorities
  const requiredAuths = access.routesAuthorities?.[routeName];
  if (requiredAuths && requiredAuths.length > 0) {
    const hasOne = requiredAuths.some(
      (req) => access.authorities.has('*') || access.authorities.has(req)
    );
    if (!hasOne) return false;
  }

  // If visibleRouteNames is populated from useSections(), ensure route (or its parent list route) is visible
  if (access.visibleRouteNames.size > 0) {
    const parentEquivalent =
      routeName === 'merchant-detail'
        ? 'merchants'
        : routeName === 'gateway-detail'
          ? 'gateways'
          : routeName;
    if (
      !access.visibleRouteNames.has(routeName) &&
      !access.visibleRouteNames.has(parentEquivalent)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Filters server groups through clientSearchRegistry AND route accessibility so the user
 * never sees a group or row whose destination route is hidden or unauthorized.
 */
export function filterAndNormalizeServerGroups(
  groups: SearchResultGroup[],
  rawQuery: string,
  access: FrontendAccessContext
): Array<{
  plugin: SearchTargetPlugin;
  truncated: boolean;
  items: Array<{ item: SearchResultItem; target: RouteLocationRaw }>;
}> {
  const output: Array<{
    plugin: SearchTargetPlugin;
    truncated: boolean;
    items: Array<{ item: SearchResultItem; target: RouteLocationRaw }>;
  }> = [];

  for (const group of groups) {
    const plugin = clientSearchRegistry.get(group.type);
    if (!plugin) continue;

    if (!isRouteAccessibleToUser(plugin.primaryRouteName, access)) {
      continue;
    }

    const validItems: Array<{ item: SearchResultItem; target: RouteLocationRaw }> = [];
    for (const item of group.items) {
      const target = plugin.resolveTarget(item, rawQuery);
      if (!target) continue;
      const targetRouteName =
        typeof target === 'object' && 'name' in target && typeof target.name === 'string'
          ? target.name
          : plugin.primaryRouteName;
      if (!isRouteAccessibleToUser(targetRouteName, access)) continue;
      validItems.push({ item, target });
    }

    if (validItems.length > 0) {
      output.push({
        plugin,
        truncated: group.truncated,
        items: validItems,
      });
    }
  }

  return output.sort((a, b) => a.plugin.order - b.plugin.order);
}
```

### 6.5 Local Command Sources Plugin (`admin-front/src/components/search/localCommands.ts`)

Provides instant client-side search across `Pages` (derived from `useSections()`) and `Guide` (derived from `searchGuide()`), while allowing future local command providers to be registered cleanly:

```ts
// admin-front/src/components/search/localCommands.ts
import type { RouteLocationRaw } from 'vue-router';

export interface LocalSearchCommandItem {
  id: string;
  source: 'pages' | 'guide';
  title: string;
  subtitle?: string;
  icon: string;
  kindLabel: string;
  target: RouteLocationRaw;
  score: number;
}

export interface NavigationSectionItem {
  title: string;
  routeName: string;
  icon?: string;
  sectionTitle?: string;
  keywords?: string[];
}

export function searchLocalPages(
  sections: NavigationSectionItem[],
  query: string,
  locale: 'en' | 'ar',
  limit = 6
): LocalSearchCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return sections.slice(0, limit).map((sec, idx) => ({
      id: `page:${sec.routeName}`,
      source: 'pages',
      title: sec.title,
      subtitle: sec.sectionTitle,
      icon: sec.icon || 'mdi-compass-outline',
      kindLabel: locale === 'ar' ? 'صفحة' : 'Page',
      target: { name: sec.routeName },
      score: 100 - idx,
    }));
  }

  const scored: LocalSearchCommandItem[] = [];
  for (const sec of sections) {
    const titleLower = sec.title.toLowerCase();
    const sectionLower = (sec.sectionTitle || '').toLowerCase();
    const routeLower = sec.routeName.toLowerCase();
    const kwMatch = (sec.keywords || []).some((k) => k.toLowerCase().includes(q));

    let score = 0;
    if (titleLower === q || routeLower === q) score = 1000;
    else if (titleLower.startsWith(q)) score = 800;
    else if (titleLower.includes(q)) score = 600;
    else if (sectionLower.includes(q) || kwMatch) score = 400;

    if (score > 0) {
      scored.push({
        id: `page:${sec.routeName}`,
        source: 'pages',
        title: sec.title,
        subtitle: sec.sectionTitle,
        icon: sec.icon || 'mdi-compass-outline',
        kindLabel: locale === 'ar' ? 'صفحة' : 'Page',
        target: { name: sec.routeName },
        score,
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function searchLocalGuides(
  searchGuideFn: (q: string) => Array<{ id: string; title: string; summary?: string; section?: string }>,
  query: string,
  locale: 'en' | 'ar',
  limit = 5
): LocalSearchCommandItem[] {
  const q = query.trim();
  if (!q) return [];
  const rawResults = searchGuideFn(q).slice(0, limit);
  return rawResults.map((entry, idx) => ({
    id: `guide:${entry.id}`,
    source: 'guide',
    title: entry.title,
    subtitle: entry.section || entry.summary,
    icon: 'mdi-book-open-page-variant-outline',
    kindLabel: locale === 'ar' ? 'دليل النظام' : 'Guide',
    target: { name: 'guide', query: { entry: entry.id } },
    score: 500 - idx,
  }));
}
```

### 6.6 Safe Text Highlighter & Result Row (`admin-front/src/components/search/SearchResultRow.tsx`)

Implements `DS-RULE-05` (zero `v-html`) by splitting strings into safe text and `<mark class="pg-search-highlight">` VNodes, and integrates `<StatusBadge />` and `<MonoRef />`:

```tsx
// admin-front/src/components/search/SearchResultRow.tsx
import { defineComponent, type PropType, type VNodeChild } from 'vue';
import { VIcon } from 'vuetify/components';
import { StatusBadge } from '@/components/ui/StatusBadge';

/**
 * Pure VNode text highlighter — NEVER uses v-html or innerHTML.
 * Escapes regex metacharacters and renders matched segments inside <mark>.
 */
export function renderHighlightedText(text: string | undefined, query: string): VNodeChild {
  if (!text) return null;
  const cleanQuery = query.trim();
  if (cleanQuery.length < 2) return text;

  const escaped = cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);

  if (parts.length === 1) return text;

  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <mark key={index} class="pg-search-highlight">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

export const SearchResultRow = defineComponent({
  name: 'SearchResultRow',
  props: {
    id: { type: String, required: true },
    icon: { type: String, required: true },
    title: { type: String, required: true },
    subtitle: { type: String, default: undefined },
    reference: { type: String, default: undefined },
    status: { type: String, default: undefined },
    kindLabel: { type: String, required: true },
    query: { type: String, default: '' },
    active: { type: Boolean, default: false },
    onSelect: { type: Function as PropType<() => void>, required: true },
    onHover: { type: Function as PropType<() => void>, required: true },
  },
  setup(props) {
    return () => (
      <div
        id={props.id}
        role="option"
        aria-selected={props.active ? 'true' : 'false'}
        class={['pg-command-item', props.active ? 'pg-command-item--active' : '']}
        onClick={props.onSelect}
        onMouseenter={props.onHover}
      >
        <div class="pg-command-item__icon">
          <VIcon icon={props.icon} size={18} />
        </div>

        <div class="pg-command-item__body">
          <div class="pg-command-item__title-row">
            <span class="pg-command-item__title">
              {renderHighlightedText(props.title, props.query)}
            </span>
            {props.reference && (
              <code class="pg-command-item__ref">
                {renderHighlightedText(props.reference, props.query)}
              </code>
            )}
          </div>
          {props.subtitle && (
            <div class="pg-command-item__subtitle">
              {renderHighlightedText(props.subtitle, props.query)}
            </div>
          )}
        </div>

        <div class="pg-command-item__meta">
          {props.status && <StatusBadge status={props.status} size="sm" />}
          <span class="pg-command-item__kind">{props.kindLabel}</span>
          <VIcon
            icon="mdi-keyboard-return"
            size={14}
            class="pg-command-item__enter-hint"
          />
        </div>
      </div>
    );
  },
});
```

### 6.7 Global Search Command Palette (`admin-front/src/components/search/GlobalSearchPalette.tsx`)

Implements full WAI-ARIA 1.2 combobox/listbox pattern (`role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, `aria-live="polite"` result counter), filter chips (`All`, `Records`, `Pages`, `Guide`), `250ms` debounce, keyboard navigation (`ArrowDown`, `ArrowUp`, `Home`, `End`, `Enter`, `Escape`), recent queries management, and partial/error retry states:

```tsx
// admin-front/src/components/search/GlobalSearchPalette.tsx
import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
  type PropType,
} from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { VDialog, VIcon, VProgressLinear } from 'vuetify/components';
import {
  cancelPendingGlobalSearch,
  fetchGlobalSearchResults,
} from './api';
import {
  clearRecentSearchQueries,
  getRecentSearchQueries,
  removeRecentSearchQuery,
  saveRecentSearchQuery,
} from './recents';
import {
  filterAndNormalizeServerGroups,
  type FrontendAccessContext,
} from './targets';
import {
  searchLocalGuides,
  searchLocalPages,
  type NavigationSectionItem,
} from './localCommands';
import { SearchResultRow } from './SearchResultRow';
import type { GlobalSearchResponse, SearchFilterTab } from './types';

interface FlattenedPaletteOption {
  domId: string;
  groupKey: string;
  icon: string;
  title: string;
  subtitle?: string;
  reference?: string;
  status?: string;
  kindLabel: string;
  target: RouteLocationRaw;
  queryToStore?: string;
}

export const GlobalSearchPalette = defineComponent({
  name: 'GlobalSearchPalette',
  props: {
    modelValue: { type: Boolean, required: true },
    onUpdateModelValue: {
      type: Function as PropType<(val: boolean) => void>,
      required: true,
    },
    locale: { type: String as PropType<'en' | 'ar'>, default: 'en' },
    accessContext: {
      type: Object as PropType<FrontendAccessContext>,
      required: true,
    },
    navigationItems: {
      type: Array as PropType<NavigationSectionItem[]>,
      default: () => [],
    },
    searchGuideFn: {
      type: Function as PropType<
        (q: string) => Array<{ id: string; title: string; summary?: string; section?: string }>
      >,
      default: () => () => [],
    },
    triggerElement: {
      type: Object as PropType<HTMLElement | null>,
      default: null,
    },
  },
  setup(props) {
    const router = useRouter();
    const inputRef = ref<HTMLInputElement | null>(null);
    const listboxRef = ref<HTMLElement | null>(null);

    const query = ref('');
    const activeTab = ref<SearchFilterTab>('all');
    const activeIndex = ref(0);
    const loading = ref(false);
    const errorState = ref<string | null>(null);
    const serverResponse = ref<GlobalSearchResponse | null>(null);
    const recentQueries = ref<string[]>([]);

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const isRtl = computed(() => props.locale === 'ar');
    const trimmedQuery = computed(() => query.value.trim());

    const t = computed(() =>
      props.locale === 'ar'
        ? {
            placeholder: 'ابحث في كل شيء (التجار، العمليات، الحالات، الصفحات، الدليل)…',
            all: 'الكل',
            records: 'السجلات',
            pages: 'الصفحات',
            guide: 'الدليل',
            recentSearches: 'عمليات البحث الأخيرة',
            clearAll: 'مسح الكل',
            quickLinks: 'روابط سريعة للصفحات',
            minCharsHint: 'اكتب حرفين على الأقل للبحث في سجلات النظام…',
            noResultsTitle: 'لا توجد نتائج مطابقة',
            noResultsSub: 'تحقق من الرقم المرجعي أو جرب تغيير فلتر البحث أعلاه.',
            partialBanner: 'تعذر الوصول إلى بعض المجموعات. يتم عرض نتائج جزئية.',
            errorBanner: 'تعذر إتمام البحث في السجلات الآن.',
            retry: 'إعادة المحاولة',
            navigateHint: 'للتنقل',
            selectHint: 'للفتح',
            closeHint: 'للإغلاق',
          }
        : {
            placeholder: 'Search everything (merchants, attempts, cases, pages, guide)…',
            all: 'All',
            records: 'Records',
            pages: 'Pages',
            guide: 'Guide',
            recentSearches: 'Recent Searches',
            clearAll: 'Clear',
            quickLinks: 'Quick Page Links',
            minCharsHint: 'Type at least 2 characters to search platform records…',
            noResultsTitle: 'No matching results found',
            noResultsSub: 'Double-check the reference code or switch filter tabs above.',
            partialBanner: 'Some record groups could not be reached. Showing partial results.',
            errorBanner: 'Unable to search platform records right now.',
            retry: 'Retry',
            navigateHint: 'to navigate',
            selectHint: 'to open',
            closeHint: 'to close',
          }
    );

    const executeServerSearch = async (bypassCache = false) => {
      const q = trimmedQuery.value;
      if (q.length < 2) {
        serverResponse.value = null;
        errorState.value = null;
        loading.value = false;
        return;
      }

      loading.value = true;
      errorState.value = null;
      try {
        const { data, stale } = await fetchGlobalSearchResults(
          { query: q, limit: 5 },
          { bypassCache }
        );
        if (!stale) {
          serverResponse.value = data;
          loading.value = false;
        }
      } catch (err: any) {
        if (err?.name === 'CanceledError' || err?.name === 'AbortError') return;
        loading.value = false;
        errorState.value = err?.message || 'SEARCH_FAILED';
      }
    };

    watch(
      () => trimmedQuery.value,
      (newQ) => {
        activeIndex.value = 0;
        if (debounceTimer) clearTimeout(debounceTimer);
        if (newQ.length < 2) {
          cancelPendingGlobalSearch();
          serverResponse.value = null;
          errorState.value = null;
          loading.value = false;
          return;
        }
        loading.value = true;
        debounceTimer = setTimeout(() => {
          void executeServerSearch(false);
        }, 250);
      }
    );

    watch(
      () => props.modelValue,
      async (isOpen) => {
        if (isOpen) {
          recentQueries.value = getRecentSearchQueries();
          activeIndex.value = 0;
          await nextTick();
          inputRef.value?.focus();
          inputRef.value?.select();
        } else {
          cancelPendingGlobalSearch();
          if (debounceTimer) clearTimeout(debounceTimer);
          await nextTick();
          props.triggerElement?.focus?.();
        }
      }
    );

    onBeforeUnmount(() => {
      cancelPendingGlobalSearch();
      if (debounceTimer) clearTimeout(debounceTimer);
    });

    // Compute grouped sections and flat keyboard option list
    const localPages = computed(() => {
      if (activeTab.value !== 'all' && activeTab.value !== 'pages') return [];
      return searchLocalPages(props.navigationItems, trimmedQuery.value, props.locale, 6);
    });

    const localGuides = computed(() => {
      if (activeTab.value !== 'all' && activeTab.value !== 'guide') return [];
      if (!trimmedQuery.value) return [];
      return searchLocalGuides(props.searchGuideFn, trimmedQuery.value, props.locale, 5);
    });

    const normalizedRecordGroups = computed(() => {
      if (activeTab.value !== 'all' && activeTab.value !== 'records') return [];
      if (!serverResponse.value) return [];
      return filterAndNormalizeServerGroups(
        serverResponse.value.groups,
        trimmedQuery.value,
        props.accessContext
      );
    });

    const visualGroups = computed(() => {
      const groups: Array<{
        key: string;
        title: string;
        count: number;
        truncated?: boolean;
        options: FlattenedPaletteOption[];
      }> = [];

      // 1. Empty query: Quick Page Links
      if (trimmedQuery.value.length === 0) {
        if (localPages.value.length > 0) {
          groups.push({
            key: 'quick-pages',
            title: t.value.quickLinks,
            count: localPages.value.length,
            options: localPages.value.map((p) => ({
              domId: `pg-cmd-opt-${p.id}`,
              groupKey: 'quick-pages',
              icon: p.icon,
              title: p.title,
              subtitle: p.subtitle,
              kindLabel: p.kindLabel,
              target: p.target,
            })),
          });
        }
        return groups;
      }

      // 2. Active query: Pages -> Server Record Groups -> Guide
      if (localPages.value.length > 0) {
        groups.push({
          key: 'pages',
          title: t.value.pages,
          count: localPages.value.length,
          options: localPages.value.map((p) => ({
            domId: `pg-cmd-opt-${p.id}`,
            groupKey: 'pages',
            icon: p.icon,
            title: p.title,
            subtitle: p.subtitle,
            kindLabel: p.kindLabel,
            target: p.target,
            queryToStore: trimmedQuery.value,
          })),
        });
      }

      for (const recGroup of normalizedRecordGroups.value) {
        const groupTitle =
          props.locale === 'ar'
            ? recGroup.plugin.groupLabel.ar
            : recGroup.plugin.groupLabel.en;
        const kindLabel =
          props.locale === 'ar'
            ? recGroup.plugin.kindLabel.ar
            : recGroup.plugin.kindLabel.en;

        groups.push({
          key: `record:${recGroup.plugin.type}`,
          title: groupTitle,
          count: recGroup.items.length,
          truncated: recGroup.truncated,
          options: recGroup.items.map(({ item, target }) => ({
            domId: `pg-cmd-opt-${recGroup.plugin.type}-${item.id}`,
            groupKey: `record:${recGroup.plugin.type}`,
            icon: recGroup.plugin.icon,
            title: item.title,
            subtitle: item.subtitle,
            reference: item.reference,
            status: item.status,
            kindLabel,
            target,
            queryToStore: trimmedQuery.value,
          })),
        });
      }

      if (localGuides.value.length > 0) {
        groups.push({
          key: 'guide',
          title: t.value.guide,
          count: localGuides.value.length,
          options: localGuides.value.map((g) => ({
            domId: `pg-cmd-opt-${g.id}`,
            groupKey: 'guide',
            icon: g.icon,
            title: g.title,
            subtitle: g.subtitle,
            kindLabel: g.kindLabel,
            target: g.target,
            queryToStore: trimmedQuery.value,
          })),
        });
      }

      return groups;
    });

    const flatOptions = computed<FlattenedPaletteOption[]>(() =>
      visualGroups.value.flatMap((g) => g.options)
    );

    const activeOption = computed<FlattenedPaletteOption | undefined>(
      () => flatOptions.value[activeIndex.value]
    );

    const scrollActiveIntoView = () => {
      void nextTick(() => {
        const activeId = activeOption.value?.domId;
        if (!activeId || !listboxRef.value) return;
        const el = listboxRef.value.querySelector(`#${CSS.escape(activeId)}`);
        el?.scrollIntoView({ block: 'nearest' });
      });
    };

    const selectOption = (opt: FlattenedPaletteOption) => {
      if (opt.queryToStore && opt.queryToStore.length >= 2) {
        recentQueries.value = saveRecentSearchQuery(opt.queryToStore);
      }
      props.onUpdateModelValue(false);
      void router.push(opt.target);
    };

    const handleKeydown = (e: KeyboardEvent) => {
      const totalOpts = flatOptions.value.length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (totalOpts > 0) {
          activeIndex.value = (activeIndex.value + 1) % totalOpts;
          scrollActiveIntoView();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (totalOpts > 0) {
          activeIndex.value = (activeIndex.value - 1 + totalOpts) % totalOpts;
          scrollActiveIntoView();
        }
      } else if (e.key === 'Home') {
        if (totalOpts > 0) {
          e.preventDefault();
          activeIndex.value = 0;
          scrollActiveIntoView();
        }
      } else if (e.key === 'End') {
        if (totalOpts > 0) {
          e.preventDefault();
          activeIndex.value = totalOpts - 1;
          scrollActiveIntoView();
        }
      } else if (e.key === 'Enter') {
        if (activeOption.value) {
          e.preventDefault();
          selectOption(activeOption.value);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        props.onUpdateModelValue(false);
      }
    };

    let runningFlatIdx = 0;

    return () => {
      runningFlatIdx = 0;
      return (
        <VDialog
          modelValue={props.modelValue}
          onUpdate:modelValue={props.onUpdateModelValue}
          maxWidth={780}
          contentClass="pg-command-dialog"
          scrollable
        >
          <div
            class="pg-command-surface"
            dir={isRtl.value ? 'rtl' : 'ltr'}
            onKeydown={handleKeydown}
          >
            {/* Top Search Combobox Input Bar */}
            <div class="pg-command-header">
              <VIcon icon="mdi-magnify" size={20} class="pg-command-header__icon" />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-autocomplete="list"
                aria-controls="pg-global-search-listbox"
                aria-activedescendant={activeOption.value?.domId ?? undefined}
                aria-label={t.value.placeholder}
                class="pg-command-header__input"
                placeholder={t.value.placeholder}
                value={query.value}
                onInput={(e) => {
                  query.value = (e.target as HTMLInputElement).value;
                }}
              />
              {query.value.length > 0 && (
                <button
                  type="button"
                  class="pg-command-header__clear"
                  aria-label="Clear search query"
                  onClick={() => {
                    query.value = '';
                    inputRef.value?.focus();
                  }}
                >
                  <VIcon icon="mdi-close-circle" size={16} />
                </button>
              )}
              <kbd class="pg-command-kbd">ESC</kbd>
            </div>

            {/* Filter Chips Bar */}
            <div class="pg-command-tabs" role="tablist" aria-label="Search scope filters">
              {(
                [
                  { id: 'all', label: t.value.all },
                  { id: 'records', label: t.value.records },
                  { id: 'pages', label: t.value.pages },
                  { id: 'guide', label: t.value.guide },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab.value === tab.id ? 'true' : 'false'}
                  class={[
                    'pg-command-tab-chip',
                    activeTab.value === tab.id ? 'pg-command-tab-chip--active' : '',
                  ]}
                  onClick={() => {
                    activeTab.value = tab.id;
                    activeIndex.value = 0;
                    inputRef.value?.focus();
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Thin Indeterminate Loading Bar */}
            <div class="pg-command-progress-slot">
              {loading.value && <VProgressLinear indeterminate height={2} color="primary" />}
            </div>

            {/* Screen-reader live announcement of result count */}
            <div class="sr-only" aria-live="polite" aria-atomic="true">
              { `${flatOptions.value.length} results available` }
            </div>

            {/* Scrollable Listbox Body */}
            <div
              id="pg-global-search-listbox"
              ref={listboxRef}
              role="listbox"
              class="pg-command-body"
            >
              {/* Empty Query -> Recent Searches */}
              {trimmedQuery.value.length === 0 && recentQueries.value.length > 0 && (
                <div class="pg-command-group">
                  <div class="pg-command-group__header">
                    <span>{t.value.recentSearches}</span>
                    <button
                      type="button"
                      class="pg-command-group__action"
                      onClick={() => {
                        clearRecentSearchQueries();
                        recentQueries.value = [];
                      }}
                    >
                      {t.value.clearAll}
                    </button>
                  </div>
                  <div class="pg-command-recents">
                    {recentQueries.value.map((recentQ) => (
                      <div key={recentQ} class="pg-command-recent-pill">
                        <button
                          type="button"
                          class="pg-command-recent-pill__btn"
                          onClick={() => {
                            query.value = recentQ;
                            inputRef.value?.focus();
                          }}
                        >
                          <VIcon icon="mdi-history" size={14} />
                          <span>{recentQ}</span>
                        </button>
                        <button
                          type="button"
                          class="pg-command-recent-pill__remove"
                          aria-label={`Remove ${recentQ} from recent searches`}
                          onClick={() => {
                            recentQueries.value = removeRecentSearchQuery(recentQ);
                          }}
                        >
                          <VIcon icon="mdi-close" size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 1-char minimum hint for server records */}
              {trimmedQuery.value.length === 1 &&
                (activeTab.value === 'all' || activeTab.value === 'records') && (
                  <div class="pg-command-hint-banner">{t.value.minCharsHint}</div>
                )}

              {/* Grouped Options */}
              {visualGroups.value.map((group) => (
                <div key={group.key} class="pg-command-group">
                  <div class="pg-command-group__header">
                    <span>{group.title}</span>
                    <span class="pg-command-group__count">
                      {group.count}
                      {group.truncated ? '+' : ''}
                    </span>
                  </div>
                  {group.options.map((opt) => {
                    const optionIdx = runningFlatIdx++;
                    return (
                      <SearchResultRow
                        key={opt.domId}
                        id={opt.domId}
                        icon={opt.icon}
                        title={opt.title}
                        subtitle={opt.subtitle}
                        reference={opt.reference}
                        status={opt.status}
                        kindLabel={opt.kindLabel}
                        query={trimmedQuery.value}
                        active={activeIndex.value === optionIdx}
                        onHover={() => {
                          activeIndex.value = optionIdx;
                        }}
                        onSelect={() => selectOption(opt)}
                      />
                    );
                  })}
                </div>
              ))}

              {/* Server Error State with Local Retry (No Snackbar Spam) */}
              {errorState.value &&
                (activeTab.value === 'all' || activeTab.value === 'records') && (
                  <div class="pg-command-error-banner" role="alert">
                    <span>{t.value.errorBanner}</span>
                    <button
                      type="button"
                      class="pg-command-retry-btn"
                      onClick={() => void executeServerSearch(true)}
                    >
                      <VIcon icon="mdi-refresh" size={14} />
                      <span>{t.value.retry}</span>
                    </button>
                  </div>
                )}

              {/* Partial Failure Banner */}
              {!errorState.value &&
                serverResponse.value?.partial &&
                (activeTab.value === 'all' || activeTab.value === 'records') && (
                  <div class="pg-command-partial-banner" role="status">
                    <span>{t.value.partialBanner}</span>
                    <button
                      type="button"
                      class="pg-command-retry-btn"
                      onClick={() => void executeServerSearch(true)}
                    >
                      <VIcon icon="mdi-refresh" size={14} />
                      <span>{t.value.retry}</span>
                    </button>
                  </div>
                )}

              {/* Empty Results State */}
              {trimmedQuery.value.length >= 2 &&
                !loading.value &&
                !errorState.value &&
                flatOptions.value.length === 0 && (
                  <div class="pg-command-empty">
                    <VIcon icon="mdi-File-search-outline" size={32} />
                    <div class="pg-command-empty__title">{t.value.noResultsTitle}</div>
                    <div class="pg-command-empty__sub">{t.value.noResultsSub}</div>
                  </div>
                )}
            </div>

            {/* Footer Keyboard Legend */}
            <div class="pg-command-footer">
              <div class="pg-command-footer__shortcut">
                <kbd class="pg-command-kbd">↑</kbd>
                <kbd class="pg-command-kbd">↓</kbd>
                <span>{t.value.navigateHint}</span>
              </div>
              <div class="pg-command-footer__shortcut">
                <kbd class="pg-command-kbd">↵</kbd>
                <span>{t.value.selectHint}</span>
              </div>
              <div class="pg-command-footer__shortcut">
                <kbd class="pg-command-kbd">ESC</kbd>
                <span>{t.value.closeHint}</span>
              </div>
            </div>
          </div>
        </VDialog>
      );
    };
  },
});
```

### 6.8 Design System CSS Classes (`admin-front/src/styles/command-palette.css`)

Implements all required CSS classes (`.pg-global-search-trigger`, `.pg-command-dialog`, `.pg-command-item`, `.pg-command-item--active`, `.pg-command-kbd`, `.pg-command-empty`, `.pg-command-group`) using logical CSS properties (`padding-inline`, `margin-inline`, `inset-inline`) for automatic RTL/Arabic and Dark Mode compatibility:

```css
/* admin-front/src/styles/command-palette.css */

.pg-global-search-trigger {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding-inline: 12px 8px;
  border-radius: 8px;
  border: 1px solid var(--pg-border-default, #E2E8F0);
  background: var(--pg-bg-surface-subtle, #F8FAFC);
  color: var(--pg-text-secondary, #475569);
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}

.pg-global-search-trigger:hover {
  border-color: var(--pg-border-strong, #CBD5E1);
  background: var(--pg-bg-surface, #FFFFFF);
  color: var(--pg-text-primary, #0F172A);
}

.pg-command-dialog {
  align-self: flex-start !important;
  margin-top: 8vh !important;
}

.pg-command-surface {
  display: flex;
  flex-direction: column;
  background: var(--pg-bg-surface, #FFFFFF);
  border: 1px solid var(--pg-border-default, #E2E8F0);
  border-radius: 12px;
  box-shadow: 0 20px 45px -15px rgba(15, 23, 42, 0.22);
  overflow: hidden;
  max-height: 78vh;
}

.pg-command-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px !important;
  border-bottom: 1px solid var(--pg-border-subtle, #F1F5F9);
}

.pg-command-header__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--pg-text-primary, #0F172A);
  font-size: 0.9375rem;
  line-height: 1.4;
}

.pg-command-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px !important;
  background: var(--pg-bg-surface-subtle, #F8FAFC);
  border-bottom: 1px solid var(--pg-border-subtle, #E2E8F0);
}

.pg-command-tab-chip {
  height: 26px;
  padding-inline: 10px;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--pg-text-secondary, #475569);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
}

.pg-command-tab-chip--active {
  background: var(--pg-bg-surface, #FFFFFF);
  color: var(--pg-text-primary, #0F172A);
  border-color: var(--pg-border-default, #CBD5E1);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
}

.pg-command-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px !important;
  max-height: 54vh;
}

.pg-command-group {
  margin-bottom: 8px;
}

.pg-command-group__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px !important;
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--pg-text-muted, #64748B);
}

.pg-command-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 6px 10px !important;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 80ms ease;
}

.pg-command-item--active {
  background: var(--pg-bg-hover, #F1F5F9);
}

.pg-command-item__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  background: var(--pg-bg-surface-subtle, #F8FAFC);
  border: 1px solid var(--pg-border-subtle, #E2E8F0);
  color: var(--pg-text-secondary, #475569);
  flex-shrink: 0;
}

.pg-command-item__body {
  flex: 1;
  min-width: 0;
}

.pg-command-item__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pg-command-item__title {
  font-size: 0.84375rem;
  font-weight: 600;
  color: var(--pg-text-primary, #0F172A);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pg-command-item__ref {
  font-family: var(--pg-font-mono, 'JetBrains Mono', monospace);
  font-size: 0.72rem;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--pg-bg-surface-subtle, #F1F5F9);
  color: var(--pg-text-secondary, #334155);
}

.pg-command-item__subtitle {
  font-size: 0.75rem;
  color: var(--pg-text-muted, #64748B);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pg-command-item__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.pg-command-item__kind {
  font-size: 0.72rem;
  color: var(--pg-text-muted, #64748B);
}

.pg-command-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 20px;
  padding-inline: 5px;
  border-radius: 4px;
  border: 1px solid var(--pg-border-default, #CBD5E1);
  background: var(--pg-bg-surface, #FFFFFF);
  color: var(--pg-text-secondary, #475569);
  font-family: var(--pg-font-mono, 'JetBrains Mono', monospace);
  font-size: 0.6875rem;
  font-weight: 600;
}

.pg-search-highlight {
  background: rgba(245, 158, 11, 0.22);
  color: inherit;
  border-radius: 2px;
  padding-inline: 1px;
}

.pg-command-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 36px 20px !important;
  text-align: center;
  color: var(--pg-text-muted, #64748B);
}

.pg-command-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 18px !important;
  background: var(--pg-bg-surface-subtle, #F8FAFC);
  border-top: 1px solid var(--pg-border-subtle, #E2E8F0);
  font-size: 0.72rem;
  color: var(--pg-text-muted, #64748B);
}
```

## 7. Universal One-Shot Deep-Link Composable (`useOpenQuery`) & Page Wiring

### 7.1 Shared `useOpenQuery` Composable (`admin-front/src/composables/useOpenQuery.ts`)

Instead of duplicating custom `watch(() => route.query.open)` logic across 14 pages, `useOpenQuery` provides a deterministic, one-shot deep-link lifecycle:
1. When `?open=<id>` is present in the URL, it checks if the record already exists in `loadedRows.value`. If found and `preferLoadedRow` is true, it opens the drawer immediately without an extra network roundtrip; otherwise it calls `fetchById(id)`.
2. It tracks `lastHandledKey` so reactive table refreshes never re-trigger the same `?open=<id>` drawer after the user closes it.
3. When the user closes the detail drawer/dialog (`clearOpenQuery()`), it cleanly removes `open` from `route.query` via `router.replace` while preserving any active filter query parameters.

```ts
// admin-front/src/composables/useOpenQuery.ts
import { ref, watch, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

export interface UseOpenQueryOptions<TRecord> {
  /** Query parameter name to watch (defaults to 'open') */
  queryParam?: string;
  /** Optional reactive array of currently loaded table rows for instant lookup */
  loadedRows?: Ref<TRecord[]>;
  /** Key extractor on loaded rows (defaults to (row: any) => row.id) */
  getId?: (row: TRecord) => string;
  /** Whether to call fetchById even if found in loadedRows (true when detail drawer needs extra fields) */
  alwaysFetchDetail?: boolean;
  /** Async fetcher to retrieve the full record detail by ID */
  fetchById: (id: string) => Promise<TRecord | null>;
  /** Callback invoked once to open the drawer/dialog with the resolved record */
  onOpenRecord: (record: TRecord) => void;
  /** Optional callback if fetchById returns null or 404 */
  onNotFound?: (id: string) => void;
}

export function useOpenQuery<TRecord>(options: UseOpenQueryOptions<TRecord>) {
  const route = useRoute();
  const router = useRouter();
  const paramKey = options.queryParam ?? 'open';
  const getId = options.getId ?? ((r: any) => String(r?.id ?? ''));

  const lastHandledId = ref<string | null>(null);
  const isResolvingOpenQuery = ref(false);

  const clearOpenQueryParam = async () => {
    if (!(paramKey in route.query)) return;
    const nextQuery = { ...route.query };
    delete nextQuery[paramKey];
    lastHandledId.value = null;
    await router.replace({ query: nextQuery });
  };

  watch(
    () => route.query[paramKey],
    async (rawVal) => {
      const targetId = Array.isArray(rawVal) ? rawVal[0] : rawVal;
      const cleanId = typeof targetId === 'string' ? targetId.trim() : '';

      if (!cleanId) {
        lastHandledId.value = null;
        return;
      }

      // One-shot guard: do not re-open the same record ID repeatedly
      if (lastHandledId.value === cleanId) return;
      lastHandledId.value = cleanId;
      isResolvingOpenQuery.value = true;

      try {
        if (!options.alwaysFetchDetail && options.loadedRows?.value?.length) {
          const existing = options.loadedRows.value.find((r) => getId(r) === cleanId);
          if (existing) {
            options.onOpenRecord(existing);
            return;
          }
        }

        const fetched = await options.fetchById(cleanId);
        if (fetched) {
          options.onOpenRecord(fetched);
        } else {
          options.onNotFound?.(cleanId);
        }
      } catch {
        options.onNotFound?.(cleanId);
      } finally {
        isResolvingOpenQuery.value = false;
      }
    },
    { immediate: true }
  );

  return {
    isResolvingOpenQuery,
    clearOpenQueryParam,
  };
}
```

### 7.2 Exact Deep-Link Wiring Matrix Across All Target Pages

| Page / Component | Deep-Link Query Contract | Exact Implementation Action |
| :--- | :--- | :--- |
| **Approvals (`pages/approvals/index.tsx`)** | `?open=<id>` | Call `useOpenQuery({ alwaysFetchDetail: true, fetchById: fetchApprovalDetail, onOpenRecord: openApprovalDrawer })`. |
| **Audit Logs (`pages/audit-logs/index.tsx`)** | `?open=<id>` | Call `useOpenQuery({ alwaysFetchDetail: true, fetchById: (id) => api.get(urlsMap.auditLogDetail(id)).then(r => r.data.data), onOpenRecord: openAuditDetailDrawer })`. |
| **AML Cases (`pages/aml/cases.tsx`)** | `?open=<id>` | Call `useOpenQuery({ alwaysFetchDetail: true, fetchById: fetchAmlCaseDetail, onOpenRecord: openAmlCaseDrawer })`. |
| **AML Screenings (`pages/aml/screenings.tsx`)** | `?open=<id>` | Call `useOpenQuery({ alwaysFetchDetail: true, fetchById: fetchAmlScreeningDetail, onOpenRecord: openScreeningDrawer })`. |
| **AML Rules (`pages/aml/rules.tsx`)** | `?open=<id>` | Call `useOpenQuery({ loadedRows: rulesList, fetchById: fetchAmlRuleById, onOpenRecord: openRuleDrawer })`. |
| **AML Reports (`pages/aml/reports.tsx`)** | `?open=<id>` | Call `useOpenQuery({ alwaysFetchDetail: true, fetchById: fetchRegulatoryReportById, onOpenRecord: openReportDrawer })`. |
| **Operator Cases (`pages/operator-cases/index.tsx`)** | `?open=<id>` | Call `useOpenQuery({ alwaysFetchDetail: true, fetchById: fetchOperatorCaseById, onOpenRecord: openOperatorCaseDrawer })`. |
| **Disputes (`pages/disputes/index.tsx`)** | `?open=<id>` | Call `useOpenQuery({ alwaysFetchDetail: true, fetchById: fetchDisputeById, onOpenRecord: openDisputeDrawer })`. |
| **Adjustments (`pages/adjustments/index.tsx`)** | `?open=<id>` | Call `useOpenQuery({ alwaysFetchDetail: true, fetchById: fetchAdjustmentById, onOpenRecord: openAdjustmentDrawer })`. |
| **Cash-outs (`pages/cashouts/index.tsx`)** | `?open=<id>` | Call `useOpenQuery({ alwaysFetchDetail: true, fetchById: fetchCashoutById, onOpenRecord: openCashoutDrawer })`. |
| **Reconciliation (`pages/reconciliation/index.tsx`)** | `?open=<id>` | Call `useOpenQuery({ alwaysFetchDetail: true, fetchById: fetchReconciliationRunById, onOpenRecord: openRunDetailDrawer })`. |
| **Rails (`pages/rails/index.tsx`)** | `?open=<id>` | Call `useOpenQuery({ loadedRows: rails, fetchById: fetchRailById, onOpenRecord: openRailConfigDialog })`. |
| **Routes (`pages/routes/index.tsx`)** | `?open=<id>` | Call `useOpenQuery({ loadedRows: routes, fetchById: fetchRouteById, onOpenRecord: openRouteEditDialog })`. |
| **Gateway Inquiries (`pages/gateway-inquiries/index.tsx`)** | `?search=<term>` | Read `route.query.search` on mount/watch to prefill `TableFilters` search input and trigger inquiry list query. |
| **Merchant Detail Attempts (`pages/merchants/[id].tsx` + `MerchantResourceTable.tsx`)** | `?tab=transactions&reference=<ref>` | In `merchants/[id].tsx`, activate `transactions` tab when `route.query.tab === 'transactions'`, pass `initialSearch={route.query.reference}` and `focusReference={route.query.reference}` to `<MerchantResourceTable />`. When rows load, find matching `ourReference === focusReference` once, open `<MerchantTransactionDialog />`, and keep the URL shareable! |

## 8. Future Expansion & Plugin Cookbook (How to Add New Deep Search Items in < 25 Lines)

Because both the backend and frontend use declarative registries (`defaultSearchRegistry` and `clientSearchRegistry`), adding any future entity—or enabling the 4 deferred v1 entities (`commission_profile`, `velocity_rule`, `credential_set`, `platform_setting`) or new modules (`voucher_campaign`, `ai_onboarding_session`, `payment_link`, `pos_terminal`)—requires **ONLY 3 declarative steps** and **ZERO changes** to the search engine, BFF, or palette UI:

### Step 1: Register the Backend Provider Plugin (`core-back/lib/globalSearch.ts`)

```ts
// Example: Enabling 'commission_profile' or 'voucher_campaign' in the future:
defaultSearchRegistry.register(
  defineSearchProvider({
    type: 'commission_profile',
    aliases: ['commission', 'fee_profile'],
    order: 210,
    canAccess: (actor) => hasAuthority(actor, 'finance:read'),
    fetchCandidates: ({ prisma, parsed, take }) =>
      prisma.commissionProfile.findMany({
        where: {
          OR: [
            { id: { contains: parsed.term } },
            { code: { contains: parsed.term } },
            { name: { contains: parsed.term } },
          ],
        },
        select: { id: true, code: true, name: true, status: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take,
      }),
    extractMatchSignals: (row) => ({
      exactFields: [row.id, row.code],
      primaryTextFields: [row.name],
      timestamp: row.updatedAt,
    }),
    toResultItem: (row) => ({
      id: row.id,
      title: `${row.code} · ${row.name}`,
      reference: row.code,
      status: row.status,
    }),
  })
);
```

### Step 2: Register the Frontend Target Plugin (`admin-front/src/components/search/targets.ts`)

```ts
clientSearchRegistry.register(
  defineSearchTargetPlugin({
    type: 'commission_profile',
    order: 210,
    icon: 'mdi-percent-box-outline',
    groupLabel: { en: 'Commission Profiles', ar: 'ملفات العمولات' },
    kindLabel: { en: 'Commission', ar: 'ملف عمولة' },
    primaryRouteName: 'commission-profiles',
    resolveTarget: openDrawerTarget('commission-profiles', 'open'),
  })
);
```

### Step 3: Add 1-Line `useOpenQuery` in the Target Page

```ts
useOpenQuery({
  loadedRows: profiles,
  fetchById: fetchCommissionProfileById,
  onOpenRecord: openProfileDrawer,
});
```

### 8.1 Ready-to-Activate Plugin Blueprints for Deferred & Upcoming Modules

| Deferred / Upcoming Entity | `SearchType` Slug | Authority Predicate | Primary Match Fields (`select`-only) | Target Route & Deep-Link Helper |
| :--- | :--- | :--- | :--- | :--- |
| **Commission Profiles** | `commission_profile` | `finance:read` | `id`, `code`, `name` | `openDrawerTarget('commission-profiles', 'open')` |
| **Velocity Rules** | `velocity_rule` | `security:read` or `gateway:read` | `id`, `code`, `name`, `scope` | `openDrawerTarget('velocity-rules', 'open')` |
| **Credential Sets** | `credential_set` | `gateway:read` (redacting `secretCiphertext`) | `id`, `label`, `gatewayCode`, `environment` | `openDrawerTarget('credential-sets', 'open')` |
| **Voucher Campaigns** | `voucher_campaign` | `voucher:read` or `merchant:read` | `id`, `code`, `titleEn`, `titleAr` | `openDrawerTarget('voucher-campaigns', 'open')` |
| **AI Onboarding Sessions** | `ai_onboarding_session` | `gateway:write` | `id`, `providerName`, `targetRailCode` | `routeParamTarget('ai-onboarding-detail', 'id')` |

## 9. Comprehensive Automated Verification & Test Plan

### 9.1 Backend Unit & Authority Matrix Tests (`core-back/test/globalSearch.test.ts`)

Create `core-back/test/globalSearch.test.ts` with automated registry-wide contract assertions:
1. **Universal Registry Contract Loop:** Iterates over `defaultSearchRegistry.getAllOrdered()` and verifies that:
   - Every provider has a unique `type` and `order`.
   - When `canAccess(actor)` returns `false`, `fetchCandidates` is **never invoked** (`vi.spyOn(prisma.<model>, 'findMany')` call count === `0`), and the group never appears in `response.groups`.
   - Every item returned by `toResultItem()` passes `FORBIDDEN_RESULT_KEYS` inspection (zero `ciphertext`, `secret`, `beforeJson`, `afterJson`, `matchListName`, `payoutAccount`).
2. **Role & Authority Matrix Verification:**
   - **`SUPPORT`:** Receives `merchant` and `payment_attempt` (if granted `attempt:read`), but searching a merchant's `taxNumber` or `commercialRegistryNumber` does **not** include those fields in the Prisma `OR` clause and never exposes them; zero `aml_*`, `adjustment`, or `audit_log` groups appear.
   - **`OPERATOR`:** Receives `operator_case`, `gateway_inquiry`, `payment_attempt`, `merchant`, but zero `aml_*` confidential groups.
   - **`FINANCE`:** Receives `adjustment`, `cashout`, `reconciliation_run`, `dispute`, but zero `aml_*` or `audit_log` groups.
   - **`COMPLIANCE` / `MLRO`:** Receives `aml_case`, `aml_screening`, `aml_rule`, `aml_report`, `join_request`, `kyb_document`.
   - **`GATEWAY_ADMIN`:** Receives `gateway`, `rail`, `route`.
   - **`SECURITY_ADMIN`:** Receives `user`, `audit_log`.
3. **Deterministic Ranking & Truncation Verification:**
   - Seeds 15 mock rows for a provider with `limit = 5`; verifies `fetchCandidates` is called with `take = 15` (`limit * 3`), exact matches outrank prefix matches, prefix matches outrank substring matches, ties break by newest timestamp, `items.length === 5`, and `truncated === true`.
4. **Fault Isolation (`Promise.allSettled`):**
   - Simulates one provider throwing a database timeout error while others succeed; verifies HTTP `200`, `partial: true`, remaining groups intact, and `logger.error` called with `requestId` and **without** the raw search query string.
5. **Audit Log Detail Route Tests (`core-back/test/auditLogDetail.test.ts`):** *(as-built 2026-11-04: covered in `core-back/test/internal-routes.test.ts`; no separate file)*
   - Verifies `GET /internal/admin/audit-logs/:id` returns `401` unauthenticated, `403` without `security:read`, `404` when missing, `200` with full detail for `SECURITY_ADMIN`, and does not shadow `GET /internal/admin/audit-logs/export`.

### 9.2 Admin BFF Tests (`admin-back/test/search.test.ts` & `admin-surface.test.ts`)

*(As-built 2026-11-04: `admin-back/test/search.test.ts` was added on 2026-11-04 and covers validation, the per-session 120/min limiter and `no-store`; the audit-detail proxy is covered in `admin-back/test/admin-surface.test.ts`.)*

1. Verifies `POST /api/v1/admin/search` validates `query` length (`2..120`), `limit` (`1..10`), sets `Cache-Control: no-store`, and forwards to `/internal/admin/search`.
2. Verifies the token-hashed rate limiter allows 120 requests/minute per session token and returns `429` with `Retry-After` on request 121 without affecting a second admin session token.
3. Extends `admin-back/test/admin-surface.test.ts` with `POST /api/v1/admin/search` and `GET /api/v1/admin/audit-logs/:id`.

### 9.3 Frontend Unit & Playwright E2E Tests (`admin-front/tests/e2e/admin/global-search.spec.ts`)

1. **Unit Tests (`admin-front/src/components/search/__tests__/search.spec.ts`):**
   - Verifies `clientSearchRegistry` target resolution for all 20 types, `filterAndNormalizeServerGroups` authority/role/visibility filtering, `recents.ts` 8-item cap and deduplication, `localCommands.ts` English/Arabic matching, and `renderHighlightedText` XSS safety (verifying `<script>alert(1)</script>` in a result title renders as literal text nodes, never HTML).
2. **Playwright E2E Suite (`tests/e2e/admin/global-search.spec.ts`):**
   - Verifies app-bar `.pg-global-search-trigger` (`Search everything…` + `Ctrl K`) and navigation drawer guide trigger (`Search guide…` without `Ctrl K`) operate independently.
   - Verifies pressing `Ctrl+K` opens and focuses the palette combobox input, and `Escape` closes the palette and restores focus to the trigger button.
   - Verifies `250ms` debounced `POST /api/v1/admin/search` call renders grouped results, filter chips (`All`, `Records`, `Pages`, `Guide`), `ArrowDown`/`ArrowUp`/`Home`/`End` active item movement, and `Enter` navigation.
   - Verifies `?open=<id>` deep links open the exact detail drawer once across Approvals, Audit Logs, Disputes, Adjustments, Cash-outs, Reconciliation, AML Cases, Rails, and Routes, and `?tab=transactions&reference=<ref>` on Merchant Detail opens `MerchantTransactionDialog` once.
   - Verifies RTL (`dir="rtl"`), dark mode contrast, mobile compact trigger, and axe-core accessibility compliance.

## 10. Step-by-Step OpenCode Execution Order

Execute the implementation in these exact 8 sequential milestones:

- [ ] **Step 1 — Shared Auth Predicates & Backend Plugin Engine:** Create `core-back/lib/auth/confidentialAccess.ts`, `core-back/lib/search/types.ts`, `core-back/lib/search/engine.ts`, and `core-back/lib/globalSearch.ts` with `SearchProviderRegistry` and all 20 built-in providers.
- [ ] **Step 2 — Core Internal Routes:** Wire `POST /internal/admin/search` and `GET /internal/admin/audit-logs/:id` (after `/audit-logs/export`) in `core-back/api/internal/admin.ts`, and update any inline AML confidential checks in `admin.ts` to use `hasConfidentialAmlAccess(actor)`.
- [ ] **Step 3 — Admin BFF Search & Audit Detail Proxy:** Create `admin-back/api/protected/search.ts` (with 120 req/min token-hashed rate limiter), mount `/search` in `admin-back/api/protected/index.ts`, add `GET /:id` to `admin-back/api/protected/auditLogs.ts`, and add `globalSearch` + `auditLogDetail` to `admin-front/src/constants/urlsMap/index.ts`.
- [ ] **Step 4 — Frontend Plugin Registry & Command Palette:** Create `admin-front/src/components/search/{types.ts,api.ts,recents.ts,targets.ts,localCommands.ts,SearchResultRow.tsx,GlobalSearchPalette.tsx}` and `admin-front/src/styles/command-palette.css`.
- [ ] **Step 5 — App-Bar & Shortcut Wiring in `layouts/default.tsx`:** Replace the app-bar search button (lines 226–233) with `.pg-global-search-trigger`, relabel the drawer guide button to `Search guide…` (removing `Ctrl K`), and point `Ctrl/Cmd+K` (lines 135–141) to `GlobalSearchPalette` while preserving `?` for help.
- [ ] **Step 6 — Universal `useOpenQuery` Composable & Exact-Record Deep Links:** Create `admin-front/src/composables/useOpenQuery.ts` and wire `?open=<id>` across all 13 drawer/dialog pages plus `initialSearch` + `focusReference` on `MerchantResourceTable.tsx` for `?tab=transactions&reference=<ref>`.
- [ ] **Step 7 — Unit, Integration & Security Redaction Tests:** Add `core-back/test/globalSearch.test.ts`, `core-back/test/auditLogDetail.test.ts`, `admin-back/test/search.test.ts`, extend `admin-back/test/admin-surface.test.ts`, and add frontend unit tests in `admin-front/src/components/search/__tests__/search.spec.ts`.
- [ ] **Step 8 — Playwright E2E & Full Quality Gates:** Add `tests/e2e/admin/global-search.spec.ts`, extend `shell.spec.ts` and `a11y.spec.ts`, and run `typecheck`, `test`, `build`, and Playwright verification across `core-back`, `admin-back`, and `admin-front`.

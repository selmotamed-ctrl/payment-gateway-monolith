---
id: core.search
title: Global Search
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - core-back/lib/globalSearch.ts
  - core-back/lib/search/**
  - core-back/api/internal/admin.ts
  - admin-back/api/protected/search.ts
  - admin-back/api/protected/index.ts
  - admin-front/src/components/search/**
  - admin-front/src/composables/useOpenQuery.ts
tests:
  - core-back/test/globalSearch.test.ts
  - tests/unit/global-search.test.ts
  - tests/e2e/admin/global-search.spec.ts
gaps:
  - `supportsTokenKind` is wired into the engine but no built-in provider implements it.
  - Search uses `contains` (ILIKE) filters, not PostgreSQL full-text search or SQL ranking.
  - Several operator-relevant columns are absent from provider WHERE clauses.
  - The admin-back rate limiter is per-process and not shared across nodes.
  - There is no deep-search scale or latency benchmark.
  - The palette sends only query and limit; filter tabs are client-side, not `types` filters.
---

# Global Search

## 1. Purpose and scope

Global search is the admin back-office deep-search feature that finds records across 20 domain groups and links the operator to the canonical page or drawer for the record.

It owns:

- the server-side provider registry in `core-back/lib/globalSearch.ts`;
- the query parser, token classification, match scoring and result sanitization in `core-back/lib/search/engine.ts`;
- the core internal route `POST /internal/admin/search`;
- the mTLS admin BFF proxy `POST /api/v1/admin/search` with its rate limiter;
- the admin-front command palette (`Ctrl+K` / `Cmd+K`), local page/guide search, recent queries and the client-side target registry;
- the `useOpenQuery` deep-link composable that opens a record from a query parameter.

It does not own domain authorization policy (the providers consume authority helpers but `core-back` remains the enforcement point), the underlying record APIs, or the guide content itself.

## 2. Design intent (extracted and synthesized from ./design)

The historical deep-search design defines a federated, plugin-based search:

- the server exposes a fixed set of 20 record groups, each with an explicit authority predicate;
- providers fetch candidates independently and decide whether to appear based on the actor's authorities;
- a shared parser understands free text, UUID/reference, email, phone variants and scoped tokens such as `type:merchant` and `status:ACTIVE`;
- ranking is deterministic: exact field matches rank above prefix matches, which rank above substring matches, with recency as a tie-breaker;
- sensitive fields are never returned in results; audit/AML data is filtered by confidentiality rules;
- the admin BFF rate-limits search per session;
- the frontend registry maps each server group to a route/drawer target and enforces the same route visibility on the client;
- `useOpenQuery` turns a search result into a one-shot deep link (`?open=<id>`) that the destination page opens and then clears.

The design's "20 groups" is implemented. Its stronger claims are not:

- the search is not full-text and does not use PostgreSQL ranking; it is a set of `contains` filters plus in-memory scoring over a small candidate window;
- the token-kind hook is present but unused by every built-in provider;
- the rate limiter is in memory in one admin-back process, not a shared Redis limiter;
- there is no scale, latency or concurrency benchmark for deep search.

## 3. As-built architecture

### 3.1 The 20 provider groups

`core-back/lib/search/types.ts:1-22` declares `V1_SEARCH_TYPES` with exactly 20 types. `core-back/lib/globalSearch.ts` defines one provider per type, registers all 20 in `defaultSearchRegistry` and exports `builtinSearchProviders`.

| Order | Type | Aliases | Access predicate |
| ---: | :--- | :--- | :--- |
| 10 | `merchant` | `merchants`, `mer`, `store` | `merchant:read` |
| 20 | `payment_attempt` | `attempt`, `attempts`, `tx`, `transaction`, `payment` | `attempt:read` and `merchant:read` |
| 30 | `operator_case` | `case`, `cases` | `case:read` or `operator:read` |
| 40 | `gateway_inquiry` | `inquiry`, `inquiries` | `case:read` or `operator:read` |
| 50 | `approval` | `approvals`, `maker_checker` | `approval:read` |
| 60 | `join_request` | `onboarding`, `join`, `kyb` | `kyb:read` or `compliance:read` |
| 70 | `kyb_document` | `doc`, `docs`, `document` | `kyb:read` or `compliance:read` |
| 80 | `dispute` | `disputes`, `chargeback` | `dispute:read` |
| 90 | `adjustment` | `adjustments`, `refund`, `fee_adjustment` | `finance:read` |
| 100 | `cashout` | `cashouts`, `payout`, `withdrawal` | `cashout:read` |
| 110 | `reconciliation_run` | `recon`, `reconciliation`, `statement` | `reconciliation:read` |
| 120 | `aml_case` | `aml` | `hasConfidentialAmlAccess` |
| 130 | `aml_screening` | `screening` | `hasConfidentialAmlAccess` |
| 140 | `aml_rule` | `aml_rules` | `hasConfidentialAmlAccess` |
| 150 | `aml_report` | `str`, `sar`, `regulatory_report` | `hasConfidentialAmlAccess` |
| 160 | `gateway` | `gateways`, `gw` | `gateway:read` |
| 170 | `rail` | `rails` | `gateway:read` |
| 180 | `route` | `routes`, `rail_route` | `gateway:read` |
| 190 | `user` | `users`, `staff`, `admin` | `user:read` or `security:read` |
| 200 | `audit_log` | `audit`, `logs` | `security:read` |

`hasConfidentialAmlAccess` grants access to `COMPLIANCE` and `MLRO` roles, or to an actor with `aml:read` or `aml:write` (`core-back/lib/auth/confidentialAccess.ts:34-49`). `hasMerchantSensitiveAccess` grants tax/registration fields to non-`SUPPORT` actors with `merchant:write`, `compliance:read` or `compliance:write`; the merchant provider adjusts both its WHERE clause and its ranking signals (`globalSearch.ts:143-165`).

### 3.2 Registry and execution

`SearchProviderRegistry` (`globalSearch.ts:72-127`) stores providers by type, preserves aliases/order/access/token hooks, and:

- `getAllOrdered()` sorts by `order` then type;
- `resolveAliasToTypes()` maps a scoped alias to one or more types;
- `unregister()` supports tests and future plugins;
- `registerSearchProvider()` registers against the default registry.

`executeGlobalSearch` (`globalSearch.ts:1679-1814`):

1. Validates the body with a strict Zod schema: trimmed query length 2–120, optional `types` array, limit 1–10 default 5.
2. Rejects unknown requested types with `SEARCH_TYPE_UNSUPPORTED`.
3. Parses the query and applies alias scoping.
4. Filters providers by explicit type filter, `canAccess`, and optional `supportsTokenKind`.
5. Runs all authorized providers concurrently with `Promise.allSettled`, `take = limit * 3`.
6. Ranks each provider's candidates and slices to `limit`.
7. Aggregates non-empty groups, counts returned items and sets `partial = true` when any provider rejects.
8. Logs a warning when elapsed time exceeds 750 ms (`globalSearch.ts:1796-1807`).
9. Returns `{ query, groups, total, tookMs, partial }`.

A provider rejection does not fail the request; it removes that group and marks the response partial.

### 3.3 Parser and token kinds

`parseSearchQuery` (`core-back/lib/search/engine.ts:80-137`):

- trims and caps raw input at 120 characters;
- recognizes `type:`, `is:` and `kind:` aliases for scoped types;
- recognizes `status:` and `merchant:`;
- keeps the remaining tokens as the term;
- builds Libyan phone variants for `+218`, `00218`, leading-zero national numbers and nine-digit local numbers;
- classifies the term as `SHA256_HEX`, `EMAIL`, `PHONE`, `ID_OR_REF` or `FREE_TEXT`.

The classification is reported in `ParsedSearchQuery.tokenKind`, but no built-in provider supplies `supportsTokenKind`, so classification currently does not narrow the provider set. It is used indirectly by phone-variant generation and by the audit/ID filters.

### 3.4 Ranking and sanitization

`computeMatchScore` (`engine.ts:146-197`) scores every candidate from three signal classes:

| Signal class | Exact | Prefix | Substring |
| :--- | ---: | ---: | ---: |
| `exactFields` | 1000 | 750 | 450 |
| `primaryTextFields` | 900 | 650 | 350 |
| `secondaryTextFields` | 250 | 200 | 150 |

An unmatched candidate still gets 100, so a provider can return a record whose searchable fields are related to the row (for example a nested merchant) even when the direct term does not match. `rankAndSliceCandidates` (`engine.ts:333-389`) deduplicates by result id, sorts by score descending, then timestamp descending, then id ascending, and slices to the limit. It also reports `truncated` when more than the limit survived.

`sanitizeResultItem` (`engine.ts:254-300`) keeps only `id`, `title`, `subtitle`, `reference`, `status`, `merchantId`, `operatorCaseId` and scalar `meta` values. It drops any key matching a forbidden name or fragment:

- ciphertext, secret, password, payout, bank, match list, `beforeJson`, `afterJson`, `rawPayload`, tax id, tax number, registration number, commercial registry.

This is a defensive allow-list plus deny-list; it does not redact text inside allowed fields.

### 3.5 Provider query pattern

Every provider uses Prisma `findMany` with a status scoping helper and an `OR` array of `contains` filters, `mode: "insensitive"`, plus exact UUID filters from `idSearchFilter`. Nested relations are searched through `is` filters. Each provider selects a narrow projection, orders by its domain timestamp, and takes `limit * 3` rows.

Examples:

- `merchant` searches id, legal/trade/display name, contact email/phone and (conditionally) tax/registration, plus phone variants.
- `payment_attempt` searches id, reference, provider/gateway/network reference, idempotency key and nested merchant trade/legal name.
- `operator_case` and `gateway_inquiry` search attempt references and nested merchant names.
- `join_request`, `kyb_document`, `dispute`, `adjustment` and `cashout` search the relevant references and nested merchant names.
- `reconciliation_run` searches run references and file names.
- `approval` searches subject type/id and related references.
- `gateway`, `rail` and `route` search codes/names/operator, with nested rail/gateway names for routes.
- `user` searches id, email, phone and phone variants.
- `audit_log` uses `AuditStorePort.queryAuditLogs` when a dedicated audit store is configured, otherwise the compatibility `audit_log` table.

### 3.6 Core route and BFF

Core route: `POST /internal/admin/search` (`core-back/api/internal/admin.ts:682-709`). It reads the `x-pg-min-lsn` header, runs through `readThroughReplicaOrPrimary`, passes the actor derived from the internal principal, and sets `Cache-Control: no-store`.

Admin BFF: `admin-back/api/protected/search.ts`:

- strict Zod schema mirrors core (query 2–120, `types` max 30, limit 1–10);
- `noStore` middleware;
- per-process rate limiter with a 60,000 ms window and 120 requests per key;
- key is a SHA-256 of the bearer token (or IP, or `anonymous`) truncated to 32 hex characters;
- expired buckets are swept when the map exceeds 2,000 entries;
- `429 SEARCH_RATE_LIMITED` with `Retry-After`;
- forwards to `/internal/admin/search` with the validated body.

Mounted at `/search` under the protected admin router (`admin-back/api/protected/index.ts:44`), so the public portal path is `/api/v1/admin/search`.

### 3.7 Admin palette and local commands

`admin-front/src/components/search/GlobalSearchPalette.tsx` implements:

- a `VDialog` palette opened by the app bar trigger and the global `Ctrl+K`/`Cmd+K` shortcut;
- a 250 ms debounce before the server call;
- a minimum of two characters for record search, while page and guide search can run on shorter input;
- cancellation of the previous request through `AbortController` and a sequence guard;
- a 60-second in-memory session cache for non-partial responses (`api.ts:14-18`, `api.ts:53-90`);
- an 8-entry recent-query store in `localStorage` (`recents.ts:2`, `recents.ts:34-55`);
- tabs for All, Records, Pages and Guide;
- local page search over navigation items and local guide search via `searchGuideFn`;
- partial/error banners and keyboard navigation;
- result rendering through `SearchResultRow` with safe highlighting.

`localCommands.ts` searches the navigation catalogue and guide entries. It does not query the server.

### 3.8 Client target registry and access checks

`admin-front/src/components/search/targets.ts` registers 20 target plugins, one per server type, with icon, bilingual group/kind labels, a primary route name, optional additional route names and a `resolveTarget` function. Target shapes include:

- route-param targets such as `MerchantDetail`, `OperatorCaseDetail`, `JoinRequestDetail`, `KybReviewDetail`, `GatewayWizard` and `AdminUserDetail`;
- drawer targets with `?open=<id>` for approvals, disputes, adjustments, cashouts, reconciliations, AML cases/screenings/rules/reports, rails, routes and audit logs;
- a search-prefill fallback for gateway inquiries when no operator case is linked.

`filterAndNormalizeServerGroups` (`targets.ts:387-435`) drops any group without a registered plugin, drops groups whose primary/additional route is not visible to the user, resolves each item to a target, validates the target and re-checks the target route. Route visibility checks authorities, roles and the visible route-name set (with parent lineage). This is advisory UI filtering; core remains the authority.

### 3.9 `useOpenQuery`

`admin-front/src/composables/useOpenQuery.ts`:

- watches a query parameter (default `open`);
- normalizes string or array values;
- uses loaded rows first unless `alwaysFetchDetail` is set;
- otherwise calls the page's `fetchById`;
- invokes `onOpenRecord` once per id and guards against reactive re-opens;
- calls `onNotFound` on null or failure;
- exposes `clearOpenQueryParam()` and `isResolvingOpenQuery`.

It is used by approvals, AML cases/screenings/rules/reports, disputes, adjustments, cashouts, reconciliation, rails, routes and audit logs. The one-shot guard means a page must clear or change the query parameter to re-open the same record.

## 4. Contracts and invariants

- Request body is strict: no unknown keys. Query is trimmed, 2–120 characters. Limit is 1–10 and defaults to 5. BFF `types` is capped at 30 entries.
- A response group only contains authorized providers. `partial = true` when at least one authorized provider fails.
- Unknown requested types are rejected in core before any provider runs.
- Scoped type aliases narrow the requested set only when at least one alias resolves; an unknown alias does not silently disable all search.
- Result items never include ciphertext, secrets, payout/bank details, AML match-list data, audit before/after JSON, raw payloads or tax/registration fields. The sanitizer is the last line of defence; providers should not select forbidden fields in the first place.
- `id`, `title` and all returned scalar fields are coerced to strings; empty optional fields are omitted.
- The frontend must not render a result whose target route is not visible to the user.
- `useOpenQuery` opens a record once per id per mount; destinations must fetch the record when it is not in the loaded page.
- BFF search responses are non-cacheable (`no-store`). The client cache is memory-only and only stores non-partial responses.
- The BFF limiter is advisory abuse control, not an authority boundary. Core applies its own authentication and provider predicates.
- Search reads may be served by a replica. The `x-pg-min-lsn` header provides read-after-write consistency when the admin BFF forwards it; the palette does not currently set it.

## 5. Data / API / config / deployment surface

### APIs

| Layer | Method and path | Notes |
| :--- | :--- | :--- |
| Core | `POST /internal/admin/search` | mTLS internal route, replica-aware, no-store |
| Admin BFF | `POST /api/v1/admin/search` | mTLS to core, 120 req/min per key, no-store |
| Admin front | `v1/admin/search` | via the shared API client |

Request:

```json
{ "query": "PG-12345", "types": ["payment_attempt"], "limit": 5 }
```

Response:

```json
{
  "query": "PG-12345",
  "groups": [{ "type": "payment_attempt", "items": [], "truncated": false }],
  "total": 0,
  "tookMs": 4,
  "partial": false
}
```

### Data dependencies

- Core OLTP tables: merchants, attempts, links, operator cases, gateway inquiry schedules, approvals, join requests, KYB documents, disputes, adjustments, cashouts, reconciliation runs, AML cases/screenings/rules/reports, gateways, rails, routes, users.
- Dedicated audit database: `audit_records` through `AuditStorePort` when `AUDIT_DATABASE_URL` is configured.
- Fallback audit table: `audit_log` in the core database.
- Trigram indexes from the storage and hardening migrations support the `contains` filters, but they are ordinary GIN trigram indexes, not full-text indexes.

### Configuration

| Key | Purpose |
| :--- | :--- |
| `AUDIT_DATABASE_URL` | Enables the dedicated audit provider path |
| `DATABASE_REPLICA_URLS` | Allows search reads on replicas |
| `READ_REPLICA_MAX_LAG_MS` | Replica lag ceiling for search |
| `BACKUP_DAEMON_*` | Unrelated to search; listed here only because the BFF and core share the storage configuration surface |

### Frontend routes and components

- `admin-front/src/components/search/GlobalSearchPalette.tsx`
- `admin-front/src/components/search/targets.ts`
- `admin-front/src/components/search/api.ts`
- `admin-front/src/components/search/localCommands.ts`
- `admin-front/src/components/search/recents.ts`
- `admin-front/src/components/search/SearchResultRow.tsx`
- `admin-front/src/composables/useOpenQuery.ts`
- `admin-front/src/layouts/default.tsx` (palette wiring and shortcut)

## 6. Operational usage

- Use `Ctrl+K`/`Cmd+K` in the admin portal to open the record palette. `?` opens the shortcut help.
- Type at least two characters for record search. Page and guide results can appear earlier.
- Use the filter tabs to switch between all results, records, pages and guide entries. Tabs are applied client-side over the returned groups.
- Use `type:merchant`, `status:ACTIVE` or `merchant:<uuid>` tokens inside the query to scope server-side. The type/status aliases are server-side; the UI does not expose a separate type picker.
- Results open the canonical detail page or a drawer with the record id. The destination page uses `useOpenQuery` to load the record if it is not in the current page data.
- If a group is missing from the response, check the actor's authorities and the core log for a provider failure. A `partial: true` response means another group may still be usable.
- If search returns 429, wait for `Retry-After`. The limiter is per admin-back process; a multi-node deployment can produce inconsistent limits until a shared limiter is introduced.
- Search reads can hit a replica. If a just-written record is missing, retry from a route that sends the `x-pg-min-lsn` watermark or read the canonical detail endpoint on the primary.

## 7. Status and deviations

### Implemented

- The 20-group server registry with aliases, order and authority predicates.
- Strict request validation, scoped type/status/merchant tokens and Libyan phone variants.
- Deterministic in-memory ranking with exact/prefix/substring weights and recency tie-break.
- Sensitive-field sanitization and per-provider narrow projections.
- Concurrent provider execution with partial-result semantics.
- Replica-aware core search route and `x-pg-min-lsn` support.
- Admin BFF proxy with per-process hashed-key rate limiting and no-store headers.
- Frontend palette with debounce, abort, sequence guard, session cache, recents, local pages/guides, keyboard navigation, RTL support and partial/error states.
- Client target registry for all 20 types and route/drawer deep links.
- `useOpenQuery` one-shot deep links across the wired pages.
- Unit and E2E coverage for parser/ranking/sanitization, client registry, recents, palette behavior and deep links.

### Partial

- Token-kind routing: `supportsTokenKind` exists and is invoked, but every built-in provider omits it. The feature is effectively dormant.
- Ranking: scoring happens in Node over at most `limit * 3` rows per provider, not in PostgreSQL. A broad query can truncate candidates before the best match is seen.
- Missing fields: several schema columns are not in any provider WHERE clause. Examples: merchant `supportEmail`, `supportPhone`, `businessCategory` and `country`; payment attempt link key and attempt-group fingerprint; audit `requestId` and `clientIp`; KYB `docType` (used for scoring, not filtering) and `storageKey`.
- Audit search: the dedicated audit adapter searches action, entity type, entity id and actor email through `ILIKE`; it does not search request id, client IP or before/after JSON, and it has no relevance ranking.
- Frontend types filter: the palette sends only `query` and `limit`. The All/Records/Pages/Guide tabs do not send a `types` array, so server work is not narrowed by tab.
- Rate limiting: in-memory per process, not shared across admin-back nodes; bucket sweeping is approximate and the key falls back to IP for unauthenticated requests.

### Missing / deferred

- PostgreSQL full-text search (`tsvector`, `websearch_to_tsquery`, `ts_rank`) and SQL-side ranking.
- Cursor pagination or "show all" for a group. Each group is capped at 10 and the palette displays at most that slice.
- Typo tolerance/fuzzy matching beyond trigram-backed substring filters, prefix expansion or synonyms.
- Cross-group deduplication (the same attempt can appear under multiple groups).
- A shared/distributed rate limiter.
- A deep-search scale benchmark with realistic record counts, broad queries, 20 concurrent providers and p95 latency.
- Search analytics (zero-result queries, slow providers) beyond the 750 ms warning log.
- Saved searches or per-user search history on the server.
- Server-side `types` filtering from the UI tabs.

### Known bugs / risks

- `supportsTokenKind` is dead configuration from the product's point of view. A future provider can use it, but no current provider narrows on token kind, so a SHA256 query still fans out to all authorized providers. Code gap.
- Candidate truncation: `take = limit * 3` before ranking means a provider with many substring matches can return three mediocre rows and miss the exact match. Code risk.
- `computeMatchScore` returns 100 for a row with no matching signals; if a provider's fetch filter is broader than its signals (nested relation matches), unrelated-looking rows can survive. Code risk.
- Merchant tax/registration fields are searchable only for sensitive-access actors, but the fields are also included in the provider's selected projection only for those actors. A non-sensitive actor searching a tax id gets no match rather than a redacted result. Product decision, not a bug.
- The audit fallback path does not search `requestId` or `clientIp`; dedicated audit search also omits them. Operators must use the audit list endpoint for those fields. Feature gap.
- The BFF rate limiter keys on the full authorization header hash, so token rotation creates a new bucket. It also uses `request.ip`, which is proxy-dependent. Operational risk.
- The BFF `types` schema allows up to 30 entries while the server registry has 20. Unknown types are rejected by core, so a stale client list can fail the whole request rather than ignore the unknown entry. Code risk.
- The palette client cache does not include the actor/authority set in its key. After a role change in the same tab session, a cached group can remain visible until the 60-second TTL expires; the target-route filter still applies. Code risk.
- `filterAndNormalizeServerGroups` silently drops a group if the client target registry lacks its type, so a server/client version skew hides results without an error. Code risk.
- `useOpenQuery` marks an id handled before the fetch completes. If the fetch fails transiently, the same id will not retry until the query parameter changes or the component remounts. Code risk.
- The `route` target uses `?open=<routeId>` but the routes page must implement the drawer lookup; the target registry alone does not guarantee the page supports it. Test coverage is the guard.
- No test asserts multi-node rate-limit behavior or shared-cache behavior, because neither exists.

## 8. Verification and tests

Relevant test files:

- `core-back/test/globalSearch.test.ts` — parser/token/phone variants, match scoring, sanitization, registry, authority matrix, provider behavior.
- `tests/unit/global-search.test.ts` — client target registry, local commands, recent-query storage, highlighting, access filtering.
- `tests/e2e/admin/global-search.spec.ts` — app-bar trigger vs drawer guide search, `Ctrl+K`, debounce, Enter-to-open, one-character behavior, mocked API.
- `tests/e2e/exhaustive/exhaustive-admin-surface.spec.ts` — broader admin surface coverage that includes search interactions.

Commands:

```bash
cd core-back && bun test test/globalSearch.test.ts
cd tests && bun run test:unit
cd tests && bunx playwright test -c playwright.config.ts -g "global search"
```

The core test is a unit/authority suite and does not require PostgreSQL. The Playwright suite uses mocked API responses and does not need a live core or a populated database. There is no live-stack deep-search scale test and no benchmark. No test run was performed for this documentation change.

## 9. Source references

### Old design sections

- `design/performance-efficiency/deep_search_plugin_architecture_plan.md#1-executive-summary--why-a-declarative-plugin-architecture-is-required`
- `design/performance-efficiency/deep_search_plugin_architecture_plan.md#2-product-behavior--ux-contract`
- `design/performance-efficiency/deep_search_plugin_architecture_plan.md#3-api-contract--shared-security-predicates`
- `design/performance-efficiency/deep_search_plugin_architecture_plan.md#4-server-side-plugin-architecture-core-back`
- `design/performance-efficiency/deep_search_plugin_architecture_plan.md#5-admin-bff-layer-admin-back`
- `design/performance-efficiency/deep_search_plugin_architecture_plan.md#6-frontend-plugin-registry--global-command-palette-admin-front`
- `design/performance-efficiency/deep_search_plugin_architecture_plan.md#7-universal-one-shot-deep-link-composable-useopenquery--page-wiring`
- `design/performance-efficiency/deep_search_plugin_architecture_plan.md#9-comprehensive-automated-verification--test-plan`
- `design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md#3-2-outbox-driven-read-models--uncompromised-20-group-deep-search-on-replicas`

### Code paths

- `core-back/lib/search/types.ts`
- `core-back/lib/search/engine.ts`
- `core-back/lib/search/uuidSearch.ts`
- `core-back/lib/globalSearch.ts`
- `core-back/lib/auth/confidentialAccess.ts`
- `core-back/api/internal/admin.ts`
- `core-back/lib/storageEngine/index.ts`
- `core-back/lib/storageEngine/readStoreAdapter.ts`
- `admin-back/api/protected/search.ts`
- `admin-back/api/protected/index.ts`
- `admin-front/src/components/search/api.ts`
- `admin-front/src/components/search/targets.ts`
- `admin-front/src/components/search/localCommands.ts`
- `admin-front/src/components/search/recents.ts`
- `admin-front/src/components/search/GlobalSearchPalette.tsx`
- `admin-front/src/components/search/SearchResultRow.tsx`
- `admin-front/src/composables/useOpenQuery.ts`
- `admin-front/src/layouts/default.tsx`
- `core-back/prisma/migrations/20261103120000_postgres18_storage_engine/migration.sql`
- `core-back/prisma/migrations/20261103180000_storage_hardening/migration.sql`

### Generated appendices

- `project-design/appendices/api-route-matrix.md` — search routes across core, BFF and portal
- `project-design/appendices/schema-catalog.md` — indexed search columns and schema fields
- `project-design/appendices/test-inventory.md` — global-search test files and skip conditions

## 10. Change history

- 2026-11-03 — Initial canonical extraction. Records the 20 providers, registry, parser, ranking weights, authority predicates, BFF limiter, palette/targets/`useOpenQuery`, and the actual gaps: dormant `supportsTokenKind`, missing fields, no full-text search, per-process limiter and no deep-search scale benchmark. See `project-design/TRACKER.md`.

---
id: future.voucher
title: Voucher Provider Management System (Future)
status: missing
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
design_sources:
  - design/Voucher-Provider-Management-System-Technical-Design.md
  - design/voucher-system-raw-design.md
  - design/smart_ai_rail_and_voucher_onboarding_plan.md
tests:
gaps:
  - No voucher system code, schema, API, UI or tests exist in this repository.
  - The design is for a separate service and is not wired into core-back or any edge BFF.
  - The Smart AI importer has only a gateway half; the voucher half is absent.
  - Multi-instance invalidation, rate limiting and reconciliation are design-only.
---

# Voucher Provider Management System (Future)

## 1. Purpose and scope

This part preserves the complete design for a separate Voucher Provider Management System. It is **not current behaviour**. There is no voucher service, no Prisma schema, no route, no frontend page and no test in this repository.

The system would let an administrator plug in multiple voucher providers without per-provider code: configure authentication, purchase query stacks and voucher extraction, build a catalog tree, attach providers and product lists, issue bearer tokens to client applications, and let clients browse and buy vouchers with best-price routing and safe fallback.

This part is the canonical future design. If the feature is implemented, move it out of `09-future-and-unimplemented/` and update `project-design/TRACKER.md`.

## 2. Design intent (future, not current)

### 2.1 Goals and non-goals

Goals:

- Data-driven provider integration: auth, product listing, purchase and extraction are configuration, not code.
- Best-price routing with admin-controlled priority ties.
- Safe money handling: no double purchase, no lost voucher, full audit trail.
- A simple back-office for providers, catalog, assets, services and tokens.

Non-goals:

- Wallets, balances or accounting. Client systems keep their own accounts; this system keeps records, audits and logs.
- Markup or margin. Client systems add those.
- Currencies other than LYD.
- Multi-instance deployment in the first version (designed for, not built).
- A scripting language inside provider configuration.

### 2.2 Actors

- **Administrator:** configures everything through the back office.
- **API client:** an external system using a permanent bearer token to read the catalog and purchase vouchers.
- **Provider:** a third-party voucher supplier with its own HTTP API.
- **Operator:** reads transactions, logs and statistics.

### 2.3 Architecture

- Admin API and UI: CRUD for providers, listings, assets, services, tokens and users; read-only views for transactions, logs and stats.
- Public Voucher API: bearer-token-protected catalog and purchase endpoints.
- Provider Gateway: a registry of `ApiConsumer` instances, one per provider, handling auth, token refresh and request execution.
- Query Engine: runs a provider's purchase query stack and extracts the voucher.
- Catalog Resolver: builds the aggregated, ranked product listing for a service and caches it for a short TTL.
- Asset, Token and Audit services.
- PostgreSQL 18 using `@prisma/adapter-pg` and `pg`, with native UUID, JSONB and BYTEA where applicable.
- Money as `NUMERIC(18,4)`, never floating point.
- A single instance initially. In-memory caches sit behind an `InvalidationBus` interface: in-process emitter first, Redis pub/sub later, without changing callers.

Configuration keys:

- `API_LISTING_CONCURRENCY`: pool size for API-listed products, default 15, typical 15-20.
- `CATALOG_CACHE_TTL_SECONDS`: default 60.
- `CURRENCY=LYD`.

Purchases do not use a pool; each purchase runs its own requests.

## 3. As-built architecture

There is none. The repository contains no `voucher` workspace, no provider tables, no voucher routes and no voucher UI. The only related current code is the gateway half of the Smart AI spec importer, which is a reusable pattern, not a voucher implementation.

## 4. Contracts and invariants (future)

### 4.1 Data model

All tables have `id`, `created_at` and `updated_at`. All money is LYD, so there are no currency columns. Secret columns are encrypted at rest with AES-256-GCM using a key from the environment or KMS.

Providers:

- `Provider`: unique `name`, `blocked`, `auth_method` (`NONE`, `PERMANENT_TOKEN`, `REFRESH_TOKEN`, `USERNAME_PASSWORD`, `BASIC_AUTH`), `auth_config` JSON validated per method with encrypted secrets, and `auth_apply` JSON describing how credentials attach (default header `Authorization: Bearer <token>`).
- `ProviderMeta`: `provider_id`, `key`, `type` (`string|number|boolean|json`), `value`. Free parameters used by queries and auth, such as a merchant id.
- `ProviderQuery`: `provider_id`, unique `order_index`, `method`, full `url`, `content_type`, optional `success_check`, `timeout_ms`.
- `ProviderQueryParameter`: `query_id`, `place` (`HEADERS|QUERY|BODY`), `type`, `key` (recursive-set path), optional `selector`, `constant_value`.
- `ProviderExtraction`: one per provider with optional `secret_selector`, `id_selector`, `serial_number_selector`.
- `ProviderExtractionMeta`: `key`, `selector`.

A provider with no queries is never used for purchases.

Catalog:

- `Asset`: `name`, `mime` (`png|svg`), `size_bytes`, `storage_key`, `sha256`.
- `Listing`: optional `parent_id`, `kind` (`SUB_CATEGORY|SERVICE`), `name_ar`, `name_en`, optional `asset_id`, `priority_index`, `service_id` when kind is `SERVICE`. A service may appear under several listings.
- `Service`: `name`, `type` (`SECRET|BILL`), `blocked`, `form_enabled`.
- `ServiceMeta`: `key`, `type`, `value`.
- `ServiceFormField`: `key`, `type` (`date|date-time|time|number|string|from-list`), bilingual labels, `required`, `order_index`, `options` for from-list (`{value,label_en,label_ar}`), optional `rules`.
- `ServiceProvider`: `service_id`, `provider_id`, `priority_index`, `listing_source` (`FIXED|API`), unique on `(service_id, provider_id)`.
- `FixedProduct`: `service_provider_id`, `amount`, `price` (provider price), `face_value`, plus `FixedProductMeta`.
- `ApiListingConfig`: `method`, `url`, `list_selector`, `amount_selector`, ordered `face_value_selectors` joined by spaces, `price_selector`.
- `ApiListingMetaSelector`: `key`, `selector`, copied into product meta so it can be passed to purchase.
- `ApiListingParameter`: `place`, `key`, `type` (`PROVIDER_META|AUTH_TOKEN|CONSTANT`), `selector`. `AUTH_TOKEN` fails validation when the auth method has no token.

Access and operations:

- `AccessToken`: `name`, `token_hash`, `last_four`, `ip_whitelist_enabled`, `revoked_at`, `last_used_at`. Plaintext is never stored.
- `AccessTokenIp`: `token_id`, `cidr`.
- `VoucherTransaction`: unique `reference`, `idempotency_key` unique per token, `token_id`, `client_ip`, `service_id`, `service_provider_id`, final `provider_id`, `amount`, `price`, optional `expected_price`, `face_value`, `form_data`, `status` (`PENDING|SUCCEEDED|FAILED|UNKNOWN`), `error_code`, `result_ciphertext`, `result_meta`, `started_at`, `finished_at`.
- `TransactionAttempt`: one row per provider tried and per query executed: transaction id, provider id, query order, redacted request, redacted response, HTTP status, duration, outcome.
- `AuditLog`: admin action, who, before/after, IP.
- `User`: admin user with role.

Referential rules:

- Provider delete only when no `ServiceProvider` rows exist.
- Service delete only when no `ServiceProvider` rows exist; its listings are removed in the same transaction.
- Asset delete only when no listing references it.
- Listing delete for a service listing (service remains) or an empty sub-category.
- Transactions are never hard-deleted; they snapshot names and prices so history survives edits.

### 4.2 Provider authentication

- `NONE`: no credentials.
- `PERMANENT_TOKEN`: a token string.
- `REFRESH_TOKEN`: refresh URL, method, token, period, access-token selector and refresh parameters (`{type,key,selector,place}` with types `META`, `REFRESH_TOKEN`, `CONSTANT`).
- `USERNAME_PASSWORD`: same refresh flow built from `USERNAME` and `PASSWORD` parameters.
- `BASIC_AUTH`: username/password, `Authorization: Basic base64(user:pass)`.

Common settings: `auth_apply` (header name, scheme prefix or query/body key), `refresh_period_ms` (default 30 minutes), `refresh_on_error_statuses` (default 401, 403).

The runtime registry must fix the historical sample's defects:

- `recursiveSet` must not reset sibling containers and must not mutate the setter array.
- Cache lookup must precede the database await and store the creation promise to avoid duplicate consumers and timers.
- Concurrent 401s must share one single-flight refresh.
- Use chained `setTimeout` with jitter instead of overlapping `setInterval` async work.
- Every request needs an `AbortController` timeout (default 10 s for auth/listing).
- Retry on auth error only when the request could not have been processed.
- Support `content_type` per query, not always JSON.
- Make the auth header configurable and default `isAuthError` to 401/403.
- Persist a rotated refresh token.
- Implement `USERNAME_PASSWORD` and `BASIC_AUTH`.
- Read text first, parse JSON only when appropriate, and keep raw text in the redacted log.
- Never log auth headers, passwords or tokens.

### 4.3 Purchase query stack

Queries run in ascending `order_index`. Each parameter writes into headers, query or body at a dot path, with numeric segments creating arrays.

Parameter types:

- `PROVIDER_META`: selector over provider meta.
- `REQUEST_META`: selector over product meta.
- `AMOUNT`, `PRICE`, `FACE_VALUE`: values of the chosen product.
- `PREVIOUS_REQUEST_DATA`: selector over the previous response; invalid on the first query and rejected at save time.
- `SERVICE_ADDITIONAL_DATA`: selector over submitted `form_data`.
- Recommended additions: `CONSTANT` and `TRANSACTION_REFERENCE`.

Execution:

```text
ctx = { providerMeta, productMeta, amount, price, faceValue, formData, reference }
prev = null
for query in stack ordered by order_index:
    request = build(query, ctx, prev)
    response = consumer.request(request)
    assert success(query, response)
    log attempt (redacted)
    prev = response.data
voucher = extract(prev, providerExtraction)
```

Query strings use array indices by default. The final response is the extraction source unless `source_query_order` points to an earlier response.

Success detection: each query has an optional HTTP status set (default 2xx) and an optional `{selector, equals|exists|not_equals}` body check. A missing required selector is a failure.

Extraction: `secret_selector` is required for SECRET services. An extraction failure after a successful provider call is the worst case: the voucher was bought but not read. Keep the raw redacted response, mark the transaction `UNKNOWN` and alert.

Save-time validation rejects: first-query `PREVIOUS_REQUEST_DATA`, duplicate `order_index`, non-absolute URLs, invalid selectors and unknown parameter types. A dry-run builds requests without sending them.

### 4.4 Listings, assets, tokens and services

Listings:

- Root or sub-category parent; sub-category or service listing.
- Bilingual names required; image optional; `priority_index` sorts siblings ascending, ties by id.
- A service may appear under several listings with different names/images/priority.
- The admin sees one level at a time and can add inline.
- Cycles are prevented by choosing parents only at creation and verifying moves are not into a descendant. Suggested maximum depth is 6.
- Public visibility: a service listing is visible when the service is not blocked and has at least one unblocked provider with a non-empty query stack and non-empty product list. A sub-category is visible when it has a visible descendant. Admins see hidden items with a status badge.

Assets:

- PNG or SVG with a unique name.
- List, add, view with zoom/metadata, replace content, delete when unreferenced.
- Upload via multipart with client and server validation of extension, declared MIME, magic bytes, size (suggested 1 MB PNG, 200 KB SVG) and PNG dimensions.
- SVG is active content: sanitise on upload (strip script, event handlers, external references and `foreignObject`) and serve with `image/svg+xml`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` and `X-Content-Type-Options: nosniff`.
- Store under a content-derived key; replacing content writes a new object and swaps the pointer (`?v=sha256`).

Access tokens:

- List, create, revoke; tokens are shown once.
- Format `vp_` + 32 random bytes base64url.
- Store only SHA-256 and last four characters.
- IP whitelist supports IPv4/IPv6 single addresses and CIDR. Trust `X-Forwarded-For` only from a configured proxy.
- Tokens grant catalog/purchase access only, never admin routes.
- Update `last_used_at` with debounce.
- Optional later: scopes, rate limits and service allowlists.

Services:

- List, add (`name`, `type`), update, delete when unlinked; detail view with recent transactions, form setup, meta, block/unblock and provider links.
- Form fields: key, type, bilingual labels, required, order. `from-list` options are `{value,label_en,label_ar}`. Rules are an ordered descriptor list compiled into a Zod schema from a whitelist; never evaluate admin code. Optional in v1.
- Form schema cached per service and invalidated on change; the same descriptor is returned to clients.
- Provider links: choose unlinked providers, set `priority_index` (higher wins ties). Product list is either FIXED products with meta or an API listing config with list/amount/face-value/price selectors, meta selectors and parameters. A link with an empty product list is never selected. Switching source requires confirmation. Provide a Test Fetch button.

### 4.5 Catalog resolution and purchase

Catalog resolution for a service:

1. Blocked service -> `404 SERVICE_UNAVAILABLE` (same as not found).
2. Load unblocked providers with non-empty query stacks; none -> `404 SERVICE_HAS_NO_PROVIDERS`.
3. FIXED products come directly from the query.
4. API products are fetched in a bounded concurrency pool (`API_LISTING_CONCURRENCY`, default 15) with per-provider timeouts. A failing provider is skipped and logged.
5. Map keyed by `amount` plus `face_value` to `{amount, candidates[]}`. Each candidate has provider id, service-provider id, priority, price, face value and meta.
6. Rank candidates by price ascending, then priority descending.
7. Drop empty entries; sort by amount ascending.
8. Cache for 60 s, invalidated on provider block, service change or product edit. Purchases read the cache.

The public response exposes only `product_key` (opaque), `amount`, `face_value` and the best `price`. Provider ids, meta and priorities are never exposed.

Purchase request:

```http
POST /v1/purchases
Idempotency-Key: <client key>
{
  "service_id": "...",
  "product_key": "...",
  "expected_price": "10.0000",
  "form_data": { "...": "..." }
}
```

Validation:

1. Token valid, not revoked, IP allowed.
2. Service not blocked; `form_data` valid.
3. Candidates loaded; provider/service blocked flags re-checked against the database.
4. If `expected_price` is supplied and differs from the best candidate, `409 PRICE_CHANGED` with the current price. If omitted, no price check.
5. Idempotency: existing key returns the stored result or `409 IN_PROGRESS`.

Execution:

1. Insert the transaction as `PENDING` before any provider call.
2. Take the best candidate, load the query stack and run it, logging every query.
3. On success, extract, encrypt the secret, mark `SUCCEEDED`, return.
4. On failure, apply the fallback rule.

Fallback is allowed only when the failure is definitive and happened before the provider could act: first query, connection failure before send, 4xx or explicit error body, or auth failure after the refresh retry. If `expected_price` was supplied, a fallback candidate must also match it.

Ambiguous or partial failures always become `UNKNOWN`, never a fallback: timeout or reset after send, 5xx, failure on a later query, or extraction failure. Mark `UNKNOWN`, return 202/502 with the reference and alert. Manual reconciliation is the only exit.

All eligible candidates definitively failed -> `FAILED` and `503 NO_PROVIDER_AVAILABLE`.

Never automatically retry a purchase that may have been accepted.

Duplicate protection: the client `Idempotency-Key` and our `reference` stop duplicates at our side. The reference can be sent to the provider through `TRANSACTION_REFERENCE`; provider-side idempotency and order-status endpoints are optional per provider.

Logging stores reference, token id, client IP, user agent, service, provider, amounts, form data, per-query redacted request/response, durations, status and error. Voucher secrets are stored only encrypted and masked in admin screens; reveal is audited.

Response:

```json
{
  "reference": "...",
  "status": "SUCCEEDED",
  "service_id": "...",
  "amount": "10.0000",
  "face_value": "10",
  "price": "9.5000",
  "voucher": { "secret": "...", "id": "...", "serial_number": "...", "meta": {} },
  "created_at": "..."
}
```

Provider identity is not returned to clients.

### 4.6 API surface

Public, bearer-token auth:

- `GET /v1/catalog`: visible root items.
- `GET /v1/catalog/{listingId}`: children of a sub-category.
- `GET /v1/services/{serviceId}/products`: ranked products, service details and form.
- `POST /v1/purchases`.
- `GET /v1/purchases/{reference}`.
- `GET /v1/purchases?from&to&status&page`: transactions of the calling token only.

Error envelope `{code, message, reference?}` with codes `UNAUTHORIZED`, `IP_NOT_ALLOWED`, `SERVICE_UNAVAILABLE`, `SERVICE_HAS_NO_PROVIDERS`, `VALIDATION_FAILED`, `PRICE_CHANGED`, `NO_PROVIDER_AVAILABLE`, `IN_PROGRESS`, `PURCHASE_UNKNOWN`.

Admin API:

- Providers: list/create/get/update/delete; block/unblock; meta; queries CRUD and reorder; query parameters; extraction; dry-run.
- Listings: list by parent, create/update/delete, reorder.
- Assets: list/create/get/delete, replace file.
- Tokens: list/create/delete, IP list add/delete, whitelist toggle.
- Services: list/create/get/update/delete, block/unblock, form, meta, transactions, provider links, fixed products, API listing config and test fetch.
- Operations: transactions list/detail with attempts, logs, stats, users, audit.

### 4.7 Security and observability

Roles: `SUPER_ADMIN`, `CATALOG_ADMIN` (listings/assets/services), `PROVIDER_ADMIN` (providers/tokens), `OPERATOR` (read-only transactions/logs). Revealing a voucher secret requires explicit permission and is audited.

- Secrets encrypted at rest with a key id stored with each ciphertext.
- Client tokens stored only as hashes.
- SSRF: provider URLs are admin-entered; enforce HTTPS, optionally allowlist hosts, resolve DNS and block private/loopback/link-local ranges, disable redirects or revalidate each hop, cap response size.
- Rate limit per token and IP; stricter on purchases.
- Zod validation on every route; safe selector path grammar; reject `__proto__`, `constructor` and `prototype`.
- Audit all admin mutations with before/after snapshots and masked secrets.
- Redact secrets from stored requests/responses.
- Structured logs with the transaction reference as correlation id.
- Metrics per provider: success rate, latency percentiles, refresh failures, fallback count, UNKNOWN count.
- Alerts: UNKNOWN transaction, extraction failure, repeated refresh failure, provider error spike.
- Stats: volume by service/provider, success rates, top tokens.
- Later: auto-block a provider after N consecutive definitive failures.
- Backups include encrypted columns and a key-management plan.

### 4.8 Delivery plan

The design proposes four phases:

1. **Foundations.** Admin auth and roles, assets, listings, services and forms, access tokens.
2. **Providers.** Five auth methods, `ApiConsumer` registry, purchase query stack, extraction, save-time validation and dry-run.
3. **Catalog and purchase.** Catalog resolution with the bounded API-listing pool and cache, purchase idempotency, fallback rules, UNKNOWN handling and redacted logging.
4. **Operations.** Transactions, logs, stats, alerts; then Redis invalidation when moving to multiple instances.

Confirmed decisions from the design:

- `price` is the provider's price; margin and customer-facing prices belong to client systems.
- Routing is server-side over the cached ranked list.
- Reference-based duplicate protection is required; provider-side idempotency and status endpoints are optional.
- Access tokens are shown once only.
- `expected_price` is optional and yields `409 PRICE_CHANGED` on mismatch.
- A service can appear under several listings.
- All amounts are LYD; no accounting is kept.
- API-listed products use a configurable pool; purchases do not.

Acceptance for the whole programme: all four phases delivered, the catalog and purchase APIs exercised against at least two fake providers, idempotency/UNKNOWN/fallback tests passing, secrets encrypted and redacted, and an operations screen with transaction and audit search.

## 5. Data / API / config / deployment surface (future)

There is no current schema, route, environment key or deployment service. If implemented, the design expects a separate service with its own PostgreSQL database, admin API/UI, public API, provider registry and file storage. It must not reuse `core-back`'s database.

## 6. Operational usage

Not applicable. No runnable component exists.

## 7. Status and deviations

### Implemented

Nothing.

### Partial

Nothing in this repository.

### Missing / deferred

The entire system: schema, migrations, provider registry, query engine, catalog resolver, purchase flow, public API, admin API, admin UI, asset pipeline, token management, audit, metrics, tests and deployment.

### Known bugs / risks

- **Documentation risk:** historical summaries may claim the voucher system exists. It does not.
- **Scope risk:** the design assumes a separate service; implementing it inside `core-back` would violate the current service boundaries and database ownership.
- **Security risk:** provider URLs are admin-entered and require the same SSRF discipline as the gateway engine.

## 8. Verification and tests

There are no voucher tests. Acceptance requires at minimum:

- Schema migration and referential-rule tests.
- Provider auth method and token-refresh tests.
- Query-stack execution, parameter and extraction tests.
- Catalog ranking and cache-invalidation tests.
- Purchase idempotency, fallback and UNKNOWN tests.
- Token/IP/audit/redaction tests.
- Asset magic-byte and SVG-sanitisation tests.
- An end-to-end fake provider integration.
- A load test for catalog concurrency and purchase throughput.

## 9. Source references

### Old design sections

- `design/Voucher-Provider-Management-System-Technical-Design.md` sections 1-17.
- `design/voucher-system-raw-design.md` for the raw data model and sample `ApiConsumer`.
- `design/smart_ai_rail_and_voucher_onboarding_plan.md` for the reusable importer pattern.

### Code paths

None. The current repository has no voucher implementation.

### Generated appendices

- `project-design/appendices/design-source-map.md` (future mapping)
- `project-design/appendices/stale-claims-register.md` (SC-021)

## 10. Change history

- 2026-11-03: initial future design. Status explicitly `missing`; not current behaviour.

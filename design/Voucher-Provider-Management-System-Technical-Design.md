# Voucher Provider Management System — Technical Design

Final · 10 October 2026 · Technical version (a non-technical management overview is available separately)

## 1. Overview

This service lets an administrator plug in multiple voucher providers dynamically, with no code change per provider. The admin describes how to authenticate with a provider, which HTTP requests make up a purchase, and how to read the voucher out of the final response. The admin then builds a catalog (a tree of categories and services), attaches providers and product lists to each service, and issues bearer tokens to client applications. Clients browse the catalog and buy vouchers; for every purchase the system ranks the providers (lowest price, then priority) and tries them in order until one succeeds, falling back only when that is safe.

**Goals**

- Data-driven provider integration: authentication, product listing, purchase and extraction are configuration, not code.
- Best-price routing with admin-controlled priority.
- Safe money handling: no double purchases, no lost vouchers, full audit trail.
- Simple back-office UX for providers, catalog, assets, services and tokens.

**Non-goals**: wallets, balances or accounting (client systems keep their own accounts; this system keeps records, audits and logs only), markup or margin (added by client systems), currencies other than LYD, multi-instance deployment (designed for, not built), a scripting language inside provider config.

## 2. Actors

- **Administrator**: configures everything through the back-office UI.
- **API client**: external system using a permanent bearer token to read the catalog and purchase vouchers.
- **Provider**: third-party voucher supplier with its own HTTP API.
- **Operator**: reads transactions, logs and stats.

## 3. Architecture

- **Admin API and UI**: CRUD for providers, listings, assets, services, tokens, users; read-only views for transactions, logs, stats.
- **Public Voucher API**: bearer-token protected catalog and purchase endpoints.
- **Provider Gateway**: registry of `ApiConsumer` instances (one per provider) handling authentication, token refresh and request execution.
- **Query Engine**: runs a provider's purchase query stack and extracts the voucher.
- **Catalog Resolver**: builds the aggregated, ranked product listing for a service and keeps it in a short-lived cache.
- **Asset, Token and Audit services**.
- **Storage**: PostgreSQL (money as `NUMERIC(18,4)`, never floats) and file storage for assets.

Deployment is a single instance for now. Every in-memory cache (ApiConsumer registry, aggregated listings) sits behind an `InvalidationBus` interface: an in-process emitter today, Redis pub/sub later, with no change to callers.

&#91;embedded content: architecture · components and calls\]

Clients and the admin UI call separate APIs; every outbound provider call goes through the Provider Gateway.

**Configuration**: `API_LISTING_CONCURRENCY` (pool size for collecting API-listed provider products; default 15, typical range 15 to 20), `CATALOG_CACHE_TTL_SECONDS` (default 60), `CURRENCY=LYD`. Purchases use no pool: each purchase runs its own requests.

## 4. Data Model

All tables have `id`, `created_at`, `updated_at`. All money is LYD, so there are no currency columns. Secret columns (provider credentials, voucher secrets) are encrypted at rest (AES-256-GCM, key from environment or KMS).

### 4.1 Providers

**Provider**

- `name` (unique), `blocked` (bool), `auth_method`: `NONE | PERMANENT_TOKEN | REFRESH_TOKEN | USERNAME_PASSWORD | BASIC_AUTH`.
- `auth_config` (JSON, validated per method, secrets encrypted; see 5.2).
- `auth_apply` (JSON): how credentials are attached to each request (default: header `Authorization: Bearer <token>`).

**ProviderMeta** (`provider_id`, `key`, `type` string|number|boolean|json, `value`): free parameters usable by queries and auth, e.g. a merchant id.

**ProviderQuery** (the purchase query stack)

- `provider_id`, `order_index` (lower runs first; unique per provider), `method`, `url` (full), `content_type`, `success_check` (optional, see 6.4), `timeout_ms`.

**ProviderQueryParameter**

- `query_id`, `place` (HEADERS | QUERY | BODY), `type`, `key` (recursive-set path), `selector` (optional), `constant_value` (for CONSTANT).

**ProviderExtraction** (one per provider)

- `secret_selector`, `id_selector`, `serial_number_selector` (all optional, depending on service type), plus rows in **ProviderExtractionMeta** (`key`, `selector`).

A provider with no queries is never used for purchases.

### 4.2 Catalog

**Asset**: `name`, `mime` (png | svg), `size_bytes`, `storage_key`, `sha256`.

**Listing**

- `parent_id` (null = root), `kind` (SUB\_CATEGORY | SERVICE), `name_ar`, `name_en`, `asset_id` (optional), `priority_index`, `service_id` (only when kind = SERVICE; not unique, so one service can appear under several listings).

**Service**

- `name`, `type` (SECRET | BILL), `blocked`, `form_enabled`.
- **ServiceMeta** (`key`, `type`, `value`).
- **ServiceFormField** (`key`, `type` date | date-time | time | number | string | from-list, `label_en`, `label_ar`, `required`, `order_index`, `options` for from-list as `[{value, label_en, label_ar}]`, `rules` optional list of rule descriptors).

**ServiceProvider** (link between a service and a provider)

- `service_id`, `provider_id`, `priority_index` (higher wins ties), `listing_source` (FIXED | API); unique on (`service_id`, `provider_id`).

**FixedProduct** (when FIXED): `service_provider_id`, `amount`, `price` (the provider's price), `face_value` (string), plus **FixedProductMeta** (`key`, `type`, `value`).

**ApiListingConfig** (when API, one per service provider)

- `method`, `url`, `list_selector`, `amount_selector`, `face_value_selectors` (ordered list, joined with a space), `price_selector`.
- **ApiListingMetaSelector** (`key`, `selector`): copied into the product's meta so it can be passed to the purchase.
- **ApiListingParameter** (`place`, `key`, `type` PROVIDER\_META | AUTH\_TOKEN | CONSTANT, `selector`). `AUTH_TOKEN` fails validation if the provider's auth method has no token.

### 4.3 Access and operations

**AccessToken**: `name`, `token_hash`, `last_four`, `ip_whitelist_enabled`, `revoked_at`, `last_used_at`. The plaintext token is never stored. **AccessTokenIp**: `token_id`, `cidr`.

**VoucherTransaction**

- `reference` (our id, unique), `idempotency_key` (unique per token), `token_id`, `client_ip`, `service_id`, `service_provider_id`, `provider_id` (final), `amount`, `price`, `expected_price` (optional), `face_value`, `form_data` (JSON), `status` (PENDING | SUCCEEDED | FAILED | UNKNOWN), `error_code`, `result_ciphertext`, `result_meta`, `started_at`, `finished_at`.

**TransactionAttempt**: one row per provider tried, and per query executed: `transaction_id`, `provider_id`, `query_order`, redacted request, redacted response, HTTP status, duration, outcome.

**AuditLog** (admin actions: who, what, before/after, ip) and **User** (admin users with roles).

### 4.4 Referential rules

- Provider delete: only when no `ServiceProvider` rows exist.
- Service delete: only when no `ServiceProvider` rows exist; its listings are removed with it in the same database transaction.
- Asset delete: only when no listing references it.
- Listing delete: a service listing (the service itself stays), or an empty sub-category.
- Transactions are never hard-deleted; they keep a snapshot of names and prices so history survives later edits.

## 5. Provider Management

### 5.1 Admin operations

List; add; update name, auth method and details; manage meta (key, type, value); block and unblock (a blocked provider is excluded from listings and purchases); delete when unlinked; manage the purchase query stack (section 6).

### 5.2 Authentication methods

- **NONE**: no credentials.
- **PERMANENT\_TOKEN**: `token` string.
- **REFRESH\_TOKEN**: `refresh_url`, `refresh_method`, `refresh_token`, `refresh_period_ms`, `access_token_selector` (where to read the new access token), and `refresh_parameters` (list of `{type, key, selector, place}`) describing the refresh request. Parameter types: `META`, `REFRESH_TOKEN`, `CONSTANT`.
- **USERNAME\_PASSWORD**: same as above but the refresh request is built from `USERNAME` and `PASSWORD` parameter types; the access token is extracted with `access_token_selector`.
- **BASIC\_AUTH**: `username`, `password`; header `Authorization: Basic base64(user:pass)`.

Common settings: `auth_apply` (header name, scheme prefix, or query/body key) because not every provider uses `Authorization: Bearer`; `refresh_period_ms` (default 30 minutes); `refresh_on_error_statuses` (default 401, 403).

### 5.3 Runtime: ApiConsumer registry

One `ApiConsumer` per provider, cached in a map. It lazily authenticates on first use, keeps the current auth, refreshes on a schedule, and on an auth error refreshes once and retries the request once. Editing a provider's authentication (or its meta) stops the consumer's timer, deletes it from the registry and emits `provider.invalidated` on the bus.

The consumer exposes `request({method, url, query, body, headers})`. Headers the query defines are applied first; auth headers are applied after and win, as in the sample.

### 5.4 Review of the sample code: required changes

1. **`recursiveSet` overwrites siblings.** It resets `targetObject[setter] = {}` on every call, so setting `a.b` and then `a.c` loses `a.b`. Create the intermediate container only if it does not exist, and do not mutate the passed-in `setter` array (`pop()` does).
2. **Registry race.** `getProviderApiConsumer` awaits the database before checking the cache, so concurrent callers can create two consumers and leak a timer. Check the map first and store the creation promise.
3. **Refresh stampede.** Several requests failing with 401 at once each call `updateAuth()`. Use a single-flight promise so one refresh serves all waiters.
4. **`setInterval` with async work** can overlap. Use a chained `setTimeout` with jitter, and on failure keep the old token and retry sooner.
5. **No timeouts.** `fetch` needs an `AbortController` with per-request timeouts (defaults: 10s for auth and listing calls, configurable per purchase query).
6. **Retry on auth error must not duplicate a purchase.** A 401 before the provider processed anything is safe to retry; a timeout or 5xx is not (see 12.4).
7. **Body is always JSON.** Add `content_type` per query (`json`, `form-urlencoded`) and set the header.
8. **Auth header is hard-coded as Bearer**, and `isAuthError` defaults to 'retry on every error' when absent. Make both configurable, with a safe default of 401/403.
9. **Rotating refresh tokens.** If a refresh response returns a new refresh token, persist it, otherwise the next restart fails.
10. **Not implemented in the sample**: USERNAME\_PASSWORD and BASIC\_AUTH. Specified in 5.2.
11. **Non-JSON responses** break `result.json()`. Read text first, then parse JSON when the content type says so, and keep the raw text in the redacted log.
12. **Secrets in logs.** Never log auth headers, passwords or tokens; redact by key list and by known secret values.

## 6. Purchase Query Stack

### 6.1 Definition

An ordered list of HTTP queries per provider. Lower `order_index` runs first. The admin can list, add, edit, delete and reorder (reorder is one transactional call that sends the full ordered id list).

### 6.2 Parameter types

Each parameter writes a value into headers, query or body at `key` (recursive set, dot path; numeric segments create arrays).

- `PROVIDER_META`: `selector` over the provider's meta.
- `REQUEST_META`: `selector` over the product's meta (the meta captured in the listing).
- `AMOUNT`, `PRICE`, `FACE_VALUE`: values of the chosen product; no selector.
- `PREVIOUS_REQUEST_DATA`: `selector` over the previous query's parsed response; creating this on the first query is a validation error (and throws at runtime as a safeguard).
- `SERVICE_ADDITIONAL_DATA`: `selector` over the submitted `form_data` (for example a meter number on a bill service).
- Recommended additions: `CONSTANT` (static value) and `TRANSACTION_REFERENCE` (our reference, so a provider that supports it can reject duplicates).

### 6.3 Execution

```
ctx = { providerMeta, productMeta, amount, price, faceValue, formData, reference }
prev = null
for query in stack ordered by order_index:
    request = build(query, ctx, prev)       // resolve parameters, compile url + query string
    response = consumer.request(request)    // auth headers applied by the consumer
    assert success(query, response)         // see 6.4
    log attempt (redacted)
    prev = response.data
voucher = extract(prev, providerExtraction)
```

Query strings use `compileUrl` from the sample (indices array format by default). The final response is the extraction source by default; an optional `source_query_order` lets an extraction read an earlier response.

### 6.4 Success detection

Many providers return HTTP 200 with an error body. Each query therefore has an optional `success_check`: an HTTP status set (default 2xx) and an optional `{selector, equals | exists | not_equals}` check on the body. A missing required selector is a failure, not a silent null.

### 6.5 Extraction

`secret_selector` (required for SECRET services), `id_selector`, `serial_number_selector` (optional), and meta rows `{key, selector}` stored under `key` with recursive set. Extraction failure after a successful provider call is the worst case: the voucher was bought but not read. The raw redacted response is kept, the transaction is marked UNKNOWN and an alert is raised.

### 6.6 Validation at save time

Reject: first query using PREVIOUS\_REQUEST\_DATA, duplicate `order_index`, non-absolute URL, invalid selectors, unknown parameter types. Offer a **dry-run** (admin enters sample product and form data, the engine builds requests without sending them) to preview what will be sent.

## 7. Listings (Catalog Tree)

- A listing belongs to a parent sub-category or to the root (`parent_id = null`).
- A listing is either a **sub-category** (has children) or a **service listing** (links to one service). Names in Arabic and English are required; the image is optional; `priority_index` sorts siblings (ascending, ties by id).
- **The same service can appear under several listings.** Each listing has its own names, image and priority; deleting one listing never deletes the service.
- The admin screen shows one level at a time: root items first, click a sub-category to open the same screen scoped to it, add items inline.
- Rules: cycles are impossible because parents are only chosen at creation (moving a node must verify the target is not a descendant); maximum depth (suggested 6).
- Delete: a service listing or an empty sub-category only.
- **Public visibility** (computed): a service listing is visible when the service is not blocked and it has at least one unblocked provider that has a non-empty query stack and a non-empty product list. A sub-category is visible when it has at least one visible descendant. Admins see everything with a status badge explaining why an item is hidden.

## 8. Assets

- PNG or SVG with a unique name. Admin can list, add, view in detail (viewer with zoom and metadata), replace the file content, and delete when unreferenced.
- Upload via `multipart/form-data`. Validate on **both** client and server: extension, declared MIME, **magic bytes**, size limit (suggested 1 MB PNG, 200 KB SVG), and image dimension limit for PNG.
- **SVG is active content**: sanitize on upload (strip script, event handlers, external references, `foreignObject`), and serve with `Content-Type: image/svg+xml`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `X-Content-Type-Options: nosniff`.
- Store files under a content-derived key; replacing content writes a new object and swaps the pointer so caches can be busted (`?v=sha256`).

## 9. Access Tokens

- Admin can list, create, delete (revoke) and manage the IP whitelist per token. Tokens are **shown once**, at creation; they cannot be copied later.
- Format: `vp_` + 32 random bytes (base64url). Only `sha256(token)` and the last four characters are stored, so a database leak does not expose usable tokens. A lost token is replaced by creating a new one and revoking the old one.
- **IP whitelist**: when `ip_whitelist_enabled`, the caller's IP must match an entry (IPv4/IPv6, single address or CIDR). Resolve the client IP carefully: only trust `X-Forwarded-For` when the immediate peer is a configured trusted proxy.
- Tokens grant access to the catalog and purchase APIs only, never to admin routes. Optional later: per-token scopes, rate limits and service allow-lists.
- Each request updates `last_used_at` (debounced) for visibility.

## 10. Services

### 10.1 Management

List, add (`name`, `type` SECRET | BILL), update, delete (only when no providers linked). Detail view: recent transactions, form setup, meta, block and unblock (blocking also removes the service from listings), provider links.

### 10.2 Service form

- Toggle enabled and disabled; when enabled, purchase requests must include `form_data` valid against the form.
- Field list: add, edit, delete, reorder. Fields have `key` (name in the submitted body), `type`, bilingual labels, `required`.
- `from-list` fields carry options `{value, label_en, label_ar}`; submitted value must be one of them.
- **Rules**: an ordered descriptor list (for example `[{op:'min', value:3}, {op:'regex', value:'^[0-9]+$'}]`) compiled into a zod schema from a whitelist of operations. Never evaluate admin-supplied code. Optional in v1.
- The compiled schema is cached per service and invalidated on form change; the same descriptor is returned to clients so they can render and validate the form.

### 10.3 Service meta

Key, type, value rows, available to queries as additional context if needed.

### 10.4 Provider links

- List, add, update, remove. Add means choosing from providers not already linked and setting `priority_index` (higher is preferred when prices tie).
- Per link, the admin manages the product list:
  - **FIXED**: add, edit, delete products with `amount`, `price`, `face_value`, and meta rows.
  - **API**: configure `method`, `url`, `list_selector`, `amount_selector`, `face_value_selectors`, `price_selector`, meta selectors, and parameters (list, add, edit, delete). A link with an empty product list is never selected.
- Switching listing source requires confirmation because it discards the other source's configuration.
- Provide a **Test fetch** button for API lists that shows the parsed products.

## 11. Catalog Resolution (Product Listing)

Input: `service_id`. Output: service details, its form definition, and a product list.

&#91;embedded content: catalog resolution · 8 steps\]

The cached, ranked result is what clients see and what purchases read.

1. Middleware: if the service is blocked, respond `404 SERVICE_UNAVAILABLE` (same as not found, to avoid leaking state).
2. Load the service's unblocked providers (with non-empty query stack) from the database; if none, `404 SERVICE_HAS_NO_PROVIDERS`.
3. Split into FIXED and API sources. FIXED products come straight from the query.
4. For API sources, fetch product lists in a **bounded concurrency pool** sized by `API_LISTING_CONCURRENCY` (default 15), each with a timeout. A failing provider is skipped and the failure logged, so one slow provider never breaks the listing.
5. Build a map keyed by `amount` plus `face_value` to `{amount, candidates[]}` where each candidate holds `provider_id`, `service_provider_id`, `priority_index`, `price`, `face_value`, `meta`.
6. Rank candidates inside each entry with one comparator: **price ascending, then priority descending**.
7. Drop entries with no candidates and return entries sorted by amount ascending.
8. Cache the aggregate (TTL 60 s by default), invalidated on provider block, service change or product edit. The cache is also what purchases read (section 12).

**Notes**

- The original notes sort by priority and then by price. Two consecutive stable sorts leave **price as the primary key and priority as the tie-breaker**, which matches the intent 'higher priority wins if prices match'; the comparator above encodes that.
- **Client response shape**: per entry only `product_key` (opaque), `amount`, `face_value` and the best `price`. Provider ids, provider meta and internal priorities are never exposed to clients.

## 12. Voucher Purchase

### 12.1 Request

`POST /v1/purchases` with `service_id`, `product_key`, optional `expected_price`, `form_data` (when the service has a form) and an `Idempotency-Key` header.

Routing is **server-side**: the server reads the ranked candidates for the product from the cached aggregate (rebuilding it through section 11 if missing or expired) and tries them in order until one succeeds. Clients never choose a provider.

&#91;embedded content: purchase flow · 5 steps, 1 decision\]

Section 12.4 defines which failures count as definitive and which end in UNKNOWN.

### 12.2 Validation

1. Token valid, not revoked, IP allowed.
2. Service not blocked; `form_data` valid against the service form.
3. Candidates loaded from the cache; provider and service blocked flags re-checked against the database.
4. If `expected_price` is provided and the best candidate's price does not match it, respond `409 PRICE_CHANGED` with the current price. If it is omitted, no price check is made.
5. Idempotency: if the key exists for this token, return the stored result (or `409 IN_PROGRESS`).

### 12.3 Execution

1. Insert the transaction as PENDING (before any provider call).
2. Take the best candidate, load its query stack and run the Query Engine (section 6), logging every query. Each purchase makes its own requests; there is no purchase pool.
3. On success: extract the voucher, encrypt the secret, mark SUCCEEDED, return it.
4. On failure, apply the fallback rule below.

### 12.4 Failure handling and fallback

Fallback to the next candidate is allowed **only when the failure is definitive and happened before the provider could have acted**: the failure occurred on the first query and was a connection failure before sending, a 4xx or explicit error body, or an auth failure after the refresh retry. If `expected_price` was provided, a fallback candidate is used only when its price also matches it. In every other case the outcome is ambiguous or partial:

- Timeout or connection reset after sending, 5xx, failure on a later query, or extraction failure: mark the transaction **UNKNOWN**, do not try another provider, return `202`/`502` with the reference, and alert. Resolve through manual reconciliation.
- All eligible candidates definitively failed: mark FAILED, return `503 NO_PROVIDER_AVAILABLE`.

Never automatically retry a purchase request that may have been accepted.

&#91;embedded content: transaction states · 4 states\]

A transaction leaves UNKNOWN only through manual reconciliation.

### 12.5 Duplicate protection

The client's `Idempotency-Key` and our own `reference` stop duplicate purchases at our side. The `reference` can be sent to the provider through the `TRANSACTION_REFERENCE` parameter. Whether a provider honours it, and whether it offers an order-status endpoint for reconciliation, is optional and decided per provider later; the design does not depend on it.

### 12.6 Logging

Store everything needed for investigation: reference, token id, client IP, user agent, service, provider, amounts, form data, per-query redacted request and response, durations, status and error code. Voucher secrets are stored only encrypted and are masked in admin screens; reveal is an audited action.

### 12.7 Response

```
{ reference, status, service_id, amount, face_value, price,
  voucher: { secret, id, serial_number, meta } , created_at }
```

Provider identity is not returned to clients.

## 13. Public API Surface

All under bearer-token auth.

- `GET /v1/catalog`: root listing items (visible only).
- `GET /v1/catalog/{listingId}`: children of a sub-category.
- `GET /v1/services/{serviceId}/products`: ranked product listing, service details and form definition.
- `POST /v1/purchases`: purchase (section 12).
- `GET /v1/purchases/{reference}` and `GET /v1/purchases?from&to&status&page`: transactions of the calling token only. Additional client-based queries are deferred.

Errors use a stable envelope `{ code, message, reference? }`; the codes include `UNAUTHORIZED`, `IP_NOT_ALLOWED`, `SERVICE_UNAVAILABLE`, `SERVICE_HAS_NO_PROVIDERS`, `VALIDATION_FAILED`, `PRICE_CHANGED`, `NO_PROVIDER_AVAILABLE`, `IN_PROGRESS`, `PURCHASE_UNKNOWN`.

## 14. Admin API Surface (summary)

- Providers: `GET/POST /providers`, `GET/PATCH/DELETE /providers/{id}`, `POST /providers/{id}/block|unblock`, `GET/PUT /providers/{id}/meta`, `GET/POST/PATCH/DELETE /providers/{id}/queries`, `PUT /providers/{id}/queries/order`, `PUT /providers/{id}/queries/{qid}/parameters`, `PUT /providers/{id}/extraction`, `POST /providers/{id}/queries/dry-run`.
- Listings: `GET /listings?parent_id=`, `POST/PATCH/DELETE /listings/{id}`, `PUT /listings/order`.
- Assets: `GET/POST /assets`, `GET/DELETE /assets/{id}`, `PUT /assets/{id}/file`.
- Tokens: `GET/POST /tokens` (the token value is returned only by the create response), `DELETE /tokens/{id}`, `GET/POST/DELETE /tokens/{id}/ips`, `PATCH /tokens/{id}` (whitelist flag).
- Services: `GET/POST /services`, `GET/PATCH/DELETE /services/{id}`, `POST /services/{id}/block|unblock`, `GET/PUT /services/{id}/form`, `GET/PUT /services/{id}/meta`, `GET /services/{id}/transactions`, `GET/POST/PATCH/DELETE /services/{id}/providers`, `GET/PUT /services/{id}/providers/{spid}/products` (FIXED), `GET/PUT /services/{id}/providers/{spid}/api-listing`, `POST .../api-listing/test`.
- Operations: `GET /transactions` (filters), `GET /transactions/{id}` (attempts), `GET /logs`, `GET /stats`, `GET/POST/PATCH /users`, `GET /audit`.

## 15. Security

- **Roles**: SUPER\_ADMIN, CATALOG\_ADMIN (listings, assets, services), PROVIDER\_ADMIN (providers, tokens), OPERATOR (read-only transactions and logs). Revealing voucher secrets needs an explicit permission and is audited.
- **Secrets at rest**: encrypted columns for provider credentials and voucher secrets; client tokens are stored only as hashes; key rotation supported through a key id stored with each ciphertext.
- **SSRF**: provider URLs are admin-entered. Enforce `https` (optionally allow-list hosts), resolve DNS and block private, loopback and link-local ranges, disable redirects or re-validate on each hop, cap response size.
- **Rate limiting** per token and per IP on public endpoints; stricter limit on purchases.
- **Input validation** with zod on every route; selectors and keys validated against a safe path grammar (`[A-Za-z0-9_-]+` segments joined by dots), and prototype pollution guarded (`__proto__`, `constructor`, `prototype` rejected in `recursiveSet`).
- **Auditing** of all admin mutations with before/after snapshots (secrets masked).
- **Redaction** of secrets in all stored request and response logs.

## 16. Observability and Operations

- Structured logs with correlation id (`reference`) across queries.
- Metrics per provider: success rate, latency percentiles, auth refresh failures, fallback count, UNKNOWN count.
- Alerts: UNKNOWN transaction, extraction failure, repeated refresh failure, provider error spike.
- Stats screen: volume by service and provider, success rates, top tokens.
- Auto-block option (later): temporarily deprioritize a provider after N consecutive definitive failures.
- Backups include encrypted columns and the key-management plan.

## 17. Delivery Plan and Decisions

**Phases**

1. Foundations: auth and roles, assets, listings, services and forms, tokens.
2. Providers: auth methods, ApiConsumer registry, query stack, extraction, dry-run.
3. Catalog resolution and purchase flow with idempotency, UNKNOWN handling and logging.
4. Operations: transactions, logs, stats, alerts; then Redis invalidation when going multi-instance.

**Confirmed decisions**

1. `price` is the provider's price; margin and customer-facing prices are added by client systems.
2. Routing is server-side: the cached ranked list is used and candidates are tried until one succeeds.
3. Reference-based duplicate protection is required; provider-side idempotency and status endpoints are optional and decided later.
4. Access tokens are shown once only.
5. `expected_price` is optional; when provided and not matching, the purchase is rejected with 409.
6. A service can appear under several listings.
7. All amounts are LYD; no accounting is kept here, only records, audits and logs.
8. API-listed products are collected through a configurable pool (default 15, typically 15 to 20); purchases have no pool.

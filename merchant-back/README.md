# merchant-back

`merchant-back` is the public merchant edge/BFF. One Bun/Express process serves two audiences:

- the merchant portal API under `/api/v1/merchant/*`;
- the merchant server-to-server API under `/api/v1/external/*`.

It validates requests, translates the public merchant vocabulary into the canonical core contract, verifies uploads, applies rate limits and forwards over mutual TLS (mTLS) to `core-back` under `/internal/merchant/*`.

- Runtime: Bun + Express 5 + Zod 4.
- Status: `partial` (see the canonical design part for the authoritative status).
- Generated blueprint: [`blueprint.md`](./blueprint.md)
- Canonical parts: [`Merchant Edge BFF`](../project-design/parts/02-edge-services/02-merchant-back.md), [`Shared Core Upstream Client`](../project-design/parts/02-edge-services/00-shared-core-upstream-client.md)
- Generated references: [`API route matrix`](../project-design/appendices/api-route-matrix.md), [`environment matrix`](../project-design/appendices/env-and-config-matrix.md)

## 1. Purpose and boundaries

`merchant-back` owns:

- the portal and server API route surfaces;
- public request validation and canonical body mapping;
- KYB and dispute upload validation (declared MIME, magic bytes, size);
- portal, onboarding and external rate limits;
- the `pg_live_` prefix gate for the external API;
- the mTLS pool and request context sent to core.

`merchant-back` does not own:

- database access, Prisma, migrations or `DATABASE_URL`;
- `KMS_MASTER_KEY` or another host's certificate/key;
- session signature verification, session revocation, MFA state or authority decisions;
- access-token hashing, revocation or IP allowlists;
- money arithmetic, ledger writes, maker-checker or audit writes.

Trust model: the edge is untrusted from core's point of view. The edge authenticates to core with a client certificate whose common name is exactly `merchant-back`. Core verifies the internal CA, binds the certificate to `/internal/merchant`, and independently verifies the session or `pg_live_` token, merchant binding, user state, authorities and business invariants. Edge checks are UX and contract checks; core is the authority.

The backend binds to `BIND_HOST` (default `0.0.0.0` in the service schema). Deployment writes `127.0.0.1`, so the public merchant Nginx vhost is the only intended listener.

## 2. Architecture and request flow

`index.ts` creates a stateless Express app:

1. Disables `x-powered-by`.
2. Sets Express `trust proxy` to `false`.
3. Emits no CORS headers unless `CORS_ALLOWED_ORIGINS` is set (no credentials), plus hand-written security headers.
4. Installs request logging with request-id resolution and secret redaction.
5. Serves unauthenticated `GET /health`.
6. Parses JSON and URL-encoded bodies with `MAX_JSON_BODY_BYTES`.
7. Mounts `/api/v1`.
8. Adds the shared JSON 404 and error handlers.

Mount order in `api/index.ts`:

| Mount | Router | Notes |
| :--- | :--- | :--- |
| `/merchant/auth` | `authRouter` | Public at the edge; auth limiter applies. |
| `/merchant/onboarding` | `onboardingRouter` | Requires an `Authorization` header at the edge (presence only); onboarding limiter applies. |
| `/merchant` | `protectedRouter` | Portal business routes; requires an `Authorization` header at the edge. |
| `/external` | `externalRouter` | Requires a `pg_live_` bearer prefix at the edge. |

Middleware:

| Layer | Behavior |
| :--- | :--- |
| `authLimiter` | Fixed 15-minute window, `AUTH_RATE_LIMIT_MAX` (default 20), on `/api/v1/merchant/auth`. |
| `onboardingLimiter` | Fixed 60-second window, `API_RATE_LIMIT_MAX` (default 300), on `/api/v1/merchant/onboarding`. |
| `apiLimiter` | Fixed 60-second window, `API_RATE_LIMIT_MAX` (default 300), on the protected portal router. |
| `externalLimiter` | Fixed 60-second window, `EXTERNAL_RATE_LIMIT_MAX` (default 120), on `/api/v1/external`. |
| `requirePgLiveToken` | Requires `Authorization: Bearer pg_live_...` by prefix only. |
| `coreForward` `requireAuth` | Rejects a missing `Authorization` header on protected portal routes unless `requireAuth: false`. |
| `requireBearer` | Helper used by dispute evidence and bulk user routes before multipart or fan-out work. |
| `requireAuthHeader` | Exported from `api/public/auth.ts` but a no-op; it is not a security control. |

Request flow for a portal business route:

1. `apiLimiter` applies.
2. `coreForward` requires a bearer header.
3. Params and query are validated with Zod.
4. The public body is validated with `schema`.
5. `bodyMapper()` translates product vocabulary into the core body, or `bodyFrom()` replaces it.
6. `coreSchema`, when configured, re-validates the translated body so a payload core would reject is stopped at the edge.
7. The shared client selects a core node and forwards the request with `x-request-id`, `x-real-client-ip`, `x-client-user-agent`, `x-edge-service: merchant-back`, the bearer token and an optional `x-pg-min-lsn`.
8. The edge returns the declared status, or relays the core status when `relayStatus: true`, with the core JSON body.

## 3. Routes

All routes are under `/api/v1`. `GET /health` is at the process root and is unauthenticated.

### 3.1 Portal authentication (`/api/v1/merchant/auth`)

| Method | Path | Notes |
| :--- | :--- | :--- |
| POST | `/register` | Public at the edge; creates a registration. |
| POST | `/verify-identity` | Retired: core always answers `410 IDENTITY_VERIFICATION_RETIRED`. |
| POST | `/accept-invitation` | Public at the edge; invitation token and password. |
| POST | `/login` | Public at the edge; identifier and password. |
| POST | `/google` | Public at the edge; validates a Google `idToken`. Core answers `501 GOOGLE_IDENTITY_NOT_CONFIGURED`. |
| GET | `/me` | Public at the edge; core returns static platform/version information. |
| POST | `/mfa/verify` | Public at the edge; forwards challenge id and code. |

### 3.2 Onboarding (`/api/v1/merchant/onboarding`)

| Method | Path | Notes |
| :--- | :--- | :--- |
| GET | `/join-request` | Reads the merchant join request. |
| PUT | `/join-request` | Updates the join request. |
| GET | `/kyb-revalidations` | Lists KYB revalidation requests. |
| POST | `/kyb-documents` | Multipart upload; field `document`; MIME/magic-byte/size checked before forwarding. |
| GET | `/beneficial-owners` | Lists beneficial owners. |
| POST | `/beneficial-owners` | Creates a beneficial owner. |
| DELETE | `/beneficial-owners/:id` | Removes a beneficial owner. |
| POST | `/submit` | Submits onboarding with an acknowledgement. |

### 3.3 Protected portal API (`/api/v1/merchant`)

| Area | Methods and paths |
| :--- | :--- |
| Wallets | `GET /wallets`, `POST /wallets`, `GET /wallets/:id`, `GET /wallets/:id/balance`, `GET /wallets/:id/statements`, `GET /wallets/:id/statements/:month/export` |
| Applications | `GET /applications`, `POST /applications`, `GET /applications/:id`, `PATCH /applications/:id` |
| Links | `GET /links`, `POST /links`, `GET /links/:id`, `POST /links/:id/cancel`, `GET /links/:id/attempts` |
| POS | `GET /pos/terminals`, `POST /pos/terminals`, `GET /pos/terminals/:id`, `PATCH /pos/terminals/:id`, `POST /pos/terminals/:id/screens`, `GET /pos/screens/:screenCode/stream` (SSE) |
| Payments | `GET /payments` |
| Disputes | `GET /disputes`, `GET /disputes/:id`, `POST /disputes/:id/evidence` (multipart) |
| Cash-outs | `GET /cashouts`, `POST /cashouts` |
| API tokens | `GET /tokens`, `POST /tokens`, `PUT /tokens/:id/ips`, `DELETE /tokens/:id` |
| Credential sets | `GET /credential-sets`, `POST /credential-sets`, `GET /credential-sets/:id`, `PUT /credential-sets/:id` |
| Team users | `GET /users`, `POST /users`, `PATCH /users` (bulk), `PATCH /users/:id` |
| Stats | `GET /stats/overview` |

`GET /options/:kind` exists in `api/protected/options.ts` but the router is not mounted by `api/protected/index.ts`. A portal call to `/api/v1/merchant/options/:kind` receives `404 NOT_FOUND`.

### 3.4 External merchant API (`/api/v1/external`)

| Method | Path | Notes |
| :--- | :--- | :--- |
| POST | `/links` | Creates a payment link. Requires `pg_live_` bearer prefix. |
| GET | `/links/:key` | Reads a link by public key. |
| POST | `/links/:key/cancel` | Cancels a link. |
| GET | `/payments/:reference` | Looks up a payment by reference. |

### 3.5 Delegated portal statuses

Some portal routes relay core's status instead of a fixed one:

- `PATCH /applications/:id` relays `202 Accepted` when a sensitive change becomes an approval request.
- Auth and token creation routes declare `201` for successful creation.
- The bulk user patch fans out one core call per user and returns `200`.

## 4. `CORE_BACK_URLS` pool and failover

The shared client is implemented in `lib/coreInternalClient.ts`. This service uses `CORE_SERVICE_NAME=merchant-back` and `CORE_CHANNEL_PREFIX=/internal/merchant`.

Configuration:

- `CORE_BACK_URL` is required and must be an absolute `https:` URL. It is the first URL and the fallback when `CORE_BACK_URLS` is unset.
- `CORE_BACK_URLS` is an optional comma-separated list of absolute `https:` URLs.
- Empty entries are rejected, URLs are de-duplicated by normalized `URL.toString()`, and the original trimmed strings are used for requests.
- One keep-alive `https.Agent` is created per node with the client certificate, client key and internal CA. TLS 1.3 is fixed; `rejectUnauthorized` is true; `maxSockets` is 64; the agent timeout is `CORE_REQUEST_TIMEOUT_MS`.
- Certificate and key files are read when the pool is created. Replacing files on disk does not affect a running process; restart or rebuild the pool.
- A missing certificate/key/CA file produces `500 MTLS_MATERIAL_UNAVAILABLE`.

Selection and failover:

1. The pool selects the node with the fewest in-flight requests. A round-robin cursor breaks ties.
2. Connection errors, TLS errors and HTTP `502`/`503` mark the node unhealthy and start a 5-second cooldown.
3. After the cooldown, a zero-in-flight unhealthy node is selected as a half-open probe before healthy nodes are considered again.
4. A call never retries against the same node URL.
5. `GET`, `HEAD`, `PUT`, `DELETE` and `OPTIONS` retry by default. `POST` and `PATCH` do not retry unless a caller opts in. `maxAttempts` defaults to 2.
6. Other statuses, including `4xx` and `5xx` other than `502`/`503`, mark the node healthy and are returned to the caller.
7. If all attempts end in `502`/`503`, the last response is returned. If no eligible node remains, the edge returns `503 CORE_UNAVAILABLE`.
8. `x-pg-min-lsn` is propagated when the caller supplies an LSN. The client does not generate one.

Transport mapping:

| Transport condition | Edge error |
| :--- | :--- |
| `ETIMEDOUT`, `ESOCKETTIMEDOUT` | `504 CORE_TIMEOUT` |
| `ECONNREFUSED`, `ECONNRESET`, `EPIPE`, `EHOSTUNREACH` | `502 CORE_UNREACHABLE` |
| `ENOTFOUND`, `EAI_AGAIN` | `502 CORE_DNS_FAILURE` |
| TLS error codes | `502 CORE_TLS_ERROR` |
| Other failures | `502 CORE_CONNECTION_ERROR` |

SSE note: the POS screen stream uses the same node selection and retries a failed handshake on another node. Once the stream is established it is not load-balanced or resumed; `POS_STREAM_TIMEOUT_MS` controls the proxy timeout. The edge has no pool metrics or status endpoint.

## 5. Authentication, authorities and trust

| Control | `merchant-back` behavior | `core-back` behavior |
| :--- | :--- | :--- |
| Portal session | Requires only a non-empty `Authorization` header on protected routes. Does not verify signature, expiry, user state, MFA or revocation. | Verifies the session JWT signature, issuer, audience, expiry, user existence and `ACTIVE` status. |
| Portal authorities | No edge role or authority guard. | Merchant internal routes scope by `merchantId`; they do not use per-route authority guards. API-token scopes are stored but not enforced per endpoint. `requireMerchantScope` has no production caller. |
| MFA | Not checked. | Login/MFA issue an `mfa` claim, but later calls do not enforce it. |
| Session revocation | Not checked. | Stateless 12-hour JWTs; no per-session revocation table. Disabling the user blocks the next request. |
| External API | Checks only the `pg_live_` prefix. | Hashes the token, looks up `AccessToken`, rejects unknown/revoked tokens, and enforces the optional `AccessTokenIp` CIDR allowlist. |
| Google login | Forwards a shaped `idToken`. | Returns `501 GOOGLE_IDENTITY_NOT_CONFIGURED`; no OIDC provider is integrated. |
| Maker-checker | Not decided at the edge. | Database constraint/trigger and execution checks enforce maker != checker. |
| Merchant ownership | Not decided at the edge. | Core resolves the merchant from the token and scopes every query by it. |

Important consequences:

- A random non-empty bearer string reaches core on protected portal routes. Core is the only authentication authority.
- The external prefix check is not a credential check. Do not log or expose the token.
- API-token scopes are not enforced per merchant endpoint. This is a core-side authorization gap relative to the design.
- `GET /auth/me` is not protected at the edge and core's merchant `/auth/me` returns static platform/version information before core's authentication middleware.
- Merchant internal routes do not call `requireAuthorities`. Authority enforcement is limited to the merchantId binding and core business checks.

## 6. Uploads and money rules

Uploads:

- Multer memory storage with `MAX_UPLOAD_BYTES` (10 MiB default), one file and at most 32 fields.
- `assertAllowedUpload()` checks declared MIME, magic bytes (PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, PDF `25 50 44 46 2D`) and size.
- KYB documents are forwarded as raw bytes with `x-upload-filename`, `x-upload-content-type`, `x-upload-sha256`, `x-upload-size` and base64url `x-upload-metadata`.
- Dispute evidence is converted into a canonical JSON body with the file base64 encoded. The evidence file cap is `MAX_EVIDENCE_FILE_BYTES` (712,704 bytes), below the core JSON body limit.

Money rules:

- Link creation is a merchant-owned operation, so the portal and external link schemas accept a decimal-string `amount` and an ISO 4217 `currency`.
- The edge never performs arithmetic on money. It forwards the values and core re-validates amount, currency, fee model and link state.
- Checkout's stricter zero-monetary-field rule does not apply here.

## 7. Environment

| Key | Required | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | no | `development` | Runtime mode (`development`, `test`, `production`). |
| `PORT` | no | `4102` | Backend listener port. |
| `BIND_HOST` | no | `0.0.0.0` | Backend bind address. Deployment sets `127.0.0.1`. |
| `CORE_BACK_URL` | yes | none | First core node; absolute `https:` URL. |
| `CORE_BACK_URLS` | no | none | Comma-separated core pool; absolute `https:` URLs. |
| `MTLS_CLIENT_CERT_PATH` | yes | none | Client certificate for core. |
| `MTLS_CLIENT_KEY_PATH` | yes | none | Client private key. |
| `MTLS_CA_CERT_PATH` | yes | none | Internal CA certificate. |
| `CORE_REQUEST_TIMEOUT_MS` | no | `30000` | Per-request and agent timeout. |
| `TRUSTED_PROXY_CIDRS` | no | loopback only (`127.0.0.0/8,::1/128`) | Peers whose forwarded IP headers are trusted. |
| `MAX_JSON_BODY_BYTES` | no | `2097152` | JSON and URL-encoded body limit. |
| `MAX_UPLOAD_BYTES` | no | `10485760` | Multipart upload limit. |
| `UPLOAD_ALLOWED_MIME` | no | `image/png,image/jpeg,application/pdf` | Allowed upload MIME types. |
| `PG_LIVE_TOKEN_PREFIX` | no | `pg_live_` | External API bearer prefix. |
| `AUTH_RATE_LIMIT_MAX` | no | `20` | Auth requests per fixed 15-minute window. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | no | `900000` | Defined but not read by the auth limiter; the window is fixed at 15 minutes. |
| `API_RATE_LIMIT_MAX` | no | `300` | Portal and onboarding requests per fixed 60-second window. |
| `API_RATE_LIMIT_WINDOW_MS` | no | `60000` | Defined but not read by the current limiter; the window is fixed at 60 seconds. |
| `EXTERNAL_RATE_LIMIT_MAX` | no | `120` | External API requests per fixed 60-second window. |
| `EXTERNAL_RATE_LIMIT_WINDOW_MS` | no | `60000` | Defined but not read by the current limiter; the window is fixed at 60 seconds. |
| `POS_STREAM_TIMEOUT_MS` | no | `900000` | POS SSE proxy timeout. |

The service never reads `DATABASE_URL`, `KMS_MASTER_KEY` or another service's certificate. Deploy writes `BIND_HOST=127.0.0.1`, `PG_LIVE_TOKEN_PREFIX=pg_live_`, the core URL list and the edge mTLS paths into the generated `.env`.

## 8. Commands

```bash
cd merchant-back
bun install
bun run start      # bun run index.ts
bun run dev        # bun --watch index.ts
bun test
bun run typecheck  # bunx tsc --noEmit
```

Public reachability is through the merchant Nginx vhost; the backend port must stay loopback-only.

## 9. Testing and troubleshooting

```bash
cd merchant-back && bun run typecheck && bun test
```

Key suites:

- `test/core-forwarding.test.ts`: forwarding, status relay and body handling.
- `test/core-contract.test.ts`: public-to-core mappers and canonical schemas.
- `test/core-internal-client.test.ts`: pool, retry, headers and LSN behavior.
- `test/mtls-client.test.ts`: channel confinement and transport error mapping.
- `test/merchant-kyb-and-external.test.ts`: upload validation and external API behavior.
- `test/env-isolation.test.ts`: no database/KMS secrets in the edge environment.

These suites use local stubs and do not require PostgreSQL or Redis. Google login has no successful implementation to test; the expected result is core's `501`.

Common failures:

| Symptom | Likely cause / check |
| :--- | :--- |
| `401 AUTH_REQUIRED` | No Authorization header on a protected portal route. |
| `401 INVALID_API_TOKEN` | External request did not carry a `Bearer pg_live_...` token; the edge checks the prefix only. |
| `401 ACCESS_TOKEN_INVALID` / `ACCESS_TOKEN_REVOKED` | Core rejected the external token; inspect token state and revocation. |
| `403 ACCESS_TOKEN_IP_NOT_ALLOWED` | Core's token IP allowlist rejected the resolved client IP. |
| `404 NOT_FOUND` on `/api/v1/merchant/options/:kind` | The options router is not mounted. |
| `413 UPLOAD_TOO_LARGE` | Upload exceeds `MAX_UPLOAD_BYTES` or the core JSON evidence limit. |
| `415 UNSUPPORTED_UPLOAD_TYPE` / `UPLOAD_SIGNATURE_MISMATCH` | Declared MIME or magic bytes do not match. |
| `429 RATE_LIMITED` | Auth, portal, onboarding or external limiter exceeded. |
| `502 CORE_TLS_ERROR` | Certificate/CA mismatch, expired certificate, or wrong client certificate. Restart after rotation. |
| `502 CORE_UNREACHABLE` / `504 CORE_TIMEOUT` | Core node is down or slower than `CORE_REQUEST_TIMEOUT_MS`. |
| `503 CORE_UNAVAILABLE` | No eligible core node remains or `CORE_BACK_URLS` is empty. |
| POS stream closes | Check Nginx buffering, `POS_STREAM_TIMEOUT_MS`, the core deadline and whether core restarted mid-stream. |

## 10. Security notes

- No database, KMS or migration material is present at the edge. Environment-isolation tests assert this boundary.
- The client certificate CN must be exactly `merchant-back`; core's mTLS guard rejects a valid certificate on another namespace.
- TLS 1.3 is fixed in both directions; core verifies the internal CA and the edge verifies the core server certificate.
- CORS headers are emitted only when `CORS_ALLOWED_ORIGINS` is set (cross-origin dev frontends need it); the reverse proxy, CSP and bearer-token model remain the browser-facing controls.
- Portal authentication is only a header-presence check at the edge. Core verifies the session and scopes data by merchant. Do not assume the edge rejected an invalid token.
- The external token prefix check is not a credential check. Core hashes the token, checks revocation and enforces the optional IP allowlist.
- (Superseded) `resolveClientIp` honours forwarded headers only from trusted peers and requires a single valid IP (`x-real-ip` preferred, `x-real-client-ip` fallback); the edge overwrites `x-real-client-ip` towards core. Previously `x-real-client-ip` was preferred over `x-real-ip` in `merchant-back/lib/net/index.ts`. When the backend is loopback-bound this is safe; if it is ever exposed and a direct peer is inside `TRUSTED_PROXY_CIDRS`, the peer can spoof its client IP.
- Raw body handling: KYB uploads are forwarded byte for byte after MIME/magic-byte/size validation. Dispute evidence is base64 encoded into JSON and is not forwarded as raw bytes.
- Upload limits: JSON bodies 2 MiB, multipart 10 MiB, evidence file 712,704 bytes, POS stream timeout 15 minutes. Core has its own limits and must re-check uploads.
- Logs redact sensitive keys and truncate long strings, but tokens, signatures, credentials and document contents must never be logged by application code.
- API-token scopes are stored but not enforced per endpoint; treat portal and token-based authorization as core-enforced, not edge-enforced.
- There is no edge session revocation or per-call MFA cache. Disabling the user in core is the effective emergency stop.

## 11. References

- [`blueprint.md`](./blueprint.md) (generated from the canonical parts)
- [`project-design/parts/02-edge-services/02-merchant-back.md`](../project-design/parts/02-edge-services/02-merchant-back.md)
- [`project-design/parts/02-edge-services/00-shared-core-upstream-client.md`](../project-design/parts/02-edge-services/00-shared-core-upstream-client.md)
- [`project-design/parts/00-platform/02-security-and-mtls.md`](../project-design/parts/00-platform/02-security-and-mtls.md)
- [`project-design/appendices/api-route-matrix.md`](../project-design/appendices/api-route-matrix.md)
- [`project-design/appendices/env-and-config-matrix.md`](../project-design/appendices/env-and-config-matrix.md)

## Security hardening (2026-11-05)

Token creation rejects malformed CIDRs and ranges broader than /8 (IPv4) or /32 (IPv6); scopes are lowercase `resource:action`, unique, at most `TOKEN_MAX_SCOPES` (20); `expiresAt` must be a future ISO date within `TOKEN_MAX_TTL_DAYS` (365), default `TOKEN_DEFAULT_TTL_DAYS` (90); `pg_live_` tokens are `pg_live_` plus 43 base64url characters. The external limiter keys on token hash plus IP. Uploads require a bearer token and Content-Length (411) and are size-checked (413) before buffering (`UPLOAD_RATE_LIMIT_MAX`). Cash-out creation forwards `idempotencyKey` (body or `Idempotency-Key` header). Rate-limit windows: `AUTH_/API_/EXTERNAL_RATE_LIMIT_WINDOW_MS`.

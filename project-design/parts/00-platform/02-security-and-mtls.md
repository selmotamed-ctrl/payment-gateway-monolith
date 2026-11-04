---
id: platform.security
title: Security and mTLS
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - core-back/index.ts
  - core-back/api/middleware/mtlsGuard.ts
  - core-back/api/middleware/authDoubleCheck.ts
  - core-back/api/middleware/makerCheckerGuard.ts
  - core-back/lib/auth/index.ts
  - core-back/lib/auth/uiAuthorities.ts
  - core-back/lib/auth/confidentialAccess.ts
  - core-back/engine/crypto/Vault.ts
  - core-back/engine/crypto/CryptoEngine.ts
  - core-back/engine/apiConsumer/ApiConsumer.ts
  - core-back/engine/apiConsumer/compileUrl.ts
  - core-back/engine/apiConsumer/fakeRailsAllowlist.ts
  - core-back/engine/flow/StepExecutor.ts
  - core-back/engine/runtime/callbackVerifier.ts
  - admin-back/api/middleware/lanGuard.ts
  - admin-back/api/middleware/authorityGuard.ts
  - core-back/scripts/generate-mtls-certs.ts
design_sources:
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#22-mutual-tls-mtls-inter-service-transport-architecture
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#12-fourteen-engineering-safeguards-inter-service-double-validation--stride-threat-model
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#101-the-14-code-level-engineering-safeguards
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#102-complete-24-item-stride-threat-register
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#21-service-roles-boundaries-and-security-constraints
  - design/90-archive/delivery-logs/opencode_technical_delivery_design.md#41-core-back-mtls-server--channel-bound-cn-guard
tests:
  - core-back/test/phase1-mtls-and-schema.test.ts
  - core-back/test/exhaustive/05-api-matrix/mtls-channel-isolation.test.ts
  - core-back/test/exhaustive/08-security-edge/stride-24-and-15-safeguards.test.ts
  - core-back/test/exhaustive/03-transforms-crypto/crypto-profiles-and-vault.test.ts
  - core-back/test/fake-rails-allowlist.test.ts
  - admin-back/test/env-isolation.test.ts
  - merchant-back/test/env-isolation.test.ts
  - checkout-back/test/env-isolation.test.ts
gaps:
  - Session JWTs are stateless; there is no session revocation table and no per-call MFA claim enforcement.
  - API-token scopes are stored but not enforced per merchant endpoint.
  - Merchant internal routes do not use per-route authority guards.
  - Google OIDC login returns 501.
  - Storage mTLS certificates are generated but not consumed by PostgreSQL/Redis.
  - The backup daemon certificate environment names are not aligned with core.
---

# Security and mTLS

## 1. Purpose and scope

This part records the actual security controls of the platform: the TLS and mutual-TLS configuration, channel-bound certificate identity, bearer authentication and authority checks, MFA and revocation behavior, maker-checker enforcement, secret storage and redaction, SSRF protections, webhook verification, edge LAN controls and the deployment PKI.

It describes what the code enforces, not what the historical designs aspired to. Where the historical documents claim a control that is only partially wired, the limitation is stated explicitly.

## 2. Design intent (extracted and synthesized from ./design)

The historical design is a zero-trust seven-service architecture:

- `core-back` is the only service with database and KMS access and the only service that executes outbound money-moving calls.
- The three edge backends are untrusted from core's point of view. They authenticate to core with distinct client certificates whose common names are bound to namespaces: `admin-back`, `merchant-back`, `checkout-back`.
- Core independently re-validates every payload, token, user/merchant state, authority, amount, link state and maker-checker invariant. Compromising an edge must not be enough to move money or elevate authority.
- Fifteen engineering safeguards are specified: prototype-pollution-safe `recursiveSet`, promise-cached consumers, single-flight token refresh, jittered refresh timers, atomic rotated-refresh persistence, per-step timeouts, strict money-step retry boundaries, raw-text-first parsing, multi-layer secret redaction, SSRF/DNS-rebinding protection, host-pinned credentials, distributed invalidation, destination-correct encoding, final-URL re-validation, and edge-to-core double validation.
- Maker-checker is enforced at the database constraint/trigger, the approval service and the HTTP middleware. A checker must differ from the maker; system automation can never check.
- Browser callbacks and return URLs are untrusted hints. Webhooks are verified with constant-time signatures across active secret versions, source IP allowlists and replay windows.
- Secrets are write-only to clients, encrypted at rest with AES-256-GCM, bound to a key id, redacted from logs, and never exported in configuration.

## 3. As-built architecture

### 3.1 TLS 1.3 server and client

`core-back/createHttpsServer()` reads the server key, server certificate and internal CA from `MTLS_SERVER_KEY_PATH`, `MTLS_SERVER_CERT_PATH` and `MTLS_CA_CERT_PATH`. A missing file aborts startup with a message instructing the operator to run `bun run generate-mtls-certs`.

The server is created with Node's `tls.createServer`:

```ts
tls.createServer({
  key: readSecretFile("mTLS server key", env.MTLS_SERVER_KEY_PATH),
  cert: readSecretFile("mTLS server certificate", env.MTLS_SERVER_CERT_PATH),
  ca: [readSecretFile("internal CA certificate", env.MTLS_CA_CERT_PATH)],
  requestCert: true,
  rejectUnauthorized: true,
  minVersion: "TLSv1.3",
});
```

A plain `http.Server` is created around the Express app, and every `secureConnection` socket is fed into it. TLS handshake errors are logged without certificate material. `x-powered-by` is disabled.

The edge backends use `https.Agent` with:

- `cert`, `key` and `ca` read from their client certificate paths.
- `minVersion: "TLSv1.3"` and `maxVersion: "TLSv1.3"`.
- `rejectUnauthorized: true`.
- keep-alive with 30-second keep-alive and 64 maximum sockets.
- the request timeout from `CORE_REQUEST_TIMEOUT_MS`.

The edge sets SNI `servername` only when the core URL host is not an IP literal. A core server certificate must therefore contain the DNS/IP identity used by `CORE_BACK_URLS`.

### 3.2 Channel-bound common-name guard

`requireEdgeIdentity(expectedCn)` runs before every internal namespace router. It:

1. Reads `request.socket` as a `TLSSocket`.
2. Rejects with `401 MTLS_UNAUTHORIZED` if `socket.authorized` is false.
3. Reads the peer certificate subject CN; array CNs use the first entry.
4. Rejects with `401 MTLS_UNAUTHORIZED` if the CN cannot be inspected.
5. Rejects with `403 FORBIDDEN_SERVICE_IDENTITY` if the CN differs from the expected edge name.

The bindings are exactly:

```text
/internal/admin/*     -> admin-back
/internal/merchant/*  -> merchant-back
/internal/checkout/*  -> checkout-back
```

There is no mapping from a certificate to a specific core node or tenant. One certificate per edge role is the trust unit.

### 3.3 Bearer authentication

`authenticate()` resolves a bearer token in two modes:

1. **`pg_live_...` API token.**
   - SHA-256 hashes the token and looks up `AccessToken` by `tokenHash`.
   - Rejects an unknown token with `401 ACCESS_TOKEN_INVALID`.
   - Rejects a revoked token with `401 ACCESS_TOKEN_REVOKED`.
   - Reads scopes from `AccessToken.scopes`.
   - If `ipWhitelistEnabled`, resolves the client IP from `x-real-client-ip` first and checks it against `AccessTokenIp.cidr` entries; failure is `403 ACCESS_TOKEN_IP_NOT_ALLOWED`.
   - Updates `lastUsedAt`.
   - Returns a principal with `kind: "apiToken"`, `role: "MERCHANT_API"`, the token merchant/application, and the scopes as both authorities and scopes.

2. **Session JWT (anything else).**
   - Verifies the HS256 signature, issuer `payment-gateway-core` and audience `payment-gateway-edge`.
   - Rejects an invalid or expired token with `401 SESSION_INVALID`.
   - Loads the user and rejects a missing user with `401 SESSION_USER_MISSING`.
   - Rejects a non-`ACTIVE` user with `403 SESSION_USER_INACTIVE`.
   - Reads `authoritiesMap` from the database, not from the JWT; empty authorities are rejected with `403 SESSION_AUTHORITIES_EMPTY`.
   - Returns `kind: "session"`, user id, role, merchant id, authorities and `sessionId` equal to the JWT subject.

The session key and MFA-challenge key are derived with HKDF-SHA256 from `KMS_MASTER_KEY` using the purposes `session-signing` and `mfa-challenge`. Session lifetime is 12 hours; MFA challenge lifetime is 10 minutes. The JWT includes a `mfa` boolean claim and an `appScopeIds` array.

### 3.4 Actual MFA, revocation and IP behavior

| Control | Admin | Merchant | API token | Notes |
| :--- | :--- | :--- | :--- | :--- |
| Password login | Yes | Yes | N/A | bcrypt cost 12 |
| MFA challenge issued when `user.mfaRequired` | Yes | Yes | N/A | 6-digit code, HMAC stored in challenge token, notification row queued |
| MFA enforced on every request | No | No | N/A | `resolveSessionPrincipal` does not inspect `claims.mfa` |
| Session revocation | No per-session revocation | No per-session revocation | Yes, `revokedAt` | Disabling a user blocks the next request because the user is re-read; changing a password does not invalidate existing JWTs |
| IP allowlist | Edge LAN CIDR only | API token CIDR only | Yes | Core does not enforce an admin IP list |
| Authority source | DB `authoritiesMap` | DB `authoritiesMap` | Token scopes | Session JWT authorities are not trusted for authorization decisions |
| Google OIDC | N/A | 501 | N/A | Merchant `/auth/google` is a stub |

The `pg_live_` token IP check trusts `x-real-client-ip` without checking that the immediate peer is a trusted proxy. That is acceptable only because core is expected to be reachable solely through the mTLS edge and a private network; a direct core access path would make the header spoofable.

The admin edge also enforces `ADMIN_LAN_CIDRS` through `enforceLanAccess`, resolving the client IP through `TRUSTED_PROXY_CIDRS`. That is an edge control; core itself has no admin IP guard.

### 3.5 Authority enforcement

Most admin internal routes call `requireAuthorities(request, [...])` per handler. The semantics are OR: any one of the listed authorities (or `*`) satisfies the requirement. The authority list is read from the database-backed principal. Examples:

- `security:read` for users/audit/backups overview.
- `merchant:read` / `merchant:write` for merchant surfaces.
- `kyb:read` / `kyb:write`, `compliance:read` / `compliance:write`.
- `approval:read` and `approval:check` / `approval:write`.
- `gateway:read` / `gateway:write`, `gateway:test`.
- `settings:read` / `settings:write`, `finance:read` / `finance:write`, `cashout:read` / `cashout:review`.
- `case:read` / `case:write`, `operator:read` / `operator:write`.

Not every authenticated admin route has a specific authority. `GET /stats/overview`, `POST /stats/export-audit`, `GET /options/:kind` and the current-user academy progress routes require only a valid admin session. See `01-core-back/01-api-surface.md`.

The admin edge's `requireAuthorities` parses unverified JWT claims only to hide/deny screens early. It normalizes a small role-to-authority alias map for `COMPLIANCE`/`MLRO`. Core is the authority.

Merchant internal routes do not call `requireAuthorities`. They authenticate, require a `merchantId` binding, and use `merchantIdOf(request)` to scope queries. API-token scopes are stored but not checked per endpoint. `requireMerchantScope` is exported from the merchant router but has no production caller. This is a material authorization gap relative to the design.

Checkout internal routes are intentionally unauthenticated: the long link key and attempt id are capabilities, and the payer must not need an account. The checkout edge validates the shape and forbids monetary fields; core re-validates and resolves the amount from `payment_links.amount`.

### 3.6 Maker-checker enforcement

There are three enforcement layers:

1. **Database:** `approval_requests_checker_not_maker_insert` is a `CHECK` constraint, and `approval_requests_checker_not_maker_update` is a `BEFORE UPDATE` trigger. Both are in the PostgreSQL baseline migration.
2. **Middleware:** `actorFromRequest` requires a human user id, rejects `SYSTEM_AUTOMATION` as an actor, and computes `isChecker` from `approval:check`. `assertCheckerIsNotMaker` rejects equal or missing maker/checker ids. `assertCheckerAuthority` requires the checker authority.
3. **Execution:** `executeApprovalSubject` re-checks that the checker is not the system automation principal, that a checker exists and that maker != checker before dispatching to a subject-specific handler.

The approval endpoint additionally applies domain checks:

- An admin-assisted join request prepared by the same operator cannot be checked by that operator.
- Merchant approvals restrict the checker role by payload domain via `merchantApprovalCheckerAllowed`.
- Backup policy approvals require the daemon to be configured and are executed out of band by the backup route.

The executable subject coverage is uneven. `executeApprovalSubject` handles `AML_CASE`, `OPERATOR_CASE`, `ADJUSTMENT`, `REGULATORY_REPORT`, `REPORTING_RULE`, `AML_RULE`, `JOIN_REQUEST`, `MERCHANT`, `COMMISSION_PROFILE`, `VELOCITY_RULE`, `USER` and `GATEWAY_VERSION`. Any other subject type throws `409 NO_EXECUTABLE_SUBJECT`. `BACKUP_POLICY` is handled specially in the approve route. `APPLICATION` approvals are created by the merchant route but have no handler, so they remain `PENDING_REVIEW` and cannot be executed. Cash-out processing and some settings/commission/velocity writes execute under a single authority-holding actor rather than through the approval queue; see `01-core-back/01-api-surface.md` for the exact list.

### 3.7 Secrets and cryptographic material

- The vault encrypts with AES-256-GCM, a random 12-byte IV and the key id as additional authenticated data. The payload is `keyId:iv:authTag:ciphertext` in base64 segments.
- The master key resolution supports `KMS_MASTER_KEY` as a 32-byte value, a base64 32-byte value, a `keyId:base64key` value, or a JSON key map. `KMS_KEYS_JSON` can hold multiple direct 32-byte keys.
- A non-32-byte master secret is SHA-256 hashed once; per-key material is derived with HKDF-SHA256 using the key id and the context `payment-gateway:vault:aes-256-gcm:v1`.
- Redaction covers exact sensitive names (`password`, `secret`, `token`, `otp`, `cvv`, `pan`, `authorization`, `apikey`, `webhooksecret`, `clientsecret`, `privatekey`), a broad sensitive-name pattern, literal decrypted secrets (longest first), and Luhn-valid 12-19 digit sequences.
- Credential sets store encrypted entries in `entriesCiphertext`; the API never returns a secret, only write/replace/verify operations.
- KMS material is core-only. Edge services receive only their client certificate, key and CA. Deploy writes database and KMS values only to the core host.

`CryptoEngine` implements the signing side of the declarative crypto profiles: HMAC-SHA256/512, RSA-SHA256 and SHA-256, with UTF8/HEX/BASE64 key decoding and HEX_LOWER/HEX_UPPER/BASE64 output. Canonicalization modes include `MOAMALAT_SECURE_HASH`, `DPAY_WEBHOOK_VERIFY`, `PLUTU_CALLBACK_HASH`, `MYPAY_RAW_BODY`, `SORTED_KEY_VALUE_AMP`, `TIMESTAMP_DOT_RAW_BODY`, `SORTED_VALUES_HASH`, `TEMPLATE_STRING`, `JSON_CANONICAL` and `RAW_BODY`. Signature comparison is constant-time via SHA-256 hashing plus `timingSafeEqual`.

### 3.8 SSRF and outbound hardening

Outbound gateway calls run through `StepExecutor` and/or `ApiConsumer`. Both enforce:

- **HTTPS only**, except for the explicitly scoped Fake Rails host.
- **Host allowlist:** the final URL host must appear in the gateway version's `allowed_hosts` when the list is non-empty.
- **No userinfo, no fragments, no backslashes, no encoded path separators, no `.`/`..` traversal.**
- **No control characters** in URLs, headers, query keys/values.
- **No redirects:** fetch uses `redirect: "manual"` and a 3xx response becomes `GATEWAY_REDIRECT_BLOCKED`.
- **DNS resolution guard:** for a hostname, every resolved address must be public. The blocked IPv4 ranges include `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, multicast and reserved ranges. IPv6 blocks loopback, unspecified, IPv4-mapped/compatible, NAT64, discard, Teredo, 6to4, unique-local, link-local, multicast and documentation ranges.
- **Fake Rails exception:** only when `ALLOW_FAKE_RAILS_HOSTS=true`, the host is in `FAKE_RAILS_ALLOWED_HOSTS`, and the same host is in the gateway version's `allowed_hosts`. The exception is exact-host, not a CIDR.
- **Response cap:** default 2 MiB, enforced both by `Content-Length` and by streaming byte count.
- **JSON depth cap:** 64 by default.
- **XML DTD/entity block:** a response containing `<!DOCTYPE` or `<!ENTITY` is rejected.
- **Timeouts:** per-step `timeout_ms` or the consumer timeout, implemented with `AbortController`.
- **Retry boundary:** a `MOVES_MONEY` step always has one attempt. Timeouts, resets and 5xx on a money step become `UNKNOWN`, not retries. Non-money steps may retry according to the declarative policy.

`ApiConsumer` also blocks authentication errors on safe pre-money steps by refreshing once and retrying, with a single-flight refresh promise. Refresh timers use ±10% jitter and are unref'd. The newer refresh token is persisted before the refresh promise resolves.

### 3.9 Webhook verification

The inbound channel flow is:

1. Checkout edge captures the raw bytes and a small forwardable header set.
2. Core resolves `ConfirmationChannel` by `pathToken`.
3. Core checks the gateway code and the bound environment are enabled.
4. Core computes a dedupe key from `channel.id` and the raw body, creates an `inbound_events` row, and correlates the attempt from the channel's selector.
5. `PrismaCallbackVerifier` checks the source IP allowlist, timestamp tolerance (default 300 seconds), correlation, and the channel verification method.
6. For `IP_ONLY` or `NONE_PLUS_INQUIRY`, the callback is accepted only as `mustInquire`; the engine then performs an inquiry before trusting the result.
7. For signed methods, the signature is verified in constant time against every active secret version of the attempt's credential set.
8. Evidence is built from the payload plus derived status/reference/amount/currency and the attempt environment; raw payload fields may not overwrite the derived status/amount/currency.
9. The engine applies the trusted-success facts and posts the ledger only when status, reference, amount tolerance, currency and environment all match.

The inbox stores `content-type` and `content-length` in `redactedHeadersJson`, not the full signature header set. The live request path verifies with the full request headers before responding, so the synchronous path is correct; the inbox worker's replay path has less header material. That is recorded as a gap for asynchronous replay.

### 3.10 Edge controls

- `admin-back` runs `enforceLanAccess` on `/api/v1/admin`, using `ADMIN_LAN_CIDRS` and trusted proxy CIDRs.
- Admin auth has a 10-request/15-minute limiter; admin protected routes have a 600-request/60-second limiter.
- Merchant auth has a 20-request/15-minute limiter; portal API 300/60s; external API 120/60s.
- Checkout pay has 120/60s; inbound webhook has 600/60s.
- Upload limits: admin 20 MiB, merchant 10 MiB, checkout inbound 3 MiB at the edge; core raw-body limit is 25 MiB.
- KYB uploads are checked by declared MIME and magic bytes in both the edge and core; core stores the detected type, not the declared one.
- The admin edge's authority guard is advisory; core re-checks authorities.
- CORS is `origin: true` with credentials disabled on all three edges. The source of truth for browser safety is the reverse proxy/CSP and the bearer-token model, not CORS.

## 4. Contracts and invariants

1. **No plaintext core listener.** `core-back` only exposes the `tls.Server` created by `createHttpsServer`. Tests may call `createApp()` directly, but production startup does not.
2. **No edge database credentials.** Env isolation tests assert that `DATABASE_URL`, `KMS_MASTER_KEY` and other core-only variables are absent from edge plans.
3. **Certificate identity is namespace identity.** A valid certificate from the internal CA is not enough; the CN must match the namespace.
4. **Authorities come from core's database.** The edge may decode a JWT to hide a screen, but cannot grant access.
5. **Maker-checker is never relaxed for automation.** `SYSTEM_AUTOMATION` may draft but may never check.
6. **Money steps never auto-retry.** This is enforced in both `StepExecutor` and `ApiConsumer`.
7. **Secrets are write-only.** No route returns a credential value; verification returns a verdict, not the secret.
8. **Payload validation is repeated in core.** Edges validate for UX; core re-parses with Zod and enforces business invariants.
9. **Client-supplied amount/currency is rejected on checkout.** The edge calls `assertNoMonetaryFields`; core reads the amount from the link.
10. **SSRF is default-deny.** The Fake Rails exception requires three simultaneous conditions and is exact-host.

## 5. Data / API / config / deployment surface

### 5.1 Certificate inventory

| Certificate | Common name | Consumer | Purpose |
| :--- | :--- | :--- | :--- |
| `internal-ca.crt/key` | CA | Core server, all edges, backup daemon | Signs and verifies internal certificates |
| `core-back.crt/key` | Server identity (SAN: core DNS/IPs) | `core-back` | TLS server |
| `admin-back-client.crt/key` | `admin-back` | `admin-back` | mTLS client to core |
| `merchant-back-client.crt/key` | `merchant-back` | `merchant-back` | mTLS client to core |
| `checkout-back-client.crt/key` | `checkout-back` | `checkout-back` | mTLS client to core |
| Backup daemon certificate/key | Daemon identity | `pg-backup-daemon` | mTLS server for core backup client |
| Storage client certs | Storage roles | Generated by deploy | Intended for PostgreSQL/Redis mTLS; not consumed today |

### 5.2 Security env keys

- `MTLS_CA_CERT_PATH`, `MTLS_SERVER_CERT_PATH`, `MTLS_SERVER_KEY_PATH` on core.
- `MTLS_CA_CERT_PATH`, `MTLS_CLIENT_CERT_PATH`, `MTLS_CLIENT_KEY_PATH` on edges.
- `KMS_MASTER_KEY` (minimum 16 characters), optional `KMS_KEYS_JSON`.
- `TRUST_PROXY` on core; `TRUSTED_PROXY_CIDRS` and `ADMIN_LAN_CIDRS` on the edges.
- `BACKUP_DAEMON_CA_CERT_PATH`, `BACKUP_DAEMON_CLIENT_CERT_PATH`, `BACKUP_DAEMON_CLIENT_KEY_PATH`.
- `ALLOW_FAKE_RAILS_HOSTS`, `FAKE_RAILS_ALLOWED_HOSTS`.
- `ACCESS_TOKEN`-related fields live in the database, not env.

### 5.3 Security-relevant routes

- Public within channel: `GET /internal/admin/health`, `GET /internal/merchant/health`, `GET /internal/checkout/health`, admin/merchant auth login and MFA routes, merchant registration/verify/accept-invitation, checkout pay/return/inbound.
- Authenticated: all other merchant routes and all admin routes after `router.use(requireAuthentication)`.
- Authorities: most admin business routes call `requireAuthorities`; backups and approvals are the most sensitive. The documented authenticated-only exceptions are the dashboard overview/export-audit, options and current-user academy progress.
- Maker-checker: `POST /internal/admin/approvals/:id/approve`, `/reject`, plus proposal routes.
- Raw body: `/internal/checkout/inbound*`, `/internal/merchant/onboarding/kyb-documents`, `/internal/admin/reconciliation/upload`, `/internal/admin/join-requests/:id/kyb-documents`.

## 6. Operational usage

### 6.1 Generate and rotate PKI

```bash
cd core-back
bun run generate-mtls-certs
```

The script writes the CA, server and three client certificates under `core-back/certs/`. Deploy regenerates or rotates the same material per environment. A certificate rotation must keep the old client certificate valid until every edge node has switched, or a rolling restart will produce `CORE_TLS_ERROR` handshakes.

### 6.2 Verify channel isolation

1. Use the admin client certificate against `/internal/merchant/...`; expect `403 FORBIDDEN_SERVICE_IDENTITY`.
2. Use a certificate signed by a different CA; the TLS handshake must fail.
3. Use no client certificate; the handshake must fail.
4. Use an authorized certificate with no bearer where the route requires one; expect `401 AUTH_REQUIRED`.

### 6.3 Verify a `pg_live_` token

1. Create a token in the merchant portal; the plaintext is returned once.
2. Call `/api/v1/external/*` with `Authorization: Bearer pg_live_...`.
3. If the token has an IP allowlist and the request comes from another address, expect `403 ACCESS_TOKEN_IP_NOT_ALLOWED`.
4. Revoke with `DELETE /internal/merchant/tokens/:id`; the next call must return `401 ACCESS_TOKEN_REVOKED`.

### 6.4 Emergency controls

- Disable a user by setting `status` away from `ACTIVE`; the next session request is rejected because the user is re-read.
- Revoke an API token with `revokedAt`; the next API request is rejected.
- Suspend a merchant; checkout resolves the environment from merchant status, and active links become unavailable according to the link/state checks.
- A suspected session compromise cannot be revoked per session; rotate `KMS_MASTER_KEY` or disable the user. Rotating the master key invalidates all sessions and makes existing vault ciphertext unreadable unless the old key is retained as a key id in `KMS_KEYS_JSON`.

## 7. Status and deviations

### Implemented

- TLS 1.3 mTLS server and clients with CA verification.
- Channel-bound CN authorization for the three internal namespaces.
- Database-backed authority checks on the admin namespace.
- `pg_live_` revocation and optional IP allowlists.
- Maker-checker at database, middleware and execution layers.
- AES-256-GCM vault with per-key derivation, write-only secrets and multi-layer redaction.
- SSRF guards in both `StepExecutor` and `ApiConsumer`, including scoped Fake Rails behavior.
- Signed/IP/inquiry webhook verification with replay and environment checks.
- Edge LAN guard, rate limits, upload signature checks and raw-body preservation.

### Partial

- **Session lifecycle.** JWTs are stateless with a 12-hour TTL. There is no session table, no per-session revoke and no per-request MFA assertion. Disabling a user is the effective emergency stop.
- **Merchant authorization.** Merchant routes scope by `merchantId` but do not enforce per-route authorities or token scopes. This is broader than the design.
- **Approval execution.** Some subject types have no executable handler; `APPLICATION` is the clearest example. Some money-adjacent writes bypass the approval queue.
- **Admin IP enforcement.** The CIDR check is at `admin-back`; a direct mTLS call that bypasses the edge is not IP-restricted.
- **Backup/storage mTLS.** The backup control plane is mTLS-capable but the provisioner variable names are mismatched; storage certificates are not consumed by PostgreSQL/Redis.
- **Inbound replay.** The inbox stores a reduced header set, which limits asynchronous signature replay.

### Missing / deferred

- Google OIDC login (501).
- A session-revocation list or token-version claim.
- Per-endpoint merchant scopes and authority checks.
- A universal approval handler for `APPLICATION`, `CASHOUT_REQUEST`, `GATEWAY`, `CREDENTIAL_SET`, `KYB_DOCUMENT`, `PLATFORM_SETTING` and similar subject types.
- Hardware KMS/HSM integration; the current KMS is an environment master key or an injected `VaultKms` resolver.
- Data-loss-prevention or outbound secret scanning beyond redaction.
- Full gateway wire-log redaction pipeline; step logs are redacted, but no separate wire log database exists.

### Known bugs / risks

- **Code gap:** `resolveSessionPrincipal` ignores the `mfa` claim, so MFA is a login gate, not a per-call assertion.
- **Code gap:** the `x-real-client-ip` header is trusted by the API-token IP check without verifying that the peer is the edge. Core's private-only boundary is the compensating control.
- **Code gap:** `requireMerchantScope` is dead code in production.
- **Code gap:** `auth/me` in both admin and merchant routers returns a static platform name/version and is not behind the authentication middleware in the admin router (it is registered before `router.use(requireAuthentication)`).
- **Documentation gap:** historical v5 §2.2 states that core checks revocation, MFA and IP allowlists on every call; the actual behavior is narrower, as above.

## 8. Verification and tests

- `core-back/test/phase1-mtls-and-schema.test.ts` verifies the PKI material and schema.
- `core-back/test/exhaustive/05-api-matrix/mtls-channel-isolation.test.ts` verifies the namespace/CN matrix.
- `core-back/test/exhaustive/08-security-edge/stride-24-and-15-safeguards.test.ts` covers the STRIDE/safeguard catalog at the unit level.
- `core-back/test/exhaustive/03-transforms-crypto/crypto-profiles-and-vault.test.ts` covers encryption, key derivation, canonicalization and redaction.
- `core-back/test/fake-rails-allowlist.test.ts` covers the three-condition SSRF exception.
- `core-back/test/runtime/raw-body.test.ts` covers opaque body preservation.
- `admin-back/test/env-isolation.test.ts`, `merchant-back/test/env-isolation.test.ts` and `checkout-back/test/env-isolation.test.ts` assert the secret boundary.
- `admin-back/test/mtls-client.test.ts`, `merchant-back/test/mtls-client.test.ts` and `checkout-back/test/mtls-client.test.ts` cover the client transport.

No test run was performed for this documentation change. Integration suites that need PostgreSQL/Redis or live certificates are environment-dependent.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` §2.1 service roles, §2.2 mTLS transport, §12 safeguards and STRIDE.
- `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md` §10.1 fourteen safeguards, §10.2 STRIDE register, §15.2–§15.4 roles and four-eyes.
- `design/90-archive/delivery-logs/opencode_technical_delivery_design.md` §4.1 server/CN guard, §4.2 edge mTLS wrapper.
- `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md` §12 security.

### Code paths

- `core-back/index.ts` for TLS server configuration.
- `core-back/api/middleware/mtlsGuard.ts` for CN binding.
- `core-back/api/middleware/authDoubleCheck.ts` for bearer/session/API-token resolution.
- `core-back/api/middleware/makerCheckerGuard.ts` for maker/checker guards.
- `core-back/lib/auth/index.ts` for JWT/MFA derivation.
- `core-back/engine/crypto/Vault.ts` and `CryptoEngine.ts` for encryption, signing and redaction.
- `core-back/engine/apiConsumer/compileUrl.ts`, `ApiConsumer.ts`, `fakeRailsAllowlist.ts` for SSRF and outbound controls.
- `core-back/engine/flow/StepExecutor.ts` for the step-level SSRF/retry controls.
- `core-back/engine/runtime/callbackVerifier.ts` for webhook verification.
- `admin-back/api/middleware/lanGuard.ts` and `authorityGuard.ts` for edge controls.
- `scripts/generate-mtls-certs.ts` for local PKI.

### Generated appendices

- `project-design/appendices/stale-claims-register.md` (SC-025, SC-026, SC-027)
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/api-route-matrix.md`

## 10. Change history

- 2026-11-03: Initial canonical security part written against `5a24f6f+working-tree`; records actual MFA/revocation/IP enforcement and the merchant authorization gap.

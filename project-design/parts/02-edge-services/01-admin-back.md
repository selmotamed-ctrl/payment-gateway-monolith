---
id: edge.admin
title: Admin Edge BFF
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - admin-back/index.ts
  - admin-back/api/**
  - admin-back/lib/env/index.ts
  - admin-back/lib/coreInternalClient.ts
  - admin-back/lib/net/index.ts
  - admin-back/lib/error/index.ts
  - admin-back/lib/requestLogger/index.ts
design_sources:
  - design/payment_gateway_final_design-v5.md#21-service-roles-boundaries-and-security-constraints
  - design/payment_gateway_final_design-v5.md#163-admin-back-lan-only-api-apiv1admin---forwards-to-core-back-internaladmin
  - design/payment_gateway_deployment_and_guides_architecture.md#5-host-aware-ufw-firewall--network-isolation-provisioning
tests:
  - admin-back/test/admin-surface.test.ts
  - admin-back/test/core-contract.test.ts
  - admin-back/test/core-internal-client.test.ts
  - admin-back/test/mtls-client.test.ts
  - admin-back/test/backups.test.ts
  - admin-back/test/academy-progress.test.ts
  - admin-back/test/env-isolation.test.ts
gaps:
  - Edge authority gating decodes JWT claims without verifying the signature or expiry; it is advisory and forgeable, and core remains the only enforcement point.
  - Most admin routes are protected only by the presence of an Authorization header; AML and backup routes are the only edge-level authority checks.
  - The login/MFA rate limiter uses a fixed 15-minute window and ignores AUTH_RATE_LIMIT_WINDOW_MS.
  - CORS reflects any origin and the LAN guard's trust in forwarded IP headers depends on the reverse-proxy topology.
  - The admin KYB join-request upload route forwards the file without the shared MIME/magic-byte validation used by merchant uploads and reconciliation.
---

# Admin Edge BFF

## 1. Purpose and scope

`admin-back` is the private-LAN API edge for the back office. It terminates browser requests from `admin-front`, enforces the LAN boundary and coarse-grained authority hints, validates and translates the public admin vocabulary into the canonical `core-back` contract, and forwards every operation over mTLS to `/internal/admin/*`.

It owns no database connection, no Prisma client, no `DATABASE_URL`, no `KMS_MASTER_KEY` and no business authority. The service is a stateless Express 5 application built for Bun.

Scope boundaries:

- Owns the admin LAN ingress, LAN CIDR check, rate limiting, request logging, upload buffering, schema validation and body mapping.
- Does not own JWT signature verification, session revocation, MFA state, IP allowlists for individual users, maker-checker enforcement or money movement.
- Does not own the backup daemon; it proxies backup control routes to `core-back`, which talks to `pg-backup-daemon` over mTLS.

## 2. Design intent (extracted and synthesized from ./design)

The historical design places the admin portal on a private LAN, behind a non-forwarded reverse proxy on port 8443. The admin backend binds to loopback. Every request is forwarded to `core-back` over TLS 1.3 using a client certificate with `CN=admin-back`; the core rejects that certificate on the merchant or checkout channels.

The design describes the edge as validating input with shared Zod schemas, enforcing LAN rate limits and admin session/MFA headers, and leaving session verification, revocation, MFA and authority checks to `core-back`. It also requires maker-checker for sensitive actions, with the checker different from the maker, enforced by the core.

The admin surface is intentionally broad: users, join requests and KYB, merchants, approvals, AML, gateway catalog and wizard, rails/routes, operations, reconciliation, finance, settings, audit logs and backup controls.

## 3. As-built architecture

### 3.1 Process and listener

`admin-back/index.ts` creates an Express app with:

- `x-powered-by` disabled;
- `trust proxy` disabled at the Express layer (`app.set("trust proxy", false)`);
- CORS with `origin: true` and `credentials: false`;
- request logging middleware;
- an unauthenticated `GET /health` returning `{ status: "ok", service: "admin-back", uptime }`;
- JSON and URL-encoded body parsers limited by `MAX_JSON_BODY_BYTES`;
- the admin router mounted at `/api/v1/admin`, wrapped by `enforceLanAccess`;
- a JSON 404 handler and the shared error handler.

The listener binds to `ADMIN_BIND_HOST` (default `127.0.0.1`). The deploy engine writes `ADMIN_BIND_HOST=127.0.0.1`, so only the co-located Nginx vhost reaches the process. The admin Nginx vhost is exposed on `ADMIN_NGINX_LAN_PORT` (default 8443) and restricted to `LAN_ALLOWED_CIDRS`.

### 3.2 Middleware and guards

| Layer | Behavior |
| :--- | :--- |
| `enforceLanAccess` | Resolves the client IP from `x-real-ip`/`x-real-client-ip` only when the immediate peer is loopback or in `TRUSTED_PROXY_CIDRS`, then requires the result to be inside `ADMIN_LAN_CIDRS`. Failure is `403 ADMIN_LAN_ONLY`. Applied to the entire `/api/v1/admin` router, including `/auth`. |
| `adminLimiter` | 600 requests per 60 seconds by default (`ADMIN_RATE_LIMIT_MAX`), applied to the protected router. Returns `429 RATE_LIMITED`. |
| `authLimiter` | 10 requests per fixed 15 minutes by default (`AUTH_RATE_LIMIT_MAX`), applied to `/auth`. The `AUTH_RATE_LIMIT_WINDOW_MS` setting is defined but not used here. |
| `requireSession` | Rejects a missing `Authorization` header with `401 AUTH_REQUIRED`. It does not parse or verify the header. |
| `requireAuthorities` | Reads `role`, `roles`, `authorities` and `authorities_map` from the base64url JWT payload, then checks that at least one requested authority or role is present. `COMPLIANCE` and `MLRO` are aliases for `aml:read`/`aml:write`. |
| Search limiter | `POST /search` has its own 120-requests-per-minute limiter keyed by a SHA-256 hash of the bearer token or IP. |
| Upload middleware | Multer memory storage with `MAX_UPLOAD_BYTES`; the reconciliation route validates the detected MIME type and magic bytes through `assertAllowedUpload`, while the join-request KYB route forwards the raw file without that check. |

`extractAuthorityHints()` does not verify the token signature and does not check `exp` or `nbf`. It rejects a token only when a present `typ` is not `session`, a present `iss` is not `payment-gateway-core`, or a present `aud` does not include `payment-gateway-edge`. A caller can therefore craft a token that satisfies the edge's AML or backup gate; `core-back` will still reject it. This is documented as advisory gating, not authentication.

`ADMIN_AUTHORITY_HINTS` filters which requested authority strings the edge checks. If the configured list is empty, the edge skips the check. If a requested authority is not in the configured list, it is not counted as expected; if no expected authorities remain, the route passes.

### 3.3 Forwarding behavior

`admin-back/api/forward.ts` implements `coreForward()`:

1. Reads the `Authorization` header and validates route params and query with Zod where configured.
2. Skips the body for `GET`/`HEAD`; otherwise validates the public body with the route schema.
3. Applies `bodyFrom()` to translate the public body into the canonical core body.
4. Calls `callCoreResponse()` over the shared mTLS pool with:
   - the route method and path;
   - the translated body;
   - scalar query parameters only;
   - optional fixed headers;
   - the edge request id, resolved client IP, user agent and bearer token.
5. Sends the core response body with the declared status, or the core status when `relayStatus: true`.

Routes that can become asynchronous or return a non-200 outcome use `relayStatus: true` (merchant suspension/reinstatement/close, approvals, join-request decisions, gateway submit-approval, AML proposals, backup trigger/drill/policy, reconciliation and operator actions). Creation routes generally declare 201 explicitly. `splitBodyFrom` exists in the forwarder but is not used by the current admin routers.

`forwardUpload()` streams a multipart file to the core as raw bytes with `x-upload-filename`, `x-upload-content-type`, `x-upload-sha256`, `x-upload-size` and base64url `x-upload-metadata`. The reconciliation route uses this path with a longer `RECONCILIATION_TIMEOUT_MS`.

### 3.4 Route map

All routes are prefixed with `/api/v1/admin`. The auth routes are inside the LAN guard but outside `requireSession`.

| Area | Routes |
| :--- | :--- |
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/mfa` |
| Search | `POST /search` |
| Academy | `GET, PUT /academy/progress`, `GET /academy/progress/overview`, plus summary/export variants |
| Users | `GET, POST, PATCH /users`, `GET /users/:id`, `PATCH /users/:id`, `GET /users/export`, `GET /users/summary`, `GET /users/summary/export` |
| Join requests | `GET /join-requests`, `GET /join-requests/:id`, `POST /join-requests/admin-assisted`, `PATCH /join-requests/:id/profile`, `POST /join-requests/:id/beneficial-owners`, `PATCH, DELETE /join-requests/:id/beneficial-owners/:ownerId`, `POST, DELETE /join-requests/:id/kyb-documents[/:docId]`, `POST /join-requests/:id/submit`, `POST /join-requests/:id/withdraw`, `PATCH /join-requests/:id/checklist`, `POST /join-requests/:id/screening/retry`, `POST /join-requests/:id/assign`, `POST /join-requests/:id/request-info`, `POST /join-requests/:id/decide` |
| KYB documents | `GET /kyb-documents`, `GET /kyb-documents/:id`, `GET /kyb-documents/:id/content`, `POST /kyb-documents/:id/review`, `POST /kyb-documents/:id/request-replacement`, `POST /kyb-documents/:id/request-revalidation`, plus export/summary variants |
| Merchants | `GET /merchants`, `GET /merchants/:id`, `GET /merchants/:id/stats`, `PATCH /merchants/:id/descriptive`, `POST /merchants/:id/suspend`, `POST /merchants/:id/reinstate`, `POST /merchants/:id/close`, `GET /merchants/:id/pending-changes`, `POST /merchants/:id/pending-changes/:approvalId/withdraw`, `POST /merchants/:id/propose-edit`, `GET /merchants/:id/detail-changes`, plus export/summary variants |
| Approvals | `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve`, `POST /approvals/:id/reject`, `POST /approvals/bulk-reject`, plus export/summary variants |
| AML (confidential) | `GET /aml/screenings`, `GET /aml/screenings/:id`, `POST /aml/matches/:id/disposition`, `GET /aml/cases`, `GET /aml/cases/:id`, `POST /aml/cases/:id/propose`, `GET, POST /aml/rules`, `GET, POST /aml/reporting-rules`, `GET, POST /aml/reports`, `POST /aml/reports/:id/submit`, `POST /aml/reports/:id/acknowledge`, plus export/summary variants |
| Gateways | `GET /gateways/ai-transcript`, `POST /gateways/spec-verify`, `POST /gateways/spec-import`, `GET, POST /gateways`, `GET, PATCH /gateways/:id`, `POST /gateways/:id/rollback`, `GET, POST /gateways/:id/versions`, plus export/summary variants |
| Gateway versions | `POST /gateway-versions/:vid/clone`, `GET /gateway-versions/:vid`, `PUT /gateway-versions/:vid/environments`, `/auth`, `/settings`, `/crypto-profiles`, `/flows`, `/channels`, `/status-rules`, `/error-maps`, `POST /gateway-versions/:vid/dry-run`, `/run-suite`, `/submit-approval` |
| Credential sets | `GET, POST /credential-sets`, `GET, PUT /credential-sets/:id`, `POST /credential-sets/:id/verify`, `POST /credential-sets/:id/revoke` |
| Rails and routes | `GET, POST /rails`, `GET, PATCH /rails/:id`, `PUT /rails/:id/fields`, `GET, POST /routes`, `GET, PATCH /routes/:id`, `POST /routes/:id/state`, plus export/summary variants |
| Assets | `GET, POST /assets`, `GET /assets/:id` |
| Operations | `GET /gateway-inquiries`, `GET /gateway-inquiries/:id`, `POST /gateway-inquiries/:id/cancel`, `/run-now`, `/retry`, `GET /operator-cases`, `GET, PATCH /operator-cases/:id`, `POST /operator-cases/:id/resolve`, `POST /operator-cases/bulk-inquire`, `/bulk-assign`, `/bulk-state`, `POST /attempts/:id/inquire`, `GET /attempts/:id`, plus export/summary variants |
| Reconciliation | `GET, POST /reconciliation/sources`, `PATCH /reconciliation/sources/:id`, `POST /reconciliation/upload`, `GET /reconciliation/runs`, `GET /reconciliation/runs/:id`, `GET /reconciliation/runs/:id/export`, `GET /reconciliation/runs/summary`, `GET /reconciliation/runs/summary/export` |
| Finance | `GET, POST /disputes`, `GET /disputes/:id`, `POST /disputes/:id/evidence`, `GET, POST /adjustments`, `GET /adjustments/:id`, `GET /cashouts`, `GET /cashouts/:id`, `POST /cashouts/:id/process`, `GET, POST /commission-profiles`, `POST /commission-profiles/:id/expire`, `GET /commission-profiles/:id/history`, `GET, POST /velocity-rules`, `POST /velocity-rules/:id/deactivate`, `GET /velocity-rules/:id/history`, `GET /finance/profitability`, `GET /finance/liquidity`, `GET /finance/invariant-check`, plus export/summary variants |
| Settings | `GET, PUT /settings`, `POST /settings/restore-preview`, `POST /settings/restore-apply`, `GET /settings/export`, `GET /settings/summary`, `GET /settings/summary/export`, `GET, PUT /settings/checkout-support`, `GET /settings/checkout-support/history`, `GET /settings/checkout-support/summary`, `GET /settings/checkout-support/summary/export` |
| Options | `GET /options/:kind` |
| Stats | `GET /stats/overview`, `GET /stats/recent-activity`, `GET /stats/export`, `POST /stats/export-audit`, plus export variants |
| Audit logs | `GET /audit-logs`, `GET /audit-logs/:id`, `GET /audit-logs/export`, `GET /audit-logs/summary`, `GET /audit-logs/summary/export` |
| System backups | `GET /system/backups/overview`, `POST /system/backups/trigger`, `POST /system/backups/drill`, `PUT /system/backups/policy` |

The AML router applies `requireAuthorities("COMPLIANCE", "MLRO", "aml:read", "aml:write")` to every AML route. The backup router applies `security:read`/`gateway:read` to the overview and `security:write` to trigger, drill and policy. The remaining routes rely on `requireSession` plus core-side authority enforcement.

## 4. Contracts and invariants

- The admin API is reachable only from `ADMIN_LAN_CIDRS`; the deploy engine aligns the UFW admin rule with `LAN_ALLOWED_CIDRS`.
- Every forwarded path must stay under `/internal/admin`; the shared client enforces this and core re-checks the client CN.
- The edge never accepts a core path from the request; route modules construct the path.
- The edge never performs money arithmetic; amount and currency fields are validated and forwarded for core to re-check.
- Sensitive mutations are not approved at the edge. Maker-checker, base-version checks, state transitions and audit writes happen in `core-back`.
- The backup policy route creates a maker-checker approval when `approvalRequestId` is absent; a checker must be a different user from the maker.
- The admin edge never receives database credentials, the KMS key or another host's certificate.
- Error envelopes from core (`code`, `message`, `details`, `reference`) are preserved by `mapCoreHttpError()`.

## 5. Data / API / config / deployment surface

### Environment

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | Runtime mode. |
| `PORT` | `4101` | Backend listener port. |
| `ADMIN_BIND_HOST` | `127.0.0.1` | Backend bind address. |
| `CORE_BACK_URL` | required | First core node, absolute HTTPS. |
| `CORE_BACK_URLS` | optional | Core pool. |
| `MTLS_CLIENT_CERT_PATH`, `MTLS_CLIENT_KEY_PATH`, `MTLS_CA_CERT_PATH` | required | Edge mTLS material. |
| `CORE_REQUEST_TIMEOUT_MS` | `60000` | Core request timeout. |
| `TRUSTED_PROXY_CIDRS` | loopback plus RFC1918 ranges | Peers whose forwarded IP headers are trusted. |
| `ADMIN_LAN_CIDRS` | loopback plus RFC1918 ranges | Allowed admin clients. |
| `ADMIN_AUTHORITY_HINTS` | roles plus `aml:*` and `security:*` | Edge-checkable authority vocabulary. |
| `MAX_JSON_BODY_BYTES` | `4194304` | JSON limit. |
| `MAX_UPLOAD_BYTES` | `20971520` | Multipart limit. |
| `UPLOAD_ALLOWED_MIME` | `text/csv,application/vnd.ms-excel,application/json` | Reconciliation upload MIME list. |
| `ADMIN_RATE_LIMIT_MAX`, `ADMIN_RATE_LIMIT_WINDOW_MS` | `600`, `60000` | Protected router limiter. |
| `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS` | `10`, `900000` | Login/MFA limiter; the window key is not read by the limiter. |
| `RECONCILIATION_TIMEOUT_MS` | `120000` | Reconciliation upload forwarding timeout. |

### Generated deployment environment

`deploy/lib/hostPlanner.ts` writes `PORT`, `ADMIN_BIND_HOST=127.0.0.1`, `ADMIN_LAN_CIDRS`, the core URL list and mTLS paths. It never writes `DATABASE_URL` or `KMS_MASTER_KEY`.

## 6. Operational usage

```bash
cd admin-back
bun install
bun run start
bun run dev
bun test
bun run typecheck
```

- Open the portal through the LAN vhost (`https://admin.internal:8443` or the configured LAN port), not directly against `:4101`.
- `GET /health` is unauthenticated and does not check core; use the deployment verifier for an upstream mTLS check.
- To diagnose a `403 ADMIN_LAN_ONLY`, inspect `ADMIN_LAN_CIDRS` and the reverse proxy's `X-Real-IP` behavior. The admin resolver prefers `x-real-ip`, then `x-real-client-ip`, and only when the immediate peer is trusted.
- To diagnose `EDGE_AUTHORITY_DENIED`, the edge did not find a configured role/authority in the token payload. This is intentional fail-closed behavior for AML and backup routes; core may still accept the token.
- Backup policy changes normally return `202 PENDING_REVIEW`; a second user supplies the `approvalRequestId` to execute.

## 7. Status and deviations

### Implemented

- LAN-only ingress with CIDR guard and UFW alignment.
- Full admin forwarding surface with public-to-core body mappers.
- mTLS pool, channel confinement, retries and LSN header propagation through the shared client.
- AML and backup edge-level authority hints.
- Multipart upload forwarding with hashes and metadata.
- Rate limiting for auth, protected routes and deep search.
- Relay of asynchronous core statuses for approvals, merchant lifecycle, AML proposals and backup controls.

### Partial

- Edge authority gating is advisory and based on unsigned claims; it cannot be treated as authentication.
- Only AML and backup routes have edge-level authority checks. Every other protected route depends on core.
- The login limiter ignores `AUTH_RATE_LIMIT_WINDOW_MS`.

### Missing / deferred

- No edge-side JWT verification, revocation cache, MFA-state check or per-user IP allowlist.
- No OpenAPI/route manifest generated from the routers.
- No dedicated pool status or metrics endpoint.
- No admin-initiated session refresh endpoint at the edge.

### Known bugs / risks

- A forged token with acceptable `typ`/`iss`/`aud` can pass edge AML or backup gating. Core rejects it, but the edge response differs from an outright authentication failure and may leak route existence.
- Core verifies the session signature, expiry, user status and authorities, but it does not enforce per-call MFA state, session revocation or a per-user admin IP allowlist. The edge does not add those checks.
- CORS reflects any origin. The LAN guard is the compensating control; do not expose `:8443` outside the LAN.
- `app.set("trust proxy", false)` means Express's `req.ip` is the socket peer. The LAN guard implements its own trusted-proxy logic; the two can disagree if a new proxy is introduced.
- The join-request KYB upload forwards the client-declared MIME type without magic-byte validation. Core must treat the file as untrusted.
- Protected admin routes accept any non-empty bearer string; core is the only authentication authority.

## 8. Verification and tests

```bash
cd admin-back && bun run typecheck && bun test
```

Key suites:

- `admin-back/test/admin-surface.test.ts`: route surface and forwarding behavior.
- `admin-back/test/core-contract.test.ts`: public-to-core mappers and strict core schemas.
- `admin-back/test/core-internal-client.test.ts`: pool, retry, headers and LSN.
- `admin-back/test/mtls-client.test.ts`: channel confinement and error mapping.
- `admin-back/test/backups.test.ts`: backup proxy schema and authority behavior.
- `admin-back/test/academy-progress.test.ts`: academy route forwarding.
- `admin-back/test/env-isolation.test.ts`: edge environment has no database/KMS secrets.

The tests use a local HTTPS/HTTP stub and do not require PostgreSQL or Redis. A live mTLS check is part of `deploy/lib/healthVerifier.ts`.

## 9. Source references

### Old design sections

- `design/payment_gateway_final_design-v5.md` section 2.1, service boundaries.
- `design/payment_gateway_final_design-v5.md` section 16.3, admin API surface.
- `design/payment_gateway_deployment_and_guides_architecture.md` section 5, firewall policy.

### Code paths

- `admin-back/index.ts`: app composition and LAN mount.
- `admin-back/api/middleware/lanGuard.ts`: LAN CIDR enforcement.
- `admin-back/api/middleware/authorityGuard.ts`: claim decoding and authority hints.
- `admin-back/api/forward.ts`: forwarding contract.
- `admin-back/api/protected/**`: route surface and mappers.
- `admin-back/api/upload.ts`: multipart forwarding.
- `admin-back/lib/coreInternalClient.ts`: shared pool.
- `admin-back/lib/env/index.ts`: environment contract.

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

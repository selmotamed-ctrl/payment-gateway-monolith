---
id: platform.topology
title: Service Topology
status: partial
confidence: high
last_verified: 2026-11-07
verified_against: d695518+working-tree
code:
  - core-back/index.ts
  - core-back/api/index.ts
  - admin-back/index.ts
  - admin-back/lib/env/index.ts
  - admin-back/lib/coreInternalClient.ts
  - merchant-back/index.ts
  - checkout-back/index.ts
  - checkout-back/api/public/inbound.ts
  - checkout-back/api/public/pay.ts
  - core-back/lib/storageEngine/index.ts
  - fake-rails-back/index.ts
  - deploy/deploy.env.example
  - deploy/lib/configSchema.ts
  - deploy/lib/hostPlanner.ts
design_sources:
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#2-zero-trust-7-service-split-architecture-mtls--reverse-proxy-topology
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#1-executive-summary-and-architectural-vision
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#1-flexible-1n-compute--storage-topology-model-same-server-vs-fully-distributed
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#6-ordered-14-step-multi-host-deployment-pipeline
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#11-high-level-system--storage-topology-diagram
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#62-edge-to-core-mtls-upstream-load-balancer--health-failover-admin-back-merchant-back-checkout-back
tests:
  - core-back/test/exhaustive/05-api-matrix/mtls-channel-isolation.test.ts
  - admin-back/test/mtls-client.test.ts
  - merchant-back/test/mtls-client.test.ts
  - checkout-back/test/mtls-client.test.ts
  - checkout-back/test/checkout-zero-trust.test.ts
  - deploy/test/hostPlanner.test.ts
  - deploy/test/pipeline.test.ts
gaps:
  - Multi-host deployment and rolling failover are not verified against production-shaped hosts.
  - PostgreSQL/Redis storage mTLS is generated but not consumed by the storage configuration.
  - Backup daemon certificate variable names differ between core and daemon configuration.
  - Core node identity is limited to certificate CN; there is no per-node application identity inside the core namespace.
---

# Service Topology

## 1. Purpose and scope

This part describes the runtime service graph: which processes exist, how they listen, which network boundary they sit in, which channels are mutual-TLS, which component owns the database, and how requests travel from a browser or gateway to core and back. It also describes the horizontal-node arrays in the deploy engine and the optional Fake Rails tier.

This part does not repeat the API contracts (`01-core-back/01-api-surface.md`), the security controls (`00-platform/02-security-and-mtls.md`), the full env schema (`00-platform/03-runtime-and-config.md`) or the deploy pipeline (`07-deploy/**`). It provides the topology those parts depend on.

## 2. Design intent (extracted and synthesized from ./design)

The historical design defines a seven-service split:

1. `core-back`: private-LAN mTLS server, sole database owner, KMS and secret owner, dynamic rail engine, ledger, workers and outbound gateway calls.
2. `admin-back`: LAN-only edge BFF with no database driver.
3. `merchant-back`: public-SSL merchant edge BFF with no database driver.
4. `checkout-back`: public-SSL checkout and webhook edge with no database driver.
5. `admin-front`: LAN-only admin SPA.
6. `merchant-front`: public merchant SPA.
7. `checkout-front`: public hosted-checkout SPA.

`fake-rails-back` and `fake-rails-front` are an optional eighth and ninth workspace used for sandbox and testing; they are not part of the production seven-service core.

The design also defines the network zones:

- Public internet reaches only the merchant and checkout reverse proxies on `80/443`. The proxies serve the matching SPA and forward `/api` to the matching edge backend.
- The admin reverse proxy is bound to a private LAN interface on a non-forwarded port, normally `8443`. It serves the admin SPA and forwards `/api` to `admin-back`.
- All three edge backends call `core-back` over a private LAN with mTLS 1.3 client certificates.
- `core-back` is never published by a reverse proxy and has no public listener.
- `core-back` reaches PostgreSQL, Redis, the audit database, the log database and external gateways.
- The object-storage daemon is a separate mTLS data plane, normally `:4095`; the backup daemon is a separate mTLS control plane, normally `:4090`, with backup storage in S3/MinIO/R2 and an optional secondary vault.

The historical target for compute is `CORE_NODES`, `ADMIN_NODES`, `MERCHANT_NODES` and `CHECKOUT_NODES` arrays, each entry shaped `nodeId@sshHost:sshPort:privateIp:servicePort`. Storage is declared separately with `PG_PRIMARY_NODE`, `PG_REPLICA_NODES`, `PGBOUNCER_*`, `REDIS_NODES`, `AUDIT_DB_NODE`, `LOG_DB_NODE` and `BACKUP_NODE`. The design supports a single all-in-one host, combined compute hosts, fully distributed hosts and horizontal compute.

## 3. As-built architecture

### 3.1 Process and listener inventory

| Process | Default listener | Exposure | Database | Upstream | Entry point |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `core-back` | `127.0.0.1:4000` (`HOST`/`PORT`) | Private LAN only, TLS 1.3 server, client certificate required | PostgreSQL primary/replicas, Redis, audit/log DBs | External gateway HTTPS endpoints, backup daemon mTLS | `core-back/index.ts` |
| `admin-back` | `127.0.0.1:4101`, behind LAN nginx `:8443` | Private LAN only; `enforceLanAccess` on `/api/v1/admin` | None | `CORE_BACK_URL(S)` over mTLS | `admin-back/index.ts` |
| `merchant-back` | `0.0.0.0:4102` | Public reverse proxy `80/443` | None | `CORE_BACK_URL(S)` over mTLS | `merchant-back/index.ts` |
| `checkout-back` | `0.0.0.0:4103` | Public reverse proxy `80/443` | None | `CORE_BACK_URL(S)` over mTLS | `checkout-back/index.ts` |
| `admin-front` | static build behind nginx `:8443` | LAN | None | `admin-back` HTTP API | `admin-front/src/**` |
| `merchant-front` | static build behind public nginx | Public | None | `merchant-back` HTTP API | `merchant-front/src/**` |
| `checkout-front` | static build behind public nginx | Public | None | `checkout-back` HTTP API | `checkout-front/src/**` |
| `pg-object-storage-daemon` | `:4095` (`https`) | Private LAN, mTLS client certificate required | None (shared vault) | Core nodes and backup daemon | `deploy/object-storage-daemon` |
| `fake-rails-back` | `127.0.0.1:4104` (`HOST`/`PORT`) | Optional, behind `fake-rails` nginx `:8444` | Its own SQLite store | Core inbound URL for synthetic webhooks | `fake-rails-back/index.ts` |
| `fake-rails-front` | static build behind the Fake Rails vhost | Optional | None | `fake-rails-back` portal API | `fake-rails-front/src/**` |

The ports above are schema defaults; every deployment can override them. `deploy/lib/configSchema.ts` derives the edge pool from `CORE_NODES` unless `CORE_BACK_URLS` is set explicitly.

### 3.2 Core composition

`createApp()` builds one Express app for both the TLS server and tests. The middleware order is:

1. `app.disable("x-powered-by")`.
2. `app.set("trust proxy", env.TRUST_PROXY)`.
3. `requestIdMiddleware`.
4. `requestLoggerMiddleware`.
5. `rawBodyMiddleware` for opaque upload/webhook paths.
6. `express.json({ limit: "1mb" })`.
7. `express.urlencoded({ extended: true, limit: "1mb" })`.
8. `GET /health`.
9. `app.use("/internal", internalRouter)`.
10. `app.use("/api", apiRouter)`.
11. The terminal error handler.

`internalRouter` mounts each channel behind `requireEdgeIdentity`:

```text
/internal/admin     -> requireEdgeIdentity("admin-back")     -> adminInternalRouter
/internal/merchant  -> requireEdgeIdentity("merchant-back")  -> merchantInternalRouter
/internal/checkout  -> requireEdgeIdentity("checkout-back")  -> checkoutInternalRouter
```

`apiRouter` mounts `publicRouter` at `/api/public`; that router currently installs only a rate limiter and registers no endpoint.

Inside the admin router, `/health` is public over the mTLS channel; authentication starts at `router.use(requireAuthentication)`, and the backup router is mounted under `/system/backups` after that guard. Inside the merchant router, `/health` and the auth routes before the `requireAuthentication` line are public within the channel; onboarding and the remaining merchant routes require a bearer credential. The checkout router has no bearer authentication because the link key and attempt token are the payer capability.

### 3.3 Edge composition

All three edge backends use the same pattern:

- Express 5 app, `x-powered-by` disabled, `trust proxy` false, CORS enabled with `origin: true, credentials: false` (core is private behind mTLS; the edges no longer emit CORS headers unless `CORS_ALLOWED_ORIGINS` is set).
- A request logger and a `/health` endpoint returning service name and uptime.
- Body parsers with a per-edge JSON limit: admin `4 MiB`, merchant `2 MiB`, checkout `1 MiB`.
- A request validator at the edge and a second validator inside core (the Double-Check Rule).
- A mTLS HTTPS agent built from `MTLS_CLIENT_CERT_PATH`, `MTLS_CLIENT_KEY_PATH` and `MTLS_CA_CERT_PATH`, with `minVersion` and `maxVersion` fixed to TLS 1.3 and `rejectUnauthorized: true`.
- `CORE_BACK_URLS` parsed into an ordered pool; `CORE_BACK_URL` remains the first-node compatibility value.
- Least-in-flight selection with a round-robin tie-break, a 5-second failure cooldown, passive health marking on transport errors and `502`/`503`, and retries for idempotent methods (or when `retryIfUnavailable` is set).
- Forwarded headers: `x-request-id`, `x-real-client-ip` (always overwritten by the edge with the resolved client IP), `x-client-user-agent`, `x-edge-service`, and `authorization` when present. Edge-owned headers are applied last and header names/values are validated. `x-pg-min-lsn` is propagated when a route declares a consistency LSN.

`admin-back` adds `enforceLanAccess`, which resolves the client IP through trusted proxy CIDRs and checks `ADMIN_LAN_CIDRS`. `merchant-back` adds rate limits for auth, portal API and external API. `checkout-back` mounts the raw inbound router before the JSON parser so webhook bytes and signature headers survive.

### 3.4 Storage and data topology

`core-back` boots exactly one `StorageEngine` per process. `createStorageEngine()` constructs:

- A Prisma client for the primary from `DATABASE_URL`.
- Zero or more Prisma clients for `DATABASE_REPLICA_URLS`, each with a health/lag state.
- A `PostgresReplicaReadStore` with `READ_REPLICA_MAX_LAG_MS`, LSN monitor and primary fallback.
- A `PostgresUnitOfWorkAdapter` that owns `BEGIN`/`COMMIT`, sorted `gl_account_shards` locking and the post-commit WAL flush LSN.
- A Redis cache/velocity adapter when `REDIS_URL` or the first `REDIS_NODES` entry is set; otherwise an in-memory adapter.
- A dedicated audit driver over `AUDIT_DATABASE_URL` when set.
- A dedicated log sink over `LOG_DATABASE_URL` when set; without it, logs are kept in a bounded in-memory buffer.

PostgreSQL is the only runtime database. The data plane also includes PgBouncer when `PGBOUNCER_ENABLED=true`, streaming replicas, the 16-way system GL shard table, the outbox/read-model tables, and the audit/log databases. Redis is never authoritative for money.

The backup control plane is core -> `BACKUP_DAEMON_URL` (mTLS when HTTPS) -> `pg-backup-daemon` -> WAL-G/Barman -> primary S3 and optional secondary vault. The daemon also exposes `/health`, `/v1/overview`, `/v1/backups/trigger`, `/v1/drills/run`, `/v1/policy`, `/v1/runs` and `/v1/drills`.

### 3.5 Fake Rails tier

`fake-rails-back` is intentionally independent: it reads its own env, owns a SQLite store and never touches the gateway database. It listens on `127.0.0.1:4104` by default and is published on a separate nginx vhost, default `:8444`. It exposes hosted pages, rail routers, SDK shims, portal APIs, chaos scenarios and a webhook dispatcher that calls `CORE_INBOUND_BASE_URL` (default `http://127.0.0.1:4103/api/v1/inbound`).

Core can reach a Fake Rails host only through a three-part allowlist: `ALLOW_FAKE_RAILS_HOSTS=true`, the host in `FAKE_RAILS_ALLOWED_HOSTS`, and the same host in the gateway version's `allowed_hosts`. This is an SSRF exception scoped to the exact host; it is not a general private-network allowance. The `FAKE_RAILS_ENABLED` and `FAKE_RAILS_ALLOW_IN_PRODUCTION` flags are separate from the SSRF allowlist.

## 4. Contracts and invariants

### 4.1 Channel binding

- `/internal/admin/*` accepts only a certificate whose subject CN is exactly `admin-back`.
- `/internal/merchant/*` accepts only `merchant-back`.
- `/internal/checkout/*` accepts only `checkout-back`.
- A valid certificate from the internal CA on the wrong channel gets `403 FORBIDDEN_SERVICE_IDENTITY`.
- An unauthorized or missing client certificate is rejected by TLS (`rejectUnauthorized: true`) and, defensively, by `requireEdgeIdentity` with `401 MTLS_UNAUTHORIZED`.

### 4.2 Database exclusivity

- `DATABASE_URL`, `DATABASE_REPLICA_URLS`, `AUDIT_DATABASE_URL`, `LOG_DATABASE_URL`, `REDIS_URL` and `KMS_MASTER_KEY` are core-only.
- Edge env schemas do not contain those keys; edge packages do not depend on `pg` or Prisma.
- Edge services can only mutate state through core's internal API.
- `admin-front` and `merchant-front` still list `@prisma/client` as a dependency (`checkout-front` no longer does, GAP-029), but no frontend source imports Prisma and no frontend receives a database URL; it is not a data-plane credential.

### 4.3 Request consistency

- A core route may set `x-pg-min-lsn` on a write response. The edge passes the header on a subsequent read, and core routes that use `readThroughReplicaOrPrimary` wait for a replica at or above that LSN, falling back to the primary.
- The commit LSN for an attempt is kept in an in-process map in `PlatformRuntime` and consumed once by the checkout confirm route. It is not shared across core nodes.

### 4.4 Health contracts

- Core `GET /health` is always on the mTLS listener and reports queue health; it is not a public liveness endpoint. It returns `status: "ok"` or `status: "degraded"` with HTTP 200 in both cases.
- Each channel also has a trivial `GET /health` inside its internal router (`admin`, `merchant`, `checkout`), reachable only after the channel identity guard.
- Edge `GET /health` is unauthenticated and reports `{ status: "ok", service, uptime }`.
- The backup daemon has its own `/health` and is not proxied through core's `/health`.

### 4.5 Horizontal nodes

- `CORE_NODES`, `ADMIN_NODES`, `MERCHANT_NODES` and `CHECKOUT_NODES` are comma-separated `nodeId@sshHost:sshPort:privateIp:servicePort` entries.
- The core certificate SAN includes every core private IP; edge client certificates are shared per edge role.
- Edge pools are per-process and built lazily from `CORE_BACK_URLS`. A failed node is cooled down for five seconds and retried; another eligible node is selected when available.
- Rolling deployment updates one batch of nodes at a time and health-checks each batch before continuing. The previous release remains on disk when a batch fails.

## 5. Data / API / config / deployment surface

### 5.1 Service/network matrix

| Boundary | Caller | Callee | Protocol | Authentication |
| :--- | :--- | :--- | :--- | :--- |
| Public | Payer browser | `checkout-back` via nginx | HTTPS | Link key / attempt token capability |
| Public | Merchant browser | `merchant-back` via nginx | HTTPS | Session bearer token |
| Public | Merchant server | `merchant-back` `/api/v1/external` | HTTPS | `pg_live_` bearer token + optional CIDR allowlist |
| Public | Gateway | `checkout-back` `/api/v1/inbound` | HTTPS | Path token + channel verifier (signature/IP/inquiry) |
| LAN | Admin browser | `admin-back` via LAN nginx | HTTPS | Session bearer token + LAN CIDR |
| Private | `admin-back` | `core-back` | mTLS 1.3 | Client cert CN `admin-back` + bearer |
| Private | `merchant-back` | `core-back` | mTLS 1.3 | Client cert CN `merchant-back` + bearer |
| Private | `checkout-back` | `core-back` | mTLS 1.3 | Client cert CN `checkout-back` + payer capability |
| Private | `core-back` | PostgreSQL primary/replicas | PostgreSQL wire | Database credentials |
| Private | `core-back` | Redis | Redis protocol | Optional Redis URL credentials |
| Private | `core-back` | audit/log databases | PostgreSQL wire | Database credentials |
| Private | `core-back` | `pg-backup-daemon` | HTTPS mTLS | Backup client cert when configured |
| Private | `core-back` | external gateway | HTTPS | Gateway auth recipe, host allowlist, SSRF guard |
| Optional | Fake Rails webhook | `checkout-back` | HTTP/HTTPS | Fake Rails path token and signed/allowlisted payload |

### 5.2 Core env keys that affect topology

- `PORT`, `HOST`, `TRUST_PROXY`.
- `CORE_BACK_URL` / `CORE_BACK_URLS` on the edge, not core.
- `MTLS_CA_CERT_PATH`, `MTLS_SERVER_CERT_PATH`, `MTLS_SERVER_KEY_PATH` on core.
- `MTLS_CA_CERT_PATH`, `MTLS_CLIENT_CERT_PATH`, `MTLS_CLIENT_KEY_PATH` on edges.
- `DATABASE_URL`, `DATABASE_REPLICA_URLS`, `AUDIT_DATABASE_URL`, `LOG_DATABASE_URL`, `REDIS_URL`, `REDIS_NODES`.
- `BACKUP_DAEMON_URL` and its CA/client cert/key paths.
- `ALLOW_FAKE_RAILS_HOSTS`, `FAKE_RAILS_ALLOWED_HOSTS` for the scoped exception.

### 5.3 Deploy keys that affect topology

- `CORE_NODES`, `ADMIN_NODES`, `MERCHANT_NODES`, `CHECKOUT_NODES`, `CORE_BACK_URLS`.
- `CORE_PORT`, `ADMIN_BACK_PORT`, `ADMIN_NGINX_LAN_PORT`, `MERCHANT_BACK_PORT`, `MERCHANT_HTTP_PORT`, `MERCHANT_HTTPS_PORT`, `CHECKOUT_BACK_PORT`, `CHECKOUT_HTTP_PORT`, `CHECKOUT_HTTPS_PORT`.
- `PG_PRIMARY_NODE`, `PG_REPLICA_NODES`, `PGBOUNCER_ENABLED`, `PGBOUNCER_PORT`, `REDIS_NODES`.
- `AUDIT_DB_NODE`, `LOG_DB_NODE`, `BACKUP_NODE`, `BACKUP_DAEMON_PORT`.
- `FAKE_RAILS_SSH_HOST`, `FAKE_RAILS_BACK_PORT`, `FAKE_RAILS_NGINX_PORT`.

## 6. Operational usage

### 6.1 Local seven-service run

1. Generate the PKI with `bun run generate-mtls-certs` in `core-back`.
2. Start PostgreSQL, apply migrations and seed.
3. Start `core-back` on `127.0.0.1:4000`.
4. Start `admin-back` with `CORE_BACK_URL=https://127.0.0.1:4000` and the admin client certificate.
5. Start `merchant-back` and `checkout-back` with their own certificates.
6. Start the three frontends against the matching edge API URLs.

The core certificate SAN and the edge `CORE_BACK_URL` hostname must agree with the agent's `servername`; the edge sets `servername` only when the base URL host is not an IP literal.

### 6.2 Adding a core node

1. Add the node to `CORE_NODES` and its private IP to the core certificate SAN generation.
2. Deploy the same release to the new node.
3. Set `CORE_BACK_URLS` to the full ordered pool, or let the deploy engine derive it from `CORE_NODES`.
4. Health-check the node over mTLS before rolling the next batch.

### 6.3 Failure behavior

- Edge-to-core transport failure: the node is marked unhealthy and cooled down; the pool retries another node for idempotent calls. Non-idempotent POSTs are not retried unless `retryIfUnavailable` is explicitly set by the route.
- Core database failure: `GET /health` stays HTTP 200 but reports `QUEUE_HEALTH_UNAVAILABLE` and `status: "degraded"`.
- Worker disabled: core refuses to boot when `WORKER_ENABLED` or `WORKER_BACKGROUND_JOBS_ENABLED` is false, because queue-only routes would accept work that no worker can drain.
- Backup daemon unavailable: backup writes return `503 BACKUP_DAEMON_NOT_CONFIGURED`; the local catalog remains readable.

### 6.4 Request path diagrams

```text
Payer:
browser -> checkout-front -> public nginx -> checkout-back
        -> mTLS /internal/checkout/* -> core-back
        -> PostgreSQL / external gateway

Merchant:
browser -> merchant-front -> public nginx -> merchant-back
        -> mTLS /internal/merchant/* -> core-back

Admin:
browser -> LAN nginx :8443 -> admin-back
        -> mTLS /internal/admin/* -> core-back

Webhook:
gateway -> checkout-back /api/v1/inbound/:gateway/:env/:pathToken
        -> raw bytes over mTLS -> core-back
        -> inbound_events + callback verifier + engine

Backup:
admin-front -> admin-back -> /internal/admin/system/backups/*
           -> mTLS backup daemon -> WAL-G/Barman -> S3/secondary vault
```

## 7. Status and deviations

### Implemented

- The seven production services, their listeners and their channel bindings exist in code.
- The core has database exclusivity and the three client-certificate guards.
- Edge pools implement least-in-flight selection, round-robin tie-break, cooldowns and idempotent retry.
- The storage engine, replicas, Redis, audit/log databases and backup client are composed at core startup.
- The deploy engine defines horizontal node arrays, host plans, PKI SANs, firewall rules and a 14-step pipeline.
- The optional Fake Rails backend and portal exist and are independently configured.

### Partial

- **Multi-host verification.** The topology code and unit tests exist, but no production-shaped deployment, replica failover, rolling batch or backup restore is recorded in this repository state.
- **Storage mTLS.** Deploy generates storage certificates; PostgreSQL and Redis configuration do not consume them, so the storage-plane certificate chain is not an enforced channel today.
- **Backup daemon mTLS.** Core reads `BACKUP_DAEMON_CA_CERT_PATH`, `BACKUP_DAEMON_CLIENT_CERT_PATH` and `BACKUP_DAEMON_CLIENT_KEY_PATH`; the daemon reads `BACKUP_DAEMON_CERT_PATH`, `BACKUP_DAEMON_KEY_PATH` and `BACKUP_DAEMON_CA_CERT_PATH`. The provisioner mapping is not aligned in the current tree, so a staging verification is required.
- **Core node identity.** All core nodes share the same server certificate role. Claim-based workers rely on database `SKIP LOCKED` claims and conditional updates; singleton workers elect one leader with a PostgreSQL session advisory lock over `LEADER_ELECTION_DATABASE_URL` (PgBouncer `pgw_session`, `pool_mode=session`, or direct PostgreSQL). The lock is backend-specific, so `DATABASE_URL` (transaction-pooled) is never used for it; core verifies the session at boot and fails closed if the backend changes or the lock row is missing.

### Missing / deferred

- No service mesh, sidecar, centralized proxy or runtime service discovery. Topology is static env.
- No public core health endpoint by design; operators need LAN mTLS access or a monitoring sidecar.
- No cross-node invalidation for the in-process commit-LSN map used for read-your-own-writes.
- No `pgbouncer` runtime adapter; the pooler is deployment configuration in front of the PostgreSQL URL.
- No production record for the full 14-step deploy pipeline, WAL-G/Barman restore, or a secondary-vault failover.

### Known bugs / risks

- **Code gap:** `publicRouter` is mounted under `/api/public` but has no route, so any request to `/api/public/*` falls through to the Express 404 handler after the limiter.
- **Code gap:** The checkout SSE route is a database poll every two seconds, not a subscription to the invalidation bus; see `01-core-back/01-api-surface.md`.
- **Documentation gap:** Historical designs describe a public core health route and storage mTLS as implemented end to end; this part records the actual code boundaries.
- **Deployment risk:** The backup daemon falls back to `127.0.0.1` without mTLS when the certificate env names are not aligned. Treat an unset backup certificate as a configuration failure in production.

## 8. Verification and tests

- `core-back/test/exhaustive/05-api-matrix/mtls-channel-isolation.test.ts` exercises the three channel guards and wrong-CN rejection.
- `core-back/test/phase1-mtls-and-schema.test.ts` verifies the generated CA/server/client material and schema version.
- `admin-back/test/mtls-client.test.ts`, `merchant-back/test/mtls-client.test.ts` and `checkout-back/test/mtls-client.test.ts` cover agent construction, path/channel protection, pool selection, failover and header propagation.
- `checkout-back/test/checkout-zero-trust.test.ts` covers the payer edge's no-database/no-amount-injection posture.
- `deploy/test/hostPlanner.test.ts` covers single-host, split, distributed and horizontal planning.
- `deploy/test/pipeline.test.ts` covers the ordered deploy pipeline and failure handling.

These are unit/integration tests. No live multi-host deployment was run for this documentation change.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` §2.1 service roles and boundaries, §2.2 mTLS transport, §2.3 reverse proxy topology.
- `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md` §1 architecture vision and interface catalogue.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` §1 topology model, §6 ordered pipeline.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` §1.1 topology diagram, §6.2 edge load balancing.
- `design/90-archive/delivery-logs/opencode_technical_delivery_design.md` §2 workspace/ports, §28 horizontal delivery.

### Code paths

- `core-back/index.ts`, `core-back/api/index.ts`.
- `core-back/lib/storageEngine/index.ts`, `core-back/lib/storageEngine/uowAdapter.ts`, `readStoreAdapter.ts`.
- `admin-back/index.ts`, `admin-back/lib/coreInternalClient.ts`, `admin-back/api/middleware/lanGuard.ts`.
- `merchant-back/index.ts`, `checkout-back/index.ts`, `checkout-back/api/public/inbound.ts`.
- `fake-rails-back/index.ts`, `fake-rails-back/lib/env/index.ts`.
- `deploy/lib/configSchema.ts`, `deploy/lib/hostPlanner.ts`, `deploy/deploy.ts`.

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/code-surface-map.md`

## 10. Change history

- 2026-11-03: Initial canonical topology part written against `5a24f6f+working-tree`.

## Security hardening (2026-11-05)

Edge to core: the shared upstream client only marks a node unhealthy on transport/TLS errors and 502/503/504, caps buffered responses and total deadline, uses a separate SSE agent pool, and replays PUT/DELETE only with an idempotency key. Details are in the shared upstream client part. Edge TRUSTED_PROXY_CIDRS now defaults to loopback only.

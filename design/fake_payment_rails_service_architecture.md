# STANDALONE FAKE PAYMENT RAILS EMULATOR & CHAOS TESTING PORTAL — MASTER ARCHITECTURE & TECHNICAL SPECIFICATION

**Target Repository:** `selmotamed-ctrl/payment-gateway-monolith`  
**Service Workspace Directories:** `fake-rails-back` · `fake-rails-front` · `deploy` · `core-back`  
**Runtime & Stack Conventions:** Bun (`^1.4.1`) + Express 5 (`^5.2.1`) + Zod 4 (`^4.5.4`) + `bun:sqlite` (zero-dependency isolated persistence) · Vue 3 (`^3.5.22`) TSX/JSX + Vuetify 3 (`^3.10.7`) + `kt-dc` + Vite (`rolldown-vite`)

## Executive Summary & Architectural Vision

Testing a zero-code, multi-rail payment gateway platform across 20 heterogeneous Libyan and international payment switches (each with distinct collection modes, cryptographic signature schemes, amount scales, asynchronous webhook shapes, and T+N statement formats) cannot rely solely on unit mocks or unstable partner sandboxes. Partner sandboxes frequently suffer from strict hourly rate limits, unannounced downtime, inability to deterministically trigger edge cases (such as `MOVES_MONEY` socket resets, conflicting webhook vs. inquiry states, or T+N fee variances), and lack of visibility into what the upstream switch actually received.

This specification designs a **Standalone Fake Payment Rails Emulator & Chaos Testing Service** (`fake-rails-back` + `fake-rails-front`) that acts as a complete, self-contained external payment ecosystem:

1. **Zero Shared Database with the Payment Gateway (`100% Out-of-Process Isolation`):**
   - `fake-rails-back` has zero access to `core-back`'s MySQL/MariaDB database and shares no memory with `core-back`. It persists its own transactions, webhook delivery queues, and chaos rules in an isolated embedded SQLite WAL database (`bun:sqlite` at `shared/data/fake-rails.sqlite`).
   - To `core-back`, the Fake Rails Service is indistinguishable from 20 real external bank switches and aggregators over HTTPS.
2. **All 9 Collection Modes, All 10 Flow Phases, and All 20 Gateway Profiles:**
   - Emulates every collection mode (`OTP_PULL`, `REDIRECT`, `EMBEDDED`, `PUSH_APPROVAL`, `QR_DISPLAY`, `PAY_CODE`, `DEEP_LINK`, `MANUAL`, `HYBRID`) and every lifecycle phase (`CREDENTIAL_CHECK`, `PRE_INITIATE`, `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, `REFUND`, `VOID`, `CAPTURE`, `SETTLEMENT_FETCH`), plus interactive Hosted Checkout pages (`REDIRECT`) and drop-in JavaScript widget scripts (`EMBEDDED` Moamalat Lightbox & MPGS Hosted Session).
3. **Production-Deployable via the Multi-Host Deployment Engine (`deploy/`):**
   - Integrates into `deploy/deploy.env` and `deploy/deploy.ts` as an optional 6th logical host role (`FAKE_RAILS_HOST`, colocated or dedicated) gated by explicit safety flags (`FAKE_RAILS_ENABLED="true"` and `FAKE_RAILS_ALLOW_IN_PRODUCTION="true"`), with configurable ports, TLS modes, PM2 process management, Nginx reverse-proxy templates, and UFW firewall rules.
   - Automatically relaxes `core-back`'s SSRF private-IP guard **only** for the explicitly allowlisted Fake Rails host/IP when `ALLOW_FAKE_RAILS_HOSTS="true"` is set, preserving full SSRF protection against all other private/loopback addresses.
4. **Single-User Tester Portal & Live Chaos Matrix (`fake-rails-front`):**
   - Protected by a single tester credential pair (`FAKE_RAILS_ADMIN_USER` and `FAKE_RAILS_ADMIN_PASSWORD`) injected directly from `deploy.env`.
   - Streams incoming requests, outbound responses, and webhook deliveries in real time over Server-Sent Events (SSE).
   - Provides per-rail and per-phase **probabilistic failure sliders (0%–100%)** and **deterministic scenario overrides** so testers can configure any rail to fail at a given percentage chance with specific failure modes (`TIMEOUT_HANG`, `SOCKET_RESET`, `HTTP_500`, `INSUFFICIENT_FUNDS`, `LIMIT_EXCEEDED`, `WRONG_OTP`, `AMOUNT_MISMATCH`, `DUPLICATE_WEBHOOK`, `FORGED_SIGNATURE`, `CONFLICTING_INQUIRY`), manually approve/reject pending `PUSH_APPROVAL` / `QR_DISPLAY` / `PAY_CODE` payments, and generate downloadable CSV/XLSX/JSON settlement statements.

## 1. Service Topology, Isolation Boundary & Workspace Layout

### 1.1 Network & Process Isolation Model

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                      PAYMENT GATEWAY MONOLITH (EXISTING 7 SERVICES)                    │
│                                                                                        │
│  ┌────────────────┐     mTLS 1.3      ┌─────────────────────────────────────────────┐  │
│  │ checkout-front │ ───────────────▶  │                 core-back                   │  │
│  │ checkout-back  │ ◀───────────────  │  DynamicRailEngine · ApiConsumer · Vault    │  │
│  └───────┬────────┘                   │  LedgerPoster · StatementIngestor · Workers │  │
│          │                            └──────┬─────────────────────────────────┬────┘  │
└──────────┼───────────────────────────────────┼─────────────────────────────────┼───────┘
           │                                   │                                 │
   Browser Redirects /                 Outbound Flow Calls               Inbound Webhooks
   Embedded Widget JS                  (INITIATE / SUBMIT /             (/api/v1/inbound/
   (/hosted/*, /sdk/*)                  VERIFY / REFUND)                 :gw/:env/:token)
           │                                   │                                 │
           ▼                                   ▼                                 │
┌────────────────────────────────────────────────────────────────────────────────┴───────┐
│                STANDALONE FAKE PAYMENT RAILS SERVICE (NEW ISOLATED TIER)               │
│                                                                                        │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │                     Nginx Reverse Proxy (FAKE_RAILS_PORT)                        │  │
│  │   /            -> fake-rails-front/dist (Single-User Tester Dashboard SPA)       │  │
│  │   /hosted/*    -> fake-rails-front/dist (Interactive Redirect & Widget UI)       │  │
│  │   /sdk/*       -> fake-rails-back (Served JS SDKs: Moamalat Lightbox, MPGS)      │  │
│  │   /rails/*     -> fake-rails-back (20 Emulated Gateway APIs)                     │  │
│  │   /portal-api/*-> fake-rails-back (Tester Auth, Chaos Config, SSE, Seeder Sync)  │  │
│  └───────────────────────────────────────────┬──────────────────────────────────────┘  │
│                                              ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │                         fake-rails-back (Bun + Express 5)                        │  │
│  │  • 20 Protocol Emulators (JSON, Form, Multipart, XML/SOAP)                       │  │
│  │  • Chaos & Probabilistic Failure Engine (0% - 100% per Rail & Phase)             │  │
│  │  • Outbound Webhook Dispatcher (HMAC, Sorted-Values, Timestamp.Body, RSA)        │  │
│  │  • Statement Generator (CSV / XLSX / JSON with configurable fee variance)        │  │
│  │  • Embedded SQLite WAL Store (shared/data/fake-rails.sqlite — Zero MySQL access) │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Directory Structure inside `payment-gateway-monolith`

Both new projects follow the exact conventions of `selmotamed-ctrl/template-back-front`:

```text
payment-gateway-monolith/
├── fake-rails-back/
│   ├── api/
│   │   ├── index.ts                        # Mounts /rails, /sdk, /portal-api
│   │   ├── middleware/
│   │   │   ├── portalAuthGuard.ts          # Verifies tester JWT issued from deploy.env credentials
│   │   │   ├── requestRecorder.ts          # Records raw wire request/response + broadcasts SSE
│   │   │   └── chaosInterceptor.ts         # Evaluates deterministic & % probabilistic failure rules
│   │   ├── rails/                          # 20 Gateway Protocol Emulators
│   │   │   ├── otpPullRouter.ts            # Edfali, Sadad, MobiCash, Libyana, Masrefy, Yussor, Sahara
│   │   │   ├── embeddedRouter.ts           # Moamalat NPG Lightbox & FilterTransactions, Numo Pay, MPGS
│   │   │   ├── qrAndPushRouter.ts          # CBL LYPay, OnePay, GPay Libya, Hawelli, Evo Pay
│   │   │   ├── redirectRouter.ts           # Tadawul T-LYNC, MyPay, DPay Hosted, Plutu Hosted
│   │   │   ├── internalNeomPayRouter.ts    # NeomPay First-Party Wallet emulator
│   │   │   └── statementRouter.ts          # Settlement statement export endpoints per gateway
│   │   ├── sdk/
│   │   │   ├── moamalat-lightbox.js.ts     # Dynamic drop-in Lightbox.Checkout script for EMBEDDED mode
│   │   │   └── mpgs-session.js.ts          # Dynamic Hosted Session iframe driver for MPGS 3DS2
│   │   └── portal/
│   │       ├── auth.ts                     # POST /portal-api/auth/login (checks deploy.env user/pass)
│   │       ├── transactions.ts             # GET /portal-api/transactions, SSE stream, manual actions
│   │       ├── scenarios.ts                # GET/PUT /portal-api/scenarios (per-rail % failure matrix)
│   │       ├── webhooks.ts                 # POST /portal-api/webhooks/:txId/fire | replay | tamper
│   │       ├── statements.ts               # POST /portal-api/statements/generate
│   │       └── seederSync.ts               # POST /portal-api/internal/bulk-seed (for synthetic seeder)
│   ├── engine/
│   │   ├── db/
│   │   │   ├── index.ts                    # bun:sqlite WAL connection & schema initializer
│   │   │   └── schema.sql                  # SQLite tables: fake_transactions, fake_step_events, etc.
│   │   ├── chaos/
│   │   │   ├── ChaosEvaluator.ts           # Weighted PRNG + magic-input trigger evaluation
│   │   │   └── DefaultRailScenarios.ts     # Default 0% failure baseline for all 20 rails
│   │   ├── crypto/
│   │   │   └── FakeCryptoSigner.ts         # Signs outbound webhooks & verifies inbound gateway hashes
│   │   └── webhooks/
│   │       └── WebhookDispatcher.ts        # Async timer queue for normal, delayed, duplicate & out-of-order webhooks
│   ├── lib/
│   │   ├── env/index.ts                    # Zod 4 startup env validation (exits 1 if invalid)
│   │   ├── error/index.ts                  # ApiError with Symbol("api-error") & parseOrThrow
│   │   ├── requestLogger/index.ts
│   │   └── zReady/index.ts
│   ├── index.ts                            # HTTP/HTTPS server entry point + /health probe
│   ├── package.json
│   └── tsconfig.json
│
├── fake-rails-front/
│   ├── src/
│   │   ├── components/
│   │   │   ├── LiveTransactionFeed.tsx     # Realtime SSE stream of incoming gateway calls
│   │   │   ├──WireInspectorDrawer.tsx      # Side-by-side raw headers, body, crypto string & response
│   │   │   ├── RailChaosCard.tsx           # Per-rail % failure sliders, latency & error mode pickers
│   │   │   └── WebhookComposerModal.tsx    # Trigger/replay/tamper webhooks & disputes on demand
│   │   ├── layouts/
│   │   │   ├── portal.tsx                  # Tester Dashboard shell (app bar, navigation, SSE indicator)
│   │   │   └── hosted.tsx                  # Clean customer-facing shell for /hosted/redirect/:sessionId
│   │   ├── pages/
│   │   │   ├── login/index.tsx             # Single-user login (validates against deploy.env credentials)
│   │   │   ├── dashboard/index.tsx         # Live KPIs, SSE feed, pending push/QR/OTP approvals
│   │   │   ├── transactions/index.tsx      # Searchable history + 1-click Refund/Dispute/Webhook actions
│   │   │   ├── chaos-matrix/index.tsx      # Interactive probability sliders & presets for all 20 rails
│   │   │   ├── statements/index.tsx        # Settlement statement generator & fee-variance injector
│   │   │   └── hosted/
│   │   │       ├── redirect/[sessionId].tsx # Interactive Hosted Checkout Simulator (T-LYNC/MyPay/DPay/3DS2)
│   │   │       └── widget-frame.tsx        # Sandboxed Lightbox modal rendered inside checkout-front
│   │   ├── App.tsx
│   │   └── main.ts
│   ├── vite.config.ts                      # Components() registered BEFORE vueJsx()
│   ├── package.json
│   └── tsconfig.json
```

## 2. Deployment Engine Integration & Production Guardrails (`deploy/`)

The user requirement specifies that the Fake Rails Service must be deployable even to a production environment via the deployment engine (`deploy/deploy.ts`) when explicitly configured with its port, production-allow flag, and single-user portal credentials in `deploy/deploy.env`.

### 2.1 New Configuration Variables in `deploy/deploy.env`

Add Section 7 to `deploy/deploy.env.example` and `deploy/lib/configSchema.ts`:

```ini
# --- 7. STANDALONE FAKE PAYMENT RAILS SERVICE (OPTIONAL TESTING / SANDBOX TIER) -
# Set FAKE_RAILS_ENABLED="true" to build, provision, and deploy the standalone
# Fake Payment Rails service & Tester Portal.
# SAFETY GUARD: If DEPLOY_ENV="production" (or NODE_ENV="production"), the deploy
# orchestrator and the service itself will REFUSE to start unless
# FAKE_RAILS_ALLOW_IN_PRODUCTION="true" is ALSO explicitly set.
FAKE_RAILS_ENABLED="true"
FAKE_RAILS_ALLOW_IN_PRODUCTION="true"   # Explicit opt-in required when running in production mode
IS_TEST_SERVER="true"                   # Declares this server as a test/sandbox installation (enables fake rails & synthetic seeder)

# Host & SSH settings (can share IP with CORE_HOST / CHECKOUT_HOST or use a dedicated 6th VM)
FAKE_RAILS_SSH_HOST="10.10.0.20"
FAKE_RAILS_SSH_PORT="22"
FAKE_RAILS_SSH_USER="ubuntu"
FAKE_RAILS_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_core"
FAKE_RAILS_SUDO_PASSWORD="core-sudo-password"
FAKE_RAILS_PRIVATE_IP="10.10.0.20"

# Port & Reverse Proxy Binding
FAKE_RAILS_BACK_PORT="4104"             # Local Express port bound to 127.0.0.1:4104
FAKE_RAILS_NGINX_PORT="8444"            # External/LAN Nginx port serving Portal + Hosted Pages + Gateway APIs
FAKE_RAILS_SSL="true"                   # "true" (HTTPS via self-signed/certbot/custom) | "false" (HTTP)
FAKE_RAILS_SSL_MODE="self_signed"       # "self_signed" | "certbot" | "custom"
FAKE_RAILS_DOMAIN="fakerails.internal"  # Domain or IP used in base_urls of seeded fake gateways
FAKE_RAILS_PUBLIC_BASE_URL="https://10.10.0.20:8444"
FAKE_RAILS_REMOTE_DIR="/var/www/pg-fake-rails"
FAKE_RAILS_ALLOWED_CIDRS="10.0.0.0/8,192.168.0.0/16,127.0.0.1/32"

# Single-User Tester Portal Credentials (Required when FAKE_RAILS_ENABLED="true")
FAKE_RAILS_ADMIN_USER="tester_admin"
FAKE_RAILS_ADMIN_PASSWORD="ChangeMe-Strong-Tester-Pass-2026!"
FAKE_RAILS_JWT_SECRET="64-byte-random-secret-for-fake-rails-portal-jwt"
FAKE_RAILS_SEEDER_TOKEN="64-byte-shared-token-for-synthetic-seeder-sync"

# Core-Back Integration Flags
SEED_FAKE_RAILS_BLUEPRINTS="true"       # Registers/updates the 20 gateways in core-back to point to FAKE_RAILS_PUBLIC_BASE_URL
```

### 2.2 Startup & Deployment Safety Gates (`deploy/lib/configSchema.ts` & `fake-rails-back/lib/env/index.ts`)

Both the deployment orchestrator (`deploy/deploy.ts`) and the service startup (`fake-rails-back/lib/env/index.ts`) enforce three non-negotiable rules:

1. **Explicit Production Opt-In Gate:**
   - If `FAKE_RAILS_ENABLED === "true"` and `NODE_ENV === "production"`, startup immediately checks `FAKE_RAILS_ALLOW_IN_PRODUCTION === "true"`. If false or omitted, `configSchema.ts` and `fake-rails-back` abort with exit code `1` (`FAKE_RAILS_PRODUCTION_GUARD_BLOCKED: Set FAKE_RAILS_ALLOW_IN_PRODUCTION="true" to run Fake Rails in production mode`).
2. **Non-Empty Single-User Portal Credentials Gate:**
   - When `FAKE_RAILS_ENABLED === "true"`, `FAKE_RAILS_ADMIN_USER` (min 4 chars) and `FAKE_RAILS_ADMIN_PASSWORD` (min 12 chars, never default/empty) are strictly validated by Zod 4 before any SSH connection or process startup.
3. **Port Collision & Firewall Isolation Gate:**
   - `configSchema.ts` verifies that `FAKE_RAILS_BACK_PORT` (`4104`) and `FAKE_RAILS_NGINX_PORT` (`8444`) do not collide with `CORE_PORT` (`4000`), `ADMIN_BACK_PORT` (`4101`), `MERCHANT_BACK_PORT` (`4102`), `CHECKOUT_BACK_PORT` (`4103`), `ADMIN_NGINX_LAN_PORT` (`8443`), or public `80`/`443`.
   - `firewallConfigurator.ts` opens `FAKE_RAILS_NGINX_PORT` (`8444`) to `FAKE_RAILS_ALLOWED_CIDRS` (plus `CORE_PRIVATE_IP` and `CHECKOUT_PRIVATE_IP`), while keeping `FAKE_RAILS_BACK_PORT` (`4104`) bound strictly to `127.0.0.1`.

### 2.3 Scoped SSRF & TLS Allowlist in `core-back` for Fake Rails

In `core-back`, Safeguard 10 (`StepExecutor.ts` custom DNS hook) blocks outbound calls to private/loopback IP ranges (`10.0.0.0/8`, `192.168.0.0/16`, `127.0.0.0/8`) to prevent SSRF. When `FAKE_RAILS_ENABLED="true"` is deployed on a LAN IP (e.g., `https://10.10.0.20:8444`) or `127.0.0.1:8444`:

- `deploy/deploy.ts` writes `ALLOW_FAKE_RAILS_HOSTS="true"` and `FAKE_RAILS_ALLOWED_HOSTS="fakerails.internal,10.10.0.20,127.0.0.1"` into `core-back`'s `shared/.env`, and trusts the generated `fake-rails-ca.crt` (or `internal-ca.crt` used to sign the Fake Rails Nginx TLS certificate) in `NODE_EXTRA_CA_CERTS`.
- `core-back/engine/flow/StepExecutor.ts` checks: if `env.ALLOW_FAKE_RAILS_HOSTS === true` and the target hostname/IP is **both** in `env.FAKE_RAILS_ALLOWED_HOSTS` **and** in the gateway version's `gateway_environments.allowed_hosts`, the private-IP rejection is bypassed for that exact host:port. All other private/loopback/metadata IPs (`169.254.169.254`, database ports, internal admin ports) remain strictly blocked.

### 2.4 Extension to the 12-Step Deployment Pipeline (`deploy/deploy.ts`)

When `FAKE_RAILS_ENABLED="true"` (or `./deploy/deploy.sh --only=fake-rails`), the orchestrator executes:
- **Step 2b (Local SPA Build):** Builds `fake-rails-front` via Vite (`bun run build`) alongside `admin-front`, `merchant-front`, and `checkout-front`.
- **Step 3b (Certificate Minting):** Mints `fake-rails.crt` / `fake-rails.key` signed by the deployment CA with `SAN = DNS:${FAKE_RAILS_DOMAIN}, IP:${FAKE_RAILS_PRIVATE_IP}, IP:127.0.0.1` so `core-back` verifies HTTPS TLS 1.3 cleanly without disabling TLS verification.
- **Step 6b (Deploy `fake-rails-back` & `fake-rails-front` to `FAKE_RAILS_HOST`):**
  - Rsyncs `fake-rails-back/` and `fake-rails-front/dist/` to `/var/www/pg-fake-rails/releases/<TS>/`.
  - Creates `/var/www/pg-fake-rails/shared/data/` (for persistent `fake-rails.sqlite`) and `/var/www/pg-fake-rails/shared/.env` (`chmod 600`) containing `FAKE_RAILS_ADMIN_USER`, `FAKE_RAILS_ADMIN_PASSWORD`, `CORE_INBOUND_BASE_URL=https://${CHECKOUT_DOMAIN}/api/v1/inbound`, and deterministic signing secrets matching `seedFakeRails.ts`.
  - Switches `/var/www/pg-fake-rails/current` symlink, starts PM2 process `pg-fake-rails-back`, renders `/etc/nginx/sites-enabled/pg-fake-rails.conf` on `FAKE_RAILS_NGINX_PORT`, runs `nginx -t`, and reloads Nginx.
  - If `SEED_FAKE_RAILS_BLUEPRINTS="true"`, runs `bun run seed-fake-rails` on `CORE_HOST` so all 20 gateway configurations in `core-back` have their `base_urls` and `script_urls` pointed to `FAKE_RAILS_PUBLIC_BASE_URL` and their `ConfirmationChannel` path tokens synced with `fake-rails-back`.

## 3. Single-User Authentication Architecture (Configured via `deploy.env`)

Per the specification, the Fake Rails Portal has **one user** whose username and password are provided in `deploy.env`.

### 3.1 Authentication Flow (`fake-rails-back/api/portal/auth.ts`)

1. **Zero Database User Table Required:**
   - On startup, `fake-rails-back/lib/env/index.ts` reads `FAKE_RAILS_ADMIN_USER`, `FAKE_RAILS_ADMIN_PASSWORD`, and `FAKE_RAILS_JWT_SECRET` from `.env` (populated by `deploy.ts` from `deploy.env`).
   - Startup derives a SHA-256 digest of both credentials in memory for constant-time comparison via `crypto.timingSafeEqual`.
2. **Login Endpoint (`POST /portal-api/auth/login`):**
   - Validates `{ username, password }` using Zod 4.
   - Enforces a sliding-window brute-force rate limiter (max 10 failed attempts per IP per 15 minutes).
   - Compares `username` and `password` against the `deploy.env` credentials using `crypto.timingSafeEqual`.
   - On match, issues a signed HS256 JWT (`exp: 12h`, `sub: env.FAKE_RAILS_ADMIN_USER`, `role: "FAKE_RAILS_TESTER"`) and returns `{ token, user: { username: env.FAKE_RAILS_ADMIN_USER, allowInProduction: env.FAKE_RAILS_ALLOW_IN_PRODUCTION } }`.
3. **Portal Guard Middleware (`portalAuthGuard.ts`):**
   - Protects all `/portal-api/*` endpoints (except `/portal-api/auth/login` and `/portal-api/internal/bulk-seed`, which requires the `X-Fake-Rails-Seeder-Token: ${FAKE_RAILS_SEEDER_TOKEN}` header).

## 4. Comprehensive Multi-Rail Protocol Emulation (All 20 Gateways & 9 Modes)

`fake-rails-back` exposes realistic, protocol-accurate endpoints under `/rails/<gateway_code>/*` that honor the exact wire formats, content types (`application/json`, `application/x-www-form-urlencoded`, `multipart/form-data`, `text/xml`), amount scales, and cryptographic signatures defined in `core-back`'s 7 Production Blueprints and 20-gateway matrix.

### 4.1 Complete Endpoint & Protocol Map in `fake-rails-back`

| Gateway Code | Collection Mode(s) | Emulated Endpoints on `fake-rails-back` | Wire Format, Auth & Crypto Verified by Emulator | Confirmation & Settlement Emulation |
| :--- | :--- | :--- | :--- | :--- |
| **`edfali`** | `OTP_PULL` | `POST /rails/edfali/verify`<br>`POST /rails/edfali/confirm`<br>`GET /rails/edfali/statement` | `Bearer` + `X-API-KEY`; `multipart/form-data` or `JSON`; 2-decimal LYD (`XXX.XX`); validates `^09[0-9]{8}$` | Returns `process_id` on `/verify` (default test OTP `1234` or shown live in Tester Portal); returns `transaction_id` on `/confirm`. No inquiry API (forces statement reconciliation on `UNKNOWN`). |
| **`sadad`** | `OTP_PULL` | `POST /rails/sadad/verify`<br>`POST /rails/sadad/confirm`<br>`GET /rails/sadad/statement` | `Bearer` + `X-API-KEY`; validates `customer_mobile` (`^091[0-9]{7}$`) + `birth_year` (`YYYY`); 10m session TTL | Returns `process_id` on `/verify` (6-digit OTP `123456` or live in Portal); settles on `/confirm`. |
| **`mobicash`** | `OTP_PULL` / `QR_DISPLAY` | `POST /rails/mobicash/open`<br>`POST /rails/mobicash/confirm`<br>`POST /rails/mobicash/qr` | `Bearer`; validates 7-digit MobiCash `card_number`; 15m TTL | Opens `payment_uuid`, confirms OTP -> `bank_reference`, or generates dynamic EMVCo QR payload. |
| **`moamalat`** | `EMBEDDED` / `REDIRECT` | `GET /sdk/moamalat-lightbox.js`<br>`GET /hosted/widget-frame`<br>`POST /rails/moamalat/FilterTransactions`<br>`POST /rails/moamalat/refund` | Verifies `SecureHash` via **Hex-decoded** `MerchantSecretKey` (`SORTED_KEY_VALUE_AMP`, `HEX_UPPER`); Dirhams integer (`LYD * 1000`, e.g. `"10500"`); `TrxDateTime` (`YYYYMMDDHHmm`) | Serves drop-in `Lightbox.Checkout.configure(...)` script that opens an interactive card modal in `checkout-front`, fires browser callback (`completeCallback`), dispatches IP-allowlisted webhook (`ActionCode: "00"`), and answers `FilterTransactions` inquiry. |
| **`lypay`** | `QR_DISPLAY` / `PUSH_APPROVAL` | `POST /rails/lypay/api/v1/auth/token`<br>`POST /rails/lypay/api/v1/payments/funds-transfers`<br>`POST /rails/lypay/api/v1/payments/funds-transfers/:uuid/confirm`<br>`GET /rails/lypay/api/v1/payments/funds-transfers/enquiry` | OAuth2 `TOKEN_ENDPOINT` Bearer; 3-decimal LYD (`XXX.XXX`); enforces 20k/100k LYD CBL ceiling check | Generates NUMO EMVCo TLV QR or Push request. Supports 5s sync confirm (`Confirmed`) **or** delayed `Processing` -> HMAC-signed webhook (`transaction_status_update`) + Enquiry API. |
| **`onepay`** | `QR_DISPLAY` / `PAY_CODE` / `OTP_PULL` | `POST /rails/onepay/qr`<br>`POST /rails/onepay/paycode`<br>`POST /rails/onepay/verify`<br>`POST /rails/onepay/confirm`<br>`GET /rails/onepay/status/:ref` | `HMAC-SHA256` payload signature; supports 9-digit cross-bank card code, SMS pay code, or EMVCo QR | Tester can click **"Scan QR / Pay SMS Code"** in the Fake Rails Portal (or let auto-settle timer fire after `N` seconds), triggering signed webhook + inquiry update. |
| **`tlync`** | `REDIRECT` | `POST /rails/tlync/payment/create`<br>`POST /rails/tlync/receipt/transaction`<br>`POST /rails/tlync/refund` | `store_id` + `store_token` + HMAC header; rejects duplicate `custom_ref` with HTTP `422` | Returns `redirect_url` pointing to `/hosted/redirect/:sessionId`. Payer or tester clicks **Approve / Decline / Cancel / Tamper Return URL**; fires POST webhook + GET return redirect + answers `/receipt/transaction` inquiry. |
| **`mypay`** | `REDIRECT` | `POST /rails/mypay/auth/token`<br>`POST /rails/mypay/payment/create` | `TOKEN_ENDPOINT` (600s JWT; returns HTTP `409` on idempotency body mismatch); 8 method aliases | Redirects to `/hosted/redirect/:sessionId`; signs outbound webhook with `X-MYPAY-SIGNATURE` (raw-body HMAC) with 5-retry backoff schedule. |
| **`dpay`** | `REDIRECT` / `OTP_PULL` / `EMBEDDED` | `POST /rails/dpay/sessions/open`<br>`POST /rails/dpay/sessions/:id/verify`<br>`GET /rails/dpay/sessions/:id`<br>`POST /rails/dpay/refund` | `Bearer` token; requires `Idempotency-Key` header; applies 2-decimal rounding (`76.255 -> 76.26`) | Dispatches 6 webhook event types (`payment.paid`, `payment.failed`, `payment.disputed`, etc.) signed via `TIMESTAMP_DOT_RAW_BODY` (`X-DPay-Timestamp` + `X-DPay-Signature`). |
| **`plutu`** | `OTP_PULL` / `REDIRECT` | `POST /rails/plutu/edfali/verify`<br>`POST /rails/plutu/edfali/confirm`<br>`POST /rails/plutu/sadad/verify`<br>`POST /rails/plutu/sadad/confirm`<br>`POST /rails/plutu/tlync/create` | `X-API-KEY` + `Authorization: Bearer <access_token>` + `Secret-Key` | Emulates Plutu's wrapper around Edfali/Sadad/T-LYNC/MPGS and signs card callbacks using `SORTED_VALUES_HASH` (uppercase HMAC with `hashed` excluded). |
| **`yussor_pay` · `sahara_pay` · `masrefy_pay`** | `HYBRID` (`OTP_PULL`, `QR_DISPLAY`, `PAY_CODE`) | `POST /rails/:code/initiate`<br>`POST /rails/:code/confirm`<br>`GET /rails/:code/status/:ref` | Masarat switch style Bearer / API Key; Bronze/Silver/Gold tier limit simulation | Supports 7-digit ID + OTP, MobiMal QR, or SMS purchase code, plus status check endpoint. |
| **`hawelli` · `gpay_libya` · `numo_pay` · `libyana`** | `PUSH_APPROVAL` / `QR_DISPLAY` / `OTP_PULL` / `DEEP_LINK` | `POST /rails/:code/request`<br>`POST /rails/:code/confirm`<br>`POST /rails/:code/cancel`<br>`GET /rails/:code/status/:ref` | Bearer + HMAC / RSA signature headers | Push requests appear immediately in the Fake Rails Portal **"Pending Customer Actions"** queue where the tester can click **Accept**, **Reject**, **Approve Late (After Expiry)**, or let auto-approve fire. |
| **`mpgs`** (Visa/MC) | `EMBEDDED` / `REDIRECT` | `GET /sdk/mpgs-session.js`<br>`POST /rails/mpgs/session`<br>`GET /rails/mpgs/order/:id`<br>`POST /rails/mpgs/order/:id/refund` | `Basic` (`merchant.<MID>:<apiPassword>`); `X-Notification-Secret` webhook header; multi-currency (`LYD`, `USD`, `EUR`) | Simulates 3DS2 challenge screen, sends `X-Notification-Secret` webhook, and answers `GET /order/:id` with `result: "SUCCESS", status: "CAPTURED"`. |
| **`evopay`** | `QR_DISPLAY` / `PUSH_APPROVAL` | `POST /rails/evopay/Payment`<br>`GET /rails/evopay/Payment/:id` | Validates nested JSON `transAmount.amount`, `transAmount.currency`, `merchantTransInfo.merchantTransID` | Returns dynamic QR, fires webhook, and answers `GET /Payment/:id` with `payment.status: "Captured"`. |
| **`neompay`** | `HYBRID` (`INTERNAL` First-Party) | `POST /rails/neompay/payments/requests`<br>`POST /rails/neompay/payments/:id/confirm`<br>`GET /rails/neompay/payments/by-reference/:ref`<br>`POST /rails/neompay/payments/:id/refund`<br>`GET /rails/neompay/ledger-export` | Validates `wallet_id` (`^NP-[0-9]{12}$` + Luhn check digit) and `Idempotency-Key` header; native 3-decimal LYD (`10.505 -> "10.505"`) | Emulates NeomPay reserve -> capture -> release semantics, partial/full refunds, and daily ledger export API for cross-ledger equality verification. |

### 4.2 Interactive Browser Flows (`REDIRECT` & `EMBEDDED` Mode Simulation)

Unlike headless mock servers that cannot be tested from a real browser in `checkout-front`, `fake-rails-front` and `fake-rails-back` provide interactive browser UIs for redirected and embedded flows:

1. **Interactive Hosted Checkout Page (`/hosted/redirect/:sessionId`):**
   - When a customer in `checkout-front` selects a `REDIRECT` rail (e.g., T-LYNC, MyPay, DPay Hosted, MPGS 3DS2), `checkout-front` redirects the browser to `https://<FAKE_RAILS_DOMAIN>:8444/hosted/redirect/:sessionId`.
   - If the rail's Chaos Config is set to **Auto-Pilot** (`autoCompleteRedirect = true`), the page displays a 2-second spinner, evaluates the configured failure probability `%`, fires the background webhook to `checkout-back`, and redirects the browser back to `return_url`.
   - If **Interactive Tester Mode** is active, the page displays the gateway's branded checkout simulator with 6 one-click buttons for the tester:
     - **1. Approve & Redirect Normally** (fires valid signed webhook + redirects to `return_url`),
     - **2. Approve with Tampered Return URL** (redirects to `return_url?status=failed&amount=0.01` while webhook says `PAID`, testing Edge Case 28 / T-04),
     - **3. Send Browser Return Only — Drop Webhook** (tests `RETURN_URL` hint triggering `VERIFY`),
     - **4. Close Tab / Abandon — Fire Webhook 30s Later** (tests Edge Case 1 & async webhook settlement),
     - **5. Decline (Insufficient Funds / Limit Exceeded)**,
     - **6. Customer Cancel** (redirects to `cancel_url`).
2. **Drop-In Embedded Widget Simulator (`/sdk/moamalat-lightbox.js` & `/hosted/widget-frame`):**
   - `core-back` seeds the Moamalat Lightbox `WidgetDefinition.script_urls` to `https://<FAKE_RAILS_DOMAIN>:8444/sdk/moamalat-lightbox.js` (with its matching SHA-384 SRI hash and CSP origin).
   - When `checkout-front` loads the script and calls `window.Lightbox.Checkout.configure({ MID, TID, AmountTrxn, MerchantReference, TrxDateTime, SecureHash, completeCallback, errorCallback, cancelCallback })`, the script verifies the server-computed `SecureHash` against `fake-rails-back` and mounts an interactive Lightbox modal overlay with one-click buttons: **Complete Card Payment**, **Spoof Browser `completeCallback` Without Server Payment (Tests T-06 / Edge Case 21)**, **Trigger Card Decline**, and **Cancel**.

## 5. Probabilistic Chaos & Failure Injection Engine

A core requirement is configuring whether a given rail is going to fail or succeed with a **given percentage chance**, alongside fine-grained control over *how* it fails at each lifecycle phase.

### 5.1 Chaos Configuration Data Model (`fake_rail_scenarios` in SQLite)

Each of the 20 rails has a persisted configuration row in `fake-rails-back` (editable live from the Tester Portal with zero restart):

```ts
export interface RailChaosScenarioConfig {
  railCode: string;                       // e.g. "edfali", "sadad", "moamalat", "lypay", "tlync", "neompay"
  enabled: boolean;                       // If false, returns HTTP 503 Connection Refused (simulates full outage / RB-01)
  overallFailureChancePercent: number;    // 0 to 100 (e.g. 25 means 25% of transactions on this rail will fail)

  // Phase-specific failure distribution (when the PRNG rolls a failure, which phase & error mode is chosen)
  phaseBreakdown: {
    initiateFailWeight: number;           // Weight for failing during INITIATE (before point_of_no_return -> tests Route Failover)
    submitFailWeight: number;             // Weight for failing during SUBMIT / CONFIRM (MOVES_MONEY -> tests UNKNOWN & Lockout)
    verifyFailWeight: number;             // Weight for failing during VERIFY / INQUIRE
    webhookFailWeight: number;            // Weight for webhook delivery anomalies
    refundFailWeight: number;             // Weight for failing during REFUND / VOID (tests Adjustment EXECUTING state)
  };

  // Weighted distribution of failure modes when a failure is triggered
  failureModeWeights: {
    TERMINAL_DECLINE_INSUFFICIENT_FUNDS: number; // Explicit 200/400 decline -> FAILED
    LIMIT_EXCEEDED_CUSTOMER_CEILING: number;     // Customer ceiling hit -> FAILED (must NOT trip circuit breaker)
    WRONG_OTP_RETRYABLE: number;                 // Mistyped OTP -> stays AWAITING_CUSTOMER (otp_attempts + 1)
    HTTP_500_GATEWAY_FAULT: number;              // 500 Internal Server Error -> UNKNOWN on money step, trips breaker on initiate
    TIMEOUT_HANG_ABOVE_STEP_TTL: number;         // Sleeps 20,000ms so core-back AbortController times out -> UNKNOWN
    SOCKET_RESET_MID_STREAM: number;             // Destroys TCP socket after receiving body -> UNKNOWN
    MALFORMED_OR_UNMAPPED_200_BODY: number;      // Returns 200 OK with broken/changed JSON schema -> UNKNOWN (Edge Case 57)
    RATE_LIMIT_HTTP_429: number;                 // Returns 429 Too Many Requests
    AMOUNT_ROUNDING_MISMATCH: number;            // Settles +/- 0.050 LYD or 2-decimal rounded amount -> tests mismatch_policy
    CONFLICTING_WEBHOOK_VS_INQUIRY: number;      // Webhook says PAID, Inquiry says FAILED -> P1 CONFLICT (Edge Case 20)
  };

  // Latency & Async Confirmation Timing
  latencyMs: { min: number; max: number };       // Artificial network latency range (e.g. 50ms - 400ms)
  autoApproveAsyncAfterSec: number | null;       // For PUSH_APPROVAL / QR_DISPLAY: auto-confirm after N sec (null = wait for manual click in Portal)
  webhookBehavior: {
    delaySeconds: number;                        // Delay before sending webhook (set > session TTL to test Late Success Recovery)
    duplicateCount: number;                      // Send 1 (normal) or 2..5 identical webhooks (tests dedupe_key)
    outOfOrderPendingAfterPaid: boolean;         // Send PAID webhook followed 2s later by PENDING (tests forward-only rule)
    corruptSignatureChancePercent: number;       // 0 to 100% chance of sending an invalid HMAC signature (tests RB-02)
  };
}
```

### 5.2 Deterministic Magic Inputs + Probabilistic PRNG Evaluation (`ChaosEvaluator.ts`)

Every incoming request to `/rails/:gatewayCode/*` passes through `ChaosEvaluator.evaluate(req, railConfig)`:

1. **Priority 1 — Deterministic Magic Test Inputs (100% Reproducible Contract & 15-Scenario Suite):**
   - Before rolling the percentage dice, `ChaosEvaluator` checks if the request contains a deterministic magic phone number, OTP, or amount suffix (used by `core-back`'s 15-scenario sandbox runner and automated tests):
     - OTP `000000` or `0000` -> Always returns `WRONG_OTP_RETRYABLE`.
     - OTP `999999` or Phone ending in `9901` -> Always returns `INSUFFICIENT_FUNDS`.
     - Phone ending in `9902` -> Always returns `LIMIT_EXCEEDED`.
     - Phone ending in `9905` or OTP `500500` -> Always returns `HTTP_500_GATEWAY_FAULT` on `SUBMIT` (`MOVES_MONEY`).
     - Phone ending in `9906` or OTP `408408` -> Always hangs for `20,000ms` (`TIMEOUT_HANG_ABOVE_STEP_TTL`).
     - Phone ending in `9907` -> Always returns `200 OK` with `{ unexpected_schema: true }` (`MALFORMED_OR_UNMAPPED_200_BODY`).
2. **Priority 2 — Per-Transaction Override from the Tester Portal:**
   - If the tester clicked **"Force Next Outcome"** on an active transaction in the Portal (while the customer is on the OTP, QR, Push, or Redirect screen), that explicit outcome wins.
3. **Priority 3 — Configured Percentage Chance (`overallFailureChancePercent`):**
   - For normal traffic, when a transaction first hits `INITIATE` (or `PRE_INITIATE`), `ChaosEvaluator` draws `roll = Math.random() * 100`.
   - If `roll < railConfig.overallFailureChancePercent`, the transaction is assigned a failure fate (`assignedFailPhase` and `assignedFailureMode`) sampled from `phaseBreakdown` and `failureModeWeights` and stored on its `fake_transactions` row in SQLite.
   - Pinning the roll at transaction creation ensures coherent multi-step behavior: for example, if the roll decides this transaction will fail at `SUBMIT` with `TIMEOUT_HANG_ABOVE_STEP_TTL`, `INITIATE` succeeds normally (sending the OTP), and when `SUBMIT` arrives, it hangs as scheduled.

### 5.3 Embedded SQLite Schema (`fake-rails-back/engine/db/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS fake_rail_scenarios (
  rail_code TEXT PRIMARY KEY,
  gateway_code TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fake_transactions (
  id TEXT PRIMARY KEY,                      -- UUIDv7
  gateway_code TEXT NOT NULL,
  rail_code TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT 'SANDBOX',      -- 'SANDBOX' | 'LIVE'
  our_reference TEXT NOT NULL,              -- ATTEMPT.gateway_reference sent by core-back
  provider_reference TEXT NOT NULL UNIQUE,  -- Generated by fake-rails-back (e.g. "FK-EDF-20261030-00192")
  network_reference TEXT,                   -- Generated for switch rails (Moamalat, LYPay, OnePay)
  idempotency_key TEXT,
  requested_amount_wire TEXT NOT NULL,      -- Exact wire string received (e.g. "10500" or "76.26")
  normalized_amount_lyd TEXT NOT NULL,      -- Decimal(18,4) string in LYD
  settled_amount_lyd TEXT,                  -- May differ if AMOUNT_ROUNDING_MISMATCH is injected
  gateway_fee_lyd TEXT NOT NULL DEFAULT '0.0000',
  currency TEXT NOT NULL DEFAULT 'LYD',
  collection_mode TEXT NOT NULL,
  customer_identifier_masked TEXT,          -- Masked phone / card / wallet_id
  expected_otp TEXT,                        -- Generated OTP (visible in Tester Portal for live copy-paste!)
  status TEXT NOT NULL,                     -- 'INITIATED' | 'AWAITING_ACTION' | 'PAID' | 'FAILED' | 'UNKNOWN_SIMULATED' | 'CANCELLED' | 'REFUNDED' | 'DISPUTED'
  assigned_fail_phase TEXT,                 -- Null if happy path, else 'INITIATE' | 'SUBMIT' | 'VERIFY' | 'WEBHOOK' | 'REFUND'
  assigned_failure_mode TEXT,               -- Specific failure mode selected by PRNG or tester
  inquiry_override_status TEXT,             -- Used to simulate CONFLICT (webhook=PAID, inquiry=FAILED)
  return_url TEXT,
  cancel_url TEXT,
  webhook_url TEXT,
  is_seeded_historical INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fake_tx_our_ref ON fake_transactions(gateway_code, our_reference);
CREATE INDEX IF NOT EXISTS idx_fake_tx_created ON fake_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fake_tx_status ON fake_transactions(rail_code, status);

CREATE TABLE IF NOT EXISTS fake_step_events (
  id TEXT PRIMARY KEY,
  transaction_id TEXT,
  gateway_code TEXT NOT NULL,
  phase TEXT NOT NULL,                      -- 'INITIATE' | 'SUBMIT' | 'VERIFY' | 'REFUND' | 'WEBHOOK_OUT'
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  request_body_raw TEXT NOT NULL,
  response_status INTEGER,
  response_body_raw TEXT,
  injected_fault TEXT,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fake_events_tx ON fake_step_events(transaction_id, created_at ASC);
```

## 6. Single-User Tester Portal & Dashboard Architecture (`fake-rails-front`)

Built in Vue 3 TSX (`dc()` from `kt-dc`) + Vuetify 3, `fake-rails-front` gives the tester complete visibility and control over all 20 fake rails.

### 6.1 Portal Views & Capabilities

| View / Route | Core Features for the Tester |
| :--- | :--- |
| **1. Login (`/login`)** | Single-user sign-in form verified against `FAKE_RAILS_ADMIN_USER` and `FAKE_RAILS_ADMIN_PASSWORD` from `deploy.env`. Displays an environment badge (`SANDBOX` or `PRODUCTION TEST SERVER`). |
| **2. Live Command Center (`/dashboard`)** | - **Realtime SSE Stream (`GET /portal-api/transactions/stream`):** Every incoming `INITIATE`, `SUBMIT`, `VERIFY`, or `REFUND` call from `core-back` flashes live on screen within 20ms.<br>- **Live OTP & Action Banner:** When a tester initiates an `OTP_PULL` payment in `checkout-front`, the generated OTP code (`expected_otp`, e.g., `482910`) pops up at the top of the Fake Rails Dashboard with a 1-click **Copy OTP** button so the tester knows the exact code.<br>- **Pending Customer Actions Queue:** For `PUSH_APPROVAL`, `QR_DISPLAY`, and `PAY_CODE` attempts (LYPay, OnePay, GPay, Hawelli, Evo Pay, NeomPay), displays 1-click buttons: **Approve Now**, **Approve with Amount Mismatch**, **Approve Late (After Expiry)**, or **Reject in Wallet**. |
| **3. Per-Rail Chaos & Failure Probability Matrix (`/chaos-matrix`)** | - Displays all 20 rails as interactive cards (`RailChaosCard.tsx`).<br>- Each card has a **Failure Chance Slider (`0%` to `100%`)**, a quick toggle (**100% Healthy**, **25% Flaky**, **100% Timeout on Confirm -> `UNKNOWN`**, **Full Outage 503**), phase breakdown weights (`INITIATE` vs `SUBMIT` vs `VERIFY`), and failure mode weights.<br>- Includes global preset buttons: **"Reset All Rails to 0% Failure"**, **"Simulate National Switch Instability (40% Timeout/5xx)"**, and **"Force Aggregator Failover (100% DPay Fail at Initiate, 0% Direct Fail)"**. |
| **4. Transactions & Wire Inspector (`/transactions`)** | - Server-side filterable table of all transactions (both live and seeded historical records) by rail, gateway, status, reference, amount, and date range.<br>- Clicking any row opens `WireInspectorDrawer.tsx` showing the exact HTTP headers, raw request body, canonical string used for HMAC verification, injected chaos fault, and response payload.<br>- **Post-Payment Action Bar:** On any `PAID` transaction, the tester can click **1. Trigger Webhook Replay**, **2. Send Forged-Signature Webhook**, **3. Open Upstream Chargeback/Dispute Webhook** (fires a signed `DISPUTE_OPENED` webhook to `core-back` to test automated `SYSTEM_AUTOMATION` dispute drafting!), or **4. Flip Inquiry Status to FAILED** (to trigger a `P1 CONFLICT` operator case). |
| **5. Settlement Statement Generator (`/statements`)** | - Selects any gateway and date window, previews all settled transactions in `fake-rails-back`, and lets the tester inject reconciliation anomalies before downloading or pushing the statement (`CSV`, `XLSX`, or `JSON`) to `core-back`:<br>  • **Include 100% Matched Lines (Clean Sweep)**<br>  • **Inject Fee Variance (+0.150 LYD on 5% of rows)**<br>  • **Omit 1 Transaction (`MISSING_AT_GATEWAY`)**<br>  • **Add 1 Unrecorded Transaction (`MISSING_LOCALLY`)** |

## 7. `core-back` Pre-Seeded Fake Gateway Blueprints (`seedFakeRails.ts`)

To make `core-back` work out-of-the-box with `fake-rails-back`, `core-back/prisma/seedFakeRails.ts` configures all 20 gateways and their active `LIVE` / `SANDBOX` versions to point their `gateway_environments.base_urls` to `FAKE_RAILS_PUBLIC_BASE_URL` (`https://<FAKE_RAILS_DOMAIN>:8444/rails/<gateway_code>`) and their `allowed_hosts` to `[FAKE_RAILS_DOMAIN, FAKE_RAILS_PRIVATE_IP]`.

Crucially, both `seedFakeRails.ts` and `fake-rails-back` share a deterministic credential and webhook-secret derivation keyed by `FAKE_RAILS_SEEDER_TOKEN` so that:
- `MOAMALAT_SECURE_HASH` outbound signatures computed by `core-back` are cryptographically verified by `fake-rails-back`,
- `DPAY_WEBHOOK_VERIFY`, `PLUTU_CALLBACK_HASH`, `MYPAY` raw-body HMAC, and `LYPAY` webhooks signed by `fake-rails-back` pass `core-back`'s `CallbackVerifier` with real constant-time cryptographic verification (zero bypassed security checks in `core-back`).

## 8. OpenCode Implementation Checklist for the Fake Rails Service

- [ ] **`FR-1` Scaffold `fake-rails-back` & SQLite WAL Store:** Create `fake-rails-back/` following `template-back-front` conventions (`lib/env`, `lib/error`, `lib/zReady`, `engine/db/schema.sql`), enforcing the `FAKE_RAILS_ALLOW_IN_PRODUCTION` startup gate and single-user `deploy.env` authentication.
- [ ] **`FR-2` Implement `ChaosEvaluator` & `WebhookDispatcher`:** Build the percentage-chance failure evaluator (`0%–100%`), deterministic magic-input detector, and cryptographic webhook dispatcher (`HMAC_SHA256` Hex/UTF8, `SORTED_KEY_VALUE_AMP`, `TIMESTAMP_DOT_RAW_BODY`, `SORTED_VALUES_HASH`).
- [ ] **`FR-3` Implement All 20 Gateway Protocol Routers & Drop-In JS SDKs:** Build `/rails/*` routers (`otpPullRouter`, `embeddedRouter`, `qrAndPushRouter`, `redirectRouter`, `internalNeomPayRouter`, `statementRouter`) and `/sdk/moamalat-lightbox.js` + `/sdk/mpgs-session.js`.
- [ ] **`FR-4` Build `fake-rails-front` Tester Portal & Hosted Checkout Pages in Vue 3 TSX (`kt-dc`):** Build `/login`, `/dashboard` (SSE live feed + OTP banner + pending push/QR actions), `/chaos-matrix` (percentage sliders), `/transactions` (`WireInspectorDrawer` + dispute/webhook triggers), `/statements`, and `/hosted/redirect/[sessionId]`.
- [ ] **`FR-5` Integrate into `deploy/` & `core-back/prisma/seedFakeRails.ts`:** Update `deploy/deploy.env.example`, `deploy/lib/configSchema.ts`, `deploy/lib/hostPlanner.ts`, `deploy/lib/firewallConfigurator.ts`, `deploy/deploy.ts`, `deploy/templates/nginx.fakerails.conf.tpl`, `core-back/engine/flow/StepExecutor.ts` (scoped `ALLOW_FAKE_RAILS_HOSTS` check), and `core-back/prisma/seedFakeRails.ts`.

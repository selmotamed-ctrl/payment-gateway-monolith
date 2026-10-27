# MASTER ARCHITECTURE & TECHNICAL SPECIFICATION · VERSION 5.0 (FINAL MULTI-SERVICE PRODUCTION EDITION)

# Unified Dynamic Payment Gateway & Payment Links Platform

**Subtitle:** Zero-code dynamic payment gateway engine, four-layer catalog, 10-phase declarative flow engine, trusted confirmation layer, ownership-aware double-entry ledger, and full KYB/AML/Dispute governance — architected for a Zero-Trust 7-Project Split Topology (`core-back`, `admin-back`, `admin-front`, `merchant-back`, `merchant-front`, `checkout-back`, `checkout-front`) built on the `selmotamed-ctrl/template-back-front` stack (Bun + Express 5 + Zod 4 + Prisma 7 & Vue 3 TSX/JSX + Vuetify 3 + `kt-dc` + Vite).

**Author:** Platform Architecture & Engineering Group  
**Date:** October 2026 · Libya (Central Bank of Libya Compliant) & International Switches  
**Coverage (20 Gateways):** Moamalat (NPG) · LYPay (CBL Instant Payment) · Numo Pay · Sadad (Almadar) · Libyana · Edfali / Edfaa Li (BCD) · MobiCash (Masarat) · Tadawul / T-LYNC · OnePay · Yussor Pay (NCB) · Sahara Pay · Masrefy Pay (Jumhouria Bank) · Hawelli (Zaho) · GPay Libya & Google Pay · Visa / Mastercard (MPGS / 3DS2) · Evo Pay · NeomPay (First-Party Wallet) · Aggregators (DPay, Plutu, MyPay)

## Contents

- **PART I: FOUNDATIONS & MULTI-SERVICE TOPOLOGY**
  - 1. Executive Summary and Architectural Vision
  - 2. Zero-Trust 7-Service Split Architecture, mTLS & Reverse Proxy Topology
  - 3. Template Stack Standards (`selmotamed-ctrl/template-back-front` Conventions)
  - 4. Source Design Consolidation & v5.0 Evolution Register
  - 5. Research Foundation: The Libyan & International Gateway Landscape (20 Gateways)
- **PART II: PLATFORM CORE & PRISMA 7 DATABASE SCHEMA**
  - 6. Core Domain Concepts: The Four-Layer Catalog & Visible Rails Formula
  - 7. Complete Database Schema in `core-back` (64 Tables Across 6 Groups + Prisma 7 Rules)
- **PART III: THE UNIVERSAL RAIL ENGINE (VOUCHER-INSPIRED ZERO-CODE ARCHITECTURE)**
  - 8. Engine Contract, `ApiConsumer` Registry, `recursiveSet`, Transforms & Crypto Engine
- **PART IV: COLLECTION MODES, STATE MACHINE & PRODUCTION BLUEPRINTS**
  - 9. The 13-State Attempt Lifecycle Machine and Atomic Slot Reservation Invariant
  - 10. Seven Production Configuration Blueprints (Including NeomPay First-Party Rail)
- **PART V: TRUST, VERIFICATION AND THE DOUBLE-ENTRY LEDGER**
  - 11. Money, Fee Bearers, Ownership Models & 15 Worked Journal Entries
- **PART VI: GOVERNANCE, SECURITY, THREAT MODEL & OPERATIONS**
  - 12. Fourteen Engineering Safeguards, Inter-Service Double-Validation & STRIDE Threat Model
  - 13. Service-Level Objectives (SLOs), Incident Runbooks & DR Replay
- **PART VII: QUALITY, TESTING AND THE 140-CASE EDGE-CASE MASTER CATALOG**
  - 14. The Twelve Go-Live Gates
  - 15. The Complete 140-Entry Edge-Case Master Catalog
- **PART VIII: ADMIN WIZARD, INTERNAL mTLS & PUBLIC API SURFACES**
  - 16. The 8-Step Admin "Add-a-Gateway" Wizard & Complete API Surface Mapping
- **PART IX: PLATFORM INTERFACES, ONBOARDING, GOVERNANCE & COMPLIANCE PROGRAM**
  - 17. Actors, Interfaces, Roles & the Four-Eyes Matrix
  - 18. Merchant Onboarding & Join Request Flow
  - 19. Applications, Wallets & Detail Governance
  - 20. AML & Compliance Program
  - 21. Disputes, Chargebacks & Automated Drafting
  - 22. Platform Profitability, Liquidity & Statistics
- **PART X: MANAGEMENT DECISIONS, ASSUMPTIONS & TRACEABILITY**
  - 23. Management Decisions Register (`OD-1` to `OD-11`)
  - 24. Assumptions, Out-of-Scope Items & Traceability Matrix

# PART I: FOUNDATIONS & MULTI-SERVICE TOPOLOGY

## 1. Executive Summary and Architectural Vision

This specification is the single, authoritative, consolidated production design (**Version 5.0**) for the **Unified Dynamic Payment Gateway & Payment Links Platform**. It unifies the original management proposal (*Payment Gateway Platform Proposal*), the dynamic zero-code provider engine from the *Voucher Provider Management System*, and all refinements through *Master Architecture v4.1*, while adapting the entire system to your **isolated 7-service multi-tier security architecture** and the exact conventions of [`selmotamed-ctrl/template-back-front`](https://github.com/selmotamed-ctrl/template-back-front).

An operator adds a payment gateway from the Admin Back Office (`admin-front` -> `admin-back` -> `core-back`) by describing:
1. How to authenticate (`GatewayAuth` & `ApiConsumer` registry),
2. What the customer must enter (`RailField` compiled to cached Zod 4 validators),
3. Which HTTP calls pre-validate, start, confirm, inquire, cancel, and refund a payment (`Flow` & `FlowStep` stacks across 10 phases),
4. How the result arrives (`ConfirmationChannel` across 7 trust-ranked channels),
5. How gateway status and error codes map to canonical platform statuses (`StatusRule` & `ErrorMap`), and
6. How the money settles (`CredentialSet` ownership & `GLAccount` clearing/treasury routing).

Where declarative configuration genuinely cannot express a gateway (proprietary binary protocols, hardware encryption, or bespoke multi-leg exchanges), a **Native Adapter** plugs into the same registry inside `core-back` under the exact same 6-method contract, state machine, inbox, verifier, and single `LedgerPoster`.

### 1.1 The Thirteen Headline Architectural Decisions

1. **Zero-Trust 7-Project Split with `core-back` Database Exclusivity (New in v5.0):**
   - **`core-back` is the sole service with database access (`prisma/`), secret encryption keys, ledger posting authority, and outbound gateway execution (`DynamicRailEngine`).** It is strictly internal and unreachable from the public internet.
   - Public-facing edge backends (`merchant-back`, `checkout-back`) and the LAN-restricted admin backend (`admin-back`) have **zero database drivers or credentials**. They communicate with `core-back` exclusively over **Mutual TLS (mTLS)** on the private local network, and `core-back` independently re-validates every payload, identity, authority, and business invariant ("Double-Check Rule").
2. **Four Layers Instead of One:**
   - **Gateway:** One technical integration with one external system (environments, base URLs, auth, flows, channels, status/error mappings, amount settings).
   - **Credential Set:** Whose account and secrets (`PLATFORM` or `MERCHANT`), per environment (`SANDBOX` or `LIVE`), with an explicit settlement target (`PLATFORM_CLEARING`, `MERCHANT_DIRECT`, `PROVIDER_HELD`).
   - **Rail:** What the customer sees and chooses at checkout (e.g., Edfali, Sadad, LYPay, Moamalat Card, NeomPay), owning the customer form, bilingual labels, logo, currency, and capability flags.
   - **Route:** The binding of a Rail to a Gateway through a Credential Set, carrying priority, cost model, min/max limits, daily cap, circuit-breaker health, maintenance windows, and merchant/app/channel/risk-tier scope.
3. **Collection Mode and Confirmation Channel Are Independent Axes:**
   - **Axis A (Collection Mode):** What the customer does (`OTP_PULL`, `REDIRECT`, `EMBEDDED`, `PUSH_APPROVAL`, `QR_DISPLAY`, `PAY_CODE`, `DEEP_LINK`, `MANUAL`, `HYBRID`).
   - **Axis B (Confirmation Channel):** How the platform learns the result (`SYNC_RESPONSE`, `WEBHOOK`, `INQUIRY / POLL`, `RETURN_URL`, `BROWSER_CALLBACK`, `STATEMENT`, `OPERATOR_CONFIRMATION`). Any mode combines with any valid channel ordered by trust.
4. **A Declarative 10-Phase Flow Engine with a Closed Transform Library and Native Escape Hatch:**
   - Supports 10 lifecycle phases (`CREDENTIAL_CHECK`, `PRE_INITIATE`, `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, `REFUND`, `VOID`, `CAPTURE`, `SETTLEMENT_FETCH`) and a closed library of pure, typed, save-time-validated transform operations (`TransformPipe[]`). Zero arbitrary scripting (`eval` or `Function` is strictly prohibited).
5. **Browser Events and Return URLs Are Never Trusted:**
   - Money is posted to the ledger **only** after server-verified confirmation inside `core-back` confirming all five facts: status = success, our reference matches, settled amount matches within route rounding tolerance, currency matches, and environment matches. Widget callbacks (`completeCallback`) and redirect `return_url` hits are untrusted hints that only trigger `VERIFY` (inquiry).
6. **Immutable, Versioned Configuration with In-Flight Attempt Pinning:**
   - Every gateway or rail edit drafts a new immutable `gateway_versions` snapshot (`DRAFT` -> `SANDBOX_VERIFIED` -> `PENDING_APPROVAL` -> `LIVE`). Every `payment_attempts` row pins `gateway_version_id`, `route_id`, `credential_set_id`, and `commission_profile_id` at creation so in-flight payments are never mutated by mid-day admin edits.
7. **Uncertain Outcomes Become `UNKNOWN` and Are Never Retried Blindly:**
   - A timeout, connection reset, HTTP 5xx, or extraction failure on a `MOVES_MONEY` step transitions the attempt to `UNKNOWN`, holds the single-use link slot reservation (`active_locked_count`), and triggers automated background inquiry/polling, statement reconciliation, or Maker-Checker operator resolution.
8. **Ownership-Aware Double-Entry Ledger Rooted in Physical Reality:**
   - Platform-held settlement posts through per-gateway `GATEWAY_CLEARING` accounts with optional `GATEWAY_FEE_ACCRUAL` and T+N bank sweep true-ups into `TREASURY`. Merchant-owned accounts (`MERCHANT_DIRECT`) never touch platform cash or merchant wallets; they book only platform commission into `COMMISSION_RECEIVABLE` (collected via wallet netting, invoice, or card-on-file).
9. **Four-Layer Risk & Commercial Governance:**
   - Field-level `detail_change_logs`, CBL-compliant KYB/AML screening with automatic `AML_HOLD` escrow and correlated velocity-AML escalation, atomic sliding-window Velocity Rules, and versioned Commission Profiles with three fee-bearer models (`MERCHANT_ABSORBS`, `PAYER_SURCHARGE`, `SPLIT`).
10. **Fourteen Code-Level Engineering Safeguards & STRIDE Threat Mitigation:**
    - Prototype-pollution-safe `recursiveSet`, Promise-cached `ApiConsumer` registry, single-flight token refresh, chained `setTimeout` with jitter, rotating refresh-token DB persistence, `AbortController` timeouts, strict confirm retry boundaries, raw-text-first parsing, multi-layer literal secret redaction, DNS-rebinding/SSRF protection, host-pinned credentials, distributed `InvalidationBus`, destination-aware template encoding, and final-URL re-validation.
11. **Nothing Goes Live Untested (12 Go-Live Gates):**
    - Mandatory dry-run simulation, contract tests for amount scaling/rounding and signature canonicalization against captured real samples, 15-scenario automated test suite per rail, built-in Mock Gateway chaos testing, and canary rollouts.
12. **A Complete Merchant Lifecycle and Compliance Program:**
    - Join Request onboarding with KYB documents and beneficial-owner screening; a pluggable screening-provider integration point; a declarative, versioned AML rule engine; case management under Maker-Checker; configuration-driven CBL reporting that never hard-codes a threshold; role-based interfaces with an explicit four-eyes action matrix.
13. **First-Party Rails, Disputes and Ledger-Derived Reporting:**
    - NeomPay is an `INTERNAL` rail under the same engine contract; chargebacks are drafted automatically (`SYSTEM_AUTOMATION`) but authorized only by a human checker; platform profit, liquidity and merchant statistics are computed exclusively from `journal_lines`.

## 2. Zero-Trust 7-Service Split Architecture, mTLS & Reverse Proxy Topology

To guarantee defense-in-depth, database isolation, and strict privilege separation across public and private network boundaries, the workspace is divided into **8 top-level directories** (4 backend services, 3 frontend SPAs, and 1 `design/` directory):

```text
workspace-root/
├── design/           # Master Architecture & OpenCode Technical Delivery Designs
├── core-back/        # Isolated Core Engine + Sole Prisma DB Access + Outbound Gateway Engine (mTLS Server)
├── admin-back/       # LAN-Only Admin Edge API Server (No DB; mTLS Client to core-back)
├── admin-front/      # LAN-Only Admin Back Office SPA (Vue 3 TSX + Vuetify 3 + Vite)
├── merchant-back/    # Public SSL Merchant Edge API Server (No DB; mTLS Client to core-back)
├── merchant-front/   # Public SSL Merchant Portal SPA (Vue 3 TSX + Vuetify 3 + Vite)
├── checkout-back/    # Public SSL Checkout & Webhook Edge API Server (No DB; mTLS Client to core-back)
└── checkout-front/   # Public SSL Hosted Checkout SPA (Vue 3 TSX + Vuetify 3 + Vite)
```

### 2.1 Service Roles, Boundaries, and Security Constraints

| Service Directory | Network Exposure | Database Access | Core Responsibilities & Hard Security Boundaries |
| :--- | :--- | :--- | :--- |
| **`core-back`** | **Private Local Network Only** (Port `4000`, mTLS Server; **zero** router port-forwarding, **zero** public reverse-proxy exposure) | **YES (Exclusive)** — Sole holder of `prisma/` and DB credentials | - Owns all 64 database tables, AES-256-GCM master encryption keys (`KMS_MASTER_KEY`), and the double-entry `LedgerPoster`.<br>- Runs the `DynamicRailEngine`, `ApiConsumer` registry, outbound HTTP calls to external payment gateways, durable timer workers (`expires_at`, `next_check_at`), webhook inbox worker, and reconciliation jobs.<br>- **Double-Checks Everything:** Independently re-validates every Zod schema, user/merchant session, role authority (`authorities_map`), Maker-Checker invariant (`checker_user_id != maker_user_id`), link state, and amount invariant regardless of edge-server checks.<br>- Authenticates callers (`admin-back`, `merchant-back`, `checkout-back`) via **mTLS client certificate CN** (`CN=admin-back`, `CN=merchant-back`, `CN=checkout-back`) and restricts which internal namespaces (`/internal/admin/*`, `/internal/merchant/*`, `/internal/checkout/*`) each client certificate may call. |
| **`admin-back`** | **Private LAN Only** (Served behind LAN Reverse Proxy on a non-forwarded LAN port, e.g., `https://admin.internal:8443/api`) | **NONE** (No Prisma, no DB driver) | - Serves the Admin Back Office API (`/api/v1/admin/*`).<br>- Validates admin input payloads using shared Zod schemas (`lib/zReady`), enforces LAN rate limits and admin session/MFA headers, and forwards validated commands over mTLS to `core-back` (`/internal/admin/*`).<br>- Never stores secrets or talks directly to the database. |
| **`admin-front`** | **Private LAN Only** (Served behind LAN Reverse Proxy at `https://admin.internal:8443/`) | **NONE** | - Vue 3 TSX + Vuetify 3 SPA for platform operators (`GATEWAY_ADMIN`, `SECURITY_ADMIN`, `FINANCE`, `OPERATOR`, `COMPLIANCE`, `MLRO`, `SUPPORT`).<br>- Implements the 8-Step Add-a-Gateway Wizard, Join Request & KYB Reviewer, Maker-Checker Approval Queue, AML & Dispute Queues, Reconciliation Console, and Profitability/Liquidity Dashboards. |
| **`merchant-back`** | **Public Internet via SSL Reverse Proxy** (`https://merchant.<domain>/api` on 80->443) | **NONE** (No Prisma, no DB driver) | - Serves the Merchant Portal API (`/api/v1/merchant/*`) and external Merchant Server API (`/api/v1/external/*` authenticated via `pg_live_` bearer tokens + IP CIDR allowlists).<br>- Handles merchant registration, login, KYB document multipart upload (performing edge MIME/magic-byte/size checks before streaming to `core-back`), application/wallet/link creation, POS pairing, and cash-out requests.<br>- Forwards all operations over mTLS to `core-back` (`/internal/merchant/*`). |
| **`merchant-front`** | **Public Internet via SSL Reverse Proxy** (`https://merchant.<domain>/` on 80->443) | **NONE** | - Vue 3 TSX + Vuetify 3 SPA for merchants (`MERCHANT_ADMIN`, `MERCHANT_STAFF`, `MERCHANT_CASHIER`).<br>- Implements self-service onboarding, KYB upload, Wallets, Applications, Payment Links, POS Terminal & Realtime Cashier Screen, Disputes, Cash-outs, API Tokens, and Statements. |
| **`checkout-back`** | **Public Internet via SSL Reverse Proxy** (`https://pay.<domain>/api` on 80->443) | **NONE** (No Prisma, no DB driver) | - Serves End-Client Checkout API (`/api/v1/pay/{linkKey}/*`), SSE realtime status streams (`/api/v1/pay/{linkKey}/logs/{logId}/status`), and Inbound Gateway Webhooks (`/api/v1/inbound/{gateway}/{env}/{token}` and `/api/v1/return/{attemptToken}`).<br>- **Strict Read/Execute Isolation:** Has **zero endpoints** to create links, update link details, or accept client-supplied payment amounts or currencies. The client only sends `linkKey`, `railCode`, and customer form inputs (`phone`, `birth_year`, `otp`, etc.); `core-back` reads the authoritative amount exclusively from `payment_links.amount`.<br>- Captures raw webhook bytes (`Buffer`) and headers for HMAC verification and forwards them unaltered over mTLS to `core-back` (`/internal/checkout/inbound/*`). |
| **`checkout-front`** | **Public Internet via SSL Reverse Proxy** (`https://pay.<domain>/` on 80->443) | **NONE** | - Lightweight, high-conversion bilingual (AR RTL / EN LTR) Vue 3 TSX + Vuetify 3 SPA for anonymous payers.<br>- Contains zero gateway-specific logic; renders strictly from the 5 declarative `ClientAction` payloads (`SHOW_OTP_FORM`, `HTTP_REDIRECT`, `RENDER_EMBEDDED`, `SHOW_QR_OR_CODE`, `SHOW_PUSH_OR_TRANSFER`) and subscribes to SSE status updates. |

### 2.2 Mutual TLS (mTLS) Inter-Service Transport Architecture

Every connection from `admin-back`, `merchant-back`, or `checkout-back` to `core-back` is authenticated at the transport layer using a dedicated internal Public Key Infrastructure (PKI):

1. **Internal Certificate Authority (CA):**
   - An offline/root Internal CA (`internal-ca.crt`) signs four certificates:
     - `core-back.crt` (`SAN: DNS:core-back.internal, IP:127.0.0.1, IP:10.x.x.x`)
     - `admin-back-client.crt` (`CN=admin-back`, `OU=edge-admin`)
     - `merchant-back-client.crt` (`CN=merchant-back`, `OU=edge-merchant`)
     - `checkout-back-client.crt` (`CN=checkout-back`, `OU=edge-checkout`)
2. **`core-back` TLS Server Configuration (`https.createServer` / Bun TLS):**
   - `requestCert: true`, `rejectUnauthorized: true`, `ca: [fs.readFileSync(ENV.MTLS_CA_CERT_PATH)]`, `minVersion: 'TLSv1.3'`.
3. **Channel-Bound Certificate Authorization Middleware in `core-back`:**
   - Even with a valid mTLS handshake, `core-back` inspects `req.socket.getPeerCertificate().subject.CN` on every request:
     - `/internal/admin/*` -> **Only** `CN === 'admin-back'` is permitted (`403 FORBIDDEN_SERVICE_IDENTITY` otherwise).
     - `/internal/merchant/*` -> **Only** `CN === 'merchant-back'` is permitted.
     - `/internal/checkout/*` -> **Only** `CN === 'checkout-back'` is permitted.
4. **Forwarded Context Headers (Verified & Re-checked by `core-back`):**
   - Edge servers attach `X-Request-Id` (UUIDv7), `X-Real-Client-Ip` (resolved from trusted reverse proxy), `X-Client-User-Agent`, and `X-Edge-Service` (`admin-back | merchant-back | checkout-back`).
   - User/merchant JWTs or API bearer tokens (`Authorization`) are passed through to `core-back`, which **cryptographically verifies the token signature/hash against the database and checks revocation, MFA, IP allowlist, and role authorities (`authorities_map`) on every single call**. `core-back` never trusts a pre-parsed `X-User-Id` header from an edge server without verifying the underlying token or signed session proof.

### 2.3 Reverse Proxy (Nginx / Caddy) Topology

```text
                         [ PUBLIC INTERNET (80/443 SSL ONLY) ]
                                    │               │
              ┌─────────────────────┘               └─────────────────────┐
              ▼                                                           ▼
┌───────────────────────────────┐                           ┌───────────────────────────────┐
│ Public Reverse Proxy (443)    │                           │ Public Reverse Proxy (443)    │
│ Host: merchant.domain.ly      │                           │ Host: pay.domain.ly           │
│  /     -> merchant-front dist │                           │  /     -> checkout-front dist │
│  /api  -> merchant-back:4102  │                           │  /api  -> checkout-back:4103  │
└──────────────┬────────────────┘                           └──────────────┬────────────────┘
               │                                                           │
               │                [ PRIVATE LAN (PORT 8443) ]                │
               │                 (NOT Router-Forwarded)                    │
               │                            │                              │
               │                            ▼                              │
               │            ┌───────────────────────────────┐              │
               │            │ LAN Reverse Proxy (8443 SSL)  │              │
               │            │ Host: admin.internal          │              │
               │            │  /     -> admin-front dist    │              │
               │            │  /api  -> admin-back:4101     │              │
               │            └──────────────┬────────────────┘              │
               │                           │                               │
               └───────────────────┐       │       ┌───────────────────────┘
                                   ▼       ▼       ▼
                        (mTLS 1.3 Client Certs over Private LAN)
                       ┌───────────────────────────────────────┐
                       │         core-back (Port 4000)         │
                       │  mTLS Server · Double-Check Guards    │
                       │  DynamicRailEngine · LedgerPoster     │
                       └───────────┬───────────────┬───────────┘
                                   │               │
                                   ▼               ▼
                        ┌─────────────────┐ ┌──────────────────────┐
│ MySQL / MariaDB │ │ External Gateways    │
                         │ (Local Only)    │ │ (Fixed Egress HTTPS) │
                        └─────────────────┘ └──────────────────────┘
```

#### Reverse Proxy Configuration Rules (Nginx Reference)
1. **Merchant Virtual Host (`merchant.domain.ly` on 443 SSL, 80 redirects to 443):**
   - Serves `merchant-front/dist` with `try_files $uri $uri/ /index.html;`.
   - Proxies `/api/` to `http://127.0.0.1:4102/api/` with `X-Real-IP $remote_addr`, `X-Forwarded-For $proxy_add_x_forwarded_for`, `X-Forwarded-Proto https`, and `client_max_body_size 15m` (for KYB document uploads).
   - Proxies `/api/v1/merchant/pos/stream` with `proxy_buffering off; proxy_read_timeout 3600s;` for POS realtime SSE/WebSocket rooms.
2. **Checkout Virtual Host (`pay.domain.ly` on 443 SSL, 80 redirects to 443):**
   - Serves `checkout-front/dist` with strict security headers (`Content-Security-Policy: frame-ancestors 'none'; X-Content-Type-Options: nosniff; Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`).
   - Proxies `/api/` to `http://127.0.0.1:4103/api/` with `client_max_body_size 3m` and `proxy_buffering off` on `/api/v1/pay/*/logs/*/status` (SSE stream).
3. **Admin Virtual Host (`admin.internal:8443` on LAN-only interface `10.x.x.x:8443` or `192.168.x.x:8443`):**
   - Bound strictly to the private LAN interface IP and restricted via `allow 10.0.0.0/8; allow 192.168.0.0/16; deny all;`.
   - Serves `admin-front/dist` at `/` and proxies `/api/` to `http://127.0.0.1:4101/api/`.

## 3. Template Stack Standards (`selmotamed-ctrl/template-back-front` Conventions)

All 4 backend projects (`core-back`, `admin-back`, `merchant-back`, `checkout-back`) and all 3 frontend projects (`admin-front`, `merchant-front`, `checkout-front`) adhere strictly to the architecture and coding conventions established in [`selmotamed-ctrl/template-back-front`](https://github.com/selmotamed-ctrl/template-back-front):

### 3.1 Backend Conventions (`core-back`, `admin-back`, `merchant-back`, `checkout-back`)
1. **Runtime & Framework:**
   - **Bun** (`^1.4.1`) with native ES Modules (`"type": "module"` in `package.json`, `tsconfig.json` targeting `ESNext` with `bun-types`).
   - **Express 5** (`^5.2.1`) where async route handlers automatically forward rejected Promises to the global error middleware.
   - **Zod 4** (`^4.5.4`) for all environment, request body, query, params, and inter-service payload validations.
2. **Directory Structure per Backend:**
   ```text
   <service>-back/
   ├── api/
   │   ├── index.ts                # Main router mounted at /api (or /internal on core-back)
   │   ├── public/                 # Unauthenticated / public routes (rate-limited)
   │   └── protected/              # Authenticated routes with role/authority guards
   ├── lib/
   │   ├── env/index.ts            # Startup Zod env validation (exits with code 1 on failure)
   │   ├── error/index.ts          # ApiError class with Symbol("api-error"), isApiError, parseOrThrow
   │   ├── requestLogger/index.ts  # ANSI-styled request logger with secret redaction
   │   ├── zReady/index.ts         # Shared Zod schemas (zPhone, zAmount, zUuid, zNationalId, etc.)
   │   └── mtlsClient/index.ts     # (Edge backs only) mTLS HTTPS client wrapper to core-back
   ├── index.ts                    # Entry point: Express app, /health probe, /api mount, error handler
   ├── package.json
   └── tsconfig.json
   ```
   *(Note: **Only `core-back`** contains the `prisma/` directory (`prisma/schema.prisma`, `prisma/client/`, `prisma/migrations/`, `prisma7.config.ts`) and the `engine/` directory (`DynamicRailEngine`, `ApiConsumer`, `LedgerPoster`, `CryptoEngine`, `Workers`). `admin-back`, `merchant-back`, and `checkout-back` MUST NOT have `prisma` in their `package.json`.)*
3. **Error Handling (`lib/error/index.ts`) & `parseOrThrow`:**
   - Every endpoint validates inputs using `const data = parseOrThrow(schema, req.body)`.
   - All business and validation errors throw `new ApiError(statusCode, code, message, details)` tagged with `Symbol("api-error")`.
   - The global Express error handler formats all `ApiError` instances into the stable platform envelope: `{ code: string, message: string, reference?: string, details?: unknown }`.

### 3.2 Frontend Conventions (`admin-front`, `merchant-front`, `checkout-front`)
1. **Framework & Build System:**
   - **Vue 3** (`^3.5.22`) + **Vuetify 3** (`^3.10.7`) + **Vue Router 4** + **Vue I18n** (`ar` RTL default / `en` LTR toggle) + **Vite** (`rolldown-vite` with `@vitejs/plugin-vue-jsx`).
   - **Vite Plugin Order (`vite.config.ts`):** `unplugin-vue-components` MUST be registered **before** `vueJsx()` so Vuetify and custom `src/components` auto-import cleanly inside `.tsx` files.
2. **Component Authoring Pattern (`.tsx` with `kt-dc`):**
   - All views (`src/pages/**/*.tsx`), layouts (`src/layouts/**/*.tsx`), and components (`src/components/**/*.tsx`) are written in **TypeScript JSX (`.tsx`)** using the `dc` wrapper from `kt-dc`:
     ```tsx
     import { dc } from "kt-dc";
     export default dc(() => {
       const loading = ref(false);
       return () => (
         <VContainer>
           <VCard loading={loading.value}>...</VCard>
         </VContainer>
       );
     });
     ```
3. **State, Network & Global Providers:**
   - **`src/main.ts`:** Polyfills `BigInt.prototype.toJSON` and initializes Vuetify, Vue I18n, and Vue Router.
   - **`src/App.tsx`:** Wraps `<RouterView />` inside `<PrintProvider>`, `<AwaitedConfirmationDialog>`, `<DetailsFieldsDialog>`, and `<SnackBar>`.
   - **`src/state/api/index.ts`:** Configured Axios instance using the `fetch` adapter (`baseURL: '/api'`), injecting `Authorization: Bearer <token>` from `@/state/user`, and intercepting `401` responses to trigger `logout()` and `loadAppStatus()`.
   - **`src/router/index.ts`:** Enforces route authority guards (`hasOneOfAuthorities`, `routesAuthorities`, `allowedToAccessCore`) matching the user's `authorities_map` returned by `core-back`.
   - **Decimal Math on Frontend:** Uses `decimal.js` (`^10.6.0`, already in template) for any client-side fee preview or amount display — never native JS floating-point arithmetic.

## 4. Source Design Consolidation & v5.0 Evolution Register

Version 5.0 preserves 100% of the domain, engine, ledger, security, compliance, and edge-case specifications from **Master Architecture v4.1** (`payment-gateway-refined-design-final.md`), **Design v2** (`Dynamic-Payment-Gateway-Management-Design-v2.md`), the **Voucher Provider Management System** (`Voucher-Provider-Management-System-Technical-Design.md` & `voucher-system-raw-design.md`), and the **Original Proposal** (`Payment_Gateway_Platform_Proposal.pdf`), while adding the v5.0 multi-service split:

| # | Architectural Area | Authoritative Specification in v5.0 |
| :--- | :--- | :--- |
| **1** | **Service Topology & DB Access** | **4 Backends + 3 Frontends.** `core-back` is the sole database owner and gateway executor, reachable only via mTLS 1.3. `admin-back` is LAN-only. `merchant-back` and `checkout-back` are public SSL behind reverse proxy with zero DB access. |
| **2** | **Checkout Zero-Trust Boundary** | `checkout-back` cannot create links, modify links, or accept amounts/currencies from the browser. It passes only `(linkKey, railCode, customerFormFields)` to `core-back`, which resolves the amount from `payment_links` in the database. |
| **3** | **Catalog Architecture** | **Four-Layer Model:** `Gateway` -> `CredentialSet` -> `Rail` -> `RailRoute`. |
| **4** | **Declarative Engine Phases** | **10 Phases:** `CREDENTIAL_CHECK`, `PRE_INITIATE`, `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, `REFUND`, `VOID`, `CAPTURE`, `SETTLEMENT_FETCH`. |
| **5** | **Voucher Engine Heritage** | Incorporates `ApiConsumer` with single-flight auth refresh, chained `setTimeout` with jitter, non-destructive prototype-guarded `recursiveSet`, `recursiveSelectWithForLoop`, `compileUrl`, and `InvalidationBus`. |
| **6** | **Attempt State Machine** | **13 States** (`CREATED`, `INITIATING`, `AWAITING_CUSTOMER`, `AUTHORIZING`, `VERIFYING`, `UNKNOWN`, `SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`, `BLOCKED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED`) + atomic `active_locked_count` slot reservation on `payment_links`. |
| **7** | **Double-Entry Ledger** | **10 GL Account Types** (`TREASURY`, `GATEWAY_CLEARING`, `MERCHANT_WALLET`, `PLATFORM_INCOME`, `PROVIDER_FEE_EXPENSE`, `GATEWAY_FEE_ACCRUAL`, `COMMISSION_RECEIVABLE`, `AML_HOLD`, `CHARGEBACK_RESERVE`, `SUSPENSE`) with 15 worked journal entries and `DECIMAL(18,4)` precision. |
| **8** | **Onboarding, KYB, AML & Disputes** | Full `join_requests` state machine, `kyb_documents`, `beneficial_owners`, pluggable `ScreeningProvider`, declarative `aml_rules`, config-driven `reporting_rules` (`PROVISIONAL` vs `CONFIRMED`), and automated dispute drafting (`SYSTEM_AUTOMATION` maker -> human `FINANCE` checker). |

## 5. Research Foundation: The Libyan & International Gateway Landscape (20 Gateways)

### 5.1 Complete 20-Gateway Technical Integration Matrix

| # | Gateway / Operator | Collection Mode(s) (Axis A) | Customer Form Inputs | Auth & Crypto Signing | Amount & Session Quirks | Confirmation Path (Axis B) & Status Check | Evidence Level |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **Moamalat NPG** (National Switch / PaySky) | `EMBEDDED` (Lightbox) or `REDIRECT` | None on our page (Card PAN, Expiry, PIN in Lightbox) | `MID`, `TID` + `SecureHash` via `HMAC-SHA256` (**Hex-decoded** `MerchantSecretKey`; sorted `k=v&...`; `HEX_UPPER` / `HEX_LOWER`) | **Dirhams integer (`LYD * 1000`), e.g., 10.50 LYD -> `"10500"`. `TrxDateTime` as `YYYYMMDDHHmm` (`Africa/Tripoli`). ~10m TTL** | JS `completeCallback` (hint) + IP-allowlisted Webhook (`ActionCode == "00"`) + mandatory `FilterTransactions` / `GetTransactionStatus` Inquiry | `VERIFIED (PUBLIC-SDK)` |
| **2** | **LYPay** (CBL Instant Payment, Moamalat-operated) | `QR_DISPLAY` (NUMO EMVCo TLV QR) or `PUSH_APPROVAL` | Customer alias / IBAN context or None (QR scan) | `TOKEN_ENDPOINT` (OAuth2 Bearer via `/api/v1/auth/token` on CBL DevPortal) | LYD 3-decimal precision. Ceilings: 20k LYD P2P, 100k LYD Merchant. 5s sync confirm window | Sync confirm within 5s (`Confirmed`/`Declined`), else `Processing` -> HMAC Webhook (`transaction_status_update`, `transaction_credit_notice`) + Enquiry API | `VERIFIED (OFFICIAL-DOCS)` |
| **3** | **Numo Pay** (Moamalat Financial Services) | `EMBEDDED` (PayButton SDK), `PUSH_APPROVAL` or `QR_DISPLAY` | None on our page (handled in Numo modal/app) | `MID`, `TID` + Hex-key `HMAC-SHA256` over canonical sorted fields | Dirhams integer (`LYD * 1000`) | Signed callback + server-to-server verification endpoint | `UNVERIFIED / VENDOR-PAGE` |
| **4** | **Sadad** (Almadar Aljadeed) | `OTP_PULL` (2-Step) | `customer_mobile` (`^091[0-9]{7}$`), `birth_year` (`YYYY`), optional category | `PERMANENT_TOKEN` (Bearer + `X-API-KEY`) or `REFRESH_TOKEN` / `USERNAME_PASSWORD` | LYD 2-decimal string (`XXX.XX`); JSON or `multipart/form-data`. 10-minute session TTL | Step 1 `/verify` sends 6-digit SMS OTP & returns `process_id`; Step 2 `/confirm` sends `process_id` + `code` + `invoice_no` -> `transaction_id`. No inquiry on DPay | `VERIFIED (PUBLIC-SDK)` |
| **5** | **Libyana Pay** (Libyana Mobile) | `OTP_PULL` or `REDIRECT` | `customer_mobile` (`^09[24][0-9]{7}$`) | Bearer / Basic / Merchant API Key + IP Allowlist | LYD 2-decimal or minor units | Step 1 triggers SMS confirmation code; Step 2 submits `otp` + `session_id` | `PARTIAL / UNVERIFIED` |
| **6** | **Edfali / Edfaa Li** (BCD Bank) | `OTP_PULL` (2-Step) | `customer_mobile` (`^09[0-9]{8}$`), 4-digit SMS code | Bearer + `X-API-KEY` (via Plutu/DPay) or direct SOAP/REST `USERNAME_PASSWORD` | LYD 2-decimal (`XXX.XX`); `multipart/form-data`, XML/SOAP, or JSON | Step 1 `/verify` registers invoice & sends 4-digit SMS code (`process_id`); Step 2 `/confirm` settles (`transaction_id`). No status inquiry -> Statement reconciliation mandatory | `VERIFIED (PUBLIC-SDK)` |
| **7** | **MobiCash** (Wahda Bank / Masarat) | `OTP_PULL` or `QR_DISPLAY` | `card_number` (7-digit MobiCash transaction card ID) or mobile | `PERMANENT_TOKEN` (Merchant API Key) or OAuth2 | LYD 2-decimal (`XXX.XX`). 15-minute session TTL | Step 1 opens `payment_uuid` & sends OTP; Step 2 confirms `payment_uuid` + `otp` -> `bank_reference`. No inquiry on DPay | `VERIFIED (PUBLIC-SDK)` |
| **8** | **Tadawul / T-LYNC** (TDSP) | `REDIRECT` (Hosted Checkout) or `OTP_PULL` | Optional phone/email on initiate; card/wallet entered on T-LYNC | `API_KEY` / `REQUEST_SIGNATURE` (`store_id` + `store_token` + HMAC header) + IP Allowlist | LYD 2-decimal. Rejects duplicate `custom_ref` with HTTP 422 | Customer GET return (hint) + IP-restricted POST callback (hint) + mandatory `POST /receipt/transaction` inquiry | `VERIFIED (OFFICIAL-DOCS)` |
| **9** | **OnePay** (CBL Cross-Bank Instant Payment) | `QR_DISPLAY` (EMVCo QR), `PAY_CODE`, or `OTP_PULL` | `card_number` (9-digit cross-bank routing code) or None (QR) | `MUTUAL_TLS` (mTLS) / Bearer + `HMAC-SHA256` payload signature | LYD 2-decimal (`XXX.XX`); CBL ceilings updated Feb 2026 | Issuing bank SMS OTP confirm or interoperable QR scan -> async Webhook + Inquiry / Statement | `PARTIAL (VENDOR-PAGE)` |
| **10** | **Yussor Pay** (NCB / Masarat / MobiMal) | `HYBRID` (`OTP_PULL`, `PAY_CODE`, `QR_DISPLAY`) | 7-digit NCB Pay ID / phone or SMS purchase code / MobiMal QR | Merchant API Key / `USERNAME_PASSWORD` token refresh | LYD 2-decimal (`XXX.XX`); Bronze/Silver/Gold tier limits | Sync confirm + Status Check available (via DPay) | `VERIFIED (PUBLIC-SDK)` |
| **11** | **Sahara Pay** (Sahara Bank / Masarat) | `HYBRID` (`OTP_PULL`, `QR_DISPLAY`, `PAY_CODE`) | 7-digit Sahara Pay ID or 9-digit OnePay / phone | Merchant API Key / Bearer via Masarat switch | LYD 2-decimal (`XXX.XX`); accepts OnePay & LYPay networks | Sync confirm + Status Check available (via DPay) | `VERIFIED (PUBLIC-SDK)` |
| **12** | **Masrefy Pay** (Jumhouria Bank / Masarat) | `OTP_PULL` or `QR_DISPLAY` | Card/account ID + SMS OTP | Via DPay Bearer API Token | LYD 2-decimal (`XXX.XX`), 15-minute session TTL | Sync confirm + Status Check available (via DPay) | `PARTIAL` |
| **13** | **Hawelli** (Zaho / FikraTech) | `HYBRID` (`PUSH_APPROVAL`, `QR_DISPLAY`, `DEEP_LINK`, `OTP_PULL`) | `customer_mobile` (`+2189xxxxxxxx`) or None (QR/Deep Link) | Bearer (`REFRESH_TOKEN` / `PERMANENT_TOKEN`) + HMAC Webhook Secret | LYD 2-decimal (`XXX.XX`) | Push approval or QR in Hawelli wallet -> signed Webhook or poll | `UNVERIFIED` |
| **14** | **GPay Libya** (Libya Guide IT, Permit 204/2023) | `PUSH_APPROVAL` or `QR_DISPLAY` | `wallet_phone` / gateway number | Signed request (`HMAC` or `RSA`) + API Key | LYD 2-decimal (`XXX.XX`) | Payment request -> user accepts/rejects in app -> signed callback + status API | `UNVERIFIED / VENDOR-PAGE` |
| **15** | **Google Pay** (Tokenized Card Sheet) | `EMBEDDED` -> `INITIATE` | JS Token Sheet in browser | Encrypted payment token passed to underlying Acquirer Card Rail | Multi-currency (`LYD`, `USD`, `EUR`) | Settled via underlying MPGS / Moamalat card rail inquiry | `VERIFIED` |
| **16** | **Visa / Mastercard** (MPGS / 3DS2) | `REDIRECT` (Hosted Checkout) or `EMBEDDED` (Hosted Session) | None on our server (`PCI-DSS SAQ-A`) | `BASIC` (`merchant.<ID>:<apiPassword>`) + `X-Notification-Secret` / HMAC | 2-decimal (`XXX.XX`) + explicit currency (`LYD`, `USD`, `EUR`) | 3DS2 challenge -> Return URL + Webhook -> mandatory `GET /order/{id}` Inquiry | `VERIFIED (PUBLIC-SDK)` |
| **17** | **Evo Pay** (`evowallet.net`, Benghazi) | `QR_DISPLAY` or `PUSH_APPROVAL` | None for QR or Wallet Account ID | Bearer / API Key + Signature Header | Nested JSON `transAmount: {amount, currency}` | `POST Payment` -> Webhook + `GET Payment` inquiry (`payment.status == "Captured"`). Distinct from EVO Payments Intl | `UNVERIFIED` |
| **18** | **DPay Aggregator** (DITS) | `REDIRECT` (Hosted) or per-method `OTP_PULL` / `EMBEDDED` | Per underlying rail (`pay_method` parameter) | `PERMANENT_TOKEN` (Bearer). **Supports `Idempotency-Key` header** on session open | 2-decimal (`76.255 -> 76.26`) & whole-dinar rounding. 10m/15m TTLs. Merchant-owned direct settlement supported | 6 HMAC-signed webhook events (`timestamp.raw_body`, 5m tolerance, 5 retries: 1m, 5m, 15m, 1h) + per-rail `get` inquiry (4 of 7 rails) | `VERIFIED (OFFICIAL-DOCS)` |
| **19** | **Plutu & MyPay Aggregators** | Plutu: `OTP_PULL` & `REDIRECT`; MyPay: `REDIRECT` (8 aliases) | Plutu: mobile + `birth_year`; MyPay: hosted selection | Plutu: `API_KEY` + `Access-Token` + `Secret-Key`; MyPay: `TOKEN_ENDPOINT` (JWT 600s; HTTP 409 on body change) | 2-decimal LYD strings; Plutu sandbox has strict hourly caps | Plutu: `SORTED_VALUES_HASH` callback (uppercase HMAC); MyPay: `X-MYPAY-SIGNATURE` raw-body HMAC (5 retries: 10s-10m). Neither has public inquiry | `VERIFIED (OFFICIAL-DOCS)` |
| **20** | **NeomPay** (First-party wallet platform; Neom-managed Treasury) | `PUSH_APPROVAL`, `OTP_PULL` or `QR_DISPLAY` (`HYBRID`) | `wallet_id` (`^NP-[0-9]{12}$`, Luhn check digit, wallet-type allowlist) or None (QR / push) | `MUTUAL_TLS` service-to-service (no third-party credentials) | LYD 3-decimal native (`amount_scale 1`, `precision 3`, no rounding); TTL 10 min push / 5 min QR | `SYNC_RESPONSE` (authoritative over mTLS) + idempotent `inquire` by `our_reference`; native refund / void / partial refund; posts directly to `TREASURY` (Ledger Rule INTERNAL-1) | `INTERNAL (FIRST-PARTY)` |

### 5.2 Mode-by-Channel Compatibility Matrix

| Collection Mode (Axis A) | SYNC_RESPONSE | WEBHOOK | INQUIRY / POLL | RETURN_URL | BROWSER_CALLBACK | STATEMENT | OPERATOR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`OTP_PULL`** | **Y** | C | **Y** | - | - | **Y** | C |
| **`REDIRECT`** | - | **Y** | **Y** | **Y (hint only)** | - | **Y** | C |
| **`EMBEDDED`** | - | **Y** | **Y** | - | **Y (hint only)** | **Y** | C |
| **`PUSH_APPROVAL`** | - | **Y** | **Y** | - | - | **Y** | C |
| **`QR_DISPLAY`** | C (LYPay 5s) | **Y** | **Y** | - | - | **Y** | C |
| **`PAY_CODE`** | - | **Y** | C | - | - | **Y** | C |
| **`DEEP_LINK`** | - | **Y** | **Y** | - | C (hint only) | **Y** | C |
| **`MANUAL`** | - | - | - | - | - | **Y** | **Y** |
| **`HYBRID`** | Per sub-mode | Per sub-mode | Per sub-mode | Per sub-mode | Per sub-mode | **Y** | C |

# PART II: PLATFORM CORE & PRISMA 7 DATABASE SCHEMA

## 6. Core Domain Concepts: The Four-Layer Catalog & Visible Rails Formula

1. **Layer 1 — Gateway (`gateways`):** Represents one technical integration with one external system. Holds `code`, `name`, `operator`, `country`, `aliases[]`, `kind` (`DIRECT`, `AGGREGATOR`, `NATIVE_ADAPTER`, `INTERNAL`), `verification_state` (`VERIFIED`, `UNVERIFIED`), and `risk_class` (`NORMAL`, `HIGH_RISK`).
2. **Layer 2 — Credential Set (`credential_sets`):** Holds the encrypted identifiers and secrets for one Gateway in one Environment (`SANDBOX` or `LIVE`). Defines `owner_type` (`PLATFORM` or `MERCHANT`) and `settlement_target` (`PLATFORM_CLEARING`, `MERCHANT_DIRECT`, `PROVIDER_HELD`). Secrets are write-only (replaceable, never readable back).
3. **Layer 3 — Rail (`rails`):** Represents what the customer sees at checkout (e.g., `edfali`, `sadad`, `lypay`, `moamalat_card`, `neompay_wallet`). Owns `rail_fields` (the bilingual customer input form), display limits, currency, and capabilities (`refund`, `partial_refund`, `void`, `capture`, `recurring`, `refund_window_days`).
4. **Layer 4 — Route (`rail_routes`):** Binds a `Rail` to a `Gateway` with a `credential_policy` (`PLATFORM`, `MERCHANT_REQUIRED`, `MERCHANT_OR_PLATFORM`), `priority`, `cost_model`, `min_amount`, `max_amount`, `daily_cap_amount`, `status` (`ACTIVE`, `PAUSED`, `DRAINING`), `health_state` (`HEALTHY`, `DEGRADED`, `OPEN_BREAKER`), `maintenance_windows`, and `scope` (`merchant_ids`, `application_ids`, `risk_tiers`, `channels`: `WEB`, `API`, `POS`).

### The Visible Rails Resolution Formula (Executed Inside `core-back`)

Evaluated dynamically on every checkout link resolution request (`checkout-back` -> `core-back`):
```text
visible_rails =
    (application.rail_whitelist ?? ALL_RAILS)
  INTERSECT (link.rail_whitelist ?? ALL_RAILS)
  INTERSECT rails_with_live_commission_profile(merchant_id, application_id, link.amount)
  INTERSECT rails_with_at_least_one_route_where(
        route.status == 'ACTIVE'
    AND route.health_state == 'HEALTHY'
    AND route.min_amount <= link.amount <= route.max_amount
    AND (route.daily_processed_amount + link.amount) <= route.daily_cap_amount
    AND NOW() NOT IN route.maintenance_windows
    AND route.in_scope(merchant_id, application_id, merchant.risk_tier, channel)
    AND route.credential_set.status == 'VERIFIED'
    AND rail.currency == link.currency
    AND rail.blocked == false
  )
```

## 7. Complete Database Schema in `core-back` (64 Tables Across 6 Groups + Prisma 7 Rules)

All 64 tables reside exclusively in `core-back/prisma/schema.prisma`.
- **Primary Keys & Timestamps:** Every table includes `id String @id @default(uuid(7))`, `createdAt DateTime @default(now())`, and `updatedAt DateTime @updatedAt`.
- **Monetary Precision:** All monetary columns use `@db.Decimal(18, 4)` (`Prisma.Decimal` / `decimal.js`) — floating-point types (`Float`, `Double`) are strictly banned.
- **Encryption at Rest:** All ciphertexts use AES-256-GCM formatted as `keyId:iv:authTag:ciphertext`.
- **Database Engine:** **MySQL 8.0+ / MariaDB 10.6+**, reached through the `@prisma/adapter-mariadb` adapter on top of the `mariadb` driver package. The datasource is `provider = "mysql"`; the database name, host, port and credentials come from the connection string (`mysql://user:password@host:3306/payment_gateway`).

### Prisma 7 Rules (MySQL / MariaDB)

The Prisma datamodel is a **MySQL / MariaDB** datamodel. These rules are not negotiable and are enforced by the migration `core-back/prisma/migrations/20261027000000_init/migration.sql`.

1. **Datasource:** `datasource db { provider = "mysql" }`. The database name is never hard-coded in the schema — it is taken from the connection string (`mysql://user:password@host:3306/payment_gateway`), which `prisma7.config.ts` reads from `DATABASE_URL`.
2. **Adapter & Driver:** `core-back` connects with `@prisma/adapter-mariadb` on top of the `mariadb` driver package. No Postgres adapter or `pg` package exists anywhere in the platform.
3. **`String` is `VARCHAR(191)`, never an unbounded `TEXT`:** in MySQL / MariaDB a Prisma `String` maps to `VARCHAR(191)`. Every field that carries free-form or serialized content is therefore declared **explicitly** as `@db.Text` (e.g. `legalName String @db.Text`, `redirectUrl String? @db.Text`, `contextCiphertext String @db.Text`), while every column that participates in an index or a foreign key stays a bounded `VARCHAR`. No string column is left to the implicit default.
4. **`Bytes` is `BLOB` (64 KB):** the inbound webhook body is larger than that, so `inbound_events.raw_body_bytes` is declared `@db.LongBlob`.
5. **`Json` is `JSON`:** stored as `LONGTEXT` with a JSON validity check in MariaDB. Every structured-but-schema-free value (`scopes`, `rail_whitelist`, `aliases`, `base_urls`, `allowed_hosts`, `cost_model`, `success_check`, `payload_json`, …) is a `Json` column; there are no native array columns.
6. **Money is `DECIMAL(18,4)`:** every monetary column is `@db.Decimal(18, 4)` (rate columns use `@db.Decimal(8, 6)`). `FLOAT` and `DOUBLE` are banned.
7. **`ENUM` columns are generated from the Prisma enums:** each Prisma `enum` becomes a native MySQL `ENUM(...)` column whose values are the enum members — the Prisma enum stays the single source of truth.
8. **Identifiers:** primary and foreign keys are `VARCHAR(191)` holding a UUIDv7 string (`uuid(7)`) — there is no native `UUID` column type and no auto-increment `SERIAL`.
9. **Timestamps:** `DateTime` maps to `DATETIME(3)` (millisecond precision, UTC). There is no `TIMESTAMPTZ` type.
10. **Row locks:** `SELECT ... FOR UPDATE SKIP LOCKED` requires **MySQL 8.0+ / MariaDB 10.6+** (see §9.1 rule 8).

### 7.1 Group A: Platform, Commercial, Risk, Governance & Double-Entry Ledger Entities (18 Tables)

| Table Name | Key Columns & Types | Domain Rules, Constraints & v5.0 Notes |
| :--- | :--- | :--- |
| **`merchants`** | `legal_name`, `trade_name`, `tax_id`, `registration_no`, `business_category`, `status` (`PENDING\|ACTIVE\|SUSPENDED\|REJECTED\|CLOSED`), `kyb_status` (`UNVERIFIED\|PENDING\|VERIFIED\|REJECTED`), `risk_tier` (`LOW\|STANDARD\|HIGH`), `onboarding_channel`, `country CHAR(2)`, `contact_phone`, `contact_email`, `activated_at`, `suspended_at`, `suspension_reason_code`, `closed_at`, `commission_receivable_ceiling DECIMAL(18,4)`, `negative_balance_ceiling DECIMAL(18,4) DEFAULT 0`, `payout_bank_details_json JSON` | Owns applications, wallets, users, and merchant-owned credential sets. Edits to `payout_bank_details_json`, `kyb_status`, `risk_tier`, or ceilings require Maker-Checker approval and log to `detail_change_logs`. |
| **`users`** | `merchant_id UUID NULL`, `email`, `phone`, `password_hash`, `role` (`GATEWAY_ADMIN\|SECURITY_ADMIN\|FINANCE\|OPERATOR\|COMPLIANCE\|MLRO\|SUPPORT\|MERCHANT_ADMIN\|MERCHANT_STAFF\|MERCHANT_CASHIER`), `authorities_map JSON`, `app_scope_ids JSON`, `is_maker BOOL`, `is_checker BOOL`, `mfa_required BOOL DEFAULT true`, `mfa_secret_ciphertext TEXT`, `status` | Zero access by default if `authorities_map` is empty. One user can never act as both Maker and Checker on the same `approval_requests` row. |
| **`applications`** | `merchant_id UUID FK`, `name`, `business_use_description`, `expected_monthly_volume DECIMAL(18,4)`, `assigned_wallet_id UUID FK NOT NULL`, `rail_whitelist JSON NULL`, `redirect_domain_allowlist JSON`, `status` | Enforces single-wallet-per-application (`assigned_wallet_id NOT NULL`). `rail_whitelist = NULL` means all rails; empty array rejected. Sensitive fields (`assigned_wallet_id`, `rail_whitelist`, `redirect_domain_allowlist`) require Maker-Checker. |
| **`wallets`** | `merchant_id UUID FK`, `gl_account_id UUID FK UNIQUE`, `currency CHAR(3) DEFAULT 'LYD'`, `status` | Merchant settlement wallet. Balance is never stored as a mutable column; derived strictly from the linked `gl_accounts` row. |
| **`access_tokens`** | `merchant_id UUID FK`, `application_id UUID FK`, `name`, `token_hash CHAR(64)`, `last_four CHAR(4)`, `scopes JSON`, `ip_whitelist_enabled BOOL`, `revoked_at DATETIME(3)`, `last_used_at DATETIME(3)` | Format: `pg_live_` + 32 random base64url bytes. Plaintext shown once at creation and never stored. |
| **`access_token_ips`** | `token_id UUID FK`, `cidr VARCHAR(191)` | Child table enforcing IP CIDR restrictions on Merchant API bearer tokens. |
| **`payment_links`** | `key VARCHAR(191) UNIQUE`, `application_id UUID FK`, `wallet_id UUID FK NOT NULL`, `amount DECIMAL(18,4)`, `currency CHAR(3)`, `fee_bearer` (`MERCHANT_ABSORBS\|PAYER_SURCHARGE\|SPLIT`), `split_ratio_json JSON`, `infinite_use BOOL`, `use_count INT`, `confirmed_count INT DEFAULT 0`, `active_locked_count INT DEFAULT 0`, `redirect_url TEXT NULL`, `rail_whitelist JSON NULL`, `state` (`PENDING\|COMPLETED\|EXPIRED\|CANCELLED`), `expires_at DATETIME(3)` | `wallet_id` derived from application at creation and immutable. `redirect_url` allowed only when `infinite_use = false AND use_count = 1`. Slot reservation invariant: `confirmed_count + active_locked_count <= use_count` (when `infinite_use = false`). |
| **`pos_terminals`** | `application_id UUID FK`, `name`, `location`, `status` | Physical or logical Point-of-Sale terminal belonging to a merchant application. |
| **`pos_screens`** | `pos_id UUID FK`, `screen_code VARCHAR(191) UNIQUE`, `auth_token_hash CHAR(64)`, `realtime_room_id TEXT`, `last_active_at DATETIME(3)` | Paired customer-facing/cashier display joining a WebSocket/SSE room with a 15-minute idle timeout. |
| **`gl_accounts`** | `account_type` (`TREASURY\|GATEWAY_CLEARING\|MERCHANT_WALLET\|PLATFORM_INCOME\|PROVIDER_FEE_EXPENSE\|GATEWAY_FEE_ACCRUAL\|COMMISSION_RECEIVABLE\|AML_HOLD\|CHARGEBACK_RESERVE\|SUSPENSE`), `owner_id UUID NULL`, `gateway_id UUID NULL`, `credential_set_id UUID NULL`, `env TEXT NULL`, `currency CHAR(3)`, `last_checkpoint_id UUID NULL`, `checkpoint_balance DECIMAL(18,4) DEFAULT 0`, `checkpoint_at DATETIME(3)` | One `GATEWAY_CLEARING` account per `(gateway_id, env, credential_set_id)`. Live balance = `checkpoint_balance + SUM(journal_lines since last_checkpoint_id)`. |
| **`journal_entries`** | `ref_type` (`PAYMENT_ATTEMPT\|ADJUSTMENT\|AML_RELEASE\|AML_VOID\|SETTLEMENT_SWEEP\|FEE_VARIANCE\|COMMISSION_NETTING\|DISPUTE_OUTCOME`), `ref_id UUID`, `description TEXT`, `created_at DATETIME(3)` | Immutable append-only header. **`UNIQUE(ref_type, ref_id)`** guarantees idempotent single posting per payment attempt, adjustment, or dispute outcome. |
| **`journal_lines`** | `entry_id UUID FK`, `gl_account_id UUID FK`, `direction` (`DEBIT\|CREDIT`), `amount DECIMAL(18,4) CHECK (amount > 0)` | Immutable append-only lines. Enforces `SUM(DEBIT) == SUM(CREDIT) > 0` per `entry_id` in the posting transaction and DB trigger. |
| **`commission_profiles`** | `merchant_id UUID NULL`, `application_id UUID NULL`, `rail_code TEXT`, `calc_type` (`FLAT\|PERCENTAGE\|TIERED\|HYBRID`), `flat_fee DECIMAL(18,4)`, `percentage_rate DECIMAL(8,6)`, `tiers_json JSON`, `min_fee DECIMAL(18,4)`, `max_fee DECIMAL(18,4)`, `fee_bearer_default TEXT`, `rounding_mode TEXT`, `effective_from DATETIME(3)`, `effective_to DATETIME(3) NULL`, `version INT`, `approval_request_id UUID FK` | Hierarchical resolution: `(merchant, app, rail)` -> `(merchant, rail)` -> `(platform_default, rail)`. Effective-dated so historical journal entries never mutate. |
| **`velocity_rules`** | `scope_type` (`END_CLIENT_IP\|END_CLIENT_PHONE\|END_CLIENT_CARD\|MERCHANT\|APPLICATION\|RAIL\|LINK`), `scope_value TEXT NULL`, `window_seconds INT`, `max_count INT`, `max_amount DECIMAL(18,4)`, `action` (`REJECT\|FLAG`), `active BOOL`, `version INT`, `effective_from`, `effective_to`, `approval_request_id UUID FK` | Evaluated atomically inside the attempt-creation guard transaction. `REJECT` creates a terminal `BLOCKED` attempt for audit. Changes require Maker-Checker. |
| **`aml_cases`** | `subject_type` (`MERCHANT\|END_CLIENT\|PAYMENT_ATTEMPT`), `subject_id UUID`, `trigger_reason TEXT`, `severity` (`LOW\|MEDIUM\|HIGH\|CRITICAL`), `severity_inputs_json JSON`, `screening_id UUID NULL`, `rule_id UUID NULL`, `rule_version INT NULL`, `hold_journal_entry_id UUID NULL`, `status` (`OPEN\|IN_REVIEW\|PENDING_CHECKER\|RELEASED\|REJECTED_VOID\|FROZEN\|ESCALATED_STR`), `sla_due_at`, `assigned_reviewer_id`, `regulatory_report_id`, `confidential BOOL DEFAULT true`, `reviewer_notes TEXT` | Correlated escalation: if a payment hits both a `FLAG` velocity rule and an AML threshold, `severity` escalates to `CRITICAL` automatically. |
| **`adjustments`** | `type` (`CHARGEBACK\|REFUND\|MANUAL_CREDIT\|MANUAL_DEBIT\|CORRECTION\|CASHOUT_SUBTRACTION`), `target_gl_account_id UUID FK`, `source_attempt_id UUID NULL FK`, `dispute_id UUID NULL FK`, `drafted_by_system BOOL DEFAULT false`, `amount DECIMAL(18,4)`, `reverse_commission BOOL`, `reason TEXT`, `external_dispute_ref TEXT NULL`, `provider_refund_ref TEXT NULL`, `state` (`DRAFT\|PENDING_REVIEW\|APPROVED\|EXECUTING\|EXECUTED\|REJECTED`), `journal_entry_id UUID NULL FK` | Generalizes all non-standard money movements. `EXECUTING` holds automated API refunds while the gateway `REFUND` flow is in flight or `UNKNOWN`. |
| **`cashout_requests`** | `merchant_id UUID FK`, `wallet_id UUID FK`, `amount DECIMAL(18,4)`, `destination_bank_json JSON`, `state` (`PENDING\|REJECTED\|PROCESSING\|COMPLETE\|SUBTRACTED`), `adjustment_id UUID NULL FK` | Snapshots `destination_bank_json` at creation. `COMPLETE -> SUBTRACTED` executes as a Maker-Checker Adjustment. |
| **`approval_requests`** | `subject_type`, `subject_id`, `payload_diff_json JSON`, `mode` (`STANDARD\|EMERGENCY_RATIFICATION`), `base_version INT NULL`, `expires_at DATETIME(3)`, `ratify_due_at DATETIME(3) NULL`, `maker_user_id UUID`, `checker_user_id UUID NULL`, `state` (`DRAFT\|PENDING_REVIEW\|APPROVED\|EXECUTED\|REJECTED`), `rejection_reason`, `risk_acceptance_note` | Maker ≠ Checker (`checker_user_id <> maker_user_id`) is enforced by the `approval_requests_checker_not_maker` `BEFORE INSERT` trigger (MariaDB forbids a `CHECK` constraint on a column that participates in a foreign key), **and** by the application-level check in `ApprovalService` and the `makerCheckerGuard` middleware. |

### 7.2 Group B: Gateway Catalog, Environments, Auth & Credentials (6 Tables)

| Table Name | Key Columns & Types | Purpose & Behavior |
| :--- | :--- | :--- |
| **`gateways`** | `code VARCHAR(191) UNIQUE`, `name TEXT`, `operator TEXT`, `country CHAR(2) DEFAULT 'LY'`, `aliases JSON`, `kind` (`DIRECT\|AGGREGATOR\|NATIVE_ADAPTER\|INTERNAL`), `status` (`DRAFT\|SANDBOX_VERIFIED\|PENDING_APPROVAL\|LIVE\|SUSPENDED\|RETIRED`), `active_version_id UUID NULL`, `verification_state` (`VERIFIED\|UNVERIFIED`), `risk_class` (`NORMAL\|HIGH_RISK`) | Top-level integration registry. `aliases` resolves spelling collisions (`Edfali`, `Edfaa Li`, `Adfali`). `INTERNAL` represents first-party NeomPay. |
| **`gateway_versions`** | `gateway_id UUID FK`, `version_number INT`, `snapshot_ciphertext TEXT`, `content_hash CHAR(64)`, `state` (`DRAFT\|SANDBOX_VERIFIED\|PENDING_APPROVAL\|LIVE\|SUPERSEDED\|ROLLED_BACK`), `created_by UUID FK`, `approval_request_id UUID NULL FK`, `change_note TEXT`, `rollback_version_id UUID NULL FK` | Immutable, content-addressed snapshot of all Group B–D configs for a gateway. Attempts pin `gateway_version_id` at creation. |
| **`gateway_environments`** | `gateway_version_id UUID FK`, `env` (`SANDBOX\|LIVE`), `base_urls JSON` (`api`, `checkout`, `inquiry`), `allowed_hosts JSON`, `inbound_ip_allowlist JSON`, `outbound_egress_ips JSON`, `enabled BOOL` | Sandbox and Live never share credentials, path tokens, webhook secrets, or ledger postings. `allowed_hosts` pins credential hostnames (Safeguard 11). |
| **`gateway_auth`** | `gateway_version_id UUID FK`, `env TEXT`, `method` (`NONE\|API_KEY\|PERMANENT_TOKEN\|TOKEN_ENDPOINT\|REFRESH_TOKEN\|USERNAME_PASSWORD\|BASIC\|REQUEST_SIGNATURE\|OAUTH2_CLIENT_CREDENTIALS\|MUTUAL_TLS`), `auth_apply` (`HEADER\|QUERY\|BODY`), `refresh_config_json JSON` | Defines transport authentication per environment, including `refresh_url`, `refresh_period_ms`, `access_token_selector`, and `new_refresh_token_selector`. |
| **`gateway_settings`** | `gateway_version_id UUID FK`, `amount_scale INT` (`1\|100\|1000`), `amount_precision INT` (`0\|2\|3`), `amount_rounding` (`NONE\|NEAREST\|UP\|DOWN`), `amount_format` (`STRING_DECIMAL\|INTEGER_MINOR_UNITS\|NUMBER`), `reference_format JSON` (`charset`, `max_length`, `prefix`), `session_ttl_seconds INT`, `otp_ttl_seconds INT`, `otp_resend_cooldown_seconds INT`, `max_otp_attempts INT DEFAULT 3`, `supports_status_check BOOL`, `status_check_min_age_seconds INT`, `supports_idempotency_key BOOL`, `supports_cancel BOOL`, `rate_limit_per_second INT`, `concurrency_cap INT`, `timeout_ms INT DEFAULT 15000`, `max_response_bytes INT DEFAULT 2097152`, `gateway_timezone TEXT DEFAULT 'Africa/Tripoli'` | Gateway-wide operational and monetary parameters. The amount pipeline (`scale`, `precision`, `rounding`, `format`) is verified by pre-launch contract tests. |
| **`credential_sets`** | `gateway_id UUID FK`, `env` (`SANDBOX\|LIVE`), `owner_type` (`PLATFORM\|MERCHANT`), `owner_merchant_id UUID NULL FK`, `external_merchant_id TEXT NULL`, `settlement_target` (`PLATFORM_CLEARING\|MERCHANT_DIRECT\|PROVIDER_HELD`), `entries_ciphertext JSON` (`key`, `type`, `value`, `is_secret`, `secret_version`, `valid_from`, `valid_to`), `mtls_cert_ciphertext TEXT NULL`, `status` (`UNTESTED\|VERIFIED\|FAILING\|REVOKED`), `last_verified_at DATETIME(3)`, `expires_at DATETIME(3) NULL` | Supports overlapping `secret_version` entries for zero-downtime webhook/API key rotation. `UNIQUE(gateway_id, env, external_merchant_id)` prevents two merchants from registering the same gateway account. |

### 7.3 Group C: Customer-Facing Catalog (4 Tables)

| Table Name | Key Columns & Types | Purpose & Behavior |
| :--- | :--- | :--- |
| **`assets`** | `name VARCHAR(191) UNIQUE`, `mime` (`image/png\|image/svg+xml`), `size_bytes INT`, `storage_key TEXT`, `sha256 CHAR(64)` | Stores gateway/rail logos. SVGs are sanitized on upload (scripts/event handlers stripped) and served with `CSP: sandbox` and `nosniff`. |
| **`rails`** | `code VARCHAR(191) UNIQUE`, `name_ar TEXT`, `name_en TEXT`, `logo_asset_id UUID FK`, `collection_mode` (`OTP_PULL\|REDIRECT\|EMBEDDED\|PUSH_APPROVAL\|QR_DISPLAY\|PAY_CODE\|DEEP_LINK\|MANUAL\|HYBRID`), `sub_modes JSON`, `currency CHAR(3) DEFAULT 'LYD'`, `min_amount DECIMAL(18,4)`, `max_amount DECIMAL(18,4)`, `display_order INT`, `blocked BOOL DEFAULT false`, `capabilities JSON` (`refund`, `partial_refund`, `void`, `capture`, `recurring`), `refund_window_days INT`, `instructions_ar TEXT`, `instructions_en TEXT` | Customer-facing payment method. Never hard-deleted once referenced by any attempt; operators use `blocked = true`. |
| **`rail_fields`** | `rail_id UUID FK`, `key TEXT`, `type` (`phone\|number\|string\|otp\|birth_year\|card_number\|pan\|wallet_id\|from_list`), `checksum` (`NONE\|LUHN`), `label_ar TEXT`, `label_en TEXT`, `placeholder_ar TEXT`, `placeholder_en TEXT`, `regex TEXT`, `min_length INT`, `max_length INT`, `min_val DECIMAL`, `max_val DECIMAL`, `options_json JSON`, `required BOOL`, `order_index INT`, `sensitivity` (`NORMAL\|SENSITIVE\|PAN`), `normalizer JSON` (`arabic_digits_to_ascii`, `phone_style`) | Compiled into cached backend Zod 4 schemas inside `core-back` and serialized to `checkout-front`. `PAN` fields are memory-only for the single outbound call and wiped immediately. |
| **`rail_routes`** | `rail_id UUID FK`, `gateway_id UUID FK`, `credential_policy` (`PLATFORM\|MERCHANT_REQUIRED\|MERCHANT_OR_PLATFORM`), `priority INT`, `routing_strategy` (`EFFECTIVE_COST\|STRICT_PRIORITY\|WEIGHTED`), `weight INT DEFAULT 100`, `cost_model JSON` (`calc_type`, `flat`, `percent`, `min`, `max`, `bearer`, `accrue_fee_at_confirm`), `mismatch_policy JSON` (`tolerance_amount`, `underpay_action`, `overpay_action`), `min_amount DECIMAL(18,4)`, `max_amount DECIMAL(18,4)`, `daily_cap_amount DECIMAL(18,4)`, `status` (`ACTIVE\|PAUSED\|DRAINING`), `health_state` (`HEALTHY\|DEGRADED\|OPEN_BREAKER`), `maintenance_windows JSON`, `scope JSON` (`merchant_ids`, `application_ids`, `risk_tiers`, `channels`) | `UNIQUE(rail_id, gateway_id, credential_policy)`. The unit of routing, failover, circuit breaking, and fee calculation. |

### 7.4 Group D: Declarative Flow Engine, Crypto, Channels & Mappings (13 Tables)

| Table Name | Key Columns & Types | Purpose & Behavior |
| :--- | :--- | :--- |
| **`crypto_profiles`** | `gateway_version_id UUID FK`, `name TEXT`, `purpose` (`OUTBOUND_SIGN\|INBOUND_VERIFY`), `algorithm` (`HMAC_SHA256\|HMAC_SHA512\|RSA_SHA256\|SHA256`), `secret_key_ref TEXT`, `secret_key_encoding` (`UTF8\|HEX\|BASE64`), `canonicalization_mode` (`SORTED_KEY_VALUE_AMP\|SORTED_VALUES_HASH\|TEMPLATE_STRING\|JSON_CANONICAL\|RAW_BODY\|TIMESTAMP_DOT_RAW_BODY`), `template_string TEXT NULL`, `included_fields JSON`, `excluded_fields JSON`, `output_encoding` (`HEX_LOWER\|HEX_UPPER\|BASE64`) | Declarative signing and verification recipes covering Moamalat Hex-HMAC, DPay `timestamp.body`, Plutu sorted-values callback hash, MyPay raw-body HMAC, MPGS, and RSA. |
| **`flows`** | `gateway_version_id UUID FK`, `rail_id UUID NULL FK`, `sub_mode TEXT NULL`, `phase` (`CREDENTIAL_CHECK\|PRE_INITIATE\|INITIATE\|SUBMIT\|VERIFY\|CANCEL\|REFUND\|VOID\|CAPTURE\|SETTLEMENT_FETCH`) | Ordered step stack per lifecycle phase. |
| **`flow_steps`** | `flow_id UUID FK`, `order_index INT`, `type` (`HTTP\|COMPUTE\|RENDER\|WAIT\|ASSERT\|BRANCH`), `method TEXT`, `url_template TEXT`, `content_type` (`application/json\|application/x-www-form-urlencoded\|multipart/form-data\|application/xml\|text/xml\|text/plain`), `xml_template TEXT NULL`, `timeout_ms INT`, `success_check JSON`, `side_effect` (`READ_ONLY\|SENDS_NOTIFICATION\|MOVES_MONEY`), `retry_policy` (`SAFE\|SAFE_WITH_COOLDOWN\|NEVER`), `idempotency_config JSON` (`mode`: `NONE\|HEADER\|BODY_FIELD`, `key_name`, `source_template`), `point_of_no_return BOOL` | Every HTTP step declares `side_effect`, `retry_policy`, `idempotency_config`, and `point_of_no_return`. Save-time validator forbids `MOVES_MONEY` with `retry_policy != NEVER` (unless idempotency key is supported and proven). |
| **`step_parameters`** | `step_id UUID FK`, `place` (`HEADERS\|QUERY\|PATH\|BODY\|FORM\|MULTIPART\|XML`), `key TEXT` (dot-path), `source` (`GATEWAY_META\|ROUTE_META\|CREDENTIAL\|ATTEMPT\|CUSTOMER_FIELD\|STATE\|PREVIOUS_RESPONSE\|URLS\|CLIENT_CONTEXT\|CONSTANT\|NOW\|RANDOM\|COMPUTED\|CRYPTO_SIGNATURE`), `selector TEXT NULL`, `constant_value TEXT NULL`, `crypto_profile_id UUID NULL FK`, `transforms JSON` | Ordered `TransformPipe[]` validated for type safety on save. |
| **`step_outputs`** | `step_id UUID FK`, `name TEXT`, `selector TEXT`, `transforms JSON`, `store_as` (`STATE\|PUBLIC\|SETTLED_AMOUNT\|PROVIDER_FEE\|PROVIDER_REF\|NETWORK_REF`), `required BOOL` | `PUBLIC` outputs reach `checkout-front`; `STATE` outputs are encrypted in `payment_attempts.context_ciphertext`; missing `required` output on `MOVES_MONEY` triggers `UNKNOWN`. |
| **`status_rules`** | `gateway_version_id UUID FK`, `phase TEXT`, `order_index INT`, `selector TEXT`, `op` (`equals\|not_equals\|in\|exists\|matches`), `value_json JSON`, `canonical_status` (`AWAITING_CUSTOMER\|VERIFYING\|SUCCEEDED\|FAILED\|UNKNOWN`), `canonical_substatus TEXT NULL`, `canonical_error TEXT NULL` | First match wins. No match on a `MOVES_MONEY` step defaults to `UNKNOWN`. |
| **`error_maps`** | `gateway_version_id UUID FK`, `gateway_code TEXT`, `canonical_error TEXT`, `classification` (`RETRYABLE_OTP\|TERMINAL_DECLINE\|LIMIT_EXCEEDED\|GATEWAY_FAULT\|AMBIGUOUS`), `retryable BOOL`, `counts_toward_lockout BOOL`, `counts_toward_breaker BOOL`, `customer_message_ar TEXT`, `customer_message_en TEXT`, `operator_hint TEXT` | Distinguishes customer errors (`RETRYABLE_OTP`, `LIMIT_EXCEEDED`) from gateway faults so customer mistakes never trip circuit breakers. |
| **`confirmation_channels`** | `gateway_version_id UUID FK`, `route_id UUID NULL FK`, `type` (`WEBHOOK\|RETURN_URL\|BROWSER_CALLBACK\|POLL\|STATEMENT\|OPERATOR`), `path_token VARCHAR(191) UNIQUE`, `crypto_profile_id UUID NULL FK`, `verify_method` (`HMAC_BODY\|HASH_FIELDS\|SORTED_VALUES_HASH\|RSA\|SHARED_TOKEN\|IP_ONLY\|NONE_PLUS_INQUIRY`), `signature_header TEXT NULL`, `timestamp_selector TEXT NULL`, `timestamp_tolerance_sec INT DEFAULT 300`, `ip_allowlist JSON`, `body_format` (`JSON\|FORM\|XML`), `correlation_selector TEXT`, `dedupe_key_selector TEXT NULL`, `event_map JSON`, `must_inquire BOOL`, `ack_status INT DEFAULT 200`, `ack_body_template TEXT` | Weak methods (`SHARED_TOKEN`, `IP_ONLY`, `RETURN_URL`, `BROWSER_CALLBACK`) enforce `must_inquire = true` at save time. |
| **`poll_policies`** | `route_id UUID FK`, `first_after_seconds INT DEFAULT 5`, `backoff_seconds JSON`, `max_duration_seconds INT DEFAULT 900`, `stop_on_states JSON` | Background polling schedule for asynchronous rails. |
| **`widget_definitions`** | `route_id UUID FK`, `kind` (`LIGHTBOX\|IFRAME\|SDK_WEBVIEW\|NATIVE_ANDROID`), `sdk_driver TEXT`, `script_urls JSON`, `script_sri_hashes JSON`, `config_template JSON`, `callbacks_map JSON`, `allowed_origins JSON`, `iframe_sandbox_attrs JSON`, `csp_additions TEXT` | Requires `SECURITY_ADMIN` Maker-Checker approval for any `script_urls` or `csp_additions` change. |
| **`redirect_definitions`** | `route_id UUID FK`, `method` (`GET\|POST_FORM`), `url_source_output TEXT`, `form_fields_output TEXT NULL`, `target` (`SAME_WINDOW\|NEW_TAB\|TOP_FRAME`), `return_method_expected` (`GET\|POST`), `return_params_map JSON` | Declarative HTTP redirect or auto-submitted POST form builder. |
| **`statement_sources`** | `gateway_id UUID FK`, `type` (`API\|SFTP\|UPLOAD`), `schedule_cron TEXT`, `parser_config JSON` (`format`: `CSV\|XLSX\|JSON`, `encoding`, `delimiter`, `header_row`, `columns_map`, `date_format`, `timezone`, `supports_batch_net`), `settlement_lag_days INT`, `dedupe_key_template TEXT` | Makes T+N bank/gateway statement reconciliation 100% configuration-driven. |
| **`manual_instructions`** | `rail_id UUID FK`, `instructions_ar TEXT`, `instructions_en TEXT`, `destination_account_template TEXT`, `reference_format TEXT`, `proof_upload_allowed BOOL`, `operator_sla_minutes INT`, `auto_expiry_minutes INT` | Configures manual bank transfer / cash agent rails. |

### 7.5 Group E: Runtime Execution, Audit & Reconciliation Entities (10 Tables)

| Table Name | Key Columns & Types | Purpose & Behavior |
| :--- | :--- | :--- |
| **`attempt_groups`** | `link_id UUID FK`, `customer_fingerprint CHAR(64)`, `success_count INT DEFAULT 0 CHECK (success_count <= 1)` | Groups all retries and rail switches by one customer on one link. Enforces at most one `SUCCEEDED` attempt per group. |
| **`payment_attempts`** | `reference VARCHAR(191) UNIQUE`, `idempotency_key TEXT`, `link_id UUID FK`, `attempt_group_id UUID FK`, `application_id UUID FK`, `merchant_id UUID FK`, `rail_id UUID FK`, `route_id UUID FK`, `credential_set_id UUID FK`, `gateway_version_id UUID FK`, `commission_profile_id UUID FK`, `env` (`SANDBOX\|LIVE`), `mode TEXT`, `sub_mode TEXT NULL`, `status` (`CREATED\|INITIATING\|AWAITING_CUSTOMER\|AUTHORIZING\|VERIFYING\|UNKNOWN\|SUCCEEDED\|FAILED\|EXPIRED\|CANCELLED\|BLOCKED\|PARTIALLY_REFUNDED\|REFUNDED\|DISPUTED`), `substatus TEXT NULL`, `gateway_reference TEXT`, `provider_reference TEXT NULL`, `network_reference TEXT NULL`, `requested_amount DECIMAL(18,4)`, `surcharge_amount DECIMAL(18,4) DEFAULT 0`, `total_charged_amount DECIMAL(18,4)`, `gateway_amount_wire TEXT`, `settled_amount DECIMAL(18,4) NULL`, `gateway_fee_amount DECIMAL(18,4) NULL`, `platform_commission_amount DECIMAL(18,4)`, `net_merchant_amount DECIMAL(18,4)`, `fee_bearer TEXT`, `currency CHAR(3)`, `customer_fields_masked JSON`, `context_ciphertext TEXT`, `otp_attempts INT DEFAULT 0`, `last_otp_sent_at DATETIME(3) NULL`, `client_ip TEXT`, `user_agent TEXT`, `expires_at DATETIME(3)`, `grace_expires_at DATETIME(3)`, `next_check_at DATETIME(3) NULL`, `ledger_entry_id UUID NULL FK UNIQUE`, `terminal_at DATETIME(3) NULL` | The unified runtime payment record. Pins `gateway_version_id`, `route_id`, `credential_set_id`, and `commission_profile_id`. `UNIQUE(ledger_entry_id)` prevents double ledger posting. |
| **`attempt_step_logs`** | `attempt_id UUID FK`, `gateway_version_id UUID FK`, `phase TEXT`, `step_id UUID FK`, `step_order INT`, `redacted_request_json JSON`, `redacted_response_text TEXT`, `http_status INT`, `duration_ms INT`, `outcome TEXT`, `created_at DATETIME(3)` | Immutable forensic log of every outbound HTTP call. Preserves raw text for `UNKNOWN` debugging; scrubbed by multi-layer secret redactor prior to insert. |
| **`inbound_events`** | `channel_id UUID FK`, `gateway_id UUID FK`, `env TEXT`, `raw_body_bytes LONGBLOB`, `redacted_headers_json JSON`, `source_ip TEXT`, `verified BOOL`, `verification_error TEXT NULL`, `dedupe_key CHAR(64)`, `attempt_id UUID NULL FK`, `received_at DATETIME(3)`, `processed_at DATETIME(3) NULL`, `processing_result TEXT` | Durable webhook inbox stored **before** any processing and never deleted. `UNIQUE(channel_id, dedupe_key)` absorbs replays and retries. |
| **`operator_cases`** | `attempt_id UUID NULL FK`, `reconciliation_item_id UUID NULL FK`, `kind` (`UNKNOWN\|HELD\|CONFLICT\|MISMATCH\|LATE_SUCCESS\|MANUAL_REVIEW\|UNMATCHED_STATEMENT`), `priority` (`P1\|P2\|P3`), `sla_due_at DATETIME(3)`, `state` (`OPEN\|IN_PROGRESS\|PENDING_CHECKER\|RESOLVED`), `assignee_user_id UUID NULL FK`, `resolution_notes TEXT`, `approval_request_id UUID NULL FK` | Operational queue with SLA timers for human-in-the-loop exception handling under Maker-Checker. |
| **`reconciliation_runs`** | `statement_source_id UUID FK`, `window_start DATETIME(3)`, `window_end DATETIME(3)`, `file_hash CHAR(64) UNIQUE`, `stats_json JSON` | `file_hash UNIQUE` makes manual or SFTP statement uploads idempotent. |
| **`reconciliation_items`** | `run_id UUID FK`, `attempt_id UUID NULL FK`, `our_reference TEXT`, `provider_reference TEXT`, `batch_reference TEXT NULL`, `statement_amount DECIMAL(18,4)`, `statement_fee DECIMAL(18,4)`, `result` (`MATCHED\|AMOUNT_MISMATCH\|MISSING_AT_GATEWAY\|MISSING_LOCALLY\|DUPLICATE`), `operator_case_id UUID NULL FK` | Per-line reconciliation outcome. |
| **`gateway_health_samples`** | `route_id UUID FK`, `window_start DATETIME(3)`, `definitive_failures INT`, `ambiguous_unknowns INT`, `rate_limits_429 INT`, `successes INT`, `p50_ms INT`, `p95_ms INT`, `p99_ms INT` | Rolling telemetry driving the per-route circuit breaker. |
| **`detail_change_logs`** | `actor_id UUID`, `merchant_id UUID NULL`, `entity_type TEXT`, `entity_id UUID`, `field_name TEXT`, `old_value TEXT`, `new_value TEXT`, `approval_request_id UUID NULL`, `source` (`PORTAL\|ADMIN\|API\|SYSTEM`), `request_id TEXT`, `client_ip TEXT NULL`, `created_at DATETIME(3)` | Field-level history independent of approval logs so Support can answer "what did this field used to say?". |
| **`audit_log`** | `actor_id UUID`, `role TEXT`, `action TEXT`, `entity_type TEXT`, `entity_id UUID`, `before_json JSON`, `after_json JSON`, `approval_request_id UUID NULL`, `created_at DATETIME(3)` | Immutable audit trail across all merchant, application, and admin actions. |

### 7.6 Group F: Identity, Onboarding, Compliance, Disputes & Configuration Entities (13 Tables)

| Table Name | Key Columns & Types | Purpose & Behavior |
| :--- | :--- | :--- |
| **`user_identities`** | `user_id UUID FK`, `kind` (`PHONE\|EMAIL\|GOOGLE`), `identifier_normalized TEXT`, `provider_subject TEXT NULL`, `verified_at DATETIME(3) NULL`, `is_primary BOOL`, `last_used_at DATETIME(3)` | `PII`. `UNIQUE(kind, identifier_normalized)`; for `GOOGLE`, `UNIQUE(provider_subject)` (OIDC `sub`). Usable for login only after `verified_at` is set. |
| **`join_requests`** | `merchant_id UUID FK`, `submitted_by_user_id UUID FK`, `status` (`DRAFT\|SUBMITTED\|IN_REVIEW\|INFO_REQUESTED\|PENDING_CHECKER\|APPROVED\|REJECTED\|WITHDRAWN\|EXPIRED`), `onboarding_channel` (`SELF_SERVICE\|ADMIN_ASSISTED`), `submitted_at`, `assigned_reviewer_id UUID NULL FK`, `sla_due_at DATETIME(3)`, `screening_id UUID NULL FK`, `proposed_risk_tier` (`LOW\|STANDARD\|HIGH`), `four_eyes_required BOOL`, `four_eyes_reasons JSON`, `decision` (`APPROVED\|REJECTED`) `NULL`, `decision_reason_code TEXT NULL`, `decision_notes TEXT NULL`, `info_request_json JSON NULL`, `resubmission_of_id UUID NULL FK`, `approval_request_id UUID NULL FK` | `KYB`. The auditable record of one onboarding attempt. Only one open `join_request` may exist per merchant. |
| **`kyb_documents`** | `merchant_id UUID FK`, `join_request_id UUID NULL FK`, `subject_type` (`MERCHANT\|BENEFICIAL_OWNER`), `subject_id UUID`, `doc_type` (`COMMERCIAL_REGISTRY\|TAX_CERTIFICATE\|ARTICLES_OF_ASSOCIATION\|OWNER_ID\|SIGNATORY_ID\|PROOF_OF_ADDRESS\|BANK_LETTER\|SECTOR_LICENSE\|OTHER`), `storage_key TEXT`, `sha256 CHAR(64)`, `mime TEXT`, `size_bytes INT`, `av_status` (`PENDING\|CLEAN\|INFECTED`), `status` (`UPLOADED\|ACCEPTED\|REJECTED\|EXPIRED`), `reviewed_by UUID NULL FK`, `reviewed_at`, `expires_on DATE NULL`, `rejection_reason_code TEXT NULL` | `KYB`. Encrypted object storage, malware-scanned before any reviewer can open it. `sha256` indexed across merchants for duplicate detection. |
| **`beneficial_owners`** | `merchant_id UUID FK`, `full_name_ar TEXT`, `full_name_en TEXT NULL`, `national_id_ciphertext TEXT`, `date_of_birth DATE`, `nationality CHAR(2)`, `ownership_percent DECIMAL(5,2) NULL`, `role` (`OWNER\|DIRECTOR\|SIGNATORY\|CONTROLLER`), `pep_declared BOOL`, `screening_status` (`NOT_SCREENED\|CLEAR\|POTENTIAL_MATCH\|CONFIRMED_MATCH`), `active BOOL`, `valid_from`, `valid_to NULL` | `PII`, `KYB`. Persons who own at least `aml.owner_threshold_percent` (default 25%) or exercise control. |
| **`aml_screenings`** | `subject_type` (`MERCHANT\|BENEFICIAL_OWNER\|END_CLIENT\|PAYMENT_ATTEMPT`), `subject_id UUID`, `trigger` (`ONBOARDING\|PERIODIC\|LIST_UPDATE\|OWNER_CHANGE\|TRANSACTION\|MANUAL`), `provider_code TEXT`, `provider_request_ref TEXT NULL`, `list_versions_json JSON`, `input_hash CHAR(64)`, `result` (`CLEAR\|POTENTIAL_MATCH\|CONFIRMED_MATCH\|ERROR`), `match_count INT`, `highest_score DECIMAL(5,2) NULL`, `requested_at`, `completed_at NULL` | `AML-CONFIDENTIAL`. Records exact list versions and `input_hash` for reproducibility and caching. |
| **`aml_screening_matches`** | `screening_id UUID FK`, `list_type` (`SANCTIONS\|PEP\|ADVERSE_MEDIA\|INTERNAL_WATCHLIST`), `list_name TEXT`, `list_entry_ref TEXT`, `matched_name TEXT`, `score DECIMAL(5,2)`, `attributes_json JSON`, `disposition` (`UNREVIEWED\|FALSE_POSITIVE\|TRUE_MATCH\|ESCALATED`), `disposition_by UUID NULL FK`, `disposition_notes TEXT NULL`, `suppress_future BOOL DEFAULT false`, `suppress_until DATE NULL` | `AML-CONFIDENTIAL`. Candidate hits and false-positive suppression with expiry. |
| **`aml_rules`** | `code VARCHAR(191) UNIQUE`, `name TEXT`, `rule_type` (`SINGLE_AMOUNT\|CUMULATIVE_WINDOW\|STRUCTURING\|RISK_TIER\|COUNTERPARTY_COUNTRY\|RAIL\|MERCHANT_DIRECT_AMOUNT`), `scope JSON`, `params JSON`, `action` (`HOLD\|FLAG\|BLOCK\|CASE_ONLY`), `base_severity` (`LOW\|MEDIUM\|HIGH\|CRITICAL`), `active BOOL`, `version INT`, `effective_from`, `effective_to NULL`, `approval_request_id UUID FK` | Declarative, versioned, effective-dated AML rule set. |
| **`reporting_rules`** | `authority TEXT DEFAULT 'CBL'`, `report_type` (`LARGE_TRANSACTION\|SUSPICIOUS_ACTIVITY\|PERIODIC_RETURN`), `threshold_amount DECIMAL(18,4) NULL`, `window_seconds INT NULL`, `currency CHAR(3) DEFAULT 'LYD'`, `conditions JSON`, `source_reference TEXT`, `status` (`PROVISIONAL\|CONFIRMED`), `effective_from`, `effective_to NULL`, `approval_request_id UUID FK` | Makes jurisdiction-specific reporting configuration, not code. `PROVISIONAL` rules cannot generate live regulatory filings. |
| **`regulatory_reports`** | `report_type` (`LARGE_TRANSACTION\|SUSPICIOUS_ACTIVITY\|PERIODIC_RETURN`), `authority TEXT`, `subject_type TEXT`, `subject_id UUID`, `aml_case_id UUID NULL FK`, `period_start NULL`, `period_end NULL`, `status` (`DRAFT\|PENDING_CHECKER\|APPROVED\|SUBMITTED\|ACKNOWLEDGED\|REJECTED_BY_AUTHORITY`), `payload_ciphertext TEXT`, `payload_sha256 CHAR(64)`, `submission_ref TEXT NULL`, `submitted_at NULL`, `confidential BOOL DEFAULT true`, `approval_request_id UUID NULL FK` | `AML-CONFIDENTIAL`. Frozen payload at `APPROVED`; existence of an STR is never disclosed to the subject. |
| **`disputes`** | `attempt_id UUID FK`, `gateway_id UUID FK`, `rail_id UUID FK`, `external_dispute_ref TEXT`, `source` (`WEBHOOK\|STATEMENT\|MANUAL`), `reason_code TEXT NULL`, `amount DECIMAL(18,4)`, `currency CHAR(3)`, `status` (`OPENED\|EVIDENCE_REQUESTED\|EVIDENCE_SUBMITTED\|WON\|LOST\|EXPIRED\|WITHDRAWN`), `opened_at`, `evidence_due_at DATETIME(3) NULL`, `outcome_at NULL`, `adjustment_id UUID NULL FK`, `evidence_json JSON NULL` | `UNIQUE(gateway_id, external_dispute_ref)`. Drives automated chargeback Adjustment drafting. |
| **`notification_templates`** | `code TEXT`, `channel` (`SMS\|EMAIL\|IN_APP`), `lang` (`ar\|en`), `subject_template TEXT NULL`, `body_template TEXT`, `confidentiality_class` (`PUBLIC\|MERCHANT\|INTERNAL`), `version INT`, `active BOOL` | `UNIQUE(code, channel, lang, version)`. Templates of class `MERCHANT` or `PUBLIC` may not reference `AML-CONFIDENTIAL` variables. |
| **`notifications`** | `event_id UUID UNIQUE`, `recipient_user_id UUID NULL FK`, `recipient_merchant_id UUID NULL FK`, `address_masked TEXT`, `address_ciphertext TEXT`, `template_code TEXT`, `channel TEXT`, `lang TEXT`, `payload_json JSON`, `status` (`QUEUED\|SENT\|DELIVERED\|FAILED\|SUPPRESSED`), `provider_message_id TEXT NULL`, `attempts INT DEFAULT 0`, `next_attempt_at NULL` | Transactional outbox written in the same DB transaction as the business event. |
| **`platform_settings`** | `key TEXT`, `scope TEXT DEFAULT 'PLATFORM'`, `value_json JSON`, `version INT`, `effective_from`, `approval_request_id UUID NULL FK` | Versioned, effective-dated platform configuration cached with `InvalidationBus` eviction. |

# PART III: THE UNIVERSAL RAIL ENGINE (VOUCHER-INSPIRED ZERO-CODE ARCHITECTURE)

## 8. Engine Contract, `ApiConsumer` Registry, `recursiveSet`, Transforms & Crypto Engine

All components in Part III run exclusively inside **`core-back/engine/`**.

### 8.1 Hardened Voucher Engine Primitives (`recursiveSet`, `recursiveSelect`, `compileUrl`, `ApiConsumer`)

Directly inherited from the Voucher Provider Management System and hardened with all 14 engineering safeguards:

1. **Prototype-Safe, Non-Destructive `recursiveSet(target, path, value)`:**
   - Clones the path array (`typeof path === 'string' ? path.split('.') : [...path]`) so caller arrays are never mutated by `.pop()`.
   - Rejects any segment in `['__proto__', 'constructor', 'prototype']` immediately with an `ApiError`.
   - Creates intermediate `{}` or `[]` (when the next segment matches `/^[0-9]+$/`) **only if `!target[segment]`**, preserving sibling fields (e.g., setting `transAmount.amount` and then `transAmount.currency`).
2. **Promise-Cached `ApiConsumer` Registry with Single-Flight Refresh & Jittered Chained `setTimeout`:**
   - Keyed by `(gateway_id, env, credential_set_id)`.
   - Stores the initialization `Promise<ApiConsumer>` in `consumersMap` **synchronously before awaiting DB loads** to eliminate race conditions and duplicate timer leaks under concurrent bursts.
   - Replaces `setInterval` with a **chained `setTimeout`** (`period * (0.9 + Math.random() * 0.2)` for +/-10% jitter) so refreshes never overlap or stampede across cluster instances.
   - Uses a `singleFlightRefreshPromise` when concurrent requests encounter `401`/`403` so only one token refresh HTTP call is executed.
   - If the refresh response includes a rotated refresh token (`new_refresh_token_selector`), encrypts and persists it to `credential_sets` in the MySQL / MariaDB database **before** resolving the refresh Promise.
   - Retries a `401`/`403` request **only if the HTTP failure occurred before the gateway could have processed a money movement**; timeouts and 5xx on `MOVES_MONEY` steps are **never retried**.

### 8.2 The Six-Method Universal Engine Contract (`DynamicRailEngine`)

| Method | Execution Contract & Safety Rules in `core-back` |
| :--- | :--- |
| **`preInitiate(attempt, formData)`** | Optional pre-flight phase. Executes `PRE_INITIATE` flow stack (`READ_ONLY`) to validate subscriber eligibility, fetch bill details, or lock an upstream exchange/fee quote before dispatching an OTP. |
| **`initiate(attempt, formData)`** | Validates `formData` against the rail's compiled Zod 4 schema (after applying `normalizer`), runs the `INITIATE` flow stack (or `COMPUTE` step for zero-HTTP embedded widgets like Moamalat Lightbox), stores `STATE` outputs in `context_ciphertext`, and returns a declarative `ClientAction` payload containing only `PUBLIC` outputs. |
| **`confirm(attempt, evidence)`** | Executes the `SUBMIT` (`CONFIRM`) stack using OTP input, signed callback data, or redirect evidence. Marks `point_of_no_return = true`, `side_effect = MOVES_MONEY`, `retry_policy = NEVER`. Verifies all 5 trusted-success facts and invokes the `LedgerPoster` in the same DB transaction on `SUCCEEDED`. |
| **`verifyCallback(channel, rawReq)`** | Executes constant-time signature verification across all active `secret_version` entries, checks IP CIDR allowlist and timestamp replay window (`timestamp_tolerance_sec`), computes `dedupe_key`, correlates `attempt_id`, and triggers `inquire(attempt)` when `must_inquire == true`. |
| **`inquire(attempt)`** | Executes the `VERIFY` (`INQUIRE`) read-only stack to poll authoritative status at the gateway. Used for `must_inquire` channels, `UNKNOWN` resolution, pre-expiry checks, and operator on-demand checks. |
| **`refund(attempt, amount, adjId)`** | Executes the `REFUND` (or `VOID` if pre-settlement) stack when a Maker-Checker refund `Adjustment` is approved. If timeout/5xx occurs, keeps Adjustment in `EXECUTING` and schedules reconciliation. |

### 8.3 The Five Declarative `ClientAction` Renderers (Consumed by `checkout-front`)

`checkout-front` contains zero gateway-specific logic; it renders strictly from these five declarative payloads returned by `core-back` via `checkout-back`:
1. **`SHOW_OTP_FORM`:** `{ otp_length, max_attempts, resend_cooldown_seconds, expires_at, masked_phone }`
2. **`HTTP_REDIRECT`:** `{ method: 'GET' | 'POST_FORM', url, form_fields, target, return_token }`
3. **`RENDER_EMBEDDED`:** `{ sdk_driver, script_urls, script_sri_hashes, config, allowed_origins, iframe_sandbox }`
4. **`SHOW_QR_OR_CODE`:** `{ qr_payload, pay_code, instructions_ar, instructions_en, expires_at, deep_link_url }`
5. **`SHOW_PUSH_OR_TRANSFER`:** `{ wallet_hint, destination_account, payment_reference, instructions_ar, instructions_en, proof_upload_allowed, expires_at, cancel_supported }`

### 8.4 The Closed Transform Library (`TransformPipe[]` — Pure Operations)

| Category | Whitelisted Operations |
| :--- | :--- |
| **Numeric & Amount** | `scale(factor)` / `MUL_INT(factor)`, `DIV_DECIMAL(divisor, places)`, `round(mode: NONE\|NEAREST\|UP\|DOWN)`, `format_decimal(places)`, `to_int`, `to_number`, `to_string` |
| **String & Normalization** | `concat`, `template`, `lowercase`, `uppercase`, `trim`, `pad_left(length, char)`, `pad_right(length, char)`, `substring(start, end)`, `mask(visible_start, visible_end)`, `prepend(secret_ref)`, `arabic_digits_to_ascii`, `phone_normalize(style: LOCAL_09\|INTL_218\|E164)` |
| **Canonicalization** | `sort_keys`, `values_only`, `join_pairs(kv_sep, pair_sep)` |
| **Time & Identity** | `format_date(pattern, timezone)`, `epoch_seconds`, `epoch_millis`, `uuid`, `numeric_random(length)` |
| **Encoding & Escaping** | `base64_encode`, `hex_lower`, `hex_upper`, `url_encode`, `json_encode`, `xml_escape` |
| **Cryptographic** | `sha256`, `sha512`, `hmac_sha256(key_ref, key_encoding: utf8\|hex\|base64)`, `hmac_sha512(key_ref, key_encoding)`, `rsa_sha256_sign(key_ref)` |

# PART IV: COLLECTION MODES, STATE MACHINE & PRODUCTION BLUEPRINTS

## 9. The 13-State Attempt Lifecycle Machine and Atomic Slot Reservation Invariant

### 9.1 The Nine Governing State Machine Rules
1. **Pinned Configuration:** `gateway_version_id`, `route_id`, `credential_set_id`, and `commission_profile_id` are locked on `payment_attempts` at creation.
2. **Atomic Slot Reservation (`active_locked_count`):** Inside the `SERIALIZABLE` / `SELECT ... FOR UPDATE` initiation guard transaction on `payment_links` in `core-back`, creating an attempt increments `active_locked_count`. For single-use links (`use_count = 1`), `confirmed_count + active_locked_count <= 1` prevents any second tab, device, or concurrent payer from starting a competing payment. The reservation is released **only** on terminal `FAILED`, `EXPIRED`, `CANCELLED`, or `BLOCKED` states, and is **strictly held through `UNKNOWN`**.
3. **Effective Expiry (`min` TTL) + Grace Window:** `expires_at = min(gateway_session_ttl, platform_ttl)` (platform ceiling for `OTP_PULL` is **20 minutes**; `REDIRECT` 30 minutes; `QR_DISPLAY` / `PUSH_APPROVAL` 15 minutes). When `NOW() > expires_at`, the sweeper runs `inquire(attempt)` first (if supported) before transitioning to `EXPIRED`. `grace_expires_at` (default +24h; indefinite for no-inquiry rails) keeps the webhook inbox open for late settlements.
4. **Retryable OTP vs. Terminal Decline:** If `SUBMIT` returns a gateway code mapped to `RETRYABLE_OTP` and `otp_attempts < max_otp_attempts` (default 3), `otp_attempts` increments and the attempt returns to `AWAITING_CUSTOMER (OTP_REQUIRED)` without sending a new SMS. On attempt #3, it transitions to `FAILED`.
5. **Forward-Only Motion:** `SUCCEEDED` is never downgraded by a later failure or expiry event. Conflicting trusted signals freeze the attempt in `UNKNOWN` and open a `P1` `CONFLICT` operator case.
6. **Late Success Recovery:** A verified confirmation arriving after `EXPIRED` or `FAILED` transitions the attempt to `SUCCEEDED`, posts the ledger entry (if the link slot is still available), and raises a `P2` alert. If the single-use link was already paid by another attempt in the meantime, funds route to `SUSPENSE` and auto-draft a refund `Adjustment`.
7. **Atomic Ledger Posting:** Transitioning to `SUCCEEDED` and inserting `journal_entries` + `journal_lines` occur in the **exact same database transaction**, guarded by `UNIQUE(ref_type, ref_id)` on `journal_entries` and `UNIQUE(ledger_entry_id)` on `payment_attempts`.
8. **Durable Database Timers:** `expires_at` and `next_check_at` are indexed `DATETIME(3)` columns polled by stateless workers in `core-back` using `SELECT ... FOR UPDATE SKIP LOCKED`. `SKIP LOCKED` requires **MySQL 8.0+ / MariaDB 10.6+** — below that floor the sweepers must run single-node, because the lock-skipping semantics do not exist. The terminal transitions are additionally guarded by a conditional `UPDATE ... WHERE terminal_at IS NULL`, so a terminal state is applied **at most once** even when two cluster nodes claim the same row.
9. **Realtime Streaming:** Every state transition broadcasts from `core-back` to `checkout-back` (for the payer's SSE stream) and `merchant-back` (for the paired POS WebSocket/SSE cashier room).

## 10. Seven Production Configuration Blueprints (Including NeomPay First-Party Rail)

- **Blueprint 1: Edfali & Sadad (Two-Step `OTP_PULL` with `RETRYABLE_OTP`):** `POST {api}/verify` (`SENDS_NOTIFICATION`, `SAFE_WITH_COOLDOWN`) -> extracts `process_id -> STATE`. `POST {api}/confirm` (`MOVES_MONEY`, `NEVER`, `point_of_no_return: true`) -> confirms OTP.
- **Blueprint 2: Moamalat National Switch (`EMBEDDED` Lightbox + Hex-HMAC + Mandatory Inquiry):** `INITIATE` is a zero-HTTP `COMPUTE` step building `AmountTrxn` (`scale(1000) |> to_int`), `MerchantReference` (10-digit numeric), `TrxDateTime` (`YYYYMMDDHHmm`, `Africa/Tripoli`), and `SecureHash` (`MOAMALAT_SECURE_HASH` with Hex-decoded key). `VERIFY` calls `POST {inquiry}/FilterTransactions` and asserts `Approved == true`, `ActionCode == "00"`, and settled amount match.
- **Blueprint 3: CBL LYPay Instant Payment (`QR_DISPLAY` / Push with 5s Sync Window + Webhook + Enquiry):** OAuth2 `TOKEN_ENDPOINT`, initiates transfer / EMVCo TLV QR, confirms with 5s synchronous window (`Confirmed` -> `SUCCEEDED`; `Processing` -> `VERIFYING` with HMAC webhook + Enquiry API).
- **Blueprint 4: MyPay & Tadawul T-LYNC (`REDIRECT` Hosted Checkout + Signed Webhook + Receipt Inquiry):** Creates session with `return_url` and `callback_url`, redirects customer, verifies `X-MYPAY-SIGNATURE` raw-body HMAC or T-LYNC IP allowlist + mandatory `POST /receipt/transaction` inquiry.
- **Blueprint 5: MobiCash, OnePay, Yussor Pay & Sahara Pay (`HYBRID` Card OTP / Pay Code / EMVCo QR):** Supports 7-digit MobiCash/Yussor/Sahara ID or 9-digit OnePay cross-bank code (`sensitivity: PAN`, memory-only, wiped immediately after outbound call).
- **Blueprint 6: Visa / Mastercard MPGS 3DS2 & Evo Pay (`EMBEDDED` / `REDIRECT` Multi-Currency & Nested JSON):** MPGS Hosted Session (`PCI-DSS SAQ-A`) with mandatory `GET /order/{id}` inquiry; Evo Pay nested JSON (`transAmount.amount`, `transAmount.currency`) built via `recursiveSet`.
- **Blueprint 7: NeomPay First-Party Wallet Rail (`INTERNAL` Gateway · `PUSH_APPROVAL` / `OTP_PULL` / `QR_DISPLAY`):**
  - `code = neompay`, `kind = INTERNAL`, `collection_mode = HYBRID` (`PUSH_APPROVAL`, `OTP_PULL`, `QR_DISPLAY`).
  - Field `wallet_id` (`type = wallet_id`, `regex = ^NP-[0-9]{12}$`, `checksum = LUHN`, `SENSITIVE`) + wallet-type allowlist.
  - Service-to-service `MUTUAL_TLS`, native 3-decimal LYD (`scale = 1`, `precision = 3`, `rounding = NONE`), deterministic `Idempotency-Key` (`ATTEMPT.gateway_reference`), anti-self-dealing guard (`SELF_PAYMENT_POLICY = BLOCK`), and **Ledger Rule INTERNAL-1** (posts directly to `TREASURY` with no `GATEWAY_CLEARING` leg).

# PART V: TRUST, VERIFICATION AND THE DOUBLE-ENTRY LEDGER

## 11. Money, Fee Bearers, Ownership Models & 15 Worked Journal Entries

### 11.1 The Three Fee Bearer Models (Example: 100.0000 LYD Link, 3.0000 LYD Platform Commission, 0.8000 LYD Gateway Fee)

| Fee Bearer Mode | Payer Charged (`total_charged_amount`) | Merchant Credited (`net_merchant_amount`) | Platform Gross / Net Revenue | Checkout UX Display Contract |
| :--- | :--- | :--- | :--- | :--- |
| **`MERCHANT_ABSORBS` (Default)** | `100.0000 LYD` | `97.0000 LYD` | `3.0000 LYD gross / 2.2000 LYD net` | Shows `Total: 100.00 LYD` |
| **`PAYER_SURCHARGE`** | `103.0000 LYD` | `100.0000 LYD` | `3.0000 LYD gross / 2.2000 LYD net` | Shows `100.00 LYD + 3.00 LYD Service Fee = 103.00 LYD` prior to confirm |
| **`SPLIT` (50/50 Custom)** | `101.5000 LYD` | `98.5000 LYD` | `3.0000 LYD gross / 2.2000 LYD net` | Shows `100.00 LYD + 1.50 LYD Service Fee = 101.50 LYD` prior to confirm |

### 11.2 The System-Wide Double-Entry Ledger Invariant

Checked continuously by `core-back` triggers and a scheduled verification job:
```text
  TREASURY Balance
+ SUM(GATEWAY_CLEARING Balances)
+ SUM(COMMISSION_RECEIVABLE Balances)
==
  SUM(MERCHANT_WALLET Balances)
+ PLATFORM_INCOME Balance
- PROVIDER_FEE_EXPENSE Balance
- GATEWAY_FEE_EXPENSE Balance
+ GATEWAY_FEE_ACCRUAL Balance
+ AML_HOLD Balance
+ CHARGEBACK_RESERVE Balance
+ SUSPENSE Balance
```

#### 11.2.1 Database-Level Enforcement of the Domain Invariants (MySQL / MariaDB)

The four domain invariants are enforced in the database by the initial migration, but **not** in the same way:

| Invariant | Enforcement |
| :--- | :--- |
| `journal_lines.amount > 0` | `CHECK` constraint `journal_lines_amount_positive` |
| `attempt_groups.success_count <= 1` | `CHECK` constraint `attempt_groups_single_success` |
| `payment_links` slot reservation (`infinite_use = true OR confirmed_count + active_locked_count <= use_count`) | `CHECK` constraint `payment_links_slot_reservation_invariant` |
| `approval_requests.checker_user_id <> maker_user_id` | `BEFORE INSERT` trigger `approval_requests_checker_not_maker` |

MariaDB **forbids a `CHECK` constraint on a column that participates in a foreign key**, and `approval_requests.checker_user_id` / `maker_user_id` are both foreign keys into `users`. The Maker ≠ Checker invariant is therefore enforced by a `BEFORE INSERT` trigger on `approval_requests` that raises `SIGNAL SQLSTATE '45000'` (`checker_user_id must differ from maker_user_id`), **in addition to** the application-level check in `ApprovalService` and the `makerCheckerGuard` middleware. The other three domain checks remain plain `CHECK` constraints.

### 11.3 All 15 Worked Double-Entry Journal Entries

| # | Business Event | Debits (Dr) | Credits (Cr) |
| :--- | :--- | :--- | :--- |
| **1** | **Platform-Held Confirmation (Same-Day Direct Settlement, Fee Deducted at Source):** 100 LYD, 3% commission, 1 LYD provider fee | `Dr TREASURY` `99.0000`<br>`Dr PROVIDER_FEE_EXPENSE` `1.0000` | `Cr MERCHANT_WALLET (M)` `97.0000`<br>`Cr PLATFORM_INCOME` `3.0000` |
| **2** | **Platform-Held Confirmation with Fee Accrual (T+N Settlement):** 100 LYD, 3% commission, 0.80 LYD accrued gateway fee | `Dr GATEWAY_CLEARING (G)` `100.0000`<br>`Dr GATEWAY_FEE_EXPENSE` `0.8000` | `Cr MERCHANT_WALLET (M)` `97.0000`<br>`Cr PLATFORM_INCOME` `3.0000`<br>`Cr GATEWAY_FEE_ACCRUAL` `0.8000` |
| **3** | **T+N Bank Statement Settlement Sweep:** Statement shows 99.20 LYD net settled to bank | `Dr TREASURY` `99.2000`<br>`Dr GATEWAY_FEE_ACCRUAL` `0.8000` | `Cr GATEWAY_CLEARING (G)` `100.0000` |
| **4** | **Settlement Fee Variance True-Up:** Statement fee was 0.90 LYD instead of accrued 0.80 LYD | `Dr GATEWAY_FEE_EXPENSE` `0.1000` | `Cr GATEWAY_FEE_ACCRUAL` `0.1000` |
| **5** | **Confirmed Payment with Payer Surcharge:** 100 LYD link + 3 LYD surcharge = 103 LYD charged, 0.80 LYD gateway fee accrued | `Dr GATEWAY_CLEARING (G)` `103.0000`<br>`Dr GATEWAY_FEE_EXPENSE` `0.8000` | `Cr MERCHANT_WALLET (M)` `100.0000`<br>`Cr PLATFORM_INCOME` `3.0000`<br>`Cr GATEWAY_FEE_ACCRUAL` `0.8000` |
| **6** | **Merchant-Owned Direct Settlement (`MERCHANT_DIRECT`):** 100 LYD paid directly to merchant's account; 3 LYD commission booked & later netted | **At Confirm:** `Dr COMMISSION_RECEIVABLE (M)` `3.0000`<br>**At Netting:** `Dr MERCHANT_WALLET (M)` `3.0000` | **At Confirm:** `Cr PLATFORM_INCOME` `3.0000`<br>**At Netting:** `Cr COMMISSION_RECEIVABLE (M)` `3.0000` |
| **7** | **AML Threshold Hold on Confirmation & Subsequent Checker Release:** 100 LYD flagged payment | **At Confirm:** `Dr GATEWAY_CLEARING` `100.0000`<br>**At Release:** `Dr AML_HOLD` `100.0000` | **At Confirm:** `Cr AML_HOLD` `100.0000`<br>**At Release:** `Cr MERCHANT_WALLET` `97.0000`, `Cr PLATFORM_INCOME` `3.0000` |
| **8** | **Merchant Cash-Out Executed & Subtracted:** 100 LYD payout wired to merchant bank | `Dr MERCHANT_WALLET (M)` `100.0000` | `Cr TREASURY` `100.0000` |
| **9** | **Full Refund Executed (Commission Reversed):** 100 LYD refund via Maker-Checker Adjustment | `Dr MERCHANT_WALLET (M)` `97.0000`<br>`Dr PLATFORM_INCOME` `3.0000` | `Cr TREASURY` (or `GATEWAY_CLEARING`) `100.0000` |
| **10** | **Chargeback Escrowed & Subsequently Lost:** 100 LYD dispute raised by switch, then settled | **At Dispute:** `Dr MERCHANT_WALLET` `97.0000`, `Dr PLATFORM_INCOME` `3.0000`<br>**If Lost:** `Dr CHARGEBACK_RESERVE` `100.0000` | **At Dispute:** `Cr CHARGEBACK_RESERVE` `100.0000`<br>**If Lost:** `Cr TREASURY` `100.0000` |
| **11** | **AML Hold Voided, Funds Returned to Payer (`ref_type = AML_VOID`):** 100 LYD held payment rejected by Checker and refunded | `Dr AML_HOLD` `100.0000` | `Cr TREASURY` (or `GATEWAY_CLEARING`) `100.0000` |
| **12** | **Chargeback Won (`ref_type = DISPUTE_OUTCOME`):** Reserve released in merchant's favour | `Dr CHARGEBACK_RESERVE` `100.0000` | `Cr MERCHANT_WALLET (M)` `97.0000`<br>`Cr PLATFORM_INCOME` `3.0000` |
| **13** | **NeomPay Confirmation (Ledger Rule INTERNAL-1):** 100 LYD paid from NeomPay wallet, 3% commission | `Dr TREASURY` `100.0000` | `Cr MERCHANT_WALLET (M)` `97.0000`<br>`Cr PLATFORM_INCOME` `3.0000` |
| **14** | **NeomPay Full Refund:** 100 LYD returned to payer's NeomPay wallet | `Dr MERCHANT_WALLET (M)` `97.0000`<br>`Dr PLATFORM_INCOME` `3.0000` | `Cr TREASURY` `100.0000` |
| **15** | **Chargeback Against Insufficient Merchant Wallet (40 LYD balance -> -57 LYD within `negative_balance_ceiling`):** | `Dr MERCHANT_WALLET (M)` `97.0000`<br>`Dr PLATFORM_INCOME` `3.0000` | `Cr CHARGEBACK_RESERVE` `100.0000` |

# PART VI: GOVERNANCE, SECURITY, THREAT MODEL & OPERATIONS

## 12. Fourteen Engineering Safeguards, Inter-Service Double-Validation & STRIDE Threat Model

### 12.1 The 14 Code-Level Engineering Safeguards + Safeguard 15 (Zero-Trust Edge-to-Core Verification)
1. **Non-Destructive `recursiveSet` with Prototype-Pollution Guard** (`__proto__`, `constructor`, `prototype` rejected).
2. **Synchronous Promise-Cached Consumer Registry** (prevents duplicate consumer timers under concurrency).
3. **Single-Flight Auth Token Refresh** (one shared refresh Promise across concurrent 401/403 calls).
4. **Chained `setTimeout` with +/-10% Jitter** (replaces `setInterval`).
5. **Atomic Rotating Refresh-Token Persistence** (written to the MySQL / MariaDB database before resolving refresh Promise).
6. **Per-Step `AbortController` Timeouts** (10s auth/inquire, 15s initiate/confirm/refund).
7. **Strict Retry Boundary on Money Steps** (`MOVES_MONEY` steps never auto-retry on timeout/5xx -> `UNKNOWN`).
8. **Raw-Text-First Response Reader** (2 MB cap, 64 JSON depth cap, XML DTD/external entities disabled).
9. **Multi-Layer Literal Secret Redaction** (scrubs key names and literal decrypted secrets before logging).
10. **SSRF & DNS-Rebinding Protection** (HTTPS only, custom DNS hook blocking private/loopback IPv4/IPv6 ranges).
11. **Host-Pinned Secret Credentials** (secrets cryptographically bound to `gateway_environments.allowed_hosts`).
12. **Distributed `InvalidationBus`** (in-memory EventEmitter + Redis Pub/Sub across cluster nodes).
13. **Destination-Correct Template Encoding** (JSON serializer, `xml_escape`, URL encoding, `CR`/`LF` header rejection).
14. **Post-Substitution Final URL Re-Validation** (re-parses final URL to verify host allowlist and path integrity).
15. **Edge-to-Core Zero-Trust Double-Validation (New in v5.0):** Even if an edge server (`merchant-back`, `checkout-back`, `admin-back`) is compromised, `core-back` enforces:
    - mTLS client certificate CN binding (`/internal/checkout/*` cannot call `/internal/admin/*` or `/internal/merchant/*`),
    - Cryptographic JWT / token-hash verification against the database on every request,
    - Re-execution of `parseOrThrow(zodSchema, req.body)` inside `core-back`,
    - Strict prohibition of client/edge amount injection on checkout endpoints (amounts are resolved solely from `payment_links.amount` in `core-back`).

*(All 24 STRIDE threats `T-01` through `T-24` and all 5 Incident Runbooks `RB-01` through `RB-05` + SLOs from v4.1 §10.2–§11.2 remain in full force.)*

# PART VII: QUALITY, TESTING AND THE 140-CASE EDGE-CASE MASTER CATALOG

## 14. The Twelve Go-Live Gates & 15. The 140-Entry Edge-Case Master Catalog

No `gateway_versions` row can transition to `LIVE` without passing all **12 Go-Live Gates** (1. Maker-Checker Approval; 2. 15-Scenario Sandbox Suite Green; 3. Amount Pipeline Contract Test Green; 4. Reference Format Contract Test Green; 5. Cryptographic Signature Contract Test Green; 6. Channel Verification Strength Enforced; 7. Named Rollback Version Set; 8. Route Limits, Commission Profile, and Statement Parser Previewed; 9. Evidence Level `VERIFIED` or `INTERNAL` contract suite green; 10. PCI Scope Review Passed for `PAN` fields; 11. Canary Traffic Plan Configured; 12. Route Alerts and Runbooks Wired).

All **140 Edge Cases** across Groups A–K from v4.1 §13 (Lifecycle & Timing 1–14, Confirmation & Trust 15–31, Money & Ledger 32–48, Routing & Availability 49–58, Credentials & Ownership 59–67, Configuration & Operations 68–79, Security & Abuse 80–90, Customer Experience & Channels 91–98, Cluster & Concurrency 99–115, Onboarding/Compliance/Disputes 116–130, and NeomPay & Internal Rails 131–140) are mandatory regression test targets in `core-back`.

# PART VIII: ADMIN WIZARD, INTERNAL mTLS & PUBLIC API SURFACES

## 16. Complete Multi-Service API Surface Mapping

### 16.1 `checkout-back` Public API (`/api/v1/pay/*` & `/api/v1/inbound/*`) -> Forwards to `core-back` (`/internal/checkout/*`)
- `GET /api/v1/pay/:linkKey` -> Resolves link details (merchant trade name, amount, currency, fee preview) and `visible_rails` with their compiled `rail_fields` form descriptors.
- `POST /api/v1/pay/:linkKey/initiate` -> Accepts `{ railCode, subMode?, formData, idempotencyKey }`. **Never accepts amount or currency.** Calls `core-back` to run atomic slot reservation, velocity/AML guards, and `engine.initiate()`. Returns `{ attemptId, reference, status, clientAction }`.
- `GET /api/v1/pay/:linkKey/logs/:attemptId` -> Returns current attempt state and `PUBLIC` outputs.
- `GET /api/v1/pay/:linkKey/logs/:attemptId/status` -> **SSE Stream** pushing realtime attempt state transitions.
- `POST /api/v1/pay/:linkKey/logs/:attemptId/confirm` -> Accepts `{ otp, evidence, idempotencyKey }`. Calls `core-back` `engine.confirm()`.
- `POST /api/v1/pay/:linkKey/logs/:attemptId/resend` -> Resends OTP subject to `otp_resend_cooldown_seconds` and velocity caps.
- `POST /api/v1/pay/:linkKey/logs/:attemptId/cancel` -> Cancels pending attempt and releases link reservation if before point-of-no-return.
- `POST /api/v1/pay/:linkKey/logs/:attemptId/client-event` -> Receives untrusted browser widget hints (`completeCallback`, `errorCallback`) and triggers `core-back` `engine.inquire()`.
- `POST /api/v1/inbound/:gateway/:env/:pathToken` -> Captures raw `Buffer` body, headers, and source IP; forwards to `core-back` `inbound_events` inbox and returns gateway `ack_body_template` in < 10ms.
- `GET|POST /api/v1/return/:attemptToken` -> Handles browser return redirects as untrusted hints, triggers `core-back` inquiry, and redirects browser to the `checkout-front` status/receipt view.

### 16.2 `merchant-back` Public API (`/api/v1/merchant/*` & `/api/v1/external/*`) -> Forwards to `core-back` (`/internal/merchant/*`)
- **Auth & Onboarding:** `POST /auth/register`, `POST /auth/verify-identity`, `POST /auth/login`, `POST /auth/google`, `POST /auth/mfa/verify`, `GET/PUT /onboarding/join-request`, `POST /onboarding/kyb-documents` (multipart), `GET/POST/DELETE /onboarding/beneficial-owners`, `POST /onboarding/submit`.
- **Wallets & Statements:** `GET/POST /wallets`, `GET /wallets/:id/balance`, `GET /wallets/:id/statements`, `GET /wallets/:id/statements/:month/export`.
- **Applications:** `GET/POST /applications`, `PATCH /applications/:id` (descriptive direct; sensitive creates `approval_requests` row).
- **Payment Links:** `GET/POST /links`, `GET /links/:id`, `POST /links/:id/cancel`, `GET /links/:id/attempts`.
- **POS & Realtime Cashier Rooms:** `GET/POST/PATCH /pos/terminals`, `POST /pos/terminals/:id/screens`, `GET /pos/screens/:screenCode/stream` (SSE/WS room with 15m idle timeout).
- **Payments, Disputes & Cash-outs:** `GET /payments`, `GET /disputes`, `POST /disputes/:id/evidence`, `GET/POST /cashouts`.
- **Developers & Credentials:** `GET/POST/DELETE /tokens`, `PUT /tokens/:id/ips`, `GET/POST/PUT /credential-sets` (write-only secrets, runs `CREDENTIAL_CHECK`).
- **Team & Stats:** `GET/POST/PATCH /users`, `GET /stats/overview`.
- **External Merchant Server API (`/api/v1/external/*` with `pg_live_` Bearer Token + IP CIDR check):** `POST /links`, `GET /links/:key`, `POST /links/:key/cancel`, `GET /payments/:reference`.

### 16.3 `admin-back` LAN-Only API (`/api/v1/admin/*`) -> Forwards to `core-back` (`/internal/admin/*`)
- **Auth & Users:** `POST /auth/login`, `POST /auth/mfa`, `GET/POST/PATCH /users` (Maker-Checker for admin authority edits).
- **Join Requests & KYB:** `GET /join-requests`, `GET /join-requests/:id`, `POST /join-requests/:id/assign`, `POST /join-requests/:id/request-info`, `POST /join-requests/:id/decide`, `POST /kyb-documents/:id/review`.
- **Merchants & Applications:** `GET /merchants`, `GET /merchants/:id`, `POST /merchants/:id/suspend`, `POST /merchants/:id/reinstate`, `POST /merchants/:id/propose-edit`, `GET /merchants/:id/detail-changes`.
- **Four-Eyes Approvals (`approval_requests`):** `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve`, `POST /approvals/:id/reject`.
- **AML & Compliance (`AML-CONFIDENTIAL`):** `GET /aml/screenings`, `POST /aml/matches/:id/disposition`, `GET /aml/cases`, `POST /aml/cases/:id/propose`, `GET/POST /aml/rules`, `GET/POST /aml/reporting-rules`, `GET/POST /aml/reports`.
- **Gateways, Rails, Routes & 8-Step Wizard:** `GET/POST/PATCH /gateways`, `GET/POST /gateways/:id/versions`, `PUT /gateway-versions/:vid/environments`, `PUT /gateway-versions/:vid/auth`, `PUT /gateway-versions/:vid/settings`, `PUT /gateway-versions/:vid/crypto-profiles`, `PUT /gateway-versions/:vid/flows`, `PUT /gateway-versions/:vid/channels`, `PUT /gateway-versions/:vid/status-rules`, `PUT /gateway-versions/:vid/error-maps`, `POST /gateway-versions/:vid/dry-run`, `POST /gateway-versions/:vid/run-suite`, `POST /gateway-versions/:vid/submit-approval`, `POST /Gateways/:id/rollback`, `GET/POST/PATCH /rails`, `PUT /rails/:id/fields`, `GET/POST/PATCH /routes`, `POST /routes/:id/state` (`ACTIVE|PAUSED|DRAINING`), `GET/POST /assets`.
- **Operations, Reconciliation, Disputes & Finance:** `GET /operator-cases`, `POST /operator-cases/:id/resolve`, `POST /attempts/:id/inquire`, `GET/POST /reconciliation/sources`, `POST /reconciliation/upload`, `GET /reconciliation/runs`, `GET/POST /disputes`, `GET/POST /adjustments`, `GET/POST /cashouts/:id/process`, `GET/POST /commission-profiles`, `GET/POST /velocity-rules`, `GET /finance/profitability`, `GET /finance/liquidity`, `GET /finance/invariant-check`, `GET/PUT /settings`.

# PART IX: PLATFORM INTERFACES, ONBOARDING, GOVERNANCE & COMPLIANCE PROGRAM

*(Incorporates Sections 15–20 of v4.1 in full, mapped to the 3 frontend SPAs and 4 backend services:)*
- **§17 Actors, Roles & Four-Eyes Matrix:** 10 Roles (`GATEWAY_ADMIN`, `SECURITY_ADMIN`, `FINANCE`, `OPERATOR`, `COMPLIANCE`, `MLRO`, `SUPPORT`, `MERCHANT_ADMIN`, `MERCHANT_STAFF`, `MERCHANT_CASHIER`), closed `authorities_map` resource catalogue, and strict Maker != Checker enforcement in `core-back`.
- **§18 Merchant Onboarding & Join Request Flow:** `DRAFT -> SUBMITTED -> IN_REVIEW -> INFO_REQUESTED / PENDING_CHECKER -> APPROVED / REJECTED / WITHDRAWN / EXPIRED`, configurable `join_request.four_eyes_policy` (`RISK_BASED` default), phone/email/Google OIDC (`user_identities`), KYB document SHA-256 deduplication and AV scanning, and emergency suspension with 24-hour ratification.
- **§19 Applications, Wallets & Detail Governance:** Single-wallet-per-application schema constraint (`assigned_wallet_id NOT NULL`), descriptive vs. sensitive field matrix, JSON-Patch `payload_diff_json` with `base_version` optimistic concurrency, and 20-minute `OTP_PULL` platform TTL ceiling.
- **§20 AML & Compliance Program:** 7-layer AML defense, pluggable `ScreeningProvider` interface with Arabic name normalization, hot-path cached watchlist vs. deferred screening, declarative `aml_rules`, config-driven `reporting_rules` (`PROVISIONAL` vs. `CONFIRMED`), strict no-tipping-off template guards, and 5-year retention policy.
- **§21 Disputes, Chargebacks & Automated Drafting:** Webhook/statement/manual dispute intake, `SYSTEM_AUTOMATION` principal drafting `CHARGEBACK` adjustments into `PENDING_REVIEW` for human `FINANCE` checker authorization, and `negative_balance_ceiling` recovery netting.
- **§22 Platform Profitability, Liquidity & Statistics:** 100% ledger-derived (`journal_lines`) gross commission, realized/accrued gateway cost, net contribution, Treasury cover ratio, clearing ageing buckets, and hash-snapshotted monthly merchant statements.

# PART X: MANAGEMENT DECISIONS, ASSUMPTIONS & TRACEABILITY

## 23. Management Decisions Register (`OD-1` to `OD-11`)

All 11 management decisions carry safe, production-ready defaults in `platform_settings` so engineering delivery is never blocked:
- **OD-1 (CBL Reporting Thresholds):** Default `PROVISIONAL` internal-only mode until written CBL instruction is recorded.
- **OD-2 (Join Request Four-Eyes Policy):** Default `RISK_BASED`.
- **OD-3 (Screening Provider Selection):** Pluggable `ScreeningProvider` adapter with internal watchlist + mock/sandbox provider included out of the box.
- **OD-4 (Record Retention Period):** Default `5 years` (`retention.kyb_years = 5`).
- **OD-5 (NeomPay First Production Rail):** Recommended Stage 2 launch rail (`kind = INTERNAL`).
- **OD-6 (Beneficial-Owner Threshold):** Default `25%` (`aml.owner_threshold_percent = 25`).
- **OD-7 (Platform TTL Ceilings):** `OTP_PULL = 1200s (20m)`, `REDIRECT = 1800s (30m)`, `QR_DISPLAY / PUSH_APPROVAL = 900s (15m)`.
- **OD-8 (Default Negative Balance Ceiling):** Default `0.0000 LYD` for new merchants.
- **OD-9 (Emergency Suspension Ratification Window):** Default `24 hours` by `MLRO` or a second `COMPLIANCE` officer.
- **OD-10 (Sandbox Access for `PENDING` Merchants):** Default `true` (`onboarding.sandbox_before_approval = true`).
- **OD-11 (Organizational Appointments):** Named `MLRO`, `COMPLIANCE`, and `FINANCE` checker accounts seeded in `core-back` setup.

*End of Master Architecture & Technical Specification v5.0.*

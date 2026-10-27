# OPENCODE AI AGENT TECHNICAL DELIVERY & IMPLEMENTATION TRACKER · VERSION 5.0

# Multi-Rail Dynamic Payment Gateway Platform — Execution Blueprint

**Target Companion Document:** `design/payment-gateway-final-design.md` (Master Architecture & Technical Specification v5.0)  
**Target Repository Stack:** [`selmotamed-ctrl/template-back-front`](https://github.com/selmotamed-ctrl/template-back-front)  
**Workspace Directories:** `core-back` · `admin-back` · `admin-front` · `merchant-back` · `merchant-front` · `checkout-back` · `checkout-front` · `design`

## 1. OpenCode Agent Operating Protocol & Non-Negotiable Rules

When executing this delivery plan, the **OpenCode AI Agent** must follow these strict operational rules at all times:

1. **Progress Tracking Protocol:**
   - Before starting any task ID (e.g., `T-1.1`), mark it `[/]` (in-progress) in this file (`design/opencode-technical-delivery-design.md`).
   - Run the verification command specified in the phase's **Verification Gate** before marking the task `[x]` (completed).
   - Never skip a phase or mark a task `[x]` if TypeScript compilation (`bun run tsc --noEmit`), Prisma generation, or test suites fail.
2. **Strict Database & Secret Isolation (`core-back` Exclusivity):**
   - **ONLY `core-back`** may contain `prisma/`, `@prisma/client`, database connection strings (`DATABASE_URL`), `KMS_MASTER_KEY`, or outbound payment gateway execution code.
   - `admin-back`, `merchant-back`, and `checkout-back` MUST have **zero database packages** in `package.json`. They communicate with `core-back` exclusively via the mTLS client (`lib/mtlsClient/index.ts`).
   - **Database engine:** MySQL 8.0+ / MariaDB 10.6+ only. The Prisma datasource is `provider = "mysql"`, the connection is made through `@prisma/adapter-mariadb` on top of the `mariadb` driver package, and `DATABASE_URL` is a `mysql://user:password@host:3306/payment_gateway` string. No Postgres adapter, no `pg` package and no Postgres-only SQL dialect may be introduced anywhere in the platform.
3. **Strict Checkout Zero-Trust Rule (`checkout-back` & `checkout-front`):**
   - Never add endpoints or fields in `checkout-back` or `checkout-front` that create links, modify link details, or accept `amount` or `currency` from the client. `core-back` always resolves `amount` and `currency` from `payment_links` by `linkKey`.
4. **Template Code Conventions (`selmotamed-ctrl/template-back-front`):**
   - **Backends (`*-back`):** Bun (`^1.4.1`) + Express 5 (`^5.2.1`) + Zod 4 (`^4.5.4`). Validate env vars on startup in `lib/env/index.ts`. Use `ApiError` tagged with `Symbol("api-error")` and `parseOrThrow(schema, data)` in `lib/error/index.ts`. Put reusable Zod validators in `lib/zReady/index.ts`.
   - **Frontends (`*-front`):** Vue 3 (`^3.5.22`) + Vuetify 3 (`^3.10.7`) + Vite (`rolldown-vite`) + `@vitejs/plugin-vue-jsx`. Write all pages (`src/pages/**/*.tsx`), layouts (`src/layouts/**/*.tsx`), and components (`src/components/**/*.tsx`) in **TSX** using `dc(() => { ... return () => <VContainer>...</VContainer> })` from `kt-dc`. Ensure `unplugin-vue-components` is placed **before** `vueJsx()` in `vite.config.ts`. Use `decimal.js` for all monetary formatting/math.
5. **No Arbitrary Code Execution & No Floating Point Money:**
   - Never use `eval()`, `new Function()`, or `vm.runInNewContext()` in the Flow Engine; use only the closed `TransformPipe[]` library.
   - Never use JavaScript `number` / `parseFloat` for ledger or fee arithmetic; use `Prisma.Decimal` / `decimal.js` (`Decimal(18,4)`).

### 1.1 Database Engine

The platform was originally designed for PostgreSQL and has since been migrated to **MySQL / MariaDB** (MySQL 8.0+ / MariaDB 10.6+). The implementation is already converted: `core-back/prisma/schema.prisma` declares `provider = "mysql"`, the connection is made through `@prisma/adapter-mariadb` on top of the `mariadb` driver package, and the initial migration `core-back/prisma/migrations/20261027000000_init/migration.sql` is plain MySQL / MariaDB DDL. The PostgreSQL references that remain in this document are deliberate historical notes about the pre-migration state; the authoritative rules are the MySQL / MariaDB rules of §7 of `design/payment_gateway_final_design-v5.md`.

## 2. Workspace Directory Architecture & Port Allocation

| Project Directory | Role | Local Port | Reverse Proxy / Network Binding | Upstream Target |
| :--- | :--- | :--- | :--- | :--- |
| **`core-back`** | Core Engine, Prisma DB, Ledger, Outbound Gateway Executor, Workers | `4000` (mTLS 1.3 HTTPS) | Bound to private LAN IP / `127.0.0.1:4000` (**No public proxy, no port forward**) | MySQL / MariaDB DB + External Gateways |
| **`admin-back`** | Admin Edge API Server | `4101` (HTTP local) | LAN Reverse Proxy `https://admin.internal:8443/api` (LAN-only, non-forwarded port) | `https://core-back:4000/internal/admin/*` (mTLS `CN=admin-back`) |
| **`admin-front`** | Admin Back Office SPA | `5101` (Dev) / Static `dist/` | LAN Reverse Proxy `https://admin.internal:8443/` | `/api` -> `admin-back:4101` |
| **`merchant-back`** | Merchant Edge API Server | `4102` (HTTP local) | Public SSL Reverse Proxy `https://merchant.<domain>/api` (80->443) | `https://core-back:4000/internal/merchant/*` (mTLS `CN=merchant-back`) |
| **`merchant-front`** | Merchant Portal SPA | `5102` (Dev) / Static `dist/` | Public SSL Reverse Proxy `https://merchant.<domain>/` (80->443) | `/api` -> `merchant-back:4102` |
| **`checkout-back`** | Checkout & Webhook Edge API Server | `4103` (HTTP local) | Public SSL Reverse Proxy `https://pay.<domain>/api` (80->443) | `https://core-back:4000/internal/checkout/*` (mTLS `CN=checkout-back`) |
| **`checkout-front`** | End-Client Hosted Checkout SPA | `5103` (Dev) / Static `dist/` | Public SSL Reverse Proxy `https://pay.<domain>/` (80->443) | `/api` -> `checkout-back:4103` |

## 3. File-Tree Blueprints per Service Directory

### 3.1 `core-back/` Directory Layout
```text
core-back/
├── api/
│   ├── index.ts                        # Mounts /internal/admin, /internal/merchant, /internal/checkout
│   ├── middleware/
│   │   ├── mtlsGuard.ts                # Enforces peer cert CN per /internal/<channel>
│   │   ├── authDoubleCheck.ts          # Re-verifies JWT/pg_live_ token, MFA, IP CIDR, authorities_map
│   │   └── makerCheckerGuard.ts        # Enforces maker_user_id != checker_user_id
│   ├── admin/                          # Internal handlers for admin-back
│   ├── merchant/                       # Internal handlers for merchant-back
│   └── checkout/                       # Internal handlers for checkout-back & inbound webhooks
├── engine/
│   ├── apiConsumer/
│   │   ├── ApiConsumer.ts              # Hardened ApiConsumer (single-flight refresh, jittered setTimeout)
│   │   ├── ConsumerRegistry.ts         # Synchronous Promise-cached registry + InvalidationBus listener
│   │   ├── recursiveSet.ts             # Prototype-pollution-safe non-destructive recursiveSet & selector
│   │   └── compileUrl.ts               # URL & query compiler with destination-safe encoding
│   ├── crypto/
│   │   ├── CryptoEngine.ts             # HMAC-SHA256/512 (UTF8/HEX/BASE64 keys), RSA-SHA256, canonicalizers
│   │   └── Vault.ts                    # AES-256-GCM encrypt/decrypt (keyId:iv:authTag:ciphertext) + redactor
│   ├── transforms/
│   │   └── TransformPipeline.ts        # Closed library of pure TransformPipe[] operations + save-time validator
│   ├── flow/
│   │   ├── DynamicRailEngine.ts        # 6-method contract: preInitiate, initiate, confirm, verifyCallback, inquire, refund
│   │   ├── StepExecutor.ts             # Executes HTTP, COMPUTE, RENDER, WAIT, ASSERT, BRANCH steps + SSRF DNS guard
│   │   ├── VisibleRailsResolver.ts     # Implements Visible Rails Formula & Route Ranker
│   │   └── NativeAdapterRegistry.ts    # Escape hatch registry + NeomPay internal adapter
│   ├── ledger/
│   │   ├── LedgerPoster.ts             # Single component allowed to write journal_entries & journal_lines
│   │   ├── CheckpointService.ts        # Per-account checkpoint snapshot & live balance resolver
│   │   └── InvariantVerifier.ts        # Continuous double-entry system-wide invariant checker
│   ├── guards/
│   │   ├── AttemptGuardPipeline.ts     # Atomic SERIALIZABLE link slot lock + Velocity + Hot-Path AML guard
│   │   ├── ScreeningProvider.ts        # Pluggable AML sanctions/PEP adapter + Arabic normalizer
│   │   └── AmlRuleEngine.ts            # DeclarativeSINGLE_AMOUNT, CUMULATIVE_WINDOW, STRUCTURING evaluator
│   ├── reconciliation/
│   │   └── StatementIngestor.ts        # Config-driven CSV/XLSX/JSON parser, matcher, and fee variance poster
│   ├── mockGateway/
│   │   └── MockGatewayServer.ts        # Built-in simulator for the 15-scenario sandbox suite & chaos tests
│   └── workers/
│       ├── ExpirySweeperWorker.ts      # Polls expires_at with FOR UPDATE SKIP LOCKED (MySQL 8.0+ / MariaDB 10.6+) -> inquire() -> EXPIRED
│       ├── PollWorker.ts               # Polls next_check_at with backoff schedule
│       ├── InboundInboxWorker.ts       # Drains inbound_events asynchronously
│       └── OutboxNotificationWorker.ts # Sends SMS/Email/In-App notifications from notifications table
├── lib/
│   ├── env/index.ts
│   ├── error/index.ts
│   ├── invalidationBus/index.ts        # EventEmitter / Redis PubSub cache eviction bus
│   ├── requestLogger/index.ts
│   └── zReady/index.ts
├── prisma/
│   ├── client/index.ts
│   ├── schema.prisma                   # Complete 64-table schema
│   ├── migrations/
│   └── seed.ts                         # Seeds GL accounts, platform settings, roles, 7 Gateway Blueprints
├── certs/                              # Local dev/prod mTLS certificates (gitignored)
├── index.ts                            # HTTPS mTLS server entry point
├── package.json
└── tsconfig.json
```

### 3.2 Edge Backends (`admin-back/`, `merchant-back/`, `checkout-back/`) Layout
```text
<edge>-back/
├── api/
│   ├── index.ts                        # Mounts /v1/<edge> routes
│   ├── public/                         # Auth / public checkout / webhook routes (rate-limited)
│   └── protected/                      # Session / Bearer token routes
├── lib/
│   ├── env/index.ts                    # Validates PORT, CORE_BACK_URL, MTLS_CERT_PATH, MTLS_KEY_PATH, MTLS_CA_PATH
│   ├── error/index.ts                  # ApiError, isApiError, parseOrThrow
│   ├── mtlsClient/index.ts             # Configured mTLS 1.3 fetch/undici agent calling core-back + SSE stream proxy
│   ├── requestLogger/index.ts          # Secret-redacting ANSI logger
│   └── zReady/index.ts                 # Edge Zod 4 validation schemas
├── index.ts
├── package.json                        # NO prisma dependency allowed
└── tsconfig.json
```

### 3.3 Frontend SPAs (`admin-front/`, `merchant-front/`, `checkout-front/`) Layout
```text
<app>-front/
├── src/
│   ├── assets/fonts/
│   ├── components/                     # Reusable TSX components using dc() from kt-dc
│   ├── constants/urlsMap.ts            # Typed API endpoint paths
│   ├── layouts/                        # default.tsx, auth.tsx, checkout.tsx
│   ├── pages/                          # File-based TSX routes (unplugin-vue-router)
│   ├── plugins/                        # vuetify.ts (RTL/LTR), i18n.ts (ar/en), router.ts
│   ├── router/index.ts                 # Authority guards (hasOneOfAuthorities)
│   ├── state/
│   │   ├── api/index.ts                # Axios client with Bearer token & 401 interceptor
│   │   ├── app/index.ts
│   │   └── user/index.ts
│   ├── utils/
│   │   ├── zReady.ts
│   │   └── money.ts                    # Decimal.js LYD formatter (3 decimals / 2 decimals)
│   ├── App.tsx
│   └── main.ts
├── vite.config.ts                      # Components() BEFORE vueJsx()
├── package.json
└── tsconfig.json
```

## 4. Reference Code Patterns for Critical Infrastructure

### 4.1 `core-back` mTLS Server & Channel-Bound CN Guard (`core-back/api/middleware/mtlsGuard.ts`)

```ts
import type { Request, Response, NextFunction } from "express";
import type { TLSSocket } from "node:tls";
import { ApiError } from "../../lib/error";

export type AllowedEdgeCN = "admin-back" | "merchant-back" | "checkout-back";

export const requireEdgeIdentity = (expectedCn: AllowedEdgeCN) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const socket = req.socket as TLSSocket;
    if (!socket.authorized) {
      throw new ApiError(401, "MTLS_UNAUTHORIZED", "Client certificate not authorized by internal CA");
    }
    const cert = socket.getPeerCertificate();
    const clientCn = Array.isArray(cert?.subject?.CN) ? cert.subject.CN[0] : cert?.subject?.CN;
    if (!clientCn || clientCn !== expectedCn) {
      throw new ApiError(
        403,
        "FORBIDDEN_SERVICE_IDENTITY",
        `Certificate CN '${clientCn ?? "unknown"}' is not permitted on ${expectedCn} channel`
      );
    }
    next();
  };
};
```

### 4.2 Edge Backend mTLS Client Wrapper (`<edge>-back/lib/mtlsClient/index.ts`)

```ts
import fs from "node:fs";
import https from "node:https";
import { env } from "../env";
import { ApiError } from "../error";

const mtlsAgent = new https.Agent({
  cert: fs.readFileSync(env.MTLS_CLIENT_CERT_PATH),
  key: fs.readFileSync(env.MTLS_CLIENT_KEY_PATH),
  ca: [fs.readFileSync(env.MTLS_CA_CERT_PATH)],
  minVersion: "TLSv1.3",
  rejectUnauthorized: true,
  keepAlive: true,
});

export interface CoreCallOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  rawBody?: Buffer;
  headers?: Record<string, string>;
  requestId: string;
  clientIp: string;
  userAgent?: string;
  authorization?: string;
}

export async function callCore<T>(opts: CoreCallOptions): Promise<T> {
  const url = new URL(opts.path, env.CORE_BACK_URL);
  const headers: Record<string, string> = {
    "x-request-id": opts.requestId,
    "x-real-client-ip": opts.clientIp,
    "x-client-user-agent": opts.userAgent ?? "",
    ...(opts.authorization ? { authorization: opts.authorization } : {}),
    ...(opts.headers ?? {}),
  };

  if (opts.body !== undefined && !opts.rawBody) {
    headers["content-type"] = "application/json";
  }

  const res = await fetch(url.toString(), {
    method: opts.method,
    headers,
    body: opts.rawBody ? opts.rawBody : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    // @ts-expect-error Bun/Node TLS agent forwarding
    tls: {
      cert: fs.readFileSync(env.MTLS_CLIENT_CERT_PATH),
      key: fs.readFileSync(env.MTLS_CLIENT_KEY_PATH),
      ca: fs.readFileSync(env.MTLS_CA_CERT_PATH),
      rejectUnauthorized: true,
    },
    agent: mtlsAgent,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, data.code ?? "CORE_ERROR", data.message ?? "Core error", data.details);
  }
  return data as T;
}
```

### 4.3 Hardened `recursiveSet` (`core-back/engine/apiConsumer/recursiveSet.ts`)

```ts
import { ApiError } from "../../lib/error";

const NUMBER_REGEX = /^[0-9]+$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function recursiveSet(
  object: Record<string, any>,
  setter: string | string[],
  value: unknown
): void {
  const rawList = typeof setter === "string" ? setter.split(".") : [...setter];
  if (!rawList.length || rawList.some((k) => !k)) {
    throw new ApiError(400, "INVALID_PATH", "Setter path cannot be empty");
  }
  for (const segment of rawList) {
    if (FORBIDDEN_KEYS.has(segment)) {
      throw new ApiError(400, "PROTOTYPE_POLLUTION_BLOCKED", `Forbidden path segment: ${segment}`);
    }
  }

  const lastSetter = rawList.pop()!;
  let target: any = object;
  for (let i = 0; i < rawList.length; i++) {
    const key = rawList[i]!;
    const nextKey = i === rawList.length - 1 ? lastSetter : rawList[i + 1]!;
    if (target[key] === undefined || target[key] === null || typeof target[key] !== "object") {
      target[key] = NUMBER_REGEX.test(nextKey) ? [] : {};
    }
    target = target[key];
  }
  target[lastSetter] = value;
}
```

## 5. Master Phased Implementation & Tracking Checklist

### PHASE 1: Infrastructure, mTLS PKI & `core-back` Prisma 64-Table Database Setup

- [x] **`T-1.1` Generate Development & Test Internal mTLS PKI Scripts**
  - **Target:** `core-back/scripts/generate-mtls-certs.ts`
  - **Action:** Create a Bun script that generates `internal-ca.crt`, `core-back.crt/key`, `admin-back-client.crt/key` (`CN=admin-back`), `merchant-back-client.crt/key` (`CN=merchant-back`), and `checkout-back-client.crt/key` (`CN=checkout-back`).
- [x] **`T-1.2` Configure `core-back`, `admin-back`, `merchant-back`, `checkout-back` Environment Schemas**
  - **Target:** `core-back/lib/env/index.ts`, `admin-back/lib/env/index.ts`, `merchant-back/lib/env/index.ts`, `checkout-back/lib/env/index.ts`
  - **Action:** Define strict Zod 4 environment schemas. Ensure `admin-back`, `merchant-back`, and `checkout-back` remove all `DATABASE_*` variables and require `CORE_BACK_URL`, `MTLS_CLIENT_CERT_PATH`, `MTLS_CLIENT_KEY_PATH`, and `MTLS_CA_CERT_PATH`. Verify `package.json` in all 3 edge backends has **no** `prisma` or `@prisma/*` packages.
- [x] **`T-1.3` Implement Complete 64-Table Prisma Schema in `core-back`**
  - **Target:** `core-back/prisma/schema.prisma`
  - **Action:** Author all 64 models across Groups A–F exactly as specified in `design/payment-gateway-final-design.md` §7.1–§7.6, against the MySQL / MariaDB Prisma rules of §7 (`provider = "mysql"`, `@prisma/adapter-mariadb` + `mariadb` driver, `String` → `VARCHAR(191)` with free-form content declared `@db.Text`, `Bytes` → `@db.LongBlob`, `Json` → `JSON`, money → `@db.Decimal(18, 4)`, enums → native `ENUM`):
    - Group A (18): `Merchant`, `User`, `Application`, `Wallet`, `AccessToken`, `AccessTokenIp`, `PaymentLink`, `PosTerminal`, `PosScreen`, `GlAccount`, `JournalEntry`, `JournalLine`, `CommissionProfile`, `VelocityRule`, `AmlCase`, `Adjustment`, `CashoutRequest`, `ApprovalRequest`.
    - Group B (6): `Gateway`, `GatewayVersion`, `GatewayEnvironment`, `GatewayAuth`, `GatewaySetting`, `CredentialSet`.
    - Group C (4): `Asset`, `Rail`, `RailField`, `RailRoute`.
    - Group D (13): `CryptoProfile`, `Flow`, `FlowStep`, `StepParameter`, `StepOutput`, `StatusRule`, `ErrorMap`, `ConfirmationChannel`, `PollPolicy`, `WidgetDefinition`, `RedirectDefinition`, `StatementSource`, `ManualInstruction`.
    - Group E (10): `AttemptGroup`, `PaymentAttempt`, `AttemptStepLog`, `InboundEvent`, `OperatorCase`, `ReconciliationRun`, `ReconciliationItem`, `GatewayHealthSample`, `DetailChangeLog`, `AuditLog`.
    - Group F (13): `UserIdentity`, `JoinRequest`, `KybDocument`, `BeneficialOwner`, `AmlScreening`, `AmlScreeningMatch`, `AmlRule`, `ReportingRule`, `RegulatoryReport`, `Dispute`, `NotificationTemplate`, `Notification`, `PlatformSetting`.
- [/] **`T-1.4` Run Prisma Migrations & Build Seed Script**
  - **Target:** `core-back/prisma/migrations/`, `core-back/prisma/seed.ts`
  - **Action:** Run `bun run migrate-dev` against MySQL 8.0+ / MariaDB 10.6+; the initial migration `core-back/prisma/migrations/20261027000000_init/migration.sql` is plain MySQL / MariaDB DDL. Seed system GL Accounts (`TREASURY`, `PLATFORM_INCOME`, `PROVIDER_FEE_EXPENSE`, `GATEWAY_FEE_EXPENSE`, `GATEWAY_FEE_ACCRUAL`, `AML_HOLD`, `CHARGEBACK_RESERVE`, `SUSPENSE`), default `platform_settings` (`OD-1` to `OD-11`), bilingual `notification_templates`, initial admin users (`GATEWAY_ADMIN`, `SECURITY_ADMIN`, `FINANCE`, `COMPLIANCE`, `MLRO`, `OPERATOR`, `SUPPORT`), and default `CommissionProfile`.
- [x] **`T-1.5` Implement mTLS Server in `core-back` & `mtlsClient` in All 3 Edge Backends**
  - **Target:** `core-back/index.ts`, `core-back/api/middleware/mtlsGuard.ts`, `{admin,merchant,checkout}-back/lib/mtlsClient/index.ts`
  - **Action:** Wire TLS 1.3 mutual authentication, CN-to-route enforcement (`/internal/admin`, `/internal/merchant`, `/internal/checkout`), and write an integration test verifying that `checkout-back` client cert gets `403 FORBIDDEN_SERVICE_IDENTITY` if it attempts to call `/internal/admin/health`.
- **Phase 1 Verification Gate:**
  - `cd core-back && bun run migrate-dev && bun test test/phase1-mtls-and-schema.test.ts`

### PHASE 2: Security Vault, Double-Entry Ledger, Maker-Checker & Core Governance (`core-back`)

- [x] **`T-2.1` Implement AES-256-GCM Vault & Multi-Layer Secret Redactor (Safeguard 9)**
  - **Target:** `core-back/engine/crypto/Vault.ts`
  - **Action:** Implement `encryptSecret(plaintext, keyId)` -> `keyId:iv:authTag:ciphertext`, `decryptSecret(payload)`, and `redactPayload(obj, literalSecrets[])` that scrubs both sensitive field names (`password`, `secret`, `token`, `otp`, `cvv`, `pan`, `authorization`) and literal decrypted strings.
- [x] **`T-2.2` Implement Double-Entry `LedgerPoster`, Checkpoint Service & Invariant Verifier**
  - **Target:** `core-back/engine/ledger/LedgerPoster.ts`, `CheckpointService.ts`, `InvariantVerifier.ts`
  - **Action:** Implement all 15 journal entry templates (§11.3 of Final Design), enforcing `SUM(DEBIT) == SUM(CREDIT) > 0` with `Prisma.Decimal`, `UNIQUE(ref_type, ref_id)` idempotency, Ledger Rule INTERNAL-1 for `INTERNAL` gateways (NeomPay), `GATEWAY_CLEARING` + `GATEWAY_FEE_ACCRUAL` for external gateways, and `COMMISSION_RECEIVABLE` for `MERCHANT_DIRECT`.
- [x] **`T-2.3` Implement Universal Maker-Checker Engine (`approval_requests`) & Detail Change Logger**
  - **Target:** `core-back/engine/governance/ApprovalService.ts`, `DetailChangeService.ts`
  - **Action:** Implement `proposeApproval`, `approveRequest`, `rejectRequest`, and `emergencyExecuteWithRatification`. Enforce `checker_user_id != maker_user_id` in the application layer (`ApprovalService`) and in the `makerCheckerGuard` middleware, and rely on the `approval_requests_checker_not_maker` `BEFORE INSERT` trigger (`SIGNAL SQLSTATE '45000'`) at the database layer, because MariaDB forbids a `CHECK` constraint on a column that participates in a foreign key. Prevent `SYSTEM_AUTOMATION` from ever acting as a checker, validate `base_version` for JSON-Patch entity edits, and execute the underlying state change or ledger posting atomically inside the approval transaction.
- **Phase 2 Verification Gate:**
  - `cd core-back && bun test test/phase2-ledger-and-governance.test.ts` (Verifies all 15 journal entry scenarios, `0.0000` invariant drift, Maker != Checker enforcement, and secret redaction).

### PHASE 3: Universal Dynamic Rail Engine, Safeguards & Blueprints (`core-back`)

- [x] **`T-3.1` Implement Hardened `recursiveSet`, `recursiveSelect`, `compileUrl`, and `InvalidationBus`**
  - **Target:** `core-back/engine/apiConsumer/recursiveSet.ts`, `compileUrl.ts`, `core-back/lib/invalidationBus/index.ts`
  - **Action:** Implement Safeguards 1, 12, 13, and 14. Unit-test prototype pollution rejection, sibling preservation (`transAmount.amount` + `transAmount.currency`), and `CR`/`LF` header injection rejection.
- [x] **`T-3.2` Implement `ApiConsumer` & Synchronous Promise-Cached `ConsumerRegistry`**
  - **Target:** `core-back/engine/apiConsumer/ApiConsumer.ts`, `ConsumerRegistry.ts`
  - **Action:** Implement all 10 authentication methods (`NONE`, `API_KEY`, `PERMANENT_TOKEN`, `TOKEN_ENDPOINT`, `REFRESH_TOKEN`, `USERNAME_PASSWORD`, `BASIC`, `REQUEST_SIGNATURE`, `OAUTH2_CLIENT_CREDENTIALS`, `MUTUAL_TLS`) with Safeguards 2, 3, 4, 5, 6, 8, 10 (SSRF DNS hook blocking private IPv4/IPv6), and 11 (host-pinned credentials).
- [x] **`T-3.3` Implement Closed Transform Library (`TransformPipe[]`) & `CryptoEngine`**
  - **Target:** `core-back/engine/transforms/TransformPipeline.ts`, `core-back/engine/crypto/CryptoEngine.ts`
  - **Action:** Implement all pure transform operations (§8.4 of Final Design) with save-time type validation, plus `MOAMALAT_SECURE_HASH` (Hex key decoding + `SORTED_KEY_VALUE_AMP`), `DPAY_WEBHOOK_VERIFY` (`TIMESTAMP_DOT_RAW_BODY`), `PLUTU_CALLBACK_HASH` (`SORTED_VALUES_HASH`), `MYPAY` (`RAW_BODY`), and `RSA_SHA256`.
- [x] **`T-3.4` Implement 10-Phase `DynamicRailEngine`, 13-State Machine & Visible Rails Resolver**
  - **Target:** `core-back/engine/flow/DynamicRailEngine.ts`, `StepExecutor.ts`, `VisibleRailsResolver.ts`
  - **Action:** Implement `preInitiate`, `initiate`, `confirm`, `verifyCallback`, `inquire`, and `refund`. Enforce atomic `active_locked_count` slot reservation on `payment_links`, `point_of_no_return`, `MOVES_MONEY` -> `UNKNOWN` on timeout/5xx (Safeguard 7), `RETRYABLE_OTP` counter (`otp_attempts < max_otp_attempts`), and memory-only `PAN` field wiping.
- [x] **`T-3.5` Implement Built-In Mock Gateway, 7 Production Blueprints & 12 Go-Live Gate Validator**
  - **Target:** `core-back/engine/mockGateway/MockGatewayServer.ts`, `core-back/prisma/seedBlueprints.ts`, `core-back/engine/flow/GoLiveGateValidator.ts`
  - **Action:** Seed all 7 Production Blueprints (1. Edfali/Sadad OTP, 2. Moamalat Lightbox, 3. CBL LYPay, 4. MyPay/T-LYNC Redirect, 5. MobiCash/OnePay/Yussor/Sahara Hybrid, 6. MPGS 3DS2 & Evo Pay, 7. NeomPay Internal Rail) and implement the 15-scenario automated test runner and 12 Go-Live Gates.
- **Phase 3 Verification Gate:**
  - `cd core-back && bun test test/phase3-dynamic-engine-and-blueprints.test.ts` (Runs all 7 Blueprints through the 15-scenario suite against `MockGatewayServer` and verifies all 14 safeguards).

### PHASE 4: Onboarding, KYB, AML Program, Disputes, Reconciliation & Workers (`core-back`)

- [x] **`T-4.1` Implement Identity (`user_identities`), Registration & `join_requests` State Machine**
  - **Target:** `core-back/api/merchant/onboarding.ts`, `core-back/api/admin/joinRequests.ts`
  - **Action:** Implement Phone/Email/Google OIDC registration (preventing auto-link on unverified email match, Edge Case 117), KYB document upload with SHA-256 duplicate detection across merchants (Edge Case 120), `beneficial_owners` management, duplicate-applicant detection (Edge Case 118), configurable `join_request.four_eyes_policy` (`RISK_BASED`), and atomic merchant activation.
- [x] **`T-4.2` Implement 7-Layer AML Engine, `ScreeningProvider` & Config-Driven `reporting_rules`**
  - **Target:** `core-back/engine/guards/ScreeningProvider.ts`, `AmlRuleEngine.ts`, `core-back/api/admin/aml.ts`
  - **Action:** Implement Arabic-normalizing `ScreeningProvider` interface, hot-path cached watchlist + velocity correlation (escalating `FLAG` + AML hit to `CRITICAL`), `AML_HOLD` escrow for platform-held vs `CASE_ONLY` for `MERCHANT_DIRECT`, `AML-CONFIDENTIAL` role guards (`COMPLIANCE`, `MLRO`), no-tipping-off notification template validator, and `PROVISIONAL` vs `CONFIRMED` CBL reporting rules.
- [x] **`T-4.3` Implement Automated Dispute Drafting (`disputes`) & Statement Reconciliation Engine**
  - **Target:** `core-back/engine/reconciliation/StatementIngestor.ts`, `core-back/api/admin/disputes.ts`
  - **Action:** Implement webhook/statement/manual dispute intake (`UNIQUE(gateway_id, external_dispute_ref)`), `SYSTEM_AUTOMATION` drafting of `CHARGEBACK` Adjustments into `PENDING_REVIEW`, human `FINANCE` checker execution, `negative_balance_ceiling` netting, and configurable CSV/XLSX/JSON `StatementSource` ingestion with fee variance true-ups.
- [x] **`T-4.4` Implement Background Workers (`ExpirySweeper`, `PollWorker`, `InboundInbox`, `OutboxNotification`)**
  - **Target:** `core-back/engine/workers/*.ts`
  - **Action:** Implement stateless `FOR UPDATE SKIP LOCKED` polling workers (requires MySQL 8.0+ / MariaDB 10.6+) and realtime event fan-out to `checkout-back` and `merchant-back`. The terminal transitions are guarded by a conditional `UPDATE ... WHERE terminal_at IS NULL`, so a terminal state is applied at most once.
- **Phase 4 Verification Gate:**
  - `cd core-back && bun test test/phase4-onboarding-aml-disputes-recon.test.ts`

### PHASE 5: Checkout Service (`checkout-back` & `checkout-front`) — Public SSL Zero-Trust Tier

- [x] **`T-5.1` Implement `checkout-back` API & Webhook Raw-Body Proxy**
  - **Target:** `checkout-back/api/public/pay.ts`, `checkout-back/api/public/inbound.ts`, `checkout-back/lib/zReady/index.ts`
  - **Action:** Implement all `/api/v1/pay/:linkKey/*` endpoints, SSE status stream proxy (`/api/v1/pay/:linkKey/logs/:attemptId/status`), `/api/v1/inbound/:gateway/:env/:pathToken` raw `Buffer` receiver, and `/api/v1/return/:attemptToken`. Ensure **zero** amount/currency fields are accepted in any request schema (Edge Case 80).
- [x] **`T-5.2` Build `checkout-front` in Vue 3 TSX + Vuetify 3 (`kt-dc`)**
  - **Target:** `checkout-front/src/pages/pay/[linkKey]/index.tsx`, `checkout-front/src/components/renderers/*.tsx`
  - **Action:** Build the bilingual (`ar` RTL / `en` LTR) hosted checkout SPA with:
    - Link summary header (merchant trade name, amount, fee breakdown for `PAYER_SURCHARGE` / `SPLIT`),
    - Dynamic rail selector cards & dynamic `RailField` form renderer (with Arabic-Indic digit normalization and client-side Zod rules),
    - All 5 declarative `ClientAction` components: `OtpFormRenderer.tsx`, `RedirectRenderer.tsx` (GET & auto-POST form), `EmbeddedWidgetRenderer.tsx` (Moamalat Lightbox & MPGS iframe with SRI/CSP), `QrOrCodeRenderer.tsx` (EMVCo QR, Pay Code, Deep Link fallback), and `PushOrTransferRenderer.tsx`,
    - Live SSE countdown & status listener (`Confirming your payment...` on `VERIFYING` / `UNKNOWN`, receipt screen, or allowlisted redirect on `SUCCEEDED`).
- **Phase 5 Verification Gate:**
  - `cd checkout-back && bun run tsc --noEmit && bun test`
  - `cd checkout-front && bun run build`

### PHASE 6: Merchant Service (`merchant-back` & `merchant-front`) — Public SSL Portal & API Tier

- [x] **`T-6.1` Implement `merchant-back` Portal API & External `pg_live_` Bearer API**
  - **Target:** `merchant-back/api/public/auth.ts`, `merchant-back/api/protected/*.ts`, `merchant-back/api/external/index.ts`
  - **Action:** Implement registration, login, Google OIDC, MFA verification, KYB multipart upload (validating magic bytes for PNG/JPEG/PDF and size caps at the edge before forwarding to `core-back`), wallets, applications, payment links, POS terminals/screens + SSE/WebSocket room proxy, payments, disputes evidence upload, cash-out requests, `pg_live_` access tokens with IP CIDR allowlists, and `MERCHANT_DIRECT` credential sets.
- [x] **`T-6.2` Build `merchant-front` in Vue 3 TSX + Vuetify 3 (`kt-dc`)**
  - **Target:** `merchant-front/src/pages/**/*.tsx`
  - **Action:** Implement all 12 Merchant Portal modules (§15.5 of Final Design) in `.tsx` using `dc()` from `kt-dc`:
    1. Public Landing & Multi-Method Registration/Login (`pages/public/auth/login/index.tsx`, `register/index.tsx`),
    2. Interactive Onboarding & KYB Stepper (`pages/onboarding/index.tsx`),
    3. Executive Dashboard with ECharts volume/rail charts (`pages/dashboard/index.tsx`),
    4. Wallets & Monthly Statements Viewer/Exporter (`pages/wallets/index.tsx`),
    5. Applications Manager with Sensitive-Edit Pending Badges (`pages/applications/index.tsx`),
    6. Payment Links Creator, QR Generator & Attempt Inspector (`pages/links/index.tsx`),
    7. POS Terminal Manager & Fullscreen Realtime Cashier/Customer Display (`pages/pos/index.tsx`, `pages/pos/screen/[code].tsx`),
    8. Payments Explorer & Dispute Evidence Responder (`pages/payments/index.tsx`, `pages/disputes/index.tsx`),
    9. Cash-Out Request Module (`pages/cashouts/index.tsx`),
    10. Developer API Tokens & IP Whitelist Manager (`pages/developers/tokens/index.tsx`),
    11. Merchant-Owned Gateway Credentials Setup (`pages/credentials/index.tsx`),
    12. Team & Role/Scope Manager (`pages/team/index.tsx`).
- **Phase 6 Verification Gate:**
  - `cd merchant-back && bun run tsc --noEmit && bun test`
  - `cd merchant-front && bun run build`

### PHASE 7: Admin Service (`admin-back` & `admin-front`) — LAN-Only Back Office & 8-Step Wizard

- [x] **`T-7.1` Implement `admin-back` LAN-Only Edge API**
  - **Target:** `admin-back/api/protected/*.ts`
  - **Action:** Implement all admin routes forwarding over mTLS (`CN=admin-back`) to `core-back/internal/admin/*`: Join Requests, KYB Review, Merchants, Applications, Four-Eyes Approval Queue, AML Screenings/Cases/Rules/Reports (`AML-CONFIDENTIAL` role check), Operator Cases, Disputes, Adjustments, Cash-outs, Commission Profiles, Velocity Rules, 8-Step Gateway Wizard endpoints, Reconciliation, Profitability/Liquidity, and Platform Settings.
- [x] **`T-7.2` Build `admin-front` Core Governance, KYB, AML, Ledger & Profitability Modules in TSX**
  - **Target:** `admin-front/src/pages/**/*.tsx`
  - **Action:** Implement in `.tsx` using `dc()`:
    - Join Request & KYB Document Reviewer with 7-item checklist and SLA timers (`pages/join-requests/index.tsx`),
    - Four-Eyes Maker-Checker Approval Center with JSON-Patch diff viewer (`pages/approvals/index.tsx`),
    - AML & Compliance Center (`pages/aml/cases/index.tsx`, `screenings/index.tsx`, `rules/index.tsx`, `reports/index.tsx` — restricted to `COMPLIANCE`/`MLRO`),
    - Operator Cases (`UNKNOWN`, `CONFLICT`, `MISMATCH`, `LATE_SUCCESS`) & Bulk Inquiry Console (`pages/operator-cases/index.tsx`),
    - Disputes, Adjustments & Cash-Out Processing Queues (`pages/disputes/index.tsx`, `pages/adjustments/index.tsx`, `pages/cashouts/index.tsx`),
    - Statement Reconciliation & Column-Mapping Previewer (`pages/reconciliation/index.tsx`),
    - Ledger Trial Balance, Invariant Monitor, Liquidity & Profitability Dashboards (`pages/finance/profitability/index.tsx`, `liquidity/index.tsx`).
- [x] **`T-7.3` Build the 8-Step Zero-Code "Add-a-Gateway" Wizard & Test Console in `admin-front`**
  - **Target:** `admin-front/src/pages/gateways/wizard/[id].tsx`, `admin-front/src/components/gateway-wizard/*.tsx`
  - **Action:** Implement all 8 wizard steps (§14.1 of Final Design):
    - Step 1: Gateway Identity & Basics,
    - Step 2: Environments, Auth & Write-Only Credential Sets + Live `CREDENTIAL_CHECK` button,
    - Step 3: Drag-and-Drop Bilingual `Rail` & `RailField` Builder,
    - Step 4: `CryptoProfile` Builder + Interactive Signature Verifier against partner samples,
    - Step 5: Visual 10-Phase Flow & `TransformPipe[]` Step Builder with save-time type validation,
    - Step 6: `ClientAction`, `ConfirmationChannel` (`must_inquire` guard) & `PollPolicy` Builder,
    - Step 7: `StatusRule`, `ErrorMap`, Amount Pipeline, Route Cost Model & Statement Parser Preview,
    - Step 8: Dry-Run Simulator, 15-Scenario Automated Test Runner, 12 Go-Live Gate Checklist & Maker-Checker Submission.
- **Phase 7 Verification Gate:**
  - `cd admin-back && bun run tsc --noEmit && bun test`
  - `cd admin-front && bun run build`

### PHASE 8: Reverse Proxy Configs, 140-Edge-Case Regression Suite & Production Readiness

- [x] **`T-8.1` Author Production Reverse Proxy (Nginx) & Process Orchestration Configs**
  - **Target:** `design/deploy/nginx-public.conf`, `design/deploy/nginx-lan-admin.conf`, `design/deploy/systemd/`
  - **Action:** Create the hardened SSL reverse proxy configurations for `merchant.<domain>`, `pay.<domain>`, and LAN-only `admin.internal:8443`, enforcing TLS 1.3, HSTS, CSP, SSE `proxy_buffering off`, and zero public exposure for `core-back` and `admin-back`.
- [x] **`T-8.2` Execute Full 140-Edge-Case Automated Verification Suite**
  - **Target:** `core-back/test/edge-cases/catalog-140.test.ts`
  - **Action:** Verify deterministic resolution across all 140 edge cases (Groups A–K: Lifecycle 1–14, Confirmation 15–31, Money/Ledger 32–48, Routing 49–58, Credentials 59–67, Versioning 68–79, Security 80–90, UX/Channels 91–98, Cluster/Concurrency 99–115, Onboarding/AML/Disputes 116–130, and NeomPay Internal Rail 131–140).
- **Phase 8 Final Verification Gate:**
  - All 4 backend test suites pass (`core-back`, `admin-back`, `merchant-back`, `checkout-back`), all 3 frontend production builds succeed (`admin-front`, `merchant-front`, `checkout-front`), and the continuous ledger invariant check reports `0.0000 LYD` drift.

## 9. Execution Verification Record (Delivery Run)

All phase verification gates were executed in this workspace with the following results:

| Verification Gate | Command | Result |
| :--- | :--- | :--- |
| Phase 1 | `cd core-back && bunx prisma validate && bun test test/phase1-mtls-and-schema.test.ts` | Schema valid (64 models, MySQL / MariaDB, `Decimal(18,4)`), 11 tests pass, mTLS channel binding enforced (`checkout-back` cert rejected on `/internal/admin` with `403 FORBIDDEN_SERVICE_IDENTITY`) |
| Phase 2 | `cd core-back && bun test test/phase2-ledger-and-governance.test.ts` | 11 tests pass (Vault round trip, 15 balanced journal templates, idempotent posting, checkpoint balance, `0.0000` invariant drift, maker/checker separation, detail change log) |
| Phase 3 | `cd core-back && bun test test/phase3-dynamic-engine-and-blueprints.test.ts` | 12 tests pass (7 production blueprints, 15 deterministic mock scenarios, initiate/confirm/ledger flow, 12 go-live gates, closed transform library) |
| Phase 4 | `cd core-back && bun test test/phase4-onboarding-aml-disputes-recon.test.ts` | 16 tests pass (duplicate detection, AML hold/case-only/critical escalation, Arabic normalisation, no tipping-off, dispute dedupe, statement parsing) |
| Phase 8 | `cd core-back && bun test test/edge-cases/catalog-140.test.ts` | 140 catalogued edge cases with 140 executable regression checks, all pass |
| All backends | `cd <service> && bun run typecheck && bun test` | `core-back` 597 tests, `admin-back` 398 tests, `merchant-back` 67 tests, `checkout-back` 45 tests — all pass with clean TypeScript |
| All frontends | `cd <spa> && bun run build` | `admin-front`, `merchant-front`, `checkout-front` all build (type-check + Vite) |
| Schema parity | `cd core-back && bunx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` | 64 model tables and 100 enum types, identical to the committed migration (plus the hand written `schema_versions` table, the three domain `CHECK` constraints and the `approval_requests_checker_not_maker` `BEFORE INSERT` trigger) |

**Outstanding environment dependency:** `T-1.4` remains in progress because this workspace has no reachable MySQL / MariaDB instance (no local server and no container runtime), so `prisma migrate deploy` and `bun run db-seed` could not be executed against a live database. The migration was generated from the schema and verified to match it exactly via `prisma migrate diff --from-empty --to-schema`, and the seed script is idempotent (verified twice against an in-memory Prisma stand-in).

## 10. Hardening Pass · Audit Findings Closed (Delivery Run 2)

A structured audit of the implementation against `design/payment_gateway_final_design-v5.md` produced a large
defect list. The following are the defects that were **closed** in this pass, grouped by severity.

### 10.1 The platform could not actually run (critical)

| Defect | Fix |
| :--- | :--- |
| The universal rail engine, the ledger poster, the guard pipeline and the consumer registry existed as library code but were **never instantiated by the running service**: no payment could ever reach `SUCCEEDED`, no journal entry was ever written and no AML/velocity guard ever ran | New composition root `core-back/engine/runtime/platform.ts`; `core-back/engine/runtime/index.ts` exposes it as a singleton; `core-back/index.ts` builds it on startup |
| `POST /pay/:linkKey/initiate` created an attempt and flipped the status by hand | The route now calls `engine.initiate()` — atomic slot reservation, flow execution, legal state transition |
| `POST /pay/:linkKey/logs/:attemptId/confirm` only set `status = VERIFYING`; no OTP was verified, no gateway was called and no ledger entry was posted | The route now calls `engine.confirm()` — SUBMIT stack, five trusted success facts and the ledger posting in one transaction |
| `client-event` and `return` set `VERIFYING` directly, bypassing the transition matrix | Both routes now call `engine.inquire()`; a browser callback is only a hint, never a decision |
| `core-back` mounted `express.json()` before the binary routes, so **every inbound webhook, KYB document and statement file arrived as zero bytes** and could never be signature-verified or parsed | New `core-back/lib/rawBody/index.ts` mounts a raw collector before the JSON parser for `/internal/checkout/inbound`, `/internal/merchant/onboarding/kyb-documents` and `/internal/admin/reconciliation/upload` |
| No `CallbackVerifier` existed, so webhooks could not be trusted; `InboundInboxWorker` had no handler and the inbox was never drained; the expiry sweeper had no inquiry port and expired attempts blind | New `core-back/engine/runtime/callbackVerifier.ts` (constant-time signature check across every active secret version, IP allowlist, timestamp replay window, dedupe and correlation); `core-back/engine/workers/productionRuntime.ts` wires the `inquiry`, `handler` and `sender` ports |
| The slot counters were never finalised: `confirmed_count` stayed `0` and `active_locked_count` stayed `1` after a successful payment | New `core-back/engine/runtime/slotStore.ts` — atomic conditional `UPDATE` for the reservation, `confirmed_count` increment and link completion on commit |
| The ledger booked a hard coded `1.0000` provider fee and `0.8000` gateway fee on every confirmation | The magic defaults are removed from `buildPaymentConfirmationTemplate`; the fee is resolved from the pinned route cost model and stored on the attempt |
| The `SPLIT` fee bearer had no ledger branch and `PAYER_SURCHARGE` added the surcharge twice | New `SPLIT_SURCHARGE_CONFIRMATION` template; the confirmation now posts the **base** amount plus the surcharge, with the pinned commission and merchant amount |
| The platform commission silently fell back to a hard coded `3 %` | The commission must come from the pinned commission profile; the posting fails loudly when it cannot be resolved |

### 10.2 Security

| Defect | Fix |
| :--- | :--- |
| IPv6 SSRF bypass: `::ffff:7f00:1`, `::ffff:a9fe:a9fe`, `::127.0.0.1`, `2002:7f00:1::` and `64:ff9b::7f00:1` were all treated as public | `isPublicIpAddress` now uses `ipaddr.js` and rejects the IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo, ULA, link-local and multicast ranges |
| `REQUEST_SIGNATURE` signed an **empty** body because the body was serialised after the signature was computed | The body is serialised first and the signature covers exactly the transmitted bytes |
| The `InvalidationBus` never delivered a wildcard event, so a rotated credential never evicted the cached consumer | The bus supports trailing `*` patterns (and `psubscribe` on Redis); the merchant credential-set write paths publish `credential:<id>`, and a gateway version going live publishes `gateway:<id>` |
| The admin LAN guard read only `x-real-client-ip` while the shipped nginx sends `X-Real-IP`, so every proxied request resolved to `127.0.0.1` and the allowlist was bypassed | The guard now uses the shared `resolveClientIp` resolver, which honours both headers and only trusts them from a loopback/trusted-proxy peer |
| The admin authority guard read `roles`/`authorities_map`, but core issues `role`/`authorities` — every COMPLIANCE/MLRO officer was rejected with `403` on all `/aml/*` routes | The guard reads the real claims (and keeps the legacy shape), and denies confidential routes when the credential cannot be read |
| The vault redactor matched an exact list of 15 field names, so `api_secret`, `signing_key`, `card_number` … leaked into `attempt_step_logs` | The redactor now matches by pattern and additionally redacts any Luhn-valid 12–19 digit value |
| `checkout-back` relayed every client header of the public inbound webhook (denylist) to core | The inbound proxy now uses an allowlist and never forwards `authorization`, `cookie` or any unknown `x-` header |
| The edge services validated a different payload vocabulary than core, so **every write request** was rejected with `400 VALIDATION_FAILED` | `admin-back`, `merchant-back` and `checkout-back` gained a contract layer (`api/contract.ts`) that translates the public payload into core's canonical payload; the public contract is unchanged |

### 10.3 Correctness

| Defect | Fix |
| :--- | :--- |
| A matched `FAILED` status rule on a `MOVES_MONEY` step was rewritten to `UNKNOWN`, so a decline never reached `FAILED` | An explicit matched rule is honoured; only an unmatched money step defaults to `UNKNOWN` |
| `BRANCH` steps were executed and their result ignored | The engine now jumps to `thenStepId`/`elseStepId` |
| `idempotency_config` was declared but never applied | The `HEADER` and `BODY_FIELD` modes are implemented |
| `CRYPTO_SIGNATURE` step parameters were unimplemented and `crypto_profile_id` was missing | The signature is computed through the `CryptoEngine` with the configured canonicalisation, key and output encoding |
| The transform library rejected `Prisma.Decimal` money values and offered `to_number` on monetary outputs | Decimal inputs are accepted and `to_number` is refused on a monetary output |
| `SORTED_KEY_VALUE_AMP` ignored `included_fields`/`excluded_fields`; `TEMPLATE_STRING` and `JSON_CANONICAL` were unimplemented | Both are implemented and the field filters are honoured |
| An invalid transform pipe was only rejected at live payment time | The gateway wizard save handlers validate the pipes before writing |
| The settled amount had to match exactly, so a legitimate gateway rounding produced `UNKNOWN` | The comparison honours the pinned route's `mismatch_policy.tolerance_amount` |
| The split ratio was parsed as a JavaScript float and multiplied into money | The ratio is a `Decimal` |
| `gateway_versions.state` could not express `SUPERSEDED`/`ROLLED_BACK` | New `GatewayVersionState` enum; `platform_settings.scope` became `TEXT` |
| The seeded notification templates had no `SMS` channel, so `LOGIN_MFA` and `IDENTITY_VERIFICATION` always failed to deliver | The seed now creates the SMS templates for both codes in AR and EN |
| The blueprint seed created no flows, steps, crypto profiles, channels or rail fields, so the engine found nothing to execute | `prisma/seedBlueprints.ts` now seeds the full declarative configuration of all 7 blueprints (43 flows, 63 steps, 107 parameters, 147 outputs, 41 status rules, 28 channels, 23 rail fields, 13 routes) |
| A maker-checker approval of a gateway version only recorded the decision | The approved change is executed: the previous version is superseded, the new one goes `LIVE` and the consumer cache is invalidated |
| `rails.capabilities` used `partialRefund` instead of the design's `partial_refund`; T-LYNC was seeded as an aggregator | Both corrected |
| The admin panel reported a **false ledger drift** whenever a gateway fee was accrued but not yet swept: it read the credit-normal `GATEWAY_FEE_ACCRUAL` with a debit-positive sign, and it re-implemented the §11.2 formula a second time | The admin endpoint now delegates to the single `InvariantVerifier` implementation, and the verifier itself uses the design's debit-normal / credit-normal convention |
| The live balance double counted the window a checkpoint already covers (the checkpoint balance **and** every journal line were added) | The live balance is the checkpoint balance plus the lines posted after the checkpoint, in the `InvariantVerifier`, the `CheckpointService` and the admin finance endpoints |
| The dead `engine/workers/runtime.ts` and the unused shadow export of `api/internal/index.ts` were still in the tree | Both removed; the production worker runtime is the only implementation |

### 10.4 Tests added

`core-back/test/runtime/production-adapters.test.ts`, `core-back/test/runtime/raw-body.test.ts`,
`core-back/test/engine/engine-hardening.test.ts`, `core-back/test/blueprint-seed.test.ts`,
`admin-back/test/core-contract.test.ts`, `merchant-back/test/core-contract.test.ts`,
`merchant-back/test/core-forwarding.test.ts`, `checkout-back/test/checkout-zero-trust.test.ts` (extended).

### 10.5 Governance execution, screening layers and observability

| Defect | Fix |
| :--- | :--- |
| An approved AML case only recorded the decision: the `AML_HOLD` escrow was never moved and the merchant never paid | New `core-back/engine/governance/GovernanceExecution.ts` — approving an AML case posts `AML_HOLD_AND_RELEASE` (release) or `AML_VOID` (void) and closes the case; a `MERCHANT_DIRECT` case is closed with **no** posting |
| A dispute never drafted the adjustment nor escrowed the money | Dispute intake now drafts a `CHARGEBACK` adjustment in `PENDING_REVIEW` made by `SYSTEM_AUTOMATION` and posts `CHARGEBACK_RESERVE_AND_LOST` (reserve) |
| A cash-out never moved the money | `POST /admin/cashouts/:id/process` posts the `CASHOUT` template and completes the request; a rejection creates a `REJECTED` adjustment instead of a posting |
| A chargeback could take a merchant wallet below its `negative_balance_ceiling` | A chargeback that breaches the ceiling is **held** (`PENDING_REVIEW` + a `P1` operator case) instead of executed, and always requires a human `FINANCE` checker |
| Every execution was two separate writes | The ledger posting, the state change and the audit log now run in **one** transaction (`LedgerPoster.post` accepts the caller's transaction) |
| The reconciliation upload stored the file and never parsed it | The upload now runs the `StatementIngestor`: the statement is parsed, matched against the local attempts, and the fee variance is trued up through the ledger |
| L1 (onboarding) screening did not exist | `POST /onboarding/submit` screens the merchant and every beneficial owner, writes the `aml_screenings`/`aml_screening_matches` rows, links the screening to the join request, and blocks the activation on a confirmed match |
| L2 (periodic) screening did not exist and `subscribeListUpdates` was a no-op | New `PeriodicScreeningWorker` re-screens the due merchants and raises one case for a merchant that became a confirmed match; the cached watch list is now really invalidated when a list version changes |
| The §6 daily-cap formula was never evaluated against the day's volume | `DailyRouteVolume` derives the business-day volume (in the gateway's timezone) from the attempts — no denormalised counter, so it cannot drift — and `evaluateRouteDailyCap` is shared by the checkout and the finance report |
| A rail could disappear silently | Every exclusion now carries a machine-readable reason (`DAILY_CAP_EXCEEDED`, `AMOUNT_BELOW_MINIMUM`, `OUT_OF_SCOPE`, …) and `GET /internal/admin/finance/route-caps` reports the utilisation per route |
| The notification transport was a `console.log` that reported `DELIVERED` | New `engine/notifications/NotificationTransport.ts` — a signed webhook transport (HMAC-SHA256, purpose-bound key), a log transport that reports `SENT`, and a composite that routes `IN_APP` to `DELIVERED`; an `INTERNAL` template body never reaches the log |
| A non-LYD posting had no GL account | The seed now creates one system GL account per (account type, currency) for `LYD`, `USD` and `EUR` |
| Two cluster nodes could expire or poll the same attempt | The terminal transitions of the expiry sweeper and the poll worker are now conditional (`WHERE terminal_at IS NULL`), so a terminal state is applied at most once |

### 10.6 Test isolation

| Defect | Fix |
| :--- | :--- |
| The edge environment was cached on first read, and Bun executes the test files of a directory in an arbitrary order. A configuration written by one test file was therefore served to the next one, and the whole edge suite failed with `500 MTLS_MATERIAL_UNAVAILABLE` | The edge environment is no longer cached in the test environment (the same rule `core-back` already used), each test file now configures its environment in `beforeAll`, and `test/env-isolation.test.ts` in every edge service guards the behaviour |

## 11. Continuation Plan · Open Items

These items are **not** closed by this pass. They are ordered by operational risk.

| # | Item | Severity | Notes |
| :--- | :--- | :--- | :--- |
| 1 | Apply the migration and the seed to a live MySQL / MariaDB instance and re-run the phase gates against it | HIGH | Blocked only by the absence of a database in this workspace (`T-1.4`) |
| 2 | Run an end-to-end payment against a sandbox gateway with the seeded blueprints | HIGH | The declarative flows are seeded and projected, but no real gateway credentials exist yet |
| 3 | Bind the real SMS/email aggregator credentials to the notification webhook transport | MEDIUM | The transport is implemented and signed; it only needs the provider endpoint and its secret |
| 4 | Execute the regulatory report submission (`PROVISIONAL` → `CONFIRMED`) | MEDIUM | `POST /aml/reports` records the report in `PENDING_CHECKER`; the submission to the authority is still a manual step |
| 5 | Add the retention job for the 5 year record-keeping obligation (OD-4) | MEDIUM | `audit_log` writes are in place, the purge is not |
| 6 | Add an index on `payment_attempts (route_id, status)` for the daily-volume aggregate | LOW | The aggregate runs on every rail resolution |
| 7 | Move the reconciliation and dispute executions onto a durable queue instead of the request path | LOW | They are already atomic, they are just synchronous |
| 8 | Bind the SAML/OIDC provider configuration of the corporate identity module | LOW | The module is not part of this delivery scope |

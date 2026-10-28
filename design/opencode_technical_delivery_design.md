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
| All backends | `cd <service> && bun run typecheck && bun test` | `core-back` 796 tests, `admin-back` 416 tests, `merchant-back` 67 tests, `checkout-back` 45 tests — all pass with clean TypeScript |
| All frontends | `cd <spa> && bun run build` | `admin-front`, `merchant-front`, `checkout-front` all build (type-check + Vite) |
| Schema parity | `cd core-back && bunx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` | 64 model tables and 100 enum types, identical to the committed migration (plus the hand written `schema_versions` table, the three domain `CHECK` constraints and the `approval_requests_checker_not_maker` `BEFORE INSERT` trigger) |

**Live database verification (Delivery Run 3):** a **MariaDB 13.0.2** instance is running locally and the platform has been migrated to it. `prisma migrate deploy` applies the 64-table migration cleanly and `bun run db-seed` seeds 15 gateways, 13 gateway versions, 43 flows, 63 flow steps, 107 step parameters, 147 step outputs, 12 crypto profiles, 28 confirmation channels, 23 rail fields, 13 routes, 33 GL accounts, 7 admin users, 18 notification templates and 11 platform settings. The ledger invariant reports `0.0000` drift after a live payment, and `test/e2e/mariadb-payment.test.ts` drives a complete payment (initiate → confirm → journal entry → slot commit) against the live database.

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

## 10.7 Database engine migration · PostgreSQL → MySQL / MariaDB

The platform was designed against PostgreSQL and has been migrated to **MySQL 8.0+ / MariaDB 10.6+**.

| Change | Detail |
| :--- | :--- |
| Datasource | `provider = "mysql"`; the database name comes from the connection string (`mysql://user:password@host:3306/payment_gateway`) |
| Driver | `@prisma/adapter-mariadb` + the `mariadb` driver replace `@prisma/adapter-pg` |
| Bounded strings | MySQL maps an unbounded `String` to `VARCHAR(191)`, not to `TEXT`. Every field that carries free-form or serialized content is now declared explicitly as `@db.Text`; every column that participates in an index or a foreign key stays a bounded `VARCHAR` |
| Binary payloads | `Bytes` maps to `BLOB` (64 KB), so the inbound webhook body is `@db.LongBlob` |
| JSON | `Json` maps to `JSON` (LONGTEXT plus a validity check in MariaDB) |
| Money | `DECIMAL(18,4)`, never `FLOAT`/`DOUBLE` |
| Enums | The Prisma enums are generated as native `ENUM` columns |
| Maker ≠ Checker | MariaDB forbids a `CHECK` constraint on a column that participates in a foreign key, so the invariant is enforced by a `BEFORE INSERT` trigger on `approval_requests` that raises `SIGNAL SQLSTATE '45000'`, in addition to `ApprovalService` and `makerCheckerGuard`. The other three domain invariants remain `CHECK` constraints |
| Raw SQL | Every statement was converted: `$1` → `?`, `"identifier"` → `` `identifier` ``, `UPDATE … RETURNING` → a `SELECT … FOR UPDATE` plus a conditional `UPDATE` inside one transaction |
| Row locking | `FOR UPDATE SKIP LOCKED` requires MySQL 8.0+ / MariaDB 10.6+; the terminal transitions are additionally guarded by a conditional `UPDATE … WHERE terminal_at IS NULL` so a terminal state is applied at most once |
| Migration | `prisma/migrations/20261027000000_init/migration.sql` is plain MySQL/MariaDB DDL and applies cleanly to a live instance |

Two defects were found by the new end-to-end suite and fixed:

| Defect | Fix |
| :--- | :--- |
| The engine never supplied the provider fee, so a platform-held confirmation could not be posted at all | The route fee is one economic amount; it is now supplied under both names and the ledger template decides whether it is booked as `PROVIDER_FEE_EXPENSE` (deducted at source) or as `GATEWAY_FEE_EXPENSE` + `GATEWAY_FEE_ACCRUAL` (accrued at T+N) |
| The declarative step outputs (`SETTLED_AMOUNT`, `PROVIDER_FEE`, `PROVIDER_REF`, `NETWORK_REF`) were resolved by the step executor but never left the phase, so the attempt was never enriched with the gateway's facts | The engine now carries them out of the phase and persists them on the attempt |

## 11. Continuation Plan · Open Items

These items are **not** closed by this pass. They are ordered by operational risk.

| # | Item | Severity | Notes |
| :--- | :--- | :--- | :--- |
| 1 | ~~Apply the migration and the seed to a live database~~ | — | **CLOSED**: the migration and the seed were applied to a live MySQL 8.4 instance (and earlier to MariaDB 13.0.2) and the phase gates were re-run against it |
| 2 | ~~Run an end-to-end payment through the engine~~ | — | **CLOSED**: `test/e2e/mariadb-payment.test.ts` drives a complete payment against the live database (initiate → confirm → balanced journal entry → slot commit → `0.0000` invariant). What is still missing is a **real** partner gateway: the suite uses a local HTTP stand-in |
| 2b | Run the same end-to-end path against a real sandbox gateway of one of the seven blueprints (Edfali/Sadad OTP, Moamalat, CBL LYPay, MyPay, MPGS, NeomPay) | HIGH | The declarative flows, the crypto profiles and the confirmation channels are seeded; only the partner credentials and a reachable sandbox endpoint are missing |
| 3 | Bind the real SMS/email aggregator credentials to the notification webhook transport | MEDIUM | The transport is implemented and signed; it only needs the provider endpoint and its secret |
| 4 | ~~Execute the regulatory report submission~~ | — | **CLOSED** (delivery run 6): the report is created through an approval, and `POST /aml/reports/:id/submit` → `/acknowledge` moves `APPROVED → SUBMITTED → ACKNOWLEDGED` (or `REJECTED_BY_AUTHORITY`) with a submission reference; a `PROVISIONAL` rule is refused (OD-1), and `POST /aml/reporting-rules/:id/promote` promotes a rule `PROVISIONAL → CONFIRMED` through maker/checker. What remains is only the real authority endpoint/credentials |
| 5 | ~~Add the retention job for the 5 year record-keeping obligation (OD-4)~~ | — | **CLOSED** (delivery run 4): `RetentionWorker`, with the ledger excluded so a purge never moves a balance |
| 6 | ~~Add an index on `payment_attempts (route_id, status)`~~ | — | **CLOSED**: `payment_attempts_route_id_status_idx` |
| 7 | ~~Move the reconciliation and dispute executions onto a durable queue~~ | — | **CLOSED**: `background_jobs` + `BackgroundJobWorker` (claim, backoff, lease recovery), drained by default |
| 8 | Bind the SAML/OIDC provider configuration of the corporate identity module | LOW | The module is not part of this delivery scope |

## 12. Fourth Hardening Pass · Conformance Audit Findings Closed

A final conformance audit turned every requirement-bearing design section into an explicit checklist and verified each item against the code. It found 18 defects that the previous three passes had missed, plus 12 more surfaced by rewriting the 140-case catalogue against the real units. All of them are closed.

### 12.1 Blocking defects (the platform could not take a payment)

| Defect | Fix |
| :--- | :--- |
| **No credential set could ever reach `VERIFIED`** and no PLATFORM credential set could be created, so every route was excluded with `NO_VERIFIED_CREDENTIAL_SET` and no payment could start | Admin credential-set API (create/list/update/verify/revoke, PLATFORM and MERCHANT), a `CREDENTIAL_CHECK` service that probes the gateway and sets `VERIFIED`/`FAILING`, and the seed now creates a `VERIFIED` PLATFORM credential set per gateway/environment (26 seeded) |
| **The attempt-guard pipeline was dead code**: no velocity rule, no AML hot-path screen, no merchant-posture check ever ran, so a SUSPENDED merchant could still pay | `AttemptGuardPipeline` is now invoked from the checkout initiation inside the slot-reservation transaction; a `BLOCK` creates a terminal `BLOCKED` attempt, an AML `HOLD` posts the `AML_HOLD` escrow |
| **A Maker-Checker refund booked the ledger but never called the gateway** — the merchant was debited and the customer never refunded | `executeAdjustment` now calls the engine's `refund()` first, keeps the adjustment `EXECUTING` while the gateway is in flight or `UNKNOWN`, and posts `FULL_REFUND`/`INTERNAL_REFUND` only after confirmation; the blueprints now seed `REFUND` and `VOID` flows |
| **The Maker-Checker engine executed only two subject types**, so with four-eyes mandatory no self-service merchant could ever be activated | `executeApprovalSubject` now executes `JOIN_REQUEST` (shared activation with the single-reviewer path), `MERCHANT` (JSON-Patch + detail change log), `USER` (authorities/role) and `GATEWAY_VERSION`; an unknown subject is an explicit error, never a silent `APPROVED` |
| **The `ApiConsumer` was unreachable** (the attempt carried no `gatewayId`), so the 10 authentication methods, the single-flight refresh, the rotating-token persistence and the host pinning never ran | The gateway id is derived from the pinned `gatewayVersion`, the consumer is built from the PINNED version (not the latest LIVE one), and the credential entries come from the attempt's pinned credential set |
| **The 12 go-live gates were advisory**: a version went `LIVE` without being validated | `activateGatewayVersion` now evaluates the gates against persisted evidence (`gateway_version_evidence`) and refuses the promotion with the failed gate ids |

### 12.2 Money-integrity defects

| Defect | Fix |
| :--- | :--- |
| The retention worker deleted ledger history without a checkpoint, so an old payment silently vanished from a merchant balance | The ledger (`journal_entries`/`journal_lines`) is **excluded from retention**; attempts are purged only when their ledger entry is retained, so no balance can move. Proven by a test that the balance and the `0.0000` invariant are identical before and after a purge |
| `SUSPENSE` was never used and the slot commit ran outside the ledger transaction, so a duplicate settlement charged the customer, credited the merchant, then 500'd on the CHECK constraint | New `SUSPENSE_SETTLEMENT` template; a commit that would exceed `use_count` routes the funds to `SUSPENSE`, drafts a refund adjustment and opens a `P1` case; `commitSlot`, the journal posting and the `SUCCEEDED` status now commit in one transaction |
| Sequential partial refunds could exceed the settled amount | The attempt is locked `FOR UPDATE` and the `EXECUTED` + `EXECUTING` refunds are summed; an over-refund is refused with `REFUND_EXCEEDS_SETTLED_AMOUNT` |
| A chargeback was drafted for the full amount even after a refund | The chargeback is capped to the unrefunded amount; a fully refunded attempt records the dispute with `NO_CHARGEBACK_DRAFTED` and drafts nothing |
| A refund ignored the rail's `capabilities.refund` / `partial_refund` and the refund window | The rail is read and the capability and window are enforced (`REFUND_NOT_SUPPORTED`, `PARTIAL_REFUND_NOT_SUPPORTED`, `REFUND_WINDOW_EXPIRED`) |
| `SETTLEMENT_SWEEP` and `CHARGEBACK_INSUFFICIENT` had no caller | The reconciliation job posts the settlement sweep for a T+N batch source; a chargeback inside the negative-balance ceiling posts `CHARGEBACK_INSUFFICIENT` |

### 12.3 Compliance and input-validation defects

| Defect | Fix |
| :--- | :--- |
| Screening failed **open**: an `ERROR` result let the onboarding and the payment through | Screening now fails **closed**: onboarding returns `503 SCREENING_UNAVAILABLE` and parks the request `IN_REVIEW`; the guard opens a terminal `BLOCKED` attempt |
| No self-payment policy | A payer wallet/account owned by the merchant is blocked with `SELF_PAYMENT_NOT_ALLOWED` (policy configurable, default block) |
| The NeomPay `wallet_id` regex, LUHN check and wallet-type allow-list were metadata only | Checkout validates every submitted field against `rail_fields` (required, regex, length, optional LUHN, optional wallet-type allow-list) before any money moves |
| The KYB upload trusted the declared MIME | Core sniffs the magic bytes (PNG/JPEG/PDF) and rejects a mismatch with `415 UPLOAD_SIGNATURE_MISMATCH` |
| `merchants.commission_receivable_ceiling` was never enforced | A repository query computes the merchant's outstanding receivable; the guard pauses settlement-dependent traffic above the ceiling (`CEILING_EXCEEDED_PAUSE`) |
| A browser callback / return hint on a pending attempt threw `INVALID_ATTEMPT_TRANSITION` | `AWAITING_CUSTOMER → VERIFYING` (and `CREATED → VERIFYING`) are legal, so the return-url inquiry works |
| A checkpoint could race a settlement sweep | `CheckpointService.captureCheckpoint` locks the GL account row (`SELECT … FOR UPDATE`) before reading the balance |

### 12.4 Operational defects

| Defect | Fix |
| :--- | :--- |
| The durable job queue was off by default, so a dispute (accepted `202`) was never executed | `WORKER_ENABLED` defaults to `true`, the background-job worker is drained by default, startup fails fast when a queue-only API has no drain, and `/health` reports the queue depth and the oldest queued job |
| OD-10 was seeded under a key the code never read and compared the wrong shape | The guard reads the `OD-10` register key, reads the `sandboxBeforeApproval` field, defaults to `true` |
| OD-2 (`RISK_BASED` four-eyes) was not implemented — every applicant needed four eyes | The four-eyes decision is computed from the risk tier, the screening result and the beneficial-ownership profile |
| Six edge routes answered `200` where core answers `202` | All of them relay the core status; the admin edge also forwards the dispute `outcome` so a chargeback can be decided |
| Abandoned join-request drafts never expired | New `JoinRequestExpiryWorker` expires the abandoned drafts and the overdue reviews |
| The 140-case catalogue was 102/140 tautological | All 140 checks now drive the real production unit; a regression in the behaviour fails the check. Zero `todo` remain |
| The design documents still described PostgreSQL | All five documents now describe MySQL 8.0+ / MariaDB 10.6+, including the `VARCHAR(191)` string rule, the `LongBlob` webhook body, the trigger-based maker/checker invariant (MariaDB forbids a CHECK on a foreign-key column) and the raw-SQL dialect |

### 12.5 Verification

| Gate | Result |
| :--- | :--- |
| `core-back`: typecheck + test | 745 pass, 0 fail (was 605) |
| `admin-back` | 408 pass, 0 fail |
| `merchant-back` | 67 pass, 0 fail |
| `checkout-back` | 45 pass, 0 fail |
| Live MySQL 8.4 end-to-end payment | 8 pass: initiate → confirm → balanced journal entry → slot commit → `0.0000` invariant, plus the duplicate-settlement, self-approval and slot-exhaustion refusals |
| Schema | 68 tables (66 models + `schema_versions` + `_prisma_migrations`), `schema_versions = 5`, migration applies cleanly to a fresh MySQL 8.4 database |
| Frontends | `admin-front`, `merchant-front`, `checkout-front` all build |

## 13. Fifth Hardening Pass · Independent Re-Audit Findings Closed

A fresh independent conformance audit re-verified the F1–F18 fixes against the code and the live database, and found **six further defects** that the previous passes had missed — including one that broke the composed checkout path the unit suites never exercised. All six are closed.

| Defect | Severity | Fix |
| :--- | :--- | :--- |
| **The guard and the engine both reserved the link slot.** The guard creates the attempt and increments `active_locked_count` in its transaction; `engine.initiate` then reserved the same slot again, so every default single-use link (`use_count = 1`) failed with `SLOT_RESERVATION_FAILED`. The e2e suite called `engine.initiate` directly, so it never saw it. | CRITICAL | `engine.initiate(attempt, formData, { slotReserved })`; the checkout passes the guard's reservation so exactly one owner reserves. New `checkout-slot-composition.test.ts` exercises the real guard + engine composition |
| The AML hold **release/void never finalized the attempt or the link slot**: the merchant was credited while the attempt stayed `CREATED`, and the slot stayed reserved (or leaked) | HIGH | `executeAmlCaseResolution` now transitions the attempt (`SUCCEEDED` on release, `FAILED` on void), sets `terminalAt`, commits/releases the slot exactly once (conditional update) and broadcasts the transition |
| `POST /gateways/:id/rollback` promoted **any** version to `LIVE`, bypassing all 12 go-live gates | HIGH | Rollback is restricted to a previously `LIVE`/`SUPERSEDED`/`ROLLED_BACK` version and runs the same go-live gate assertion inside the transaction |
| **Cancel was not idempotent**, ignored `point_of_no_return`, and could free a slot held by a different attempt (a repeated cancel, a cancel after expiry, or a cancel of a never-reserved `BLOCKED` attempt all decremented the counter) | HIGH | A single conditional transition (`terminal_at IS NULL AND point_of_no_return = 0 AND status ...`) releases the slot only when it affected a row; repeats are idempotent |
| An **infinite-use link was marked `COMPLETED` after its first payment**, so it could never be used again | HIGH | Only a finite link completes when its last slot is consumed; the SUSPENSE path uses the same rule |
| **Rotating refresh-token persistence was never wired** in production (only in a test), so a gateway that rotates its refresh token would replay the old token after a restart | HIGH | `loadConsumerConfig` now supplies `rotatingRefreshTokenPersistence`: the new token is Vault-encrypted, written to the pinned credential set with an incremented `secretVersion`, and the consumer cache is invalidated |
| The seeded reporting rules (F16) were missing, so the evaluator had nothing to evaluate | LOW | `prisma/seed.ts` seeds one `CONFIRMED` `LARGE_TRANSACTION` rule and one `PROVISIONAL` `SUSPICIOUS_ACTIVITY` rule (idempotent) |

### 13.1 Verification

| Gate | Result |
| :--- | :--- |
| `core-back`: typecheck + test | **759 pass, 0 fail** (was 712) |
| `admin-back` / `merchant-back` / `checkout-back` | 408 / 67 / 45 pass, 0 fail |
| Live MySQL 8.4 end-to-end payment | 8 pass |
| Composed checkout slot reservation | 3 new tests (single-use reserved once, engine self-reserves when not pre-reserved, infinite-use link stays usable) |
| AML release/void finalization | 4 new tests |
| Rollback gate enforcement | 4 new tests |
| Cancel safety | 5 new tests |
| Rotating refresh-token persistence | 2 new tests (ciphertext never contains the plaintext token) |
| Seed idempotency | reporting rules seeded once, `0` on re-run |

## 14. Sixth Hardening Pass · Composed-Path Audit Findings Closed

A final audit of the **composed** production paths (rather than the units) found four more defects, all closed.

| Defect | Severity | Fix |
| :--- | :--- | :--- |
| **A concurrent duplicate `confirm` double-submitted**: both requests read `AWAITING_CUSTOMER`, both called the gateway, both posted the ledger and both committed a slot (two slots for one payment on a multi-use link; a spurious SUSPENSE settlement on a single-use link) | HIGH | `confirm` now performs one atomic conditional claim (`UPDATE … SET status='AUTHORIZING', point_of_no_return=1 … WHERE terminal_at IS NULL AND status IN (…) AND NOT (status='UNKNOWN' AND point_of_no_return=1) AND substatus <> 'AML_HOLD' AND <confirm-key hash differs>`); only the winner runs SUBMIT, the loser returns the persisted state. The confirm `idempotencyKey` is hashed into `customer_fields_masked` (no schema change) |
| **The refund path deadlocked against its own row lock**: `SELECT … FOR UPDATE` on the attempt in the approval transaction, then `engine.refund` updated the same row through a different connection → the refund blocked until timeout, and the gateway refund could complete outside the rolled-back transaction | CRITICAL | The refund is now three short phases: claim (lock, verify limits/capability/window, set `EXECUTING`, commit) → gateway call with **no** transaction open → finalize (post the refund entry, set `EXECUTED`, audit) in one transaction. `UNKNOWN` stays `EXECUTING` and is scheduled for reconciliation |
| **An AML-held attempt could be cancelled or expired while its case was open**, and a later release still credited the merchant | HIGH | AML-held attempts (`substatus = 'AML_HOLD'`) are excluded from the customer cancel and from the expiry sweeper; the AML case resolution is the only writer |
| **Four frontend↔edge contract mismatches** made UI actions fail with `400`: the checkout widget sent `{ event, data }` and `"ready"`; the AML case page sent `{ resolution, rationale }`; the AML reports page sent free-form `subjectName/amount`; the approvals page never sent the chargeback `outcome` | MEDIUM | The checkout widget sends `{ event, payload }` with the canonical event names; the AML case page sends `{ severity, action, reason }` (the edge enum now also accepts `RELEASE`/`REJECT`); the reports page sends `{ reportingRuleId, reportType, periodStart, periodEnd }`; the approvals page has an outcome selector and sends `outcome` |

### 14.1 Verification

| Gate | Result |
| :--- | :--- |
| `core-back`: typecheck + test | **759 pass, 0 fail** |
| `admin-back` / `merchant-back` / `checkout-back` | 408 / 67 / 45 pass, 0 fail |
| Live MySQL 8.4 end-to-end payment | 8 pass |
| Concurrent confirm | 4 new tests (one submit, one journal, one slot) |
| Refund three-phase | 1 new test with separate transaction/base connections (no deadlock, one posting) |
| AML hold protection | 4 new tests (cancel and expiry both refuse a held attempt) |
| Regulatory report lifecycle | 6 new tests (approval, PROVISIONAL refusal, submit, acknowledge, reject, rule promotion) |
| Frontends | all three build |

## 15. Smart AI-Assisted Provider Onboarding (Bring-Your-Own-AI)

Implemented from `design/smart_ai_rail_and_voucher_onboarding_plan.md`. The platform never calls an external AI and never receives a live secret before the import; the admin drives a frontier model in their own browser and the platform verifies the result offline.

### 15.1 The four-stage flow

| Stage | Endpoint | What happens |
| :--- | :--- | :--- |
| 1. Download the kit | `GET /internal/admin/gateways/ai-transcript` (edge: `GET /api/v1/admin/gateways/ai-transcript`) | `engine/specImporter/TranscriptBuilder.ts` emits a self-contained Markdown kit generated from the LIVE Zod schema (`z.toJSONSchema`), the LIVE closed lists (auth methods, parameter sources, transform operations, statuses, channel types, …), two gold-standard examples (OTP and Redirect) and a fill-in section. It instructs the AI to give only credential *names*, never a secret. |
| 2. AI generates a spec | (outside the platform) | The admin pastes the kit + the provider docs into any AI and gets one `integration-spec.json`. |
| 3. Upload & verify | `POST /internal/admin/gateways/spec-verify` (edge: `…/spec-verify`) | `SpecSimulator.ts` runs the four layers and returns a report with a `aiRepairPrompt` when it fails. |
| 4. Bind secrets & import | `POST /internal/admin/gateways/spec-import` (edge: `…/spec-import`) | `SpecMaterializer.ts` re-verifies (double-check), Vault-encrypts the supplied secrets, and writes the whole configuration in ONE transaction as a **DRAFT** version (route `PAUSED`, credential set `UNTESTED`), then runs the live credential check. |

### 15.2 The four verification layers

| Layer | Module | What it proves |
| :--- | :--- | :--- |
| 1. Schema & version | `specSchema.ts` (Zod 4, `strictObject`) | The JSON matches the master schema and `spec_version` is exact. Failures carry `{ path, code: "SCHEMA_INVALID", message, aiFixHint }`. |
| 2. Semantic & security guard | `specValidator.ts` | Cross-field rules: `https` only, every base-URL host pinned in `allowed_hosts`, private/loopback/`.local`/`.internal` hosts blocked, `PREVIOUS_RESPONSE` never on step 0, `MOVES_MONEY` must be `retry_policy: NEVER` (unless a proven idempotency key), every `CRYPTO_SIGNATURE` parameter names a declared profile, url placeholders resolve to a base URL or a PATH parameter, weak inbound channels must inquire, transform pipes validated against the closed library with the float-money ban, unique path tokens / profile names / step ids, at least one test vector. |
| 3. Offline vector simulation | `SpecSimulator.ts` | Drives the **real `StepExecutor`** against the spec's own `test_vectors` with a captured in-memory transport: it builds the request (transforms, crypto signing), parses the documented response, applies the status rules and the output extractors, and asserts the reached canonical status, the extractions, the signature and the wire amount. No network, no database. |
| 4. Collision check | `admin.ts` `collisionCheck` | Reports whether the gateway code / rail code already exist and how many versions exist, so the UI offers "Create New" vs "New Version". |

### 15.3 Safety properties

- **Air-gap safe:** no AI SDK, no outbound call to an AI provider. The transcript is generated locally; the AI runs in the admin's browser.
- **Zero-secret prompting:** the spec declares a `required_credentials` manifest (key, `is_secret`, `encoding`, `type`); the portal renders an input per declared key and the real values are entered directly into the platform, then Vault-encrypted. A secret is never required to verify a spec.
- **Never live on import:** the version is `DRAFT`, the route is `PAUSED` and the credential set `UNTESTED`. Promotion still requires the live credential check and the 12 go-live gates.
- **Double-check:** the materializer re-runs the full verification inside `core-back`; the edge is never trusted.
- **AI-repair loop:** every diagnostic carries an `aiFixHint`, and the API returns a ready-to-paste `aiRepairPrompt`, so one failed verification is not a dead end.

### 15.4 Scope limits (deliberate)

- The import path materializes `HTTP`, `COMPUTE` and `RENDER` steps. A `WAIT` / `ASSERT` / `BRANCH` step is refused with `STEP_TYPE_NOT_IMPORTABLE` and a hint to add it in the wizard's flow editor afterwards (the runtime projection of `PrismaFlowProvider` does not carry them yet). HTTP `assertions` are supported (`success_check`).
- The Voucher Provider Management System half of the plan is **not implemented here**: that codebase is not in this workspace (only its design documents are). The module is written so the domain half (`specSchema` / `specValidator` / `SpecSimulator` / `SpecMaterializer` / `TranscriptBuilder`) can be forked for the voucher provider shape.

### 15.5 A defect found by the feature

The offline simulator found a real engine bug: a `required` step output stored as `PROVIDER_REF` / `SETTLED_AMOUNT` / `PROVIDER_FEE` / `NETWORK_REF` was treated as **missing** by `StepExecutor` (it only checked `state` / `public`), so a money step whose provider reference was successfully extracted was forced to `UNKNOWN`. Fixed in `engine/flow/StepExecutor.ts` (`isOutputPresent`), with the spec-importer vectors as the regression.

### 15.6 Verification

| Gate | Result |
| :--- | :--- |
| `core-back` typecheck + test | **788 pass, 0 fail** (+25 spec importer, +4 live materializer, and the engine fix) |
| `admin-back` | 412 pass (4 new route tests: transcript query forwarding, verify forwarding, import 201, unknown rail kind rejected before core) |
| `admin-front` build | passes (new `pages/gateways/ai-import` wizard + router entry) |
| Live MariaDB import | a verified spec materializes 2 environments, 2 auth, 1 crypto profile, 2 flows / 2 steps, 1 channel, 1 error map, 2 rail fields, a `DRAFT` version and a `PAUSED` route; `NEW_VERSION` adds a second draft; a `CREATE_NEW` on an existing code is refused; an invalid spec writes nothing |

## 16. Multi-Host Deployment Engine (`deploy/`)

Implemented from `design/payment_gateway_deployment_and_guides_architecture.md` Part I (PG-D1…PG-D4).

### 16.1 What it does

| Piece | File | Behaviour |
| :--- | :--- | :--- |
| Config + validation | `deploy/lib/configSchema.ts` | Parses `deploy.env` and validates every value with Zod 4 **before the first SSH connection**: IPs, CIDRs, FQDN domains, ports, identifier-safe DB names, `DATABASE_URL` ⟷ `DB_ENGINE` agreement, custom-SSL certificate paths, distinct merchant/checkout domains, distinct ports, and the database host never sharing an IP with the core. |
| Host planner | `deploy/lib/hostPlanner.ts` | Deduplicates the 5 logical roles by `SSH_HOST:SSH_PORT` into 1…5 concrete hosts. Merges PM2 services, Nginx vhosts, certificate bundles and **unions the UFW rules**; rejects two roles on one host that use different SSH keys/users. Classifies the topology (`single-host` / `split` / `distributed`) and renders the Host Topology Map. |
| PKI | `deploy/lib/pkiManager.ts` | Generates an offline internal CA (10y) and four leaf certificates: the core **server** certificate with `IP:<CORE_PRIVATE_IP>, IP:127.0.0.1, DNS:core-back.internal` in its SAN, and `CN=admin-back` / `CN=merchant-back` / `CN=checkout-back` client certificates. Idempotent, rotates on `--rotate-certs`, and inspects validity + SANs for the audit summary. `certFilesForHost` implements the least-privilege distribution (the CA **key** never leaves the workstation; an edge host only receives its own client certificate). |
| SSH runner | `deploy/lib/sshRunner.ts` | `ssh` with `BatchMode`/`StrictHostKeyChecking=accept-new`, privileged commands through `sudo -S` with the password on **stdin**, `rsync` for the release trees, and `writeRemoteFile` that streams a secret over ssh stdin so it never touches the local disk. |
| Firewall | `deploy/lib/firewallConfigurator.ts` | Base deny + role rules derived from the plan: the database only from the core IP, the core only from the three edge IPs, the admin portal only from `LAN_ALLOWED_CIDRS`, the public edge only SSH/80/443. The SSH rule is always present and `ufw --force enable` runs last, so a deploy can never lock itself out. |
| Verification | `deploy/lib/healthVerifier.ts` | Runs ON each host with that host's own certificate: the core `/health` over mTLS, each edge backend `/health`, each edge completing a mutual TLS handshake to **its own** core channel, and the public vhosts. |
| Orchestrator | `deploy/deploy.ts` + `deploy/deploy.sh` | The ordered 12 steps (validate → build SPAs → PKI → bootstrap+UFW → DB provisioning + pre-migration backup → core → admin → merchant → checkout → verify → prune → audit). Atomic `releases/<ts>/` + `current` symlink, `shared/.env` (0600, symlinked into each release), PM2 ecosystem per service, Nginx render + `nginx -t` + reload. Flags: `--env`, `--only`, `--fresh`, `--update`, `--enforce-firewall`, `--skip-build`, `--skip-verify`, `--rotate-certs`, `--keep`, `--dry-run`. |
| Templates | `deploy/templates/*.tpl` | Multi-app PM2 (`core`/`edge`), LAN-only admin vhost (`allow <LAN_CIDR>; deny all;`, TLS 1.3, HSTS/CSP), public merchant vhost (80→443 + unbuffered POS SSE) and public checkout vhost (80→443 + unbuffered payer SSE + strict CSP). |
| Operator manual | `deploy/DEPLOYMENT_GUIDE.md` | Quick start, the 1-to-5 host topology, the full environment dictionary, the certificate model, the firewall matrix, the 12 steps, the release layout, rollback and a troubleshooting table. |

### 16.2 Verification

- `deploy`: typecheck clean, **25 tests** (config validation incl. every rejection case, the 5/2/1-host scenarios, firewall union + restriction, the edge `.env` never containing `DATABASE_URL`/`KMS_MASTER_KEY`, the topology map, CLI parsing, env quoting and absolute cert paths, the PM2 ecosystem, and all three Nginx templates rendering with **no placeholder left**).
- `./deploy/deploy.sh --dry-run` walks the full 12-step pipeline against a sample `deploy.env` and prints every ssh/rsync/file action without executing anything.

## 17. The Four Built-In Portal Guides & Employee Academy

Implemented from the same design's Part II (PG-G1…PG-G5).

### 17.1 Backend (PG-G1)

| Change | Detail |
| :--- | :--- |
| Schema | `users.academy_progress_json` and `rails.help_guide_json` (migration `20261028100000_add_guides_support`, `schema_versions = 6`, applied to the live database). |
| Seed | `prisma/seedGuides.ts`: the `checkout.support_config` platform setting (channels, working hours, 3 bilingual FAQs) and **13 bilingual per-rail help guides** (steps, prerequisites, troubleshooting) for Edfali, Sadad, Moamalat Card, CBL LYPay, LYPay, MyPay, T-LYNC, MobiCash, OnePay, Yussor, Sahara, MPGS, Evo Pay and NeomPay. |
| Admin API | `GET/PUT /internal/admin/settings/checkout-support` (versioned + audited) and `GET/PUT /internal/admin/academy/progress` + `GET /internal/admin/academy/progress/overview`. Edge routes: `/api/v1/admin/settings/checkout-support`, `/api/v1/admin/academy/progress[/overview]`. |
| Checkout API | `GET /internal/checkout/pay/:linkKey` now returns `supportConfig` (only when `enabled`, honouring `show_platform_contact` / `show_merchant_contact`, the merchant's public contact, the FAQ) and a `helpGuide` on every visible rail. The projection is a whitelist: a field the admin stores but the contract does not expose can never leak to the payer. |

### 17.2 The four systems (PG-G2…PG-G5)

| # | Portal | What was built |
| :--- | :--- | :--- |
| 1 | `admin-front` `/guide` | Searchable 10-book guide + glossary (error codes, GL accounts, statuses), ranked filter with match highlighting, `Ctrl/Cmd+K` command palette, right-side slide-over chapter drawer, and three simulators: a chained **Transform Sandbox**, a **Crypto Signature Lab** that shows the exact canonical string for all four modes, and a **Ledger T-Account Explorer** over the 15 business events with a balanced/unbalanced badge (all money math in `decimal.js`, no `eval`). |
| 2 | `admin-front` `/academy` | 8 A-to-Z modules with lessons, sandbox labs and quizzes, progress persisted through `GET/PUT /api/v1/admin/academy/progress`, a progress bar and the four role badges (`CERTIFIED_OPERATOR`, `CERTIFIED_COMPLIANCE`, `CERTIFIED_FINANCE`, `CERTIFIED_GATEWAY_ARCHITECT`), resilient to an API outage. |
| 3 | `merchant-front` `/guide` | 9 bilingual chapters with a role filter (owner / staff / cashier / developer), a persisted "first 5 steps" onboarding checklist, an interactive **fee & net-settlement calculator** implementing the three fee bearers in `decimal.js`, and a **developer API/webhook sandbox** generating cURL, TypeScript, PHP and Python snippets with copy buttons. |
| 4 | `checkout-front` + `admin-front` | `PerRailInstructionsBanner` (the selected rail's numbered steps + prerequisites) and `CheckoutHelpDrawer` (state-aware guidance for VERIFYING/UNKNOWN/FAILED/EXPIRED/CANCELLED, a 1-click "copy payment reference", the platform FAQ, and the admin-configured WhatsApp / call / email / merchant contact / working-hours block that disappears entirely when `checkout.support_config.enabled` is false), plus the operator page `/settings/checkout-help` with a live payer preview. |

### 17.3 Verification

| Gate | Result |
| :--- | :--- |
| `core-back` typecheck + test | **796 pass, 0 fail** (+8 guide tests: the support projection incl. the leak check, the bilingual seed content, and the live seeded rows) |
| `admin-back` | **416 pass** (+4 route tests: checkout-support read/write, academy read/write/overview, and an invalid body rejected before core) |
| `merchant-back` / `checkout-back` | 67 / 45 pass |
| Live database | the `support_config` setting and all 13 rail guides are seeded; the full chain (`platform setting` + `rail.help_guide_json` → `buildCheckoutSupportConfig`/`helpGuide`) composes and returns the Sadad walkthrough, the channels and the FAQ |
| Frontends | `admin-front` (guide + academy + settings page), `merchant-front` (guide) and `checkout-front` (help drawer + banner) all build |

## 18. Live Single-Node Deployment Validation

The deploy engine was executed against a real Ubuntu 26.04 host (MySQL 8.4,
one box carrying all five roles) rather than only dry-run. The run surfaced
seven defects that the dry-run could not, all now fixed:

| # | Defect found by the live run | Fix |
| :--- | :--- | :--- |
| 1 | MySQL refused to create the maker≠checker trigger (`ERROR 1419`) because the binary log is on and the app user has no `SUPER`. | Provisioning now sets `log_bin_trust_function_creators = 1` and persists it in `/etc/mysql/conf.d/zz-payment-gateway.cnf`. |
| 2 | A single-box install was rejected because `DB_PRIVATE_IP` equalled `CORE_PRIVATE_IP`. | The validator now accepts the co-located database (it binds to `127.0.0.1`). |
| 3 | The LAN-only admin vhost rendered without a certificate, so `nginx -t` failed. | A self-signed certificate is minted for the admin server name when none is configured. |
| 4 | App files under `/var/www` were root-owned, so PM2 (the SSH user) could not read `shared/.env` or the keys. | The deploy chowns the tree to the SSH user and writes certificate/env/PM2 files as that user, using sudo only for `/var/www` creation and Nginx. |
| 5 | `bunx` was missing from the non-interactive PATH and PM2's shebang needs Node. | Bootstrap installs `nodejs`, symlinks `bun`/`bunx` into `/usr/local/bin`, and PM2 is invoked by absolute path. |
| 6 | PM2's `startOrReload` kept the old `script`/`cwd`, so after a prune the core crash-looped on a deleted release. | Deploys now `pm2 delete` then `pm2 start`, pinning each release. |
| 7 | The worker runtime was handed the `getBaseClient` **function** instead of the client (`db: baseClient`), so every background worker tick threw `$queryRawUnsafe is not a function`. | `core-back/index.ts` passes the lazily-bound `client` proxy; the workers now tick cleanly. |

Two further gaps closed while validating:

* The merchant and checkout edges bound `0.0.0.0`; they now honour `BIND_HOST`
  and the deploy sets it to `127.0.0.1` (the firewall already blocked the ports,
  this closes the socket as well).
* No seeded admin role held `settings:read`/`settings:write`, so the new
  checkout-help settings screen was unusable; the `GATEWAY_ADMIN` seed now
  carries both authorities.

Validation performed on the live host:

| Case | Result |
| :--- | :--- |
| Clean `--fresh` from a wiped box | **pass**, 12/12 steps, 9/9 verification probes, ~150 s |
| `--update` (twice) | **pass**, pre-migration `mysqldump` created, 4 services redeployed, 9/9 probes |
| `--only=admin` | **pass**, only the admin release advanced; core/merchant/checkout untouched |
| `--keep=1` | **pass**, pruned to one release per host, PM2 pointed at it |
| `--rotate-certs` | **pass**, new CA + 4 leaves uploaded to every host |
| `--dry-run` | **pass**, 12-step plan with a single-host topology |
| Invalid config (bad CIDR, mixed keys on a shared host, custom SSL without paths) | **fail fast**, exit 1 before any SSH |
| Firewall from another LAN host | 22/80/443 open; 3306/4000/4101/4102/4103 **blocked**; 8443 open to the LAN only |
| Edge `.env` isolation | no `DATABASE_URL`, `KMS_MASTER_KEY` or DB password on any edge host |
| Authenticated flow through Nginx → admin-back → core (mTLS) → DB | login (bcrypt), MFA gate, academy progress, checkout-support read **and** versioned write |
| Seed + schema | `schema_versions = 6`, 13/13 rails carry a help guide, support config enabled |
| Background workers | zero tick errors over a 30 s window after the runtime fix |

Regression after the fixes: `core-back` 796, `admin-back` 416,
`merchant-back` 67, `checkout-back` 45, `deploy` 25 — all pass.

## 19. Admin Portal Sign-In & Scaling Repair

Testing the deployed portal exposed an unfinished auth/UI integration. Fixed:

| # | Defect | Fix |
| :--- | :--- | :--- |
| 1 | The login form posted `{ username, password }` but the edge schema is strict `{ identifier, password }`, so every login returned **400 VALIDATION_FAILED**. | The form posts `identifier`; the field is labelled "Email or phone". |
| 2 | `POST /auth/login` returned only `{ token }`, so the portal stored an empty `userInfo` (no role, no authorities) and every guarded screen vanished. | Login and MFA now return `userInfo` (id, role, email, phone, maker/checker, `authoritiesMap`). |
| 3 | The portal calls `GET /auth/me` for app status; the route did not exist. | Added a public `GET /auth/me` returning platform name/version/suspended. |
| 4 | The seed leaves `password_hash` NULL and status `INVITED`, with no activation path — nobody could ever sign in. | Added `bun run create-admin` (flags or `ADMIN_*` env), idempotent, `ACTIVE`, policy-checked, MFA off by default; documented in the deployment guide. |
| 5 | The login page could not complete an MFA challenge (`missing token`). | Two-step form: login → six-digit code → `POST /auth/mfa`; a Back button returns to credentials. |
| 6 | `#app { transform: scale(0.9) }` shrank the whole app; a transformed ancestor becomes the containing block for `position: fixed`, so the Vuetify app bar, drawer, dialogs and snackbars mis-positioned, and `transform-origin: top left` left a gap in the RTL layout. | Removed the global transform (and the dead, unimported `utils/appScale.ts`); the mount point is now a plain full-size surface. Vuetify density is the supported way to tighten the layout. |
| 7 | The backend authority vocabulary (`gateway:write`) and the portal vocabulary (`gateways.edit`) were disjoint, so no projection could light up the menu. | `lib/auth/uiAuthorities.ts` projects the backend authorities onto the portal keys for `userInfo` (presentation-only; enforcement still uses the real strings), with unit tests. |

Verified on the live host: login with the exact form payload returns a token and
a populated `userInfo`; the built CSS contains no `app-scale`; the deployed
`index.html` hash matches the local build.

## 20. Portal Shell Redesign, RBAC UI, LAN Vhosts, and UI/E2E Test Harness

The deployed portals were unusable: the app bar overlapped the body, the
drawer/navigation did not respond, the pages were hidden, and the merchant and
checkout apps still carried the global scaling transform. Root causes and fixes:

| # | Root cause | Fix |
| :--- | :--- | :--- |
| 1 | `v-model={drawer.value}` is not valid Vue JSX, so `VNavigationDrawer` never received `modelValue`; the hamburger was dead and the temporary drawer could not close. | The new shell binds `modelValue` + `onUpdate:modelValue`; the drawer is permanent ≥960px, temporary below, closed on mobile and on navigation. |
| 2 | `<VAppBar>` already renders a `VToolbar`; the layout nested a second `<VToolbar>`, producing the off-style bar and wrong height. | One `VAppBar` with a bordered surface and no nested toolbar. |
| 3 | `VMain` had `minHeight: 100vh` and page padding came from a `flex: 1` div in a block parent. | `VMain` is a plain layout surface; `ScreenContainer` is a real block container with responsive padding and a 1600px max width. |
| 4 | `#app { transform: scale(0.9) }` was still present in **merchant** and **checkout** (it broke fixed positioning and caused horizontal overflow). | Removed from all three portals, plus the dead `utils/appScale.ts`; guarded by an e2e assertion that `#app` has `transform: none`. |
| 5 | Hardcoded `* { font-family: Cairo !important; letter-spacing: 1px }` fought the global font and cramped every bar. | Removed; Cairo for RTL, Plus Jakarta for LTR, no global letter-spacing. |
| 6 | Empty navigation sections rendered headers with no items. | `useSections()` drops sections whose routes are all hidden (asserted in e2e). |
| 7 | Merchant login posted `{identity, password, mfaCode}` against a strict `{identifier, password}` schema → 400; the merchant session had no `authoritiesMap`. | Payload fixed, MFA is a proper two-step flow, and the core returns `userInfo` with the merchant projection (28 UI authorities). |
| 8 | The admin dashboard called a non-existent `v1/admin/stats/overview`; the merchant overview returned a different shape than the page consumed. | Added the admin overview endpoint (core + edge) and extended the merchant overview (period-aware: stats, charts, recent payments, wallet balance). |
| 9 | New MySQL connections failed on `caching_sha2_password` (`allowPublicKeyRetrieval`), so any fresh core pool would break. | The DB adapter now builds a pool config with `allowPublicKeyRetrieval: true` (tested). |
| 10 | No frontend tests existed. | Added Playwright e2e (geometry/a11y/auth/navigation) + a live suite against the deployed box + a Vitest unit suite. |

The shell is now shared in shape between admin and merchant (branding/sections
differ), and checkout keeps its focused single-column payer surface with the
same tokens. LAN vhosts publish merchant on `8081` and checkout on `8082` with
IP-SAN self-signed certificates and UFW restricted to `LAN_ALLOWED_CIDRS`.

Test totals after the work: **core-back 807**, **admin-back 416**,
**merchant-back 67**, **checkout-back 45**, **deploy 25**, Playwright **27 e2e**
+ **4 live**, Vitest **17 unit** — all green. The live suite logs into the
deployed admin and merchant portals over the LAN ports and asserts the app bar
never overlaps content, the drawer works on mobile, nothing overflows, and the
scaling transform is gone on all three portals.

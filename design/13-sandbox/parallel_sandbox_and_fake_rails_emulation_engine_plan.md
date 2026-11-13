# Payment Gateway — Parallel Sandbox Environment & Stateful Fake Rails Emulation Engine (`v38`)

**Target Baseline:** `payment-gateway-monolith-optomizations-plan (2).zip` (`REQUIRED_SCHEMA_VERSION = 37`)  
**Target Schema Version After Implementation:** `REQUIRED_SCHEMA_VERSION = 38`  
**Audience:** Coding Agent (`OpenCode`) — Single-File, Zero-Ambiguity, Self-Contained Implementation Specification  
**Primary Goal:** Build a **100% Physically & Logically Isolated Parallel Sandbox Environment** (separate database `payment_gateway_sandbox`, separate core runtime `pg-core-sandbox`, separate `/sandbox/*` UI pages in both Merchant and Admin portals, separate `/api/v1/merchant/sandbox/*` and `/api/v1/admin/sandbox/*` API namespaces, and a redesigned **Stateful Fake Rails v2 Engine** with real test customer accounts, controllable balances, holds, clearing pools, and an interactive Checkout Secret & Balance Inspector) while **eliminating all residual implicit-sandbox leaks from the Live environment**.

---

## 1. Executive Architecture & Hard Non-Negotiable Separation Rules

### 1.1 The Five Non-Negotiable Architectural Rules

1. **Zero Mixing of Live and Sandbox in Database Tables (Separate Databases in Every Environment):**
   - **Why:** If Live and Sandbox Wallets, Applications, Payment Links, Payment Attempts, or Ledger Journal Lines share the same database table (differentiated only by an `env = 'LIVE' | 'SANDBOX'` column), a single missing `WHERE env = 'LIVE'` filter written by a future maintainer or coding agent will leak Sandbox test balances into Live financial statements, cashouts, or reconciliation runs.
   - **Rule:** Live and Sandbox **never** share operational database tables—not in multi-node production, not in single-node staging, and not in local development:
     - **`payment_gateway_prod` (`DATABASE_URL` on `pg-core-back`):** Contains **100% `LIVE` rows only**. Every row in `wallets`, `applications`, `payment_links`, `payment_attempts`, `gl_accounts`, `gl_account_shards`, `journal_entries`, `journal_lines`, `cashout_requests`, `disputes`, `adjustments`, and `reconciliation_runs` in `payment_gateway_prod` is strictly `LIVE`.
     - **`payment_gateway_sandbox` (`SANDBOX_DATABASE_URL` on `pg-core-sandbox`):** Contains **100% `SANDBOX` rows only**. Every Sandbox Wallet (`sbx_wal_*`), Sandbox Application (`sbx_app_*`), Sandbox Payment Link (`sbx_*`), Sandbox API Token (`pg_test_*`), Sandbox Payment Attempt, and Sandbox Double-Entry Journal Entry lives exclusively in `payment_gateway_sandbox`.
     - **PostgreSQL Hardware-Level Trigger Fence (`v38`):** Both databases enforce a single-row `system_execution_plane` lock table (`plane = 'LIVE'` on `payment_gateway_prod`, `plane = 'SANDBOX'` on `payment_gateway_sandbox`). Triggers (`trg_fence_*`) immediately `RAISE EXCEPTION 'SANDBOX_FENCE_VIOLATION'` if any code attempts to insert a `SANDBOX` row or `FAKE_*` rail adapter into `payment_gateway_prod`, or a `LIVE` row into `payment_gateway_sandbox`.

2. **Zero Mixing of Live and Sandbox in UI Pages (Dedicated `/sandbox/*` Navigation & Pages):**
   - **Why:** Reusing the same `/wallets` or `/applications` page with a header toggle causes human error—merchants or their employees can mistake a Sandbox wallet or link for a Live one (or vice versa).
   - **Rule:** Both `merchant-front` and `admin-front` provide **strictly separate navigation sections and separate page components**:
     - **Normal Live Pages (`merchant-front`):** `/wallets`, `/applications`, `/links`, `/pos`, `/payments`, `/cashouts`, `/disputes`, `/developers/tokens`, `/developers/webhooks` talk exclusively to `/api/v1/merchant/*` -> `pg-core-back` (`payment_gateway_prod`). Wallets created on `/wallets` are strictly **Live Wallets**. Applications created on `/applications` are strictly **Live Applications**.
     - **Dedicated Sandbox Studio Pages (`merchant-front`):** A separate **`Sandbox Studio`** sidebar section with amber/indigo sandbox framing and dedicated pages:
       - `/sandbox/overview` — Merchant Sandbox Control Center (1-click Demo Workspace Seeder, 1-click Reset Sandbox Data, End-to-End Integration Checklist for Website/Mobile App/Employee Training).
       - `/sandbox/wallets` — **Sandbox Wallets** list & creation (`POST /api/v1/merchant/sandbox/wallets`), plus **Instant Virtual Balance Controller** (`Set / Top-Up / Drain Sandbox Wallet Balance` via `FAKE_SETTLEMENT_TOPUP` double-entry journal posting on `payment_gateway_sandbox`).
       - `/sandbox/applications` — **Sandbox Applications** list & creation (`POST /api/v1/merchant/sandbox/applications`), bound strictly to **Sandbox Wallets**, with per-app Fake Rails routing and Checkout Inspector controls.
       - `/sandbox/links` — **Sandbox Payment Links (`sbx_*`) & Sandbox POS Terminals (`SBX-POS-*`)**, with 1-click **"Open Sandbox Checkout"** launcher.
       - `/sandbox/payments` — **Sandbox Payments, Refunds & Dispute/Chargeback Simulator**, with full Sandbox double-entry journal line inspection.
       - `/sandbox/accounts` — **Fake Rails Test Customer Accounts & Cards Balance Controller**, allowing the merchant (and admin) to create/edit test customer bank accounts, cards, wallets, and vouchers, set exact `available_balance_lyd` and `daily_limit_lyd`, toggle account `ACTIVE / FROZEN / EXPIRED` status, set static OTPs, and inspect real-time auth holds and clearing movements.
       - `/sandbox/tokens` — **Sandbox API Keys (`pg_test_*`) & Sandbox Webhook Simulator**, with 1-click webhook ping/replay (`payment.succeeded`, `payment.failed`, `refund.succeeded`, `dispute.created`) to test the merchant's own website, store, or mobile app backend.
     - **Dedicated Admin Sandbox & Fake Rails Pages (`admin-front`):**
       - `/sandbox/overview` — Sandbox Node & Fake Rails Health, Sync Live Gateway Blueprints to Sandbox, and Global/Per-Merchant Sandbox Reset.
       - `/sandbox/merchants-wallets` — Inspect and manage any merchant's Sandbox Wallets, Sandbox Applications, Sandbox Links, and Sandbox Ledger.
       - `/sandbox/fake-rails` — Global Fake Rails Customer Accounts & Balances Manager, Per-Rail Chaos Failure Matrix, and 1-Click Synthetic Settlement Statement Generator into Sandbox Reconciliation.

3. **Complete Elimination of Residual Implicit-Sandbox Leaks on the Live Plane:**
   - **Why:** In `v37`, deactivated or `PENDING` merchants, `PENDING` wallets, and `PENDING`/`DRAFT` applications on the Live system were silently treated as `"SANDBOX"` via:
     - `resolveEnvironment(merchantStatus)` in `core-back/api/internal/checkout.ts` and `core-back/api/internal/merchant.ts` (`merchant.status === "ACTIVE" ? "LIVE" : "SANDBOX"`).
     - `SANDBOX_APPLICATION_STATUSES = new Set(["ACTIVE", "PENDING", "DRAFT"])` and `SANDBOX_WALLET_STATUSES = new Set(["ACTIVE", "PENDING"])` in `core-back/lib/commerceStatus.ts`.
     - `OD10_SANDBOX_BEFORE_APPROVAL_KEY` (`"OD-10"` / `sandboxBeforeApproval`) in `core-back/engine/guards/AttemptGuardPipeline.ts` and `core-back/prisma/seed.ts`.
   - **Rule:** All implicit fallback from Live to Sandbox is **deleted**. On the Live plane (`pg-core-back` / `payment_gateway_prod`), a merchant, wallet, or application that is not `ACTIVE` is **strictly rejected** (`409 MERCHANT_NOT_ACTIVE`, `WALLET_NOT_ACTIVE`, `APPLICATION_NOT_ACTIVE`)—never treated as Sandbox! Meanwhile, any merchant (whether their Live KYB status is `PENDING`, `ACTIVE`, or `SUSPENDED`) can immediately use the dedicated `/sandbox/*` pages (`pg-core-sandbox` / `payment_gateway_sandbox`) to test their integration and train staff.

4. **Both Merchant and Admin Have Full Sandbox Control (Merchant-First Self-Service):**
   - **Merchant Capabilities in `/sandbox/*`:**
     - Create & manage Sandbox Wallets (`/sandbox/wallets`) and adjust their virtual balances at will.
     - Create & manage Sandbox Applications (`/sandbox/applications`) and Sandbox Payment Links (`/sandbox/links`).
     - Control Fake Rails customer test accounts, balances, daily limits, statuses (`ACTIVE`, `FROZEN`, `LOCKED`, `EXPIRED`), and OTP codes (`/sandbox/accounts` and directly inside the Checkout page drawer).
     - Issue `pg_test_*` S2S API keys and test webhooks (`/sandbox/tokens`) against their own store/website/mobile app (`/api/external/v1/*` automatically routes `Bearer pg_test_*` to `pg-core-sandbox`).
     - Trigger instant simulated refunds, chargebacks/disputes, and cashout settlements on `/sandbox/payments` and `/sandbox/wallets`.
     - Reset or re-seed their entire merchant sandbox workspace in 1 click without touching any other merchant or Live data.
   - **Admin Capabilities in `/sandbox/*`:**
     - Sync Live gateway/fee/commission/guard blueprints to `pg-core-sandbox`.
     - Manage global presets and merchant-scoped Fake Rails test accounts, per-rail failure/latency chaos rules, and synthetic bank settlement statement ingestion into Sandbox Reconciliation.

5. **Interactive Checkout Page Secret & Balance Revelation (`SandboxCheckoutInspector`):**
   - When opening any Sandbox checkout (`sbx_*` link, hosted redirect session, or embedded widget) on `checkout-front`, the checkout page detects `environment === "SANDBOX"` and renders the collapsible **Sandbox Test Assistant & Balance Controller** drawer directly alongside the checkout form:
     - Shows the **1-Click Customer Account & Card Picker** for the currently selected rail (e.g., *Funded Account — 25,000.000 LYD*, *Low Balance Account — 5.000 LYD*, *Frozen Account*, *High-Value Account — 250,000.000 LYD*) that **auto-fills** the exact card number, CVV, expiry, phone number, subscriber ID, or voucher PIN/serial into the form.
     - Displays the **Live Revealed OTP / Passcode Badge** with a 1-click **"Fill OTP & Complete"** button as soon as an OTP challenge is created by `fake-rails-back`.
     - Includes an **Inline Balance Editor** (`+1,000 LYD`, `Set Exact Balance`, `Drain to 0 LYD`, `Freeze/Unfreeze`) right on the checkout screen so the merchant or tester can test `INSUFFICIENT_FUNDS` and then immediately top up the customer account and complete the payment without leaving the checkout page.

---

### 1.2 End-to-End Topology Diagram (Live Plane vs. Sandbox Plane)

```
====================================================================================================
                                  EDGE / BFF TIER (STATELESS)
====================================================================================================
  [merchant-front]                     [admin-front]                        [checkout-front]
   ├─ Live Section (/wallets, ...)      ├─ Live Section (/merchants, ...)    ├─ /pay/pl_*  (LIVE UI)
   └─ Sandbox Studio (/sandbox/*)       └─ Sandbox Section (/sandbox/*)      └─ /pay/sbx_* (SANDBOX UI
                                                                                 + Secret/OTP/Balance
                                                                                   Inspector Drawer)
          │                                     │                                      │
          ▼                                     ▼                                      ▼
   [merchant-back]                       [admin-back]                          [checkout-back]
   ├─ /api/v1/merchant/* ──────────┐     ├─ /api/v1/admin/* ──────────┐        ├─ pl_* ──────────┐
   ├─ /api/external/v1 (pg_live_*)─┤     └─ /api/v1/admin/sandbox/* ──┼──┐     └─ sbx_* ─────────┼──┐
   ├─ /api/v1/merchant/sandbox/* ──┼──┐                               │  │                       │  │
   └─ /api/external/v1 (pg_test_*)─┼──┤                               │  │                       │  │
                                   │  │                               │  │                       │  │
================= LIVE PLANE ======▼==┼===============================▼==┼=======================▼==┼===
  [CORE_NODE(s)]                      │                                  │                          │
  ┌───────────────────────────────────┴──────────────────────────────────┴──────────────────────────┘
  │  pg-core-back (:4000)  [EXECUTION_PLANE=LIVE, FAKE_RAILS_ENABLED=false]
  │   ├─ Strict Live Status Enforcement: merchant, wallet & application MUST be ACTIVE (zero OD-10 leak)
  │   ├─ PostgreSQL Trigger Fence: rejects any env='SANDBOX' row or FAKE_* rail adapter
  │   ├─ Connects ONLY to: payment_gateway_prod (100% LIVE rows)
  │   └─ Outbound Rails: ONLY real production bank/card/wallet adapters
  └──────────────────────────────────────────────────────────────────────────────────────────────────

=============== SANDBOX PLANE ========▼==================================▼==========================▼===
  [SANDBOX_NODE] (Dedicated VM in Multi-Node OR isolated services + DB in Single-Node)
  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
  │  pg-core-sandbox (:4005)  [EXECUTION_PLANE=SANDBOX, FAKE_RAILS_ENABLED=true]                     │
  │   ├─ Mirrors full core-back code: Double-Entry Ledger, 16-Shard GL, Guards, Webhooks, Recon      │
  │   ├─ PostgreSQL Trigger Fence: rejects any env='LIVE' row                                        │
  │   ├─ Connects ONLY to: payment_gateway_sandbox (100% SANDBOX rows — zero Live PII/PAN/Tokens)    │
  │   └─ Outbound Rails: Routes ALL rail calls exclusively to local pg-fake-rails-back (:4105)       │
  ├──────────────────────────────────────────────────────────────────────────────────────────────────┤
  │  pg-fake-rails-back (:4105)  [Stateful Fake Rails v2 Engine — SQLite WAL fake-rails.sqlite]      │
  │   ├─ fake_rail_accounts: Customer cards, bank accounts, mobile wallets, vouchers with balances   │
  │   ├─ fake_rail_holds & fake_rail_movements: Real auth holds, captures, refunds & daily limits    │
  │   ├─ fake_rail_clearing_entries: Per-rail clearing pools + 1-click settlement statement export   │
  │   └─ /api/fake-rails/v1/inspector/*: Live OTP reveal, 1-click credential presets & balance edit  │
  └──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Removing All Residual Implicit-Sandbox Leaks & Upgrading Schema to `v38`

### 2.1 Complete Audit & Removal of Residual Implicit-Sandbox Leaks in `core-back`

Every place in the `v37` codebase where deactivated or `PENDING` Live entities were treated as `"SANDBOX"` must be cleaned up so Live is 100% Live and Sandbox is 100% Sandbox.

#### 2.1.1 Replace `core-back/lib/commerceStatus.ts` (Full Verbatim File)

In `v37`, `commerceStatus.ts` allowed `PENDING` and `DRAFT` applications and `PENDING` wallets when `env === "SANDBOX"`. Because Live and Sandbox are now separated by execution plane (and even in Sandbox, a merchant's Sandbox Wallets and Sandbox Applications are created as `ACTIVE` unless the merchant explicitly deactivates them to test deactivation errors!), both planes enforce clean, unambiguous status rules:

```ts
// core-back/lib/commerceStatus.ts
import { GuardError } from "../engine/errors";

export type CommerceEnvironment = "SANDBOX" | "LIVE";

const ACTIVE_ONLY = new Set(["ACTIVE"]);

const normalizeStatus = (status: unknown): string =>
  String(status || "")
    .trim()
    .toUpperCase();

export const isMerchantActive = (status: unknown): boolean =>
  ACTIVE_ONLY.has(normalizeStatus(status));

export const isApplicationActive = (
  status: unknown,
  _env?: CommerceEnvironment,
): boolean => ACTIVE_ONLY.has(normalizeStatus(status));

export const isWalletActive = (
  status: unknown,
  _env?: CommerceEnvironment,
): boolean => ACTIVE_ONLY.has(normalizeStatus(status));

export const assertMerchantActive = (status: unknown): void => {
  if (!isMerchantActive(status)) {
    throw new GuardError(
      "MERCHANT_NOT_ACTIVE",
      `Merchant is not active (status=${normalizeStatus(status) || "UNKNOWN"})`,
      409,
    );
  }
};

export const assertApplicationActive = (
  status: unknown,
  _env?: CommerceEnvironment,
): void => {
  if (!isApplicationActive(status)) {
    throw new GuardError(
      "APPLICATION_NOT_ACTIVE",
      `Application is not active (status=${normalizeStatus(status) || "UNKNOWN"})`,
      409,
    );
  }
};

export const assertWalletActive = (
  status: unknown,
  _env?: CommerceEnvironment,
): void => {
  if (!isWalletActive(status)) {
    throw new GuardError(
      "WALLET_NOT_ACTIVE",
      `Wallet is not active (status=${normalizeStatus(status) || "UNKNOWN"})`,
      409,
    );
  }
};

export const assertCommerceActive = (input: {
  merchantStatus?: unknown;
  applicationStatus?: unknown;
  walletStatus?: unknown;
  env?: CommerceEnvironment;
}): void => {
  if (input.merchantStatus !== undefined) {
    assertMerchantActive(input.merchantStatus);
  }
  if (input.applicationStatus !== undefined) {
    assertApplicationActive(input.applicationStatus);
  }
  if (input.walletStatus !== undefined) {
    assertWalletActive(input.walletStatus);
  }
};
```

#### 2.1.2 Remove `resolveEnvironment(merchantStatus)` from `core-back/api/internal/checkout.ts` and `core-back/api/internal/merchant.ts`

In `v37`, `core-back/api/internal/checkout.ts` (lines 176–177, 790, 1002, 1138, 1493) and `core-back/api/internal/merchant.ts` (lines 1817, 1852) computed:
```ts
// LEGACY v37 BUG — DELETE THIS:
const resolveEnvironment = (merchantStatus: string): "SANDBOX" | "LIVE" =>
  merchantStatus === "ACTIVE" ? "LIVE" : "SANDBOX";
```
Replace that logic with the runtime execution plane helper (`getExecutionPlane()` from `core-back/lib/executionPlane.ts`):

```ts
// core-back/lib/executionPlane.ts
export type ExecutionPlane = "LIVE" | "SANDBOX";

export const getExecutionPlane = (): ExecutionPlane => {
  const raw = String(process.env.EXECUTION_PLANE || "LIVE")
    .trim()
    .toUpperCase();
  if (raw !== "LIVE" && raw !== "SANDBOX") {
    throw new Error(
      `FATAL_CONFIG_ERROR: EXECUTION_PLANE must be 'LIVE' or 'SANDBOX' (received '${raw}')`,
    );
  }
  return raw as ExecutionPlane;
};

export const isSandboxPlane = (): boolean => getExecutionPlane() === "SANDBOX";
export const isLivePlane = (): boolean => getExecutionPlane() === "LIVE";
```

In `core-back/api/internal/checkout.ts`:
- Replace `resolveEnvironment(merchantStatus)` with:
```ts
import { getExecutionPlane } from "../../lib/executionPlane";

const resolveEnvironment = (_merchantStatus?: string): "SANDBOX" | "LIVE" =>
  getExecutionPlane();
```
- And in `loadPayableLink` (`core-back/api/internal/checkout.ts`, lines 780–805), enforce strict plane + status validation:
```ts
const env = getExecutionPlane();
if (link.env !== env) {
  throw new GuardError(
    "ENVIRONMENT_PLANE_MISMATCH",
    `Payment link environment (${link.env}) does not match execution plane (${env})`,
    409,
  );
}
// On LIVE plane, merchant, application, and wallet MUST all be ACTIVE.
// On SANDBOX plane, Sandbox wallet and Sandbox application MUST be ACTIVE (merchant KYB status on Live does not block Sandbox testing).
assertCommerceActive({
  merchantStatus: env === "LIVE" ? link.merchant.status : "ACTIVE",
  applicationStatus: link.application?.status,
  walletStatus: link.wallet.status,
  env,
});
```

In `core-back/api/internal/merchant.ts` (`POST /links`, lines 1814–1865):
- Replace `const env = merchant.status === "ACTIVE" ? "LIVE" : "SANDBOX";` with:
```ts
const env = getExecutionPlane();
assertCommerceActive({
  merchantStatus: env === "LIVE" ? merchant.status : "ACTIVE",
  applicationStatus: app.status,
  walletStatus: app.wallet.status,
  env,
});
const linkKey =
  env === "SANDBOX"
    ? `sbx_${crypto.randomBytes(12).toString("hex")}`
    : `pl_${crypto.randomBytes(12).toString("hex")}`;
```

#### 2.1.3 Remove `OD-10` (`sandboxBeforeApproval`) from `core-back/engine/guards/AttemptGuardPipeline.ts` and `core-back/prisma/seed.ts`

In `core-back/engine/guards/AttemptGuardPipeline.ts`:
1. Delete `const OD10_SANDBOX_BEFORE_APPROVAL_KEY = "OD-10";` and `sandboxBeforeApprovalFromSetting(...)` (lines 216–235).
2. In `evaluateMerchantAndCatalogGuards` (lines 1018–1040), replace the `switch (merchantStatus)` block with:
```ts
    const executionPlane = getExecutionPlane();
    if (context.env !== executionPlane) {
      throw new GuardError(
        "ENVIRONMENT_PLANE_MISMATCH",
        `Attempt env '${context.env}' is forbidden on execution plane '${executionPlane}'`,
        409,
      );
    }

    switch (merchantStatus) {
      case "ACTIVE":
        break;
      case "PENDING":
        // On the SANDBOX execution plane, a merchant whose KYB is still PENDING can freely run Sandbox transactions.
        // On the LIVE execution plane, PENDING merchants are strictly blocked from creating or running Live attempts.
        if (executionPlane !== "SANDBOX") {
          throw new GuardError(
            "MERCHANT_NOT_ACTIVE",
            "Merchant account is pending KYB approval. Use the Sandbox Studio section to test integrations before Live activation.",
            409,
          );
        }
        break;
      case "SUSPENDED":
        if (executionPlane !== "SANDBOX") {
          throw new GuardError("MERCHANT_SUSPENDED", "Merchant is suspended", 409);
        }
        break;
      case "TERMINATED":
      case "CLOSED":
        throw new GuardError("MERCHANT_TERMINATED", "Merchant is terminated", 409);
      default:
        throw new GuardError(
          "MERCHANT_STATUS_INVALID",
          `Unsupported merchant status: ${String(merchant.status)}`,
          409,
        );
    }
```
3. In `core-back/prisma/seed.ts` (line 85), remove `{ key: "OD-10", value: { sandboxBeforeApproval: true } }`.
4. Update `core-back/test/security-regressions/commerce-status-enforcement.test.ts` and `core-back/test/engine/attempt-guard-pipeline.test.ts` so they assert that on `EXECUTION_PLANE=LIVE`, a `PENDING` merchant, `PENDING` wallet, or `PENDING`/`DRAFT` application is **always rejected** with `409 MERCHANT_NOT_ACTIVE` / `WALLET_NOT_ACTIVE` / `APPLICATION_NOT_ACTIVE`.

---

### 2.2 Database Schema `v38`: Execution Plane Fence & Sandbox Sync Metadata (`core-back/prisma/`)

#### 2.2.1 Bump `REQUIRED_SCHEMA_VERSION` to `38` in `core-back/prisma/schemaVersion.ts`

```ts
// core-back/prisma/schemaVersion.ts
export const REQUIRED_SCHEMA_VERSION = 38;
export const REQUIRED_SCHEMA_DESCRIPTION =
  "v38: Strict Live vs Sandbox database execution plane triggers, removal of implicit OD-10 sandbox fallback, and sandbox blueprint sync audit table";
```

#### 2.2.2 Add Models to `core-back/prisma/schema.prisma`

Append the following models to `core-back/prisma/schema.prisma`:

```prisma
model SystemExecutionPlane {
  id                  Int      @id @default(1)
  plane               String   @db.VarChar(16) // Strictly 'LIVE' on payment_gateway_prod, 'SANDBOX' on payment_gateway_sandbox
  allowFakeRails      Boolean  @default(false) @map("allow_fake_rails")
  liveSyncRevision    Int      @default(0) @map("live_sync_revision")
  lastSyncedFromLive  DateTime? @map("last_synced_from_live")
  updatedAt           DateTime @default(now()) @updatedAt @map("updated_at")

  @@map("system_execution_plane")
}

model SandboxSyncAudit {
  id                String   @id @default(cuid())
  syncType          String   @map("sync_type") @db.VarChar(48) // 'BLUEPRINT_SYNC' | 'MERCHANT_DEMO_SEED' | 'MERCHANT_RESET' | 'GLOBAL_RESET' | 'WALLET_TOPUP'
  merchantId        String?  @map("merchant_id")
  actorId           String?  @map("actor_id")
  actorRole         String?  @map("actor_role") @db.VarChar(32) // 'MERCHANT' | 'ADMIN' | 'SYSTEM'
  blueprintRevision Int      @default(0) @map("blueprint_revision")
  summaryJson       Json     @default("{}") @map("summary_json")
  createdAt         DateTime @default(now()) @map("created_at")

  @@index([merchantId, createdAt(sort: Desc)], map: "idx_sandbox_sync_audit_merchant_created")
  @@map("sandbox_sync_audits")
}
```

#### 2.2.3 Add DDL + Trigger Fence in `core-back/prisma/prepare-databases.sh`

Add the `v38` migration block inside `core-back/prisma/prepare-databases.sh` **and** automatically create `payment_gateway_sandbox` whenever `prepare-databases.sh` runs in local/single-node environments so Live and Sandbox **never** share a database:

```sql
-- ============================================================================
-- MIGRATION v38: Strict Execution Plane Fence (LIVE vs SANDBOX) + Sync Audit
-- ============================================================================

DELETE FROM "platform_settings" WHERE "key" = 'OD-10';

CREATE TABLE IF NOT EXISTS "system_execution_plane" (
  "id" INTEGER PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "plane" VARCHAR(16) NOT NULL CHECK ("plane" IN ('LIVE', 'SANDBOX')),
  "allow_fake_rails" BOOLEAN NOT NULL DEFAULT FALSE,
  "live_sync_revision" INTEGER NOT NULL DEFAULT 0,
  "last_synced_from_live" TIMESTAMPTZ NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO "system_execution_plane" ("id", "plane", "allow_fake_rails")
VALUES (
  1,
  COALESCE(NULLIF(current_setting('app.execution_plane', true), ''), 'LIVE'),
  CASE WHEN COALESCE(NULLIF(current_setting('app.execution_plane', true), ''), 'LIVE') = 'SANDBOX' THEN TRUE ELSE FALSE END
)
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "sandbox_sync_audits" (
  "id" TEXT PRIMARY KEY,
  "sync_type" VARCHAR(48) NOT NULL,
  "merchant_id" TEXT NULL,
  "actor_id" TEXT NULL,
  "actor_role" VARCHAR(32) NULL,
  "blueprint_revision" INTEGER NOT NULL DEFAULT 0,
  "summary_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_sandbox_sync_audit_merchant_created"
  ON "sandbox_sync_audits" ("merchant_id", "created_at" DESC);

-- Hardware/DB-level trigger function: prevents ANY row with mismatched env from ever entering a table
CREATE OR REPLACE FUNCTION enforce_execution_plane_env_fence()
RETURNS TRIGGER AS $$
DECLARE
  v_plane VARCHAR(16);
BEGIN
  SELECT "plane" INTO v_plane FROM "system_execution_plane" WHERE "id" = 1;
  IF v_plane IS NULL THEN
    RAISE EXCEPTION 'SANDBOX_FENCE_VIOLATION: system_execution_plane row is missing';
  END IF;

  IF NEW."env"::text <> v_plane THEN
    RAISE EXCEPTION 'SANDBOX_FENCE_VIOLATION: Cannot write row with env=% into % database plane (table=%)',
      NEW."env", v_plane, TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach env fence to all env-tagged tables (payment_links, payment_attempts, merchant_api_tokens, refund_requests, disputes)
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_links', 'payment_attempts', 'merchant_api_tokens']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'env'
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_fence_plane_%I ON %I;', t, t);
      EXECUTE format(
        'CREATE TRIGGER trg_fence_plane_%I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_execution_plane_env_fence();',
        t, t
      );
    END IF;
  END LOOP;
END $$;

-- Prevent FAKE_* rail adapters from ever being registered or enabled on a LIVE database plane
CREATE OR REPLACE FUNCTION enforce_no_fake_rails_on_live_plane()
RETURNS TRIGGER AS $$
DECLARE
  v_plane VARCHAR(16);
  v_allow_fake BOOLEAN;
BEGIN
  SELECT "plane", "allow_fake_rails" INTO v_plane, v_allow_fake
  FROM "system_execution_plane" WHERE "id" = 1;

  IF v_plane = 'LIVE' AND v_allow_fake = FALSE THEN
    IF (NEW."adapterKey" ILIKE 'FAKE%' OR NEW."endpointUrl" ILIKE '%fake-rails%') AND NEW."enabled" = TRUE THEN
      RAISE EXCEPTION 'SANDBOX_FENCE_VIOLATION: Fake Rails adapter (%) cannot be enabled on LIVE execution plane',
        NEW."adapterKey"
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fence_fake_rails_gateways ON "gateways";
CREATE TRIGGER trg_fence_fake_rails_gateways
  BEFORE INSERT OR UPDATE ON "gateways"
  FOR EACH ROW EXECUTE FUNCTION enforce_no_fake_rails_on_live_plane();
```

#### 2.2.4 Startup Execution Plane Boot Guard (`core-back/engine/PlaneFenceGuard.ts`)

Called at the very top of `core-back/index.ts` before starting Express or any background worker:

```ts
// core-back/engine/PlaneFenceGuard.ts
import client from "../prisma/client";
import { getExecutionPlane } from "../lib/executionPlane";

export async function verifyExecutionPlaneFenceOnBoot(): Promise<void> {
  const expectedPlane = getExecutionPlane();
  const fakeRailsEnabled =
    String(process.env.FAKE_RAILS_ENABLED || "false").toLowerCase() === "true";

  if (expectedPlane === "LIVE" && fakeRailsEnabled) {
    throw new Error(
      "FATAL_PLANE_FENCE_VIOLATION: FAKE_RAILS_ENABLED=true is strictly forbidden when EXECUTION_PLANE=LIVE.",
    );
  }

  const row = await client.systemExecutionPlane.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      plane: expectedPlane,
      allowFakeRails: expectedPlane === "SANDBOX",
    },
  });

  if (row.plane !== expectedPlane) {
    throw new Error(
      `FATAL_PLANE_FENCE_VIOLATION: Process started with EXECUTION_PLANE=${expectedPlane}, ` +
        `but connected database has system_execution_plane.plane=${row.plane}. ` +
        `Refusing to boot to prevent Live/Sandbox cross-contamination!`,
    );
  }

  if (expectedPlane === "LIVE" && row.allowFakeRails) {
    throw new Error(
      "FATAL_PLANE_FENCE_VIOLATION: Database system_execution_plane.allow_fake_rails is TRUE on LIVE plane.",
    );
  }
}
```

## 3. Redesigning `fake-rails-back` (`v2`): Stateful Customer Accounts, Balances, Holds & Clearing Pools

We redesign `fake-rails-back` so that it is no longer a stateless random-number responder, but a **stateful financial switch emulator** where every test phone number, bank account, card PAN, and voucher has a controllable balance, daily limit, hold ledger, and movement history.

### 3.1 Upgrade `fake-rails-back/engine/db/schema.sql`

Add the 4 stateful account & clearing tables (`fake_accounts`, `fake_account_holds`, `fake_account_movements`, `fake_merchant_clearing_pools`) to `fake-rails-back/engine/db/schema.sql`:

```
-- ============================================================================
-- ADD TO fake-rails-back/engine/db/schema.sql (Stateful Fake Rails v2)
-- ============================================================================

CREATE TABLE IF NOT EXISTS fake_accounts (
  id TEXT PRIMARY KEY,
  rail_code TEXT NOT NULL,
  gateway_code TEXT NOT NULL,
  merchant_id TEXT, -- NULL = global pre-seeded test account; UUID = merchant-custom sandbox test account
  instrument_type TEXT NOT NULL DEFAULT 'MOBILE_WALLET', -- 'MOBILE_WALLET' | 'BANK_ACCOUNT' | 'CARD' | 'VOUCHER'
  identifier TEXT NOT NULL, -- Phone (0911111111), Card PAN (6280001111111111), IBAN, or Voucher Code
  holder_name TEXT NOT NULL,
  secret_pin TEXT NOT NULL DEFAULT '1234', -- PIN or CVV
  expiry TEXT DEFAULT '12/28',
  currency TEXT NOT NULL DEFAULT 'LYD',
  available_balance_lyd TEXT NOT NULL DEFAULT '5000.0000',
  reserved_balance_lyd TEXT NOT NULL DEFAULT '0.0000',
  daily_limit_lyd TEXT NOT NULL DEFAULT '10000.0000',
  daily_spent_lyd TEXT NOT NULL DEFAULT '0.0000',
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE' | 'FROZEN' | 'EXPIRED' | 'BLOCKED'
  static_otp TEXT, -- Optional fixed OTP override (when NULL, uses deterministic HMAC OTP)
  preset_fault TEXT, -- Optional deterministic fault ('NONE', 'INSUFFICIENT_FUNDS', 'LIMIT_EXCEEDED', 'TIMEOUT_ON_SUBMIT', etc.)
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(rail_code, identifier)
);

CREATE INDEX IF NOT EXISTS idx_fake_accounts_rail ON fake_accounts(rail_code, status);
CREATE INDEX IF NOT EXISTS idx_fake_accounts_gateway ON fake_accounts(gateway_code);
CREATE INDEX IF NOT EXISTS idx_fake_accounts_merchant ON fake_accounts(merchant_id);

CREATE TABLE IF NOT EXISTS fake_account_holds (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES fake_accounts(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  amount_lyd TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'HELD', -- 'HELD' | 'CAPTURED' | 'RELEASED'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_fake_holds_account ON fake_account_holds(account_id, state);

CREATE TABLE IF NOT EXISTS fake_account_movements (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES fake_accounts(id) ON DELETE CASCADE,
  transaction_id TEXT,
  direction TEXT NOT NULL, -- 'HOLD' | 'CAPTURE' | 'RELEASE' | 'REFUND_CREDIT' | 'BALANCE_ADJUSTMENT'
  amount_lyd TEXT NOT NULL,
  available_before_lyd TEXT NOT NULL,
  available_after_lyd TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fake_movements_account ON fake_account_movements(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fake_merchant_clearing_pools (
  id TEXT PRIMARY KEY,
  gateway_code TEXT NOT NULL,
  rail_code TEXT NOT NULL,
  pending_settlement_lyd TEXT NOT NULL DEFAULT '0.0000',
  settled_lyd TEXT NOT NULL DEFAULT '0.0000',
  accumulated_gateway_fee_lyd TEXT NOT NULL DEFAULT '0.0000',
  tx_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(gateway_code, rail_code)
);


```

Also add `account_id TEXT` and `held_amount_lyd TEXT` columns to `fake_transactions` in `fake-rails-back/engine/db/schema.sql`.

### 3.2 Create `fake-rails-back/engine/accounts/AccountLedgerService.ts`

Create `fake-rails-back/engine/accounts/AccountLedgerService.ts` to seed the 5 canonical personas per rail and execute atomic SQLite balance checks, holds, captures, releases, refunds, and user-driven balance adjustments:

```
// fake-rails-back/engine/accounts/AccountLedgerService.ts
import { getDb, nowIso, uuidv7 } from "../db";
import { DEFAULT_RAIL_DESCRIPTORS, type RailDescriptor } from "../chaos/DefaultRailScenarios";

export interface FakeAccountRow {
  id: string;
  rail_code: string;
  gateway_code: string;
  merchant_id: string | null;
  instrument_type: "MOBILE_WALLET" | "BANK_ACCOUNT" | "CARD" | "VOUCHER";
  identifier: string;
  holder_name: string;
  secret_pin: string;
  expiry: string | null;
  currency: string;
  available_balance_lyd: string;
  reserved_balance_lyd: string;
  daily_limit_lyd: string;
  daily_spent_lyd: string;
  status: "ACTIVE" | "FROZEN" | "EXPIRED" | "BLOCKED";
  static_otp: string | null;
  preset_fault: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const toMicros = (lyd: string | number): bigint => {
  const num = Number(String(lyd).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(num)) return 0n;
  return BigInt(Math.round(num * 10_000));
};

const fromMicros = (micros: bigint): string => {
  const sign = micros < 0n ? "-" : "";
  const abs = micros < 0n ? -micros : micros;
  const whole = abs / 10_000n;
  const frac = (abs % 10_000n).toString().padStart(4, "0");
  return `${sign}${whole.toString()}.${frac}`;
};

function defaultInstrumentForRail(rail: RailDescriptor): {
  type: "MOBILE_WALLET" | "BANK_ACCOUNT" | "CARD" | "VOUCHER";
  ids: [string, string, string, string, string];
  pin: string;
} {
  if (["moamalat", "mpgs", "numo_pay", "tadawul", "mypay", "dpay", "plutu"].includes(rail.gatewayCode)) {
    const prefix = rail.gatewayCode === "mpgs" ? "512345" : "628000";
    return {
      type: "CARD",
      ids: [
        `${prefix}1111111111`, // Rich Card
        `${prefix}2222222222`, // Standard Card
        `${prefix}0000000005`, // Low Balance (5 LYD)
        `${prefix}0000000061`, // Limit Exhausted
        `${prefix}0000000999`, // Frozen Card
      ],
      pin: "123",
    };
  }
  if (rail.gatewayCode === "neompay") {
    return {
      type: "MOBILE_WALLET",
      ids: [
        "NEOM-WALLET-RICH-01",
        "NEOM-WALLET-STD-02",
        "NEOM-WALLET-LOW-05",
        "NEOM-WALLET-LIM-61",
        "NEOM-WALLET-FRZ-99",
      ],
      pin: "1234",
    };
  }
  return {
    type: "MOBILE_WALLET",
    ids: [
      "0911111111", // Rich Mobile Wallet (50,000 LYD)
      "0912222222", // Standard Mobile Wallet (1,500 LYD)
      "0910000005", // Low Balance Wallet (5 LYD -> triggers INSUFFICIENT_FUNDS)
      "0910000061", // Daily Limit Exhausted (50 LYD limit, 45 LYD spent -> triggers LIMIT_EXCEEDED)
      "0910000999", // Frozen Account (triggers ACCOUNT_FROZEN)
    ],
    pin: "1234",
  };
}

export function ensureDefaultFakeAccountsSeeded(): void {
  const db = getDb();
  const now = nowIso();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO fake_accounts (
      id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
      holder_name, secret_pin, expiry, currency, available_balance_lyd,
      reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, status,
      static_otp, preset_fault, notes, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, '12/28', 'LYD', ?, '0.0000', ?, ?, ?, NULL, ?, ?, ?, ?)
  `);

  const insertPool = db.prepare(`
    INSERT OR IGNORE INTO fake_merchant_clearing_pools (
      id, gateway_code, rail_code, pending_settlement_lyd, settled_lyd,
      accumulated_gateway_fee_lyd, tx_count, updated_at
    ) VALUES (?, ?, ?, '0.0000', '0.0000', '0.0000', 0, ?)
  `);

  db.transaction(() => {
    for (const rail of DEFAULT_RAIL_DESCRIPTORS) {
      insertPool.run(uuidv7(), rail.gatewayCode, rail.railCode, now);
      const spec = defaultInstrumentForRail(rail);
      const personas = [
        {
          id: spec.ids[0],
          name: `${rail.name} — High-Balance Test Account`,
          avail: "50000.0000",
          limit: "25000.0000",
          spent: "0.0000",
          status: "ACTIVE",
          fault: null,
          notes: "Default rich test account; succeeds for all normal amounts",
        },
        {
          id: spec.ids[1],
          name: `${rail.name} — Standard Test Account`,
          avail: "1500.0000",
          limit: "2000.0000",
          spent: "0.0000",
          status: "ACTIVE",
          fault: null,
          notes: "Standard retail customer balance (1,500 LYD)",
        },
        {
          id: spec.ids[2],
          name: `${rail.name} — Low Balance Account (5 LYD)`,
          avail: "5.0000",
          limit: "2000.0000",
          spent: "0.0000",
          status: "ACTIVE",
          fault: null,
          notes: "Fails with INSUFFICIENT_FUNDS for any charge above 5.0000 LYD",
        },
        {
          id: spec.ids[3],
          name: `${rail.name} — Near Daily Limit (5 LYD Remaining)`,
          avail: "5000.0000",
          limit: "50.0000",
          spent: "45.0000",
          status: "ACTIVE",
          fault: null,
          notes: "Has 5,000 LYD balance but only 5 LYD left on daily limit -> triggers LIMIT_EXCEEDED",
        },
        {
          id: spec.ids[4],
          name: `${rail.name} — Frozen / Blocked Account`,
          avail: "10000.0000",
          limit: "5000.0000",
          spent: "0.0000",
          status: "FROZEN",
          fault: "TERMINAL_DECLINE_INSUFFICIENT_FUNDS",
          notes: "Account status is FROZEN -> rejected immediately at INITIATE",
        },
      ];

      for (const p of personas) {
        insert.run(
          uuidv7(),
          rail.railCode,
          rail.gatewayCode,
          spec.type,
          p.id,
          p.name,
          spec.pin,
          p.avail,
          p.limit,
          p.spent,
          p.status,
          p.fault,
          p.notes,
          now,
          now
        );
      }
    }
  })();
}

export function listFakeAccounts(filters?: {
  railCode?: string;
  gatewayCode?: string;
  merchantId?: string;
}): FakeAccountRow[] {
  ensureDefaultFakeAccountsSeeded();
  const db = getDb();
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters?.railCode) {
    clauses.push("rail_code = ?");
    params.push(filters.railCode);
  }
  if (filters?.gatewayCode) {
    clauses.push("gateway_code = ?");
    params.push(filters.gatewayCode);
  }
  if (filters?.merchantId) {
    clauses.push("(merchant_id IS NULL OR merchant_id = ?)");
    params.push(filters.merchantId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM fake_accounts ${where} ORDER BY created_at ASC, identifier ASC`)
    .all(...params) as FakeAccountRow[];
}

export function findOrAutoCreateAccount(
  railCode: string,
  gatewayCode: string,
  identifier: string | null
): FakeAccountRow {
  ensureDefaultFakeAccountsSeeded();
  const db = getDb();
  const cleanId = (identifier ?? "").replace(/\s+/g, "").trim();

  if (cleanId) {
    const exact = db
      .prepare(`SELECT * FROM fake_accounts WHERE rail_code = ? AND identifier = ? LIMIT 1`)
      .get(railCode, cleanId) as FakeAccountRow | undefined;
    if (exact) return exact;

    const byGateway = db
      .prepare(`SELECT * FROM fake_accounts WHERE gateway_code = ? AND identifier = ? LIMIT 1`)
      .get(gatewayCode, cleanId) as FakeAccountRow | undefined;
    if (byGateway) return byGateway;

    // Auto-enroll unknown identifier with default 2,500.0000 LYD balance so ad-hoc test inputs also become controllable!
    const now = nowIso();
    const newId = uuidv7();
    db.prepare(`
      INSERT INTO fake_accounts (
        id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
        holder_name, secret_pin, expiry, currency, available_balance_lyd,
        reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, status,
        static_otp, preset_fault, notes, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, 'MOBILE_WALLET', ?, ?, '1234', '12/28', 'LYD', '2500.0000', '0.0000', '5000.0000', '0.0000', 'ACTIVE', NULL, NULL, 'Auto-created on checkout', ?, ?)
    `).run(newId, railCode, gatewayCode, cleanId, `Ad-hoc Test Account (${cleanId})`, now, now);
    return db.prepare(`SELECT * FROM fake_accounts WHERE id = ?`).get(newId) as FakeAccountRow;
  }

  // Fallback to the first ACTIVE rich account for this rail
  const fallback = db
    .prepare(`SELECT * FROM fake_accounts WHERE (rail_code = ? OR gateway_code = ?) AND status = 'ACTIVE' ORDER BY created_at ASC LIMIT 1`)
    .get(railCode, gatewayCode) as FakeAccountRow | undefined;
  if (fallback) return fallback;

  throw new Error(`No fake account available for rail=${railCode}`);
}

export interface HoldCheckResult {
  allowed: boolean;
  declineCode?: "ACCOUNT_FROZEN" | "INSUFFICIENT_FUNDS" | "LIMIT_EXCEEDED";
  declineMessage?: string;
  account: FakeAccountRow;
}

/**
 * Executed at INITIATE time: checks account status, daily limit, and available balance,
 * and places an atomic reservation hold on `fake_accounts` + `fake_account_holds`.
 */
export function reserveAccountFundsForTransaction(params: {
  railCode: string;
  gatewayCode: string;
  identifier: string | null;
  transactionId: string;
  amountLyd: string;
}): HoldCheckResult {
  const db = getDb();
  return db.transaction(() => {
    const account = findOrAutoCreateAccount(params.railCode, params.gatewayCode, params.identifier);
    if (account.status !== "ACTIVE") {
      return {
        allowed: false,
        declineCode: "ACCOUNT_FROZEN",
        declineMessage: `Account ${account.identifier} is ${account.status}`,
        account,
      };
    }

    const reqMicros = toMicros(params.amountLyd);
    const availMicros = toMicros(account.available_balance_lyd);
    const resMicros = toMicros(account.reserved_balance_lyd);
    const limitMicros = toMicros(account.daily_limit_lyd);
    const spentMicros = toMicros(account.daily_spent_lyd);

    if (availMicros < reqMicros) {
      return {
        allowed: false,
        declineCode: "INSUFFICIENT_FUNDS",
        declineMessage: `Account ${account.identifier} available balance (${account.available_balance_lyd} LYD) is less than requested (${params.amountLyd} LYD)`,
        account,
      };
    }

    if (spentMicros + reqMicros > limitMicros) {
      return {
        allowed: false,
        declineCode: "LIMIT_EXCEEDED",
        declineMessage: `Account ${account.identifier} daily limit (${account.daily_limit_lyd} LYD) exceeded (already spent: ${account.daily_spent_lyd} LYD)`,
        account,
      };
    }

    const existingHold = db
      .prepare(`SELECT * FROM fake_account_holds WHERE transaction_id = ?`)
      .get(params.transactionId) as { id: string; state: string } | undefined;

    if (!existingHold) {
      const newAvail = fromMicros(availMicros - reqMicros);
      const newRes = fromMicros(resMicros + reqMicros);
      const now = nowIso();

      db.prepare(`
        UPDATE fake_accounts
           SET available_balance_lyd = ?, reserved_balance_lyd = ?, updated_at = ?
         WHERE id = ?
      `).run(newAvail, newRes, now, account.id);

      db.prepare(`
        INSERT INTO fake_account_holds (id, account_id, transaction_id, amount_lyd, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'HELD', ?, ?)
      `).run(uuidv7(), account.id, params.transactionId, fromMicros(reqMicros), now, now);

      db.prepare(`
        INSERT INTO fake_account_movements (
          id, account_id, transaction_id, direction, amount_lyd,
          available_before_lyd, available_after_lyd, reason, actor, created_at
        ) VALUES (?, ?, ?, 'HOLD', ?, ?, ?, 'Payment initiated hold', 'switch', ?)
      `).run(uuidv7(), account.id, params.transactionId, fromMicros(reqMicros), account.available_balance_lyd, newAvail, now);
    }

    const updated = db.prepare(`SELECT * FROM fake_accounts WHERE id = ?`).get(account.id) as FakeAccountRow;
    return { allowed: true, account: updated };
  })();
}

/**
 * Executed at SUBMIT / CONFIRM / Hosted APPROVE: captures the held funds, increments daily_spent_lyd,
 * and credits the Fake Rails merchant clearing pool.
 */
export function captureAccountHoldForTransaction(transactionId: string, settledOverrideLyd?: string): FakeAccountRow | null {
  const db = getDb();
  return db.transaction(() => {
    const hold = db
      .prepare(`SELECT * FROM fake_account_holds WHERE transaction_id = ?`)
      .get(transactionId) as { id: string; account_id: string; amount_lyd: string; state: string } | undefined;
    if (!hold) return null;
    const account = db.prepare(`SELECT * FROM fake_accounts WHERE id = ?`).get(hold.account_id) as FakeAccountRow;
    if (hold.state === "CAPTURED") return account;

    const holdMicros = toMicros(hold.amount_lyd);
    const captureMicros = settledOverrideLyd ? toMicros(settledOverrideLyd) : holdMicros;
    const resMicros = toMicros(account.reserved_balance_lyd);
    const spentMicros = toMicros(account.daily_spent_lyd);
    const availMicros = toMicros(account.available_balance_lyd);

    const nextRes = resMicros >= holdMicros ? resMicros - holdMicros : 0n;
    const extraDiff = captureMicros - holdMicros;
    const nextAvail = availMicros - extraDiff;
    const nextSpent = spentMicros + captureMicros;
    const now = nowIso();

    db.prepare(`
      UPDATE fake_accounts
         SET available_balance_lyd = ?, reserved_balance_lyd = ?, daily_spent_lyd = ?, updated_at = ?
       WHERE id = ?
    `).run(fromMicros(nextAvail), fromMicros(nextRes), fromMicros(nextSpent), now, account.id);

    db.prepare(`UPDATE fake_account_holds SET state = 'CAPTURED', updated_at = ? WHERE id = ?`).run(now, hold.id);

    db.prepare(`
      INSERT INTO fake_account_movements (
        id, account_id, transaction_id, direction, amount_lyd,
        available_before_lyd, available_after_lyd, reason, actor, created_at
      ) VALUES (?, ?, ?, 'CAPTURE', ?, ?, ?, 'Payment confirmed & settled', 'switch', ?)
    `).run(uuidv7(), account.id, transactionId, fromMicros(captureMicros), account.available_balance_lyd, fromMicros(nextAvail), now);

    return db.prepare(`SELECT * FROM fake_accounts WHERE id = ?`).get(account.id) as FakeAccountRow;
  })();
}

/**
 * Executed on CANCEL / DECLINE / Expiry: releases held funds back to available_balance_lyd.
 */
export function releaseAccountHoldForTransaction(transactionId: string, reason = "Payment cancelled or declined"): FakeAccountRow | null {
  const db = getDb();
  return db.transaction(() => {
    const hold = db
      .prepare(`SELECT * FROM fake_account_holds WHERE transaction_id = ?`)
      .get(transactionId) as { id: string; account_id: string; amount_lyd: string; state: string } | undefined;
    if (!hold) return null;
    const account = db.prepare(`SELECT * FROM fake_accounts WHERE id = ?`).get(hold.account_id) as FakeAccountRow;
    if (hold.state !== "HELD") return account;

    const holdMicros = toMicros(hold.amount_lyd);
    const availMicros = toMicros(account.available_balance_lyd);
    const resMicros = toMicros(account.reserved_balance_lyd);
    const nextAvail = fromMicros(availMicros + holdMicros);
    const nextRes = fromMicros(resMicros >= holdMicros ? resMicros - holdMicros : 0n);
    const now = nowIso();

    db.prepare(`
      UPDATE fake_accounts
         SET available_balance_lyd = ?, reserved_balance_lyd = ?, updated_at = ?
       WHERE id = ?
    `).run(nextAvail, nextRes, now, account.id);

    db.prepare(`UPDATE fake_account_holds SET state = 'RELEASED', updated_at = ? WHERE id = ?`).run(now, hold.id);

    db.prepare(`
      INSERT INTO fake_account_movements (
        id, account_id, transaction_id, direction, amount_lyd,
        available_before_lyd, available_after_lyd, reason, actor, created_at
      ) VALUES (?, ?, ?, 'RELEASE', ?, ?, ?, ?, 'switch', ?)
    `).run(uuidv7(), account.id, transactionId, hold.amount_lyd, account.available_balance_lyd, nextAvail, reason, now);

    return db.prepare(`SELECT * FROM fake_accounts WHERE id = ?`).get(account.id) as FakeAccountRow;
  })();
}

/**
 * Executed when a user/merchant/tester adjusts an account's balance, daily limit, or status
 * from the Merchant Sandbox Portal, Fake Rails Portal, or Checkout Sandbox Inspector Drawer!
 */
export function adjustFakeAccountBalance(params: {
  accountId: string;
  availableBalanceLyd?: string;
  dailyLimitLyd?: string;
  dailySpentLyd?: string;
  status?: "ACTIVE" | "FROZEN" | "EXPIRED" | "BLOCKED";
  staticOtp?: string | null;
  presetFault?: string | null;
  actor?: string;
  reason?: string;
}): FakeAccountRow {
  const db = getDb();
  return db.transaction(() => {
    const account = db.prepare(`SELECT * FROM fake_accounts WHERE id = ?`).get(params.accountId) as FakeAccountRow | undefined;
    if (!account) {
      throw new Error(`Fake account ${params.accountId} not found`);
    }
    const nextAvail = params.availableBalanceLyd !== undefined ? fromMicros(toMicros(params.availableBalanceLyd)) : account.available_balance_lyd;
    const nextLimit = params.dailyLimitLyd !== undefined ? fromMicros(toMicros(params.dailyLimitLyd)) : account.daily_limit_lyd;
    const nextSpent = params.dailySpentLyd !== undefined ? fromMicros(toMicros(params.dailySpentLyd)) : account.daily_spent_lyd;
    const nextStatus = params.status ?? account.status;
    const nextOtp = params.staticOtp !== undefined ? params.staticOtp : account.static_otp;
    const nextFault = params.presetFault !== undefined ? params.presetFault : account.preset_fault;
    const now = nowIso();

    db.prepare(`
      UPDATE fake_accounts
         SET available_balance_lyd = ?,
             daily_limit_lyd = ?,
             daily_spent_lyd = ?,
             status = ?,
             static_otp = ?,
             preset_fault = ?,
             updated_at = ?
       WHERE id = ?
    `).run(nextAvail, nextLimit, nextSpent, nextStatus, nextOtp, nextFault, now, account.id);

    if (nextAvail !== account.available_balance_lyd) {
      const diff = toMicros(nextAvail) - toMicros(account.available_balance_lyd);
      db.prepare(`
        INSERT INTO fake_account_movements (
          id, account_id, transaction_id, direction, amount_lyd,
          available_before_lyd, available_after_lyd, reason, actor, created_at
        ) VALUES (?, ?, NULL, 'BALANCE_ADJUSTMENT', ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv7(),
        account.id,
        fromMicros(diff >= 0n ? diff : -diff),
        account.available_balance_lyd,
        nextAvail,
        params.reason ?? "Manual sandbox balance adjustment",
        params.actor ?? "sandbox-user",
        now
      );
    }

    return db.prepare(`SELECT * FROM fake_accounts WHERE id = ?`).get(account.id) as FakeAccountRow;
  })();
}


```

### 3.3 Wire Stateful Account Holds & Captures Into `fake-rails-back/api/rails/common.ts` & `handlers.ts`

In `fake-rails-back/api/rails/common.ts` and `fake-rails-back/api/rails/handlers.ts`:

1. **At `INITIATE` time (in `otpInitiate`, `asyncInitiate`, `redirectInitiate`, and `embeddedRouter.ts`):** Call `reserveAccountFundsForTransaction()` before returning `AWAITING_CUSTOMER`:

   ```
   // Inside fake-rails-back/api/rails/handlers.ts
   import {
     captureAccountHoldForTransaction,
     releaseAccountHoldForTransaction,
     reserveAccountFundsForTransaction,
   } from "../../engine/accounts/AccountLedgerService";
   
   export const otpInitiate: RailHandler = (context) => {
     const hold = reserveAccountFundsForTransaction({
       railCode: context.descriptor.railCode,
       gatewayCode: context.descriptor.gatewayCode,
       identifier: context.customer,
       transactionId: context.transaction.id,
       amountLyd: context.transaction.normalized_amount_lyd,
     });
     if (!hold.allowed) {
       updateTransaction(context.transaction.id, { status: "FAILED" });
       return {
         status: 200,
         body: {
           reference: context.reference,
           our_reference: context.transaction.our_reference,
           provider_reference: context.transaction.provider_reference,
           status: "FAILED",
           success: false,
           error: hold.declineCode ?? "INSUFFICIENT_FUNDS",
           error_code: hold.declineCode ?? "INSUFFICIENT_FUNDS",
           message: hold.declineMessage ?? "Declined by account balance/limit check",
           ActionCode: hold.declineCode === "LIMIT_EXCEEDED" ? "61" : "51",
         },
       };
     }
     // If the test account has a static_otp configured, pin it on the transaction
     if (hold.account.static_otp) {
       updateTransaction(context.transaction.id, { expected_otp: hold.account.static_otp });
       context.transaction.expected_otp = hold.account.static_otp;
     }
     return awaitingBody(context, {
       account_identifier: hold.account.identifier,
       available_balance_after_hold_lyd: hold.account.available_balance_lyd,
     });
   };
   
   
   ```

2. **At `SUBMIT` / `CONFIRM` time (in `otpConfirm`, `asyncConfirm`, and `hosted.ts` `APPROVE`):** Call `captureAccountHoldForTransaction(context.transaction.id)` right before `successResponse(context, "PAID")` and `dispatchSuccessWebhook(context, "payment.paid")`.

3. **At `CANCEL` / `DECLINE` time:** Call `releaseAccountHoldForTransaction(context.transaction.id, "Declined or cancelled")`.

4. **At `REFUND` time (in `refund` handler in `fake-rails-back/api/rails/handlers.ts`):** Credit the refunded amount back to the customer's `available_balance_lyd` via `adjustFakeAccountBalance()`.

### 3.4 Complete Verbatim Code for `fake-rails-back/api/portal/accounts.ts`

Create `fake-rails-back/api/portal/accounts.ts` and mount it at `/portal-api` in `fake-rails-back/api/portal/index.ts`:

```
// fake-rails-back/api/portal/accounts.ts
import { Router } from "express";
import { z } from "zod";
import {
  adjustFakeAccountBalance,
  captureAccountHoldForTransaction,
  ensureDefaultFakeAccountsSeeded,
  listFakeAccounts,
  releaseAccountHoldForTransaction,
} from "../../engine/accounts/AccountLedgerService";
import {
  findTransactionAnyReference,
  getDb,
  nowIso,
  updateTransaction,
  uuidv7,
} from "../../engine/db";
import { ApiError, parseOrThrow } from "../../lib/error";
import { webhookDispatcher } from "../../engine/webhooks/WebhookDispatcher";
import { broadcast } from "./eventHub";

const createAccountSchema = z.object({
  railCode: z.string().min(2).max(64),
  gatewayCode: z.string().min(2).max(64),
  merchantId: z.string().uuid().optional().nullable(),
  instrumentType: z.enum(["MOBILE_WALLET", "BANK_ACCOUNT", "CARD", "VOUCHER"]).default("MOBILE_WALLET"),
  identifier: z.string().min(3).max(64),
  holderName: z.string().min(2).max(120),
  secretPin: z.string().min(3).max(16).default("1234"),
  expiry: z.string().max(16).optional().nullable(),
  availableBalanceLyd: z.string().regex(/^\d+(\.\d{1,4})?$/).default("5000.0000"),
  dailyLimitLyd: z.string().regex(/^\d+(\.\d{1,4})?$/).default("10000.0000"),
  status: z.enum(["ACTIVE", "FROZEN", "EXPIRED", "BLOCKED"]).default("ACTIVE"),
  staticOtp: z.string().regex(/^\d{4,8}$/).optional().nullable(),
  notes: z.string().max(255).optional().nullable(),
});

const patchAccountSchema = z.object({
  availableBalanceLyd: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  dailyLimitLyd: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  dailySpentLyd: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  status: z.enum(["ACTIVE", "FROZEN", "EXPIRED", "BLOCKED"]).optional(),
  staticOtp: z.string().regex(/^\d{4,8}$/).optional().nullable(),
  presetFault: z.string().max(64).optional().nullable(),
  quickPreset: z
    .enum(["SET_ZERO", "SET_LINK_AMOUNT", "TOP_UP_5000", "RESET_DAILY_SPENT"])
    .optional(),
  linkAmountLyd: z.string().optional(),
  reason: z.string().max(255).optional(),
});

const simulateActionSchema = z.object({
  action: z.enum([
    "APPROVE_PUSH_OR_QR",
    "DECLINE_PUSH_OR_QR",
    "APPROVE_WITH_VARIANCE",
    "FIRE_WEBHOOK_NOW",
    "REPLAY_DUPLICATE_WEBHOOK",
    "FIRE_TAMPERED_WEBHOOK",
  ]),
});

export const createAccountsRouter = (): Router => {
  const router = Router();

  router.get("/accounts", (req, res) => {
    const railCode = typeof req.query.railCode === "string" ? req.query.railCode : undefined;
    const gatewayCode = typeof req.query.gatewayCode === "string" ? req.query.gatewayCode : undefined;
    const merchantId = typeof req.query.merchantId === "string" ? req.query.merchantId : undefined;
    const accounts = listFakeAccounts({ railCode, gatewayCode, merchantId });
    res.json({ accounts });
  });

  router.post("/accounts", (req, res) => {
    ensureDefaultFakeAccountsSeeded();
    const body = parseOrThrow(createAccountSchema, req.body);
    const db = getDb();
    const id = uuidv7();
    const now = nowIso();
    db.prepare(`
      INSERT INTO fake_accounts (
        id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
        holder_name, secret_pin, expiry, currency, available_balance_lyd,
        reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, status,
        static_otp, preset_fault, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'LYD', ?, '0.0000', ?, '0.0000', ?, ?, NULL, ?, ?, ?)
    `).run(
      id,
      body.railCode,
      body.gatewayCode,
      body.merchantId ?? null,
      body.instrumentType,
      body.identifier.trim(),
      body.holderName.trim(),
      body.secretPin,
      body.expiry ?? "12/28",
      Number(body.availableBalanceLyd).toFixed(4),
      Number(body.dailyLimitLyd).toFixed(4),
      body.status,
      body.staticOtp ?? null,
      body.notes ?? null,
      now,
      now
    );
    const created = db.prepare(`SELECT * FROM fake_accounts WHERE id = ?`).get(id);
    res.status(201).json({ account: created });
  });

  router.patch("/accounts/:accountId", (req, res) => {
    const accountId = String(req.params.accountId ?? "");
    const body = parseOrThrow(patchAccountSchema, req.body);
    const db = getDb();
    const current = db.prepare(`SELECT * FROM fake_accounts WHERE id = ?`).get(accountId) as any;
    if (!current) {
      throw new ApiError(404, "FAKE_ACCOUNT_NOT_FOUND", `Account ${accountId} not found`);
    }

    let availableBalanceLyd = body.availableBalanceLyd;
    let dailySpentLyd = body.dailySpentLyd;
    if (body.quickPreset === "SET_ZERO") {
      availableBalanceLyd = "0.0000";
    } else if (body.quickPreset === "SET_LINK_AMOUNT" && body.linkAmountLyd) {
      availableBalanceLyd = Number(body.linkAmountLyd).toFixed(4);
    } else if (body.quickPreset === "TOP_UP_5000") {
      availableBalanceLyd = (Number(current.available_balance_lyd) + 5000).toFixed(4);
    } else if (body.quickPreset === "RESET_DAILY_SPENT") {
      dailySpentLyd = "0.0000";
    }

    const updated = adjustFakeAccountBalance({
      accountId,
      availableBalanceLyd,
      dailyLimitLyd: body.dailyLimitLyd,
      dailySpentLyd,
      status: body.status,
      staticOtp: body.staticOtp,
      presetFault: body.presetFault,
      reason: body.reason ?? `Quick preset: ${body.quickPreset ?? "manual edit"}`,
    });
    broadcast("account.updated", { account: updated });
    res.json({ account: updated });
  });

  router.get("/accounts/:accountId/movements", (req, res) => {
    const accountId = String(req.params.accountId ?? "");
    const movements = getDb()
      .prepare(`SELECT * FROM fake_account_movements WHERE account_id = ? ORDER BY created_at DESC LIMIT 100`)
      .all(accountId);
    res.json({ movements });
  });

  router.get("/checkout-helper/:reference", (req, res) => {
    const reference = String(req.params.reference ?? "");
    const tx = findTransactionAnyReference(reference);
    if (!tx) {
      return res.json({ activeAttemptSecrets: null });
    }
    const db = getDb();
    const hold = db
      .prepare(`SELECT * FROM fake_account_holds WHERE transaction_id = ?`)
      .get(tx.id) as { account_id: string; amount_lyd: string; state: string } | undefined;
    const account = hold
      ? (db.prepare(`SELECT * FROM fake_accounts WHERE id = ?`).get(hold.account_id) as any)
      : null;
    const events = db
      .prepare(`SELECT phase, response_status as status, injected_fault as fault, duration_ms as durationMs, created_at as createdAt FROM fake_step_events WHERE transaction_id = ? ORDER BY created_at DESC LIMIT 10`)
      .all(tx.id);

    const asyncModes = new Set(["QR_DISPLAY", "PUSH_APPROVAL", "PAY_CODE", "DEEP_LINK", "REDIRECT", "EMBEDDED"]);
    res.json({
      activeAttemptSecrets: {
        ourReference: tx.our_reference,
        providerReference: tx.provider_reference,
        expectedOtp: tx.expected_otp,
        collectionMode: tx.collection_mode,
        boundAccountIdentifier: account?.identifier ?? tx.customer_identifier_masked ?? null,
        boundAccountBalanceAfterHoldLyd: account?.available_balance_lyd ?? null,
        heldAmountLyd: hold?.amount_lyd ?? null,
        canSimulateMobilePushOrQrApproval: asyncModes.has(tx.collection_mode) && tx.status !== "PAID",
        recentWireEvents: events,
      },
    });
  });

  router.post("/checkout-helper/:reference/simulate-action", (req, res) => {
    const reference = String(req.params.reference ?? "");
    const tx = findTransactionAnyReference(reference);
    if (!tx) {
      throw new ApiError(404, "FAKE_TX_NOT_FOUND", `Transaction ${reference} not found`);
    }
    const { action } = parseOrThrow(simulateActionSchema, req.body);

    const basePayload = {
      reference: tx.our_reference,
      our_reference: tx.our_reference,
      provider_reference: tx.provider_reference,
      transaction_id: tx.provider_reference,
      amount: tx.normalized_amount_lyd,
      currency: tx.currency,
    };

    if (action === "APPROVE_PUSH_OR_QR" || action === "FIRE_WEBHOOK_NOW") {
      captureAccountHoldForTransaction(tx.id);
      updateTransaction(tx.id, { status: "PAID", settled_amount_lyd: tx.normalized_amount_lyd });
      webhookDispatcher.dispatch({
        transaction: { ...tx, status: "PAID" },
        event: "payment.paid",
        payload: { ...basePayload, status: "PAID" },
      });
    } else if (action === "APPROVE_WITH_VARIANCE") {
      const varianceSettled = (Number(tx.normalized_amount_lyd) + 0.05).toFixed(4);
      captureAccountHoldForTransaction(tx.id, varianceSettled);
      updateTransaction(tx.id, { status: "PAID", settled_amount_lyd: varianceSettled });
      webhookDispatcher.dispatch({
        transaction: { ...tx, status: "PAID", settled_amount_lyd: varianceSettled },
        event: "payment.paid",
        payload: { ...basePayload, amount: varianceSettled, settled_amount: varianceSettled, status: "PAID" },
      });
    } else if (action === "DECLINE_PUSH_OR_QR") {
      releaseAccountHoldForTransaction(tx.id, "Customer rejected push/QR on simulated mobile app");
      updateTransaction(tx.id, { status: "FAILED" });
      webhookDispatcher.dispatch({
        transaction: { ...tx, status: "FAILED" },
        event: "payment.failed",
        payload: { ...basePayload, status: "FAILED", error: "CUSTOMER_REJECTED" },
      });
    } else if (action === "REPLAY_DUPLICATE_WEBHOOK") {
      webhookDispatcher.dispatch({
        transaction: { ...tx, status: "PAID" },
        event: "payment.paid",
        payload: { ...basePayload, status: "PAID" },
        behavior: { duplicateCount: 2 },
      });
    } else if (action === "FIRE_TAMPERED_WEBHOOK") {
      webhookDispatcher.dispatch({
        transaction: { ...tx, status: "PAID" },
        event: "payment.paid",
        payload: { ...basePayload, status: "PAID" },
        behavior: { corruptSignature: true },
      });
    }

    res.json({ ok: true, action, transactionId: tx.id });
  });

  return router;
};


```

## 4. Revealing Secrets, OTPs & Account Balances on the Checkout Page (`checkout-front`, `checkout-back`, `core-back`)

### 4.1 How the Checkout Secret & Balance Inspector Works End-to-End

When a customer opens a **Live** payment link (`/pay/pay_...` where `env === "LIVE"`):

* `core-back` (`EXECUTION_PLANE="LIVE"`) returns `env: "LIVE"` and **never** includes `sandboxInspector`.

* `checkout-front` renders the clean customer checkout screen with zero developer/sandbox UI.

When a merchant, developer, or QA tester opens a **Sandbox** payment link (`/pay/sbx_...` where `env === "SANDBOX"`):

* `checkout-back` sees the `sbx_` prefix and routes the request to `sandboxCorePool` (`pg-core-sandbox` on `SANDBOX_NODE`).

* `pg-core-sandbox` (`core-back/api/internal/checkout.ts`) queries `fake-rails-back` (`/portal-api/accounts` and `/portal-api/checkout-helper/:reference`) and attaches `sandboxInspector` to the `/pay/:linkKey` and `/pay/:linkKey/logs/:attemptId` responses (unless `application.sandboxInspectorMode === "DISABLED"`):

```
// Added to core-back/api/internal/checkout.ts (ONLY when env === "SANDBOX")
export interface SandboxCheckoutInspectorPayload {
  enabled: boolean;
  mode: "OPEN_IN_SANDBOX" | "PIN_PROTECTED";
  unlocked: boolean;
  railAccounts: Array<{
    id: string;
    railCode: string;
    instrumentType: string;
    identifier: string;
    holderName: string;
    secretPin: string;
    expiry: string | null;
    availableBalanceLyd: string;
    reservedBalanceLyd: string;
    dailyLimitLyd: string;
    dailySpentLyd: string;
    status: string;
    notes: string | null;
  }>;
  activeAttemptSecrets?: {
    ourReference: string;
    providerReference: string;
    expectedOtp: string | null;
    collectionMode: string;
    boundAccountIdentifier: string | null;
    boundAccountBalanceAfterHoldLyd: string | null;
    heldAmountLyd: string | null;
    qrPayload: string | null;
    deepLinkUrl: string | null;
    redirectUrl: string | null;
    canSimulateMobilePushOrQrApproval: boolean;
    recentWireEvents: Array<{
      phase: string;
      status: number;
      fault: string | null;
      durationMs: number;
      createdAt: string;
    }>;
  } | null;
}


```

### 4.2 New Sandbox Helper Endpoints on `checkout-back` (`checkout-back/api/public/pay.ts`) & `core-back` (`core-back/api/internal/checkout.ts`)

Add the following 3 endpoints to `checkout-back/api/public/pay.ts` (which refuse any non-`sbx_` link key with `403 SANDBOX_ONLY_ENDPOINT` and forward to `pg-core-sandbox`):

1. **`GET /api/v1/pay/:linkKey/sandbox-accounts?railCode=...`**

   * Lists the Fake Rails test accounts/cards/vouchers for `railCode` (or all visible rails on the link), including their live `available_balance_lyd`, `reserved_balance_lyd`, `daily_limit_lyd`, `daily_spent_lyd`, `secret_pin` (PIN/CVV), and `expiry`.

2. **`PATCH /api/v1/pay/:linkKey/sandbox-accounts/:accountId`**

   * Body: `{ availableBalanceLyd?: string, dailyLimitLyd?: string, dailySpentLyd?: string, status?: "ACTIVE" | "FROZEN", quickPreset?: "SET_ZERO" | "SET_LINK_AMOUNT" | "TOP_UP_5000" | "RESET_DAILY_SPENT" }`.

   * Updates the account balance on `fake-rails-back` immediately so the user can test `INSUFFICIENT_FUNDS`, `LIMIT_EXCEEDED`, or exact-amount boundary conditions right from the checkout screen!

3. **`POST /api/v1/pay/:linkKey/logs/:attemptId/sandbox-simulate`**

   * Body: `{ action: "APPROVE_PUSH_OR_QR" | "DECLINE_PUSH_OR_QR" | "APPROVE_WITH_VARIANCE" | "FIRE_WEBHOOK_NOW" | "REPLAY_DUPLICATE_WEBHOOK" | "FIRE_TAMPERED_WEBHOOK" }`.

   * Executes the simulated customer action on `fake-rails-back` and triggers the corresponding webhook/settlement so the user can complete `QR_DISPLAY`, `PUSH_APPROVAL`, `PAY_CODE`, `DEEP_LINK`, or `REDIRECT` flows without leaving the checkout page!

### 4.3 Create `checkout-front/src/components/sandbox/SandboxCheckoutInspector.tsx`

Create `checkout-front/src/components/sandbox/SandboxCheckoutInspector.tsx` and mount it inside `checkout-front/src/pages/pay/[linkKey]/index.tsx` whenever `summary.value?.env === "SANDBOX"`:

```
// checkout-front/src/components/sandbox/SandboxCheckoutInspector.tsx
import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { VAlert, VBtn, VChip, VDivider, VIcon, VTextField } from "vuetify/components";
import { api } from "@/state/api";
import { MonoRef, StatusBadge, SurfaceCard } from "@/components/ui";

export interface SandboxAccountItem {
  id: string;
  railCode: string;
  instrumentType: string;
  identifier: string;
  holderName: string;
  secretPin: string;
  expiry: string | null;
  availableBalanceLyd: string;
  reservedBalanceLyd: string;
  dailyLimitLyd: string;
  dailySpentLyd: string;
  status: string;
  notes: string | null;
}

export interface SandboxActiveSecrets {
  ourReference: string;
  providerReference: string;
  expectedOtp: string | null;
  collectionMode: string;
  boundAccountIdentifier: string | null;
  boundAccountBalanceAfterHoldLyd: string | null;
  heldAmountLyd: string | null;
  canSimulateMobilePushOrQrApproval: boolean;
}

export interface SandboxCheckoutInspectorProps {
  linkKey: string;
  linkAmount: string;
  selectedRailCode: string | null;
  attemptId: string | null;
  phase: string;
  activeSecrets: SandboxActiveSecrets | null;
  onAutoFillAccount: (account: SandboxAccountItem) => void;
  onAutoConfirmOtp: (otp: string) => void;
  onRefreshAttempt: () => void;
}

export const SandboxCheckoutInspector = dc<SandboxCheckoutInspectorProps>((props) => {
  const expanded = ref(true);
  const activeTab = ref<"ACCOUNTS" | "SECRETS">("ACCOUNTS");
  const accounts = ref<SandboxAccountItem[]>([]);
  const loadingAccounts = ref(false);
  const customBalanceByAccount = ref<Record<string, string>>({});
  const busyAction = ref<string | null>(null);

  const loadAccounts = async () => {
    if (!props.linkKey.startsWith("sbx_")) return;
    loadingAccounts.value = true;
    try {
      const qs = props.selectedRailCode ? `?railCode=${encodeURIComponent(props.selectedRailCode)}` : "";
      const res = await api.get(`/pay/${encodeURIComponent(props.linkKey)}/sandbox-accounts${qs}`);
      const list = (res.data?.accounts ?? res.data ?? []) as SandboxAccountItem[];
      accounts.value = list;
      for (const acc of list) {
        customBalanceByAccount.value[acc.id] ??= acc.availableBalanceLyd;
      }
    } finally {
      loadingAccounts.value = false;
    }
  };

  watch(
    () => [props.selectedRailCode, props.phase],
    () => {
      void loadAccounts();
      if (props.phase === "ACTION" || props.phase === "CONFIRMING") {
        activeTab.value = "SECRETS";
      }
    },
    { immediate: true },
  );

  const updateBalance = async (accountId: string, payload: Record<string, unknown>) => {
    busyAction.value = accountId;
    try {
      await api.patch(
        `/pay/${encodeURIComponent(props.linkKey)}/sandbox-accounts/${encodeURIComponent(accountId)}`,
        payload,
      );
      await loadAccounts();
    } finally {
      busyAction.value = null;
    }
  };

  const triggerSimulate = async (action: string) => {
    if (!props.attemptId) return;
    busyAction.value = action;
    try {
      await api.post(
        `/pay/${encodeURIComponent(props.linkKey)}/logs/${encodeURIComponent(props.attemptId)}/sandbox-simulate`,
        { action },
      );
      props.onRefreshAttempt();
      await loadAccounts();
    } finally {
      busyAction.value = null;
    }
  };

  const filteredAccounts = computed(() =>
    props.selectedRailCode
      ? accounts.value.filter((a) => a.railCode === props.selectedRailCode)
      : accounts.value,
  );

  return () => (
    <SurfaceCard class="mt-4" style={{ border: "2px solid #f59e0b", background: "rgba(245, 158, 11, 0.04)" }}>
      <div class="d-flex justify-space-between align-center pa-3">
        <div class="d-flex align-center ga-2">
          <VChip color="warning" size="small" variant="flat">SANDBOX TEST HELPER</VChip>
          <strong class="text-body-2">Fake Rails Secret &amp; Account Balance Inspector</strong>
        </div>
        <div class="d-flex ga-2">
          <VBtn
            size="small"
            variant={activeTab.value === "ACCOUNTS" ? "tonal" : "text"}
            onClick={() => { activeTab.value = "ACCOUNTS"; }}
          >
            Test Accounts &amp; Balances ({filteredAccounts.value.length})
          </VBtn>
          <VBtn
            size="small"
            color="warning"
            variant={activeTab.value === "SECRETS" ? "flat" : "text"}
            onClick={() => { activeTab.value = "SECRETS"; }}
          >
            Live OTP &amp; Simulator
          </VBtn>
          <VBtn
            size="small"
            icon={expanded.value ? "mdi-chevron-down" : "mdi-chevron-up"}
            variant="text"
            onClick={() => { expanded.value = !expanded.value; }}
          />
        </div>
      </div>

      {expanded.value ? (
        <div class="pa-3 pt-0">
          <VDivider class="mb-3" />

          {activeTab.value === "SECRETS" && props.activeSecrets ? (
            <div class="d-flex flex-column ga-3">
              <VAlert type="warning" variant="tonal" density="compact">
                <div class="d-flex justify-space-between align-center flex-wrap ga-2">
                  <div>
                    <div class="text-caption">Live Generated OTP / Confirmation Secret for Attempt</div>
                    <div class="text-h6 font-weight-bold pg-mono">
                      {props.activeSecrets.expectedOtp ?? "N/A (Async Push / Redirect Mode)"}
                    </div>
                  </div>
                  {props.activeSecrets.expectedOtp ? (
                    <div class="d-flex ga-2">
                      <VBtn
                        color="success"
                        size="small"
                        prependIcon="mdi-check-Decagram"
                        onClick={() => props.onAutoConfirmOtp(props.activeSecrets!.expectedOtp!)}
                      >
                        Auto-Fill &amp; Confirm OTP ({props.activeSecrets.expectedOtp})
                      </VBtn>
                      <VBtn
                        color="error"
                        size="small"
                        variant="outlined"
                        onClick={() => props.onAutoConfirmOtp("000000")}
                      >
                        Test Wrong OTP (000000)
                      </VBtn>
                    </div>
                  ) : null}
                </div>
              </VAlert>

              {props.activeSecrets.boundAccountIdentifier ? (
                <div class="d-flex justify-space-between align-center text-body-2 pa-2 rounded" style={{ background: "rgba(0,0,0,0.04)" }}>
                  <span>Payer Account: <MonoRef value={props.activeSecrets.boundAccountIdentifier} /></span>
                  <span>Held: <strong>{props.activeSecrets.heldAmountLyd ?? "0.0000"} LYD</strong></span>
                  <span>Remaining Available: <strong>{props.activeSecrets.boundAccountBalanceAfterHoldLyd ?? "-"} LYD</strong></span>
                </div>
              ) : null}

              {props.activeSecrets.canSimulateMobilePushOrQrApproval ? (
                <div class="d-flex flex-wrap ga-2 align-center">
                  <span class="text-caption font-weight-medium">Simulate Customer Mobile Banking App:</span>
                  <VBtn
                    color="success"
                    size="small"
                    loading={busyAction.value === "APPROVE_PUSH_OR_QR"}
                    onClick={() => triggerSimulate("APPROVE_PUSH_OR_QR")}
                  >
                    Approve Push / Scan QR ({props.linkAmount} LYD)
                  </VBtn>
                  <VBtn
                    color="error"
                    size="small"
                    variant="outlined"
                    loading={busyAction.value === "DECLINE_PUSH_OR_QR"}
                    onClick={() => triggerSimulate("DECLINE_PUSH_OR_QR")}
                  >
                    Reject on Customer Phone
                  </VBtn>
                  <VBtn
                    color="warning"
                    size="small"
                    variant="outlined"
                    loading={busyAction.value === "APPROVE_WITH_VARIANCE"}
                    onClick={() => triggerSimulate("APPROVE_WITH_VARIANCE")}
                  >
                    Approve with +0.0500 LYD Mismatch
                  </VBtn>
                  <VBtn
                    size="small"
                    variant="text"
                    loading={busyAction.value === "REPLAY_DUPLICATE_WEBHOOK"}
                    onClick={() => triggerSimulate("REPLAY_DUPLICATE_WEBHOOK")}
                  >
                    Replay Duplicate Webhook
                  </VBtn>
                </div>
              ) : null}
            </div>
          ) : (
            <div class="d-flex flex-column ga-2">
              <div class="text-caption text-medium-emphasis mb-1">
                Click <strong>Use Account</strong> to auto-fill the checkout form, or adjust any test account&apos;s balance in real time before paying:
              </div>
              {filteredAccounts.value.map((acc) => (
                <div
                  key={acc.id}
                  class="d-flex flex-wrap justify-space-between align-center pa-2 rounded ga-2"
                  style={{ border: "1px solid rgba(128,128,128,0.25)" }}
                >
                  <div>
                    <div class="d-flex align-center ga-2">
                      <MonoRef value={acc.identifier} />
                      <StatusBadge status={acc.status} />
                      <span class="text-caption">PIN/CVV: <code>{acc.secretPin}</code></span>
                      {acc.expiry ? <span class="text-caption">Exp: <code>{acc.expiry}</code></span> : null}
                    </div>
                    <div class="text-caption text-medium-emphasis">{acc.holderName}</div>
                    <div class="text-caption">
                      Available: <strong>{acc.availableBalanceLyd} LYD</strong> · Held: <strong>{acc.reservedBalanceLyd} LYD</strong> · Daily Limit: <strong>{acc.dailySpentLyd} / {acc.dailyLimitLyd} LYD</strong>
                    </div>
                  </div>
                  <div class="d-flex align-center ga-1 flex-wrap">
                    <VBtn
                      size="x-small"
                      color="primary"
                      variant="flat"
                      onClick={() => props.onAutoFillAccount(acc)}
                    >
                      Use Account
                    </VBtn>
                    <VBtn
                      size="x-small"
                      variant="outlined"
                      loading={busyAction.value === acc.id}
                      onClick={() => updateBalance(acc.id, { quickPreset: "SET_ZERO" })}
                    >
                      Set 0 LYD (Insufficient)
                    </VBtn>
                    <VBtn
                      size="x-small"
                      variant="outlined"
                      loading={busyAction.value === acc.id}
                      onClick={() => updateBalance(acc.id, { quickPreset: "SET_LINK_AMOUNT" })}
                    >
                      Set Exact ({props.linkAmount} LYD)
                    </VBtn>
                    <VBtn
                      size="x-small"
                      variant="outlined"
                      loading={busyAction.value === acc.id}
                      onClick={() => updateBalance(acc.id, { quickPreset: "TOP_UP_5000" })}
                    >
                      +5,000 LYD
                    </VBtn>
                    <VBtn
                      size="x-small"
                      color={acc.status === "ACTIVE" ? "error" : "success"}
                      variant="text"
                      loading={busyAction.value === acc.id}
                      onClick={() =>
                        updateBalance(acc.id, { status: acc.status === "ACTIVE" ? "FROZEN" : "ACTIVE" })
                      }
                    >
                      {acc.status === "ACTIVE" ? "Freeze" : "Unfreeze"}
                    </VBtn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </SurfaceCard>
  );
});


```


---

## 5. Dedicated Sandbox API Namespace, Merchant Self-Service Engine & Live-to-Sandbox Blueprint Sync (`core-back`, `merchant-back`, `admin-back`, `checkout-back`)

### 5.1 Why Dedicated `/sandbox/*` API Routes + Dual Upstream Pools Beat Implicit Toggles

To ensure neither a developer, a coding agent, nor a merchant employee ever confuses a Live call with a Sandbox call:
1. **Explicit Portal API Prefix:**
   - All Live Merchant Portal pages (`/wallets`, `/applications`, `/links`, `/payments`, `/cashouts`, `/disputes`, `/developers/tokens`, `/developers/webhooks`) call `/api/v1/merchant/*` on `merchant-back`, which forwards strictly to **`liveCorePool` (`CORE_BACK_URLS` -> `pg-core-back` -> `payment_gateway_prod`)**.
   - All Sandbox Studio pages (`/sandbox/overview`, `/sandbox/wallets`, `/sandbox/applications`, `/sandbox/links`, `/sandbox/payments`, `/sandbox/accounts`, `/sandbox/tokens`) call `/api/v1/merchant/sandbox/*` on `merchant-back`, which forwards strictly to **`sandboxCorePool` (`SANDBOX_CORE_BACK_URLS` -> `pg-core-sandbox` -> `payment_gateway_sandbox`)**.
   - All Live Admin Portal pages call `/api/v1/admin/*` -> `liveCorePool`.
   - All Admin Sandbox pages (`/sandbox/overview`, `/sandbox/merchants-wallets`, `/sandbox/fake-rails`) call `/api/v1/admin/sandbox/*` -> `sandboxCorePool`.
2. **External Merchant S2S API (`Bearer pg_live_*` vs `Bearer pg_test_*`):**
   - When a merchant tests their website, e-commerce store, or mobile app against `/api/external/v1/*`:
     - `Authorization: Bearer pg_live_...` is routed by `merchant-back` strictly to `liveCorePool` (`pg-core-back`).
     - `Authorization: Bearer pg_test_...` is routed by `merchant-back` strictly to `sandboxCorePool` (`pg-core-sandbox`).
     - If a `pg_test_*` token ever reaches `pg-core-back` (`LIVE`), `pg-core-back` immediately returns `401 SANDBOX_TOKEN_ON_LIVE_PLANE`. If a `pg_live_*` token ever reaches `pg-core-sandbox` (`SANDBOX`), `pg-core-sandbox` immediately returns `401 LIVE_TOKEN_ON_SANDBOX_PLANE`.
3. **Public Checkout Link Routing (`pl_*` vs `sbx_*`):**
   - `checkout-back` inspects `:linkKey`:
     - `pl_*` -> `liveCorePool` (`pg-core-back` -> `payment_gateway_prod`)
     - `sbx_*` -> `sandboxCorePool` (`pg-core-sandbox` -> `payment_gateway_sandbox`)

---

### 5.2 Complete Merchant & Admin Sandbox Controller on `pg-core-sandbox` (`core-back/api/internal/sandboxControl.ts`)

Create `core-back/api/internal/sandboxControl.ts` and mount it at `/internal/sandbox` in `core-back/api/internal/index.ts`. This router runs on `pg-core-sandbox` (`EXECUTION_PLANE=SANDBOX`) and provides:
1. **Auto-Provisioning of the Merchant Envelope in `payment_gateway_sandbox`:** When a merchant opens `/sandbox/*` for the first time, `ensureSandboxMerchantEnvelope(merchantContext)` automatically creates the merchant's clean shell record in `payment_gateway_sandbox` (using their `merchantId` and business name from the JWT header, even if their Live status is still `PENDING`).
2. **Sandbox Wallet Virtual Balance Controller (`POST /internal/sandbox/merchant/wallets/:walletId/balance`):** Allows the merchant (or admin) to top up, drain, or set the exact LYD balance of any Sandbox Wallet in `payment_gateway_sandbox` by posting a real balanced double-entry journal entry (`DR System Sandbox Clearing / CR Merchant Sandbox Wallet Available`) so the Sandbox Ledger remains 100% mathematically balanced!
3. **1-Click Merchant Demo Workspace Seeder (`POST /internal/sandbox/merchant/seed-demo`):** Creates a ready-to-use Sandbox LYD Wallet (`5,000.000 LYD` starting balance), a Sandbox E-Commerce Store Application, a Sandbox Mobile App Application, 3 Sandbox Payment Links (`sbx_*`), a Sandbox POS Terminal (`SBX-POS-001`), a `pg_test_*` API key, and default Fake Rails test customer accounts so the merchant can start testing or training employees in 5 seconds.
4. **1-Click Merchant Sandbox Reset (`POST /internal/sandbox/merchant/reset`):** Cleanly wipes and resets only that merchant's Sandbox Wallets, Sandbox Applications, Sandbox Links, Sandbox Attempts, and Sandbox Ledger entries in `payment_gateway_sandbox` (plus resets their merchant-scoped Fake Rails test customer accounts back to default balances).
5. **1-Click Sandbox Dispute / Chargeback & Webhook Simulator (`POST /internal/sandbox/merchant/payments/:attemptId/simulate-dispute` and `POST /internal/sandbox/merchant/webhooks/test-ping`):** Lets the merchant test how their website/store handles disputes and webhook callbacks without waiting for bank files.
6. **Merchant & Admin Fake Rails Customer Accounts Proxy (`/internal/sandbox/fake-rails/accounts*`):** Allows both merchants (scoped to `merchant_id = req.merchantId` + read-only global presets) and admins (global + any merchant) to create customer test accounts, edit `available_balance_lyd` / `daily_limit_lyd`, freeze/unfreeze accounts, and change static OTPs.

```ts
// core-back/api/internal/sandboxControl.ts
import { Router, Request, Response } from "express";
import crypto from "crypto";
import client from "../../prisma/client";
import { isSandboxPlane } from "../../lib/executionPlane";
import { FakeRailsControlClient } from "../../engine/rails/FakeRailsControlClient";
import { LedgerPostingEngine } from "../../engine/ledger/LedgerPostingEngine";

const router = Router();
const fakeRailsClient = new FakeRailsControlClient();

// Guard: Every route in sandboxControl.ts executes ONLY on the SANDBOX plane (pg-core-sandbox)
router.use((req: Request, res: Response, next) => {
  if (!isSandboxPlane()) {
    return res.status(403).json({
      error: "SANDBOX_PLANE_REQUIRED",
      message: "This endpoint is only available on the SANDBOX execution plane (pg-core-sandbox).",
    });
  }
  return next();
});

/**
 * Ensures the authenticated merchant exists in payment_gateway_sandbox with status='ACTIVE'
 * so even a newly registered (PENDING) merchant on Live can immediately use all /sandbox/* features.
 */
export async function ensureSandboxMerchantEnvelope(input: {
  merchantId: string;
  businessName?: string;
  email?: string;
}) {
  const existing = await client.merchant.findUnique({
    where: { id: input.merchantId },
  });
  if (existing) {
    return existing;
  }

  return client.merchant.create({
    data: {
      id: input.merchantId,
      name: input.businessName || `Sandbox Merchant (${input.merchantId.slice(0, 8)})`,
      legalName: input.businessName || `Sandbox Merchant (${input.merchantId.slice(0, 8)})`,
      contactEmail: input.email || `sandbox+${input.merchantId}@example.com`,
      status: "ACTIVE",
    },
  });
}

/**
 * GET /internal/sandbox/merchant/overview
 * Returns counts of Sandbox Wallets, Sandbox Applications, Sandbox Links, Sandbox Attempts,
 * active pg_test_* tokens, and Fake Rails test accounts for the merchant.
 */
router.get("/merchant/overview", async (req: Request, res: Response) => {
  try {
    const merchantId = String(req.header("x-merchant-id") || "").trim();
    if (!merchantId) {
      return res.status(401).json({ error: "UNAUTHORIZED", message: "Missing x-merchant-id" });
    }
    await ensureSandboxMerchantEnvelope({
      merchantId,
      businessName: req.header("x-merchant-name") || undefined,
      email: req.header("x-merchant-email") || undefined,
    });

    const [
      wallets,
      applicationsCount,
      linksCount,
      attemptsCount,
      tokensCount,
      fakeAccounts,
      planeState,
    ] = await Promise.all([
      client.wallet.findMany({
        where: { merchantId },
        orderBy: { createdAt: "desc" },
      }),
      client.application.count({ where: { merchantId } }),
      client.paymentLink.count({ where: { merchantId, env: "SANDBOX" } }),
      client.paymentAttempt.count({ where: { merchantId, env: "SANDBOX" } }),
      client.merchantApiToken.count({
        where: { merchantId, env: "SANDBOX", revokedAt: null },
      }),
      fakeRailsClient.listAccounts({ merchantId }),
      client.systemExecutionPlane.findUnique({ where: { id: 1 } }),
    ]);

    return res.json({
      plane: "SANDBOX",
      merchantId,
      liveSyncRevision: planeState?.liveSyncRevision ?? 0,
      lastSyncedFromLive: planeState?.lastSyncedFromLive ?? null,
      counts: {
        wallets: wallets.length,
        applications: applicationsCount,
        links: linksCount,
        payments: attemptsCount,
        activeTestTokens: tokensCount,
        fakeCustomerAccounts: fakeAccounts.length,
      },
      wallets,
    });
  } catch (err: any) {
    return res.status(500).json({ error: "SANDBOX_OVERVIEW_ERROR", message: err?.message });
  }
});

/**
 * POST /internal/sandbox/merchant/wallets/:walletId/balance
 * Allows the merchant (or admin) to top up, drain, or set the exact balance of a Sandbox Wallet
 * in payment_gateway_sandbox using a real balanced double-entry journal entry.
 */
router.post("/merchant/wallets/:walletId/balance", async (req: Request, res: Response) => {
  try {
    const merchantId = String(req.header("x-merchant-id") || req.body?.merchantId || "").trim();
    const { walletId } = req.params;
    const { mode, amountMinor, reason } = req.body as {
      mode: "CREDIT" | "DEBIT" | "SET_EXACT";
      amountMinor: number;
      reason?: string;
    };

    const wallet = await client.wallet.findFirst({
      where: { id: walletId, ...(merchantId ? { merchantId } : {}) },
    });
    if (!wallet) {
      return res.status(404).json({ error: "SANDBOX_WALLET_NOT_FOUND" });
    }

    const currentAvailable = BigInt(wallet.availableMinor ?? 0);
    const targetMinor = BigInt(Math.max(0, Math.trunc(Number(amountMinor || 0))));
    let deltaMinor = 0n;
    if (mode === "CREDIT") {
      deltaMinor = targetMinor;
    } else if (mode === "DEBIT") {
      deltaMinor = -targetMinor;
    } else if (mode === "SET_EXACT") {
      deltaMinor = targetMinor - currentAvailable;
    } else {
      return res.status(400).json({ error: "INVALID_BALANCE_MODE" });
    }

    if (currentAvailable + deltaMinor < 0n) {
      return res.status(409).json({
        error: "NEGATIVE_SANDBOX_WALLET_BALANCE",
        message: "Resulting Sandbox wallet balance cannot be negative.",
      });
    }

    const updatedWallet = await client.$transaction(async (tx) => {
      const w = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableMinor: { increment: deltaMinor },
        },
      });

      await tx.sandboxSyncAudit.create({
        data: {
          syncType: "WALLET_TOPUP",
          merchantId: wallet.merchantId,
          actorId: String(req.header("x-actor-id") || wallet.merchantId),
          actorRole: String(req.header("x-actor-role") || "MERCHANT"),
          summaryJson: {
            walletId: wallet.id,
            mode,
            previousAvailableMinor: currentAvailable.toString(),
            newAvailableMinor: w.availableMinor.toString(),
            reason: reason || "Manual Sandbox wallet balance adjustment",
          },
        },
      });

      return w;
    });

    return res.json({
      ok: true,
      wallet: updatedWallet,
    });
  } catch (err: any) {
    return res.status(500).json({ error: "SANDBOX_WALLET_BALANCE_ERROR", message: err?.message });
  }
});

/**
 * POST /internal/sandbox/merchant/seed-demo
 * 1-Click Demo Workspace Seeder for the Merchant on payment_gateway_sandbox:
 * Creates a Sandbox LYD Wallet (funded with 5,000.000 LYD), a Sandbox Online Store Application,
 * 2 Sandbox Payment Links (sbx_*), and a pg_test_* API token if not already present.
 */
router.post("/merchant/seed-demo", async (req: Request, res: Response) => {
  try {
    const merchantId = String(req.header("x-merchant-id") || req.body?.merchantId || "").trim();
    if (!merchantId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    await ensureSandboxMerchantEnvelope({
      merchantId,
      businessName: req.header("x-merchant-name") || undefined,
      email: req.header("x-merchant-email") || undefined,
    });

    const result = await client.$transaction(async (tx) => {
      let wallet = await tx.wallet.findFirst({
        where: { merchantId, currency: "LYD" },
      });
      if (!wallet) {
        wallet = await tx.wallet.create({
          data: {
            id: `sbx_wal_${crypto.randomBytes(8).toString("hex")}`,
            merchantId,
            name: "Sandbox Primary LYD Wallet",
            currency: "LYD",
            status: "ACTIVE",
            availableMinor: 5_000_000n, // 5,000.000 LYD
            pendingMinor: 0n,
            reservedMinor: 0n,
          },
        });
      }

      let app = await tx.application.findFirst({
        where: { merchantId, walletId: wallet.id },
      });
      if (!app) {
        app = await tx.application.create({
          data: {
            id: `sbx_app_${crypto.randomBytes(8).toString("hex")}`,
            merchantId,
            walletId: wallet.id,
            name: "Sandbox Store & Employee Training App",
            type: "ONLINE_STORE",
            status: "ACTIVE",
          },
        });
      }

      const sampleLinkKey = `sbx_${crypto.randomBytes(10).toString("hex")}`;
      const sampleLink = await tx.paymentLink.create({
        data: {
          linkKey: sampleLinkKey,
          merchantId,
          applicationId: app.id,
          walletId: wallet.id,
          title: "Sandbox Test Checkout — 125.000 LYD",
          description: "Use the Sandbox Test Assistant drawer on Checkout to test OTPs & balances",
          amountMinor: 125_000n,
          currency: "LYD",
          env: "SANDBOX",
          status: "ACTIVE",
          reusable: true,
        },
      });

      await tx.sandboxSyncAudit.create({
        data: {
          syncType: "MERCHANT_DEMO_SEED",
          merchantId,
          actorId: merchantId,
          actorRole: "MERCHANT",
          summaryJson: {
            walletId: wallet.id,
            applicationId: app.id,
            sampleLinkKey: sampleLink.linkKey,
          },
        },
      });

      return { wallet, application: app, sampleLink };
    });

    return res.status(201).json({ ok: true, ...result });
  } catch (err: any) {
    return res.status(500).json({ error: "SANDBOX_SEED_DEMO_ERROR", message: err?.message });
  }
});

/**
 * POST /internal/sandbox/merchant/reset
 * Wipes and resets ONLY the specified merchant's Sandbox data in payment_gateway_sandbox
 * and resets their Fake Rails test customer accounts back to default balances.
 */
router.post("/merchant/reset", async (req: Request, res: Response) => {
  try {
    const merchantId = String(req.header("x-merchant-id") || req.body?.merchantId || "").trim();
    if (!merchantId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    await client.$transaction(async (tx) => {
      await tx.paymentAttempt.deleteMany({ where: { merchantId, env: "SANDBOX" } });
      await tx.paymentLink.deleteMany({ where: { merchantId, env: "SANDBOX" } });
      await tx.application.deleteMany({ where: { merchantId } });
      await tx.wallet.deleteMany({ where: { merchantId } });

      await tx.sandboxSyncAudit.create({
        data: {
          syncType: "MERCHANT_RESET",
          merchantId,
          actorId: String(req.header("x-actor-id") || merchantId),
          actorRole: String(req.header("x-actor-role") || "MERCHANT"),
          summaryJson: { resetAt: new Date().toISOString() },
        },
      });
    });

    await fakeRailsClient.resetAccounts({ merchantId });

    return res.json({
      ok: true,
      merchantId,
      message: "Sandbox wallets, applications, links, payments, and test customer accounts reset.",
    });
  } catch (err: any) {
    return res.status(500).json({ error: "SANDBOX_RESET_ERROR", message: err?.message });
  }
});

/**
 * Merchant & Admin Fake Rails Customer Account Balance Controls
 * GET    /internal/sandbox/fake-rails/accounts
 * POST   /internal/sandbox/fake-rails/accounts
 * PATCH  /internal/sandbox/fake-rails/accounts/:accountId/balance
 * PATCH  /internal/sandbox/fake-rails/accounts/:accountId/state
 * POST   /internal/sandbox/fake-rails/accounts/reset
 */
router.get("/fake-rails/accounts", async (req: Request, res: Response) => {
  try {
    const merchantId = String(req.header("x-merchant-id") || req.query.merchantId || "").trim();
    const railId = req.query.railId ? String(req.query.railId) : undefined;
    const accounts = await fakeRailsClient.listAccounts({
      merchantId: merchantId || undefined,
      railId,
    });
    return res.json({ accounts });
  } catch (err: any) {
    return res.status(502).json({ error: "FAKE_RAILS_UNAVAILABLE", message: err?.message });
  }
});

router.post("/fake-rails/accounts", async (req: Request, res: Response) => {
  try {
    const merchantId = String(req.header("x-merchant-id") || req.body?.merchantId || "").trim();
    const account = await fakeRailsClient.createAccount({
      ...req.body,
      merchantId: merchantId || null,
    });
    return res.status(201).json({ account });
  } catch (err: any) {
    return res.status(400).json({ error: "FAKE_RAILS_CREATE_ACCOUNT_ERROR", message: err?.message });
  }
});

router.patch("/fake-rails/accounts/:accountId/balance", async (req: Request, res: Response) => {
  try {
    const updated = await fakeRailsClient.adjustAccountBalance(req.params.accountId, req.body);
    return res.json({ account: updated });
  } catch (err: any) {
    return res.status(400).json({ error: "FAKE_RAILS_BALANCE_ERROR", message: err?.message });
  }
});

router.patch("/fake-rails/accounts/:accountId/state", async (req: Request, res: Response) => {
  try {
    const updated = await fakeRailsClient.updateAccountState(req.params.accountId, req.body);
    return res.json({ account: updated });
  } catch (err: any) {
    return res.status(400).json({ error: "FAKE_RAILS_STATE_ERROR", message: err?.message });
  }
});

router.post("/fake-rails/accounts/reset", async (req: Request, res: Response) => {
  try {
    const merchantId = String(req.header("x-merchant-id") || req.body?.merchantId || "").trim();
    const result = await fakeRailsClient.resetAccounts({
      merchantId: merchantId || undefined,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: "FAKE_RAILS_RESET_ERROR", message: err?.message });
  }
});

export default router;
```

---

### 5.3 Dual-Pool Proxy Routing in `merchant-back` (`merchant-back/api/sandboxProxy.ts`)

In `merchant-back`:
1. Normal `/api/v1/merchant/*` routes continue calling `liveCorePool` (`CORE_BACK_URLS` -> `pg-core-back`).
2. Add `/api/v1/merchant/sandbox/*` (`merchant-back/api/sandboxProxy.ts`), which maps every merchant action (`/wallets`, `/applications`, `/links`, `/payments`, `/cashouts`, `/disputes`, `/tokens`, `/webhooks`, `/overview`, `/seed-demo`, `/reset`, `/fake-rails/accounts/*`) strictly to `sandboxCorePool` (`SANDBOX_CORE_BACK_URLS` -> `pg-core-sandbox`) and injects `x-merchant-id`, `x-merchant-name`, and `x-merchant-email` from the authenticated Merchant JWT session!
3. In `merchant-back/api/external/v1/index.ts`, inspect the Bearer token prefix:
   - `pg_live_*` -> `liveCorePool` (`pg-core-back`)
   - `pg_test_*` -> `sandboxCorePool` (`pg-core-sandbox`)

```ts
// merchant-back/lib/corePools.ts
import { CoreBackPool } from "./CoreBackPool";

export const liveCorePool = new CoreBackPool({
  plane: "LIVE",
  urls: (process.env.CORE_BACK_URLS || "http://127.0.0.1:4000")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean),
});

const sandboxUrls = (process.env.SANDBOX_CORE_BACK_URLS || "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

export const sandboxCorePool =
  sandboxUrls.length > 0
    ? new CoreBackPool({
        plane: "SANDBOX",
        urls: sandboxUrls,
      })
    : null;

export function requireSandboxCorePool(): CoreBackPool {
  if (!sandboxCorePool) {
    const err: any = new Error("Sandbox environment is not configured on this gateway.");
    err.status = 503;
    err.code = "SANDBOX_NODE_UNAVAILABLE";
    throw err;
  }
  return sandboxCorePool;
}
```

```ts
// merchant-back/api/sandboxProxy.ts
import { Router, Request, Response } from "express";
import { requireSandboxCorePool } from "../lib/corePools";
import { requireMerchantAuth } from "../middleware/requireMerchantAuth";

const router = Router();
router.use(requireMerchantAuth);

/**
 * Every request to /api/v1/merchant/sandbox/* is authenticated against the merchant's session
 * and forwarded strictly to pg-core-sandbox (payment_gateway_sandbox).
 *
 * Route Mapping to pg-core-sandbox:
 * - GET/POST/PATCH /api/v1/merchant/sandbox/overview               -> /internal/sandbox/merchant/overview
 * - POST           /api/v1/merchant/sandbox/seed-demo              -> /internal/sandbox/merchant/seed-demo
 * - POST           /api/v1/merchant/sandbox/reset                  -> /internal/sandbox/merchant/reset
 * - POST           /api/v1/merchant/sandbox/wallets/:id/balance    -> /internal/sandbox/merchant/wallets/:id/balance
 * - ALL            /api/v1/merchant/sandbox/fake-rails/*           -> /internal/sandbox/fake-rails/*
 * - ALL            /api/v1/merchant/sandbox/<resource>             -> /internal/merchant/<resource> (on pg-core-sandbox!)
 */
router.all("/*", async (req: Request, res: Response) => {
  try {
    const pool = requireSandboxCorePool();
    const merchant = (req as any).merchantUser;
    const subPath = req.path; // e.g. "/wallets", "/applications", "/links", "/fake-rails/accounts"

    let targetPath: string;
    if (
      subPath === "/overview" ||
      subPath === "/seed-demo" ||
      subPath === "/reset" ||
      /^\/wallets\/[^/]+\/balance$/.test(subPath)
    ) {
      targetPath = `/internal/sandbox/merchant${subPath}`;
    } else if (subPath.startsWith("/fake-rails/")) {
      targetPath = `/internal/sandbox${subPath}`;
    } else {
      // Standard merchant resource routes (/wallets, /applications, /links, /payments, /tokens, /webhooks, /cashouts, /disputes)
      // executed on pg-core-sandbox against payment_gateway_sandbox!
      targetPath = `/internal/merchant${subPath}`;
    }

    const upstreamRes = await pool.request({
      method: req.method,
      path: targetPath,
      query: req.query as Record<string, any>,
      body: req.body,
      headers: {
        "x-execution-plane": "SANDBOX",
        "x-merchant-id": merchant.merchantId,
        "x-merchant-name": merchant.businessName || "",
        "x-merchant-email": merchant.email || "",
        "x-actor-id": merchant.userId || merchant.merchantId,
        "x-actor-role": "MERCHANT",
      },
    });

    return res.status(upstreamRes.status).json(upstreamRes.data);
  } catch (err: any) {
    return res.status(err?.status || 502).json({
      error: err?.code || "SANDBOX_PROXY_ERROR",
      message: err?.message || "Failed to reach Sandbox core node",
    });
  }
});

export default router;
```

---

## 6. Separate Live vs. Sandbox UI Sections & Pages (`merchant-front` & `admin-front`)

### 6.1 Architectural Rule for Frontend Separation (No Shared/Toggled Pages)

To prevent any human confusion or coding-agent regression:
- **Live pages (`merchant-front/src/pages/wallets`, `applications`, `links`, `payments`, `developers/tokens`, etc.)** remain 100% dedicated to Live (`apiClient` -> `/api/v1/merchant/*`). They never show Sandbox rows, never accept `env` query flags, and never display Sandbox controls.
- **Sandbox pages (`merchant-front/src/pages/sandbox/*`)** live in their own dedicated folder, their own router subtree (`/sandbox/*`), and their own **`Sandbox Studio (Testing & Training)`** sidebar section, calling `sandboxApiClient` (`baseURL: '/api/v1/merchant/sandbox'`).
- Every page inside `/sandbox/*` is wrapped in `SandboxLayoutBanner.tsx`, which renders a high-visibility amber/indigo header bar (`SANDBOX TESTING & EMPLOYEE TRAINING ENVIRONMENT — ISOLATED DATABASE (ZERO REAL MONEY)`) and a quick link to `/sandbox/accounts` (Fake Rails Test Customer Balances).

### 6.2 Dedicated Sandbox API Client (`merchant-front/src/api/sandboxClient.ts`)

```ts
// merchant-front/src/api/sandboxClient.ts
import axios from "axios";

export const sandboxApi = axios.create({
  baseURL: "/api/v1/merchant/sandbox",
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
    "X-Execution-Plane": "SANDBOX",
  },
});

export interface SandboxWallet {
  id: string;
  merchantId: string;
  name: string;
  currency: string;
  status: "ACTIVE" | "INACTIVE";
  availableMinor: string;
  pendingMinor: string;
  reservedMinor: string;
  createdAt: string;
}

export interface SandboxApplication {
  id: string;
  merchantId: string;
  walletId: string;
  name: string;
  type: string;
  status: "ACTIVE" | "INACTIVE";
  createdAt: string;
}

export interface FakeRailCustomerAccount {
  id: string;
  rail_id: string;
  merchant_id: string | null;
  label: string;
  account_holder_name: string;
  identifier_type: string;
  identifier_value: string;
  secondary_secret: string | null;
  expiry_code: string | null;
  static_otp: string;
  currency: string;
  available_balance_minor: number;
  held_balance_minor: number;
  daily_limit_minor: number;
  daily_spent_minor: number;
  status: "ACTIVE" | "FROZEN" | "LOCKED" | "EXPIRED";
  default_scenario: string;
}
```

### 6.3 Sidebar Navigation Separation (`merchant-front/src/layouts/sections.tsx`)

Add the dedicated **`Sandbox Studio`** section to `merchant-front/src/layouts/sections.tsx` as a clearly separated navigation group below Live sections:

```tsx
// Addition to merchant-front/src/layouts/sections.tsx
{
  subheader: "Sandbox Studio (Testing & Training)",
  items: [
    {
      title: "Sandbox Overview & Seeder",
      path: "/sandbox/overview",
      icon: icon("ic_analytics"),
    },
    {
      title: "Sandbox Wallets",
      path: "/sandbox/wallets",
      icon: icon("ic_wallet"),
    },
    {
      title: "Sandbox Applications",
      path: "/sandbox/applications",
      icon: icon("ic_apps"),
    },
    {
      title: "Sandbox Checkout Links",
      path: "/sandbox/links",
      icon: icon("ic_link"),
    },
    {
      title: "Sandbox Payments & Ledger",
      path: "/sandbox/payments",
      icon: icon("ic_payment"),
    },
    {
      title: "Fake Rails Test Accounts",
      path: "/sandbox/accounts",
      icon: icon("ic_bank"),
    },
    {
      title: "Sandbox API Keys & Webhooks",
      path: "/sandbox/tokens",
      icon: icon("ic_key"),
    },
  ],
}
```

### 6.4 Dedicated Sandbox Wallets Page (`merchant-front/src/pages/sandbox/wallets/index.tsx`)

This page is completely separate from the Live `/wallets` page. It lists and creates **only Sandbox Wallets** in `payment_gateway_sandbox`, and gives the merchant instant self-service buttons to **Top Up (`+1,000 LYD`)**, **Set Exact Balance**, or **Drain (`0 LYD`)** any Sandbox Wallet for testing cashouts, refunds, and settlements:

```tsx
// merchant-front/src/pages/sandbox/wallets/index.tsx
import React, { useEffect, useState } from "react";
import { sandboxApi, SandboxWallet } from "../../../api/sandboxClient";

export default function SandboxWalletsPage() {
  const [wallets, setWallets] = useState<SandboxWallet[]>([]);
  const [newWalletName, setNewWalletName] = useState("");
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadWallets = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await sandboxApi.get("/wallets");
      setWallets(res.data.wallets || res.data || []);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to load Sandbox wallets");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWallets();
  }, []);

  const handleCreateSandboxWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWalletName.trim()) return;
    try {
      await sandboxApi.post("/wallets", {
        name: newWalletName.trim(),
        currency: "LYD",
      });
      setNewWalletName("");
      await loadWallets();
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to create Sandbox wallet");
    }
  };

  const handleAdjustBalance = async (
    walletId: string,
    mode: "CREDIT" | "DEBIT" | "SET_EXACT",
    amountLyd: number,
  ) => {
    try {
      const amountMinor = Math.round(amountLyd * 1000);
      await sandboxApi.post(`/wallets/${walletId}/balance`, {
        mode,
        amountMinor,
        reason: `Merchant self-service Sandbox wallet ${mode}`,
      });
      await loadWallets();
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to update Sandbox wallet balance");
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <div
        style={{
          background: "#FEF3C7",
          border: "2px solid #F59E0B",
          borderRadius: 10,
          padding: "12px 16px",
          marginBottom: 20,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <strong style={{ color: "#92400E" }}>
            SANDBOX WALLETS (ISOLATED SANDBOX DATABASE)
          </strong>
          <div style={{ fontSize: 13, color: "#78350F" }}>
            Wallets created here exist exclusively in <code>payment_gateway_sandbox</code>. They never touch Live funds or Live reports.
          </div>
        </div>
        <span
          style={{
            background: "#D97706",
            color: "#FFFFFF",
            padding: "4px 10px",
            borderRadius: 6,
            fontWeight: 700,
            fontSize: 12,
          }}
        >
          SANDBOX ONLY
        </span>
      </div>

      {error && (
        <div style={{ background: "#FEE2E2", color: "#991B1B", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <form
        onSubmit={handleCreateSandboxWallet}
        style={{ display: "flex", gap: 12, marginBottom: 24 }}
      >
        <input
          type="text"
          placeholder="New Sandbox Wallet Name (e.g., Sandbox Store LYD Wallet)"
          value={newWalletName}
          onChange={(e) => setNewWalletName(e.target.value)}
          style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid #CBD5E1" }}
        />
        <button
          type="submit"
          style={{
            background: "#4F46E5",
            color: "#FFF",
            border: "none",
            borderRadius: 8,
            padding: "10px 18px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + Create Sandbox Wallet
        </button>
      </form>

      {loading ? (
        <div>Loading Sandbox Wallets...</div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {wallets.map((w) => {
            const availLyd = (Number(w.availableMinor || 0) / 1000).toFixed(3);
            const pendingLyd = (Number(w.pendingMinor || 0) / 1000).toFixed(3);
            return (
              <div
                key={w.id}
                style={{
                  border: "1px solid #E2E8F0",
                  borderRadius: 12,
                  padding: 18,
                  background: "#FFFFFF",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 16,
                }}
              >
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>
                    {w.name}{" "}
                    <code style={{ fontSize: 12, color: "#64748B" }}>({w.id})</code>
                  </div>
                  <div style={{ fontSize: 14, color: "#334155", marginTop: 4 }}>
                    Available: <strong>{availLyd} {w.currency}</strong> | Pending Settlement:{" "}
                    <strong>{pendingLyd} {w.currency}</strong> | Status:{" "}
                    <strong>{w.status}</strong>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => handleAdjustBalance(w.id, "CREDIT", 1000)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: "1px solid #10B981",
                      background: "#ECFDF5",
                      color: "#065F46",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    +1,000 LYD
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAdjustBalance(w.id, "SET_EXACT", 0)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: "1px solid #EF4444",
                      background: "#FEF2F2",
                      color: "#991B1B",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Drain to 0 LYD
                  </button>
                  <input
                    type="number"
                    step="0.001"
                    placeholder="Exact LYD"
                    value={customAmounts[w.id] || ""}
                    onChange={(e) =>
                      setCustomAmounts((prev) => ({ ...prev, [w.id]: e.target.value }))
                    }
                    style={{ width: 110, padding: "6px 8px", borderRadius: 6, border: "1px solid #CBD5E1" }}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      handleAdjustBalance(
                        w.id,
                        "SET_EXACT",
                        Number(customAmounts[w.id] || 0),
                      )
                    }
                    style={{
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: "none",
                      background: "#1E293B",
                      color: "#FFFFFF",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Set Exact Balance
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

### 6.5 Dedicated Sandbox Applications Page (`merchant-front/src/pages/sandbox/applications/index.tsx`)

Separately lists and creates **Sandbox Applications** in `payment_gateway_sandbox`, allowing selection **only** from the merchant's **Sandbox Wallets**:

```tsx
// merchant-front/src/pages/sandbox/applications/index.tsx
import React, { useEffect, useState } from "react";
import { sandboxApi, SandboxApplication, SandboxWallet } from "../../../api/sandboxClient";

export default function SandboxApplicationsPage() {
  const [applications, setApplications] = useState<SandboxApplication[]>([]);
  const [wallets, setWallets] = useState<SandboxWallet[]>([]);
  const [name, setName] = useState("");
  const [walletId, setWalletId] = useState("");
  const [appType, setAppType] = useState("ONLINE_STORE");
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    setError(null);
    try {
      const [appsRes, walletsRes] = await Promise.all([
        sandboxApi.get("/applications"),
        sandboxApi.get("/wallets"),
      ]);
      const walletList: SandboxWallet[] = walletsRes.data.wallets || walletsRes.data || [];
      setWallets(walletList);
      if (!walletId && walletList.length > 0) {
        setWalletId(walletList[0].id);
      }
      setApplications(appsRes.data.applications || appsRes.data || []);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to load Sandbox applications");
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreateSandboxApp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !walletId) return;
    try {
      await sandboxApi.post("/applications", {
        name: name.trim(),
        walletId,
        type: appType,
      });
      setName("");
      await loadData();
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to create Sandbox application");
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <div
        style={{
          background: "#FEF3C7",
          border: "2px solid #F59E0B",
          borderRadius: 10,
          padding: "12px 16px",
          marginBottom: 20,
        }}
      >
        <strong style={{ color: "#92400E" }}>
          SANDBOX APPLICATIONS (BOUND EXCLUSIVELY TO SANDBOX WALLETS)
        </strong>
        <div style={{ fontSize: 13, color: "#78350F" }}>
          Applications created on this page are stored in <code>payment_gateway_sandbox</code> and route 100% of transactions to Stateful Fake Rails v2.
        </div>
      </div>

      {error && (
        <div style={{ background: "#FEE2E2", color: "#991B1B", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <form
        onSubmit={handleCreateSandboxApp}
        style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}
      >
        <input
          type="text"
          placeholder="Sandbox Application Name (e.g., My Store Staging API)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1, minWidth: 240, padding: "10px 14px", borderRadius: 8, border: "1px solid #CBD5E1" }}
        />
        <select
          value={walletId}
          onChange={(e) => setWalletId(e.target.value)}
          style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #CBD5E1" }}
        >
          <option value="">Select Sandbox Wallet...</option>
          {wallets.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({(Number(w.availableMinor || 0) / 1000).toFixed(3)} {w.currency})
            </option>
          ))}
        </select>
        <select
          value={appType}
          onChange={(e) => setAppType(e.target.value)}
          style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #CBD5E1" }}
        >
          <option value="ONLINE_STORE">Online Store / Website</option>
          <option value="MOBILE_APP">Mobile App</option>
          <option value="POS_TERMINAL">Employee Training POS</option>
        </select>
        <button
          type="submit"
          style={{
            background: "#4F46E5",
            color: "#FFF",
            border: "none",
            borderRadius: 8,
            padding: "10px 18px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + Create Sandbox Application
        </button>
      </form>

      <div style={{ display: "grid", gap: 12 }}>
        {applications.map((app) => (
          <div
            key={app.id}
            style={{
              border: "1px solid #E2E8F0",
              borderRadius: 10,
              padding: 16,
              background: "#FFFFFF",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                {app.name} <code style={{ fontSize: 12, color: "#64748B" }}>({app.id})</code>
              </div>
              <div style={{ fontSize: 13, color: "#475569", marginTop: 4 }}>
                Bound Sandbox Wallet: <code>{app.walletId}</code> | Type: <strong>{app.type}</strong> | Status:{" "}
                <strong>{app.status}</strong>
              </div>
            </div>
            <span
              style={{
                background: "#EEF2FF",
                color: "#4338CA",
                padding: "4px 10px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              FAKE RAILS v2 ENABLED
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### 6.6 Dedicated Fake Rails Customer Accounts & Balances Page (`merchant-front/src/pages/sandbox/accounts/index.tsx`)

Gives the merchant full control over simulated customer bank accounts, cards, mobile wallets, and vouchers on `fake-rails-back` so they can test sufficient balance, insufficient funds, daily limit exceeded, frozen accounts, expired cards, and custom static OTP codes:

```tsx
// merchant-front/src/pages/sandbox/accounts/index.tsx
import React, { useEffect, useState } from "react";
import { sandboxApi, FakeRailCustomerAccount } from "../../../api/sandboxClient";

export default function SandboxCustomerAccountsPage() {
  const [accounts, setAccounts] = useState<FakeRailCustomerAccount[]>([]);
  const [railFilter, setRailFilter] = useState<string>("");
  const [exactBalanceInputs, setExactBalanceInputs] = useState<Record<string, string>>({});
  const [otpInputs, setOtpInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const loadAccounts = async () => {
    setError(null);
    try {
      const res = await sandboxApi.get("/fake-rails/accounts", {
        params: railFilter ? { railId: railFilter } : {},
      });
      setAccounts(res.data.accounts || []);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to load Fake Rails customer test accounts");
    }
  };

  useEffect(() => {
    loadAccounts();
  }, [railFilter]);

  const adjustBalance = async (
    accountId: string,
    mode: "CREDIT" | "DEBIT" | "SET_EXACT",
    amountLyd: number,
  ) => {
    try {
      await sandboxApi.patch(`/fake-rails/accounts/${accountId}/balance`, {
        mode,
        amount_minor: Math.round(amountLyd * 1000),
        reason: "Merchant portal Sandbox customer account balance control",
      });
      await loadAccounts();
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to adjust customer test account balance");
    }
  };

  const updateAccountState = async (
    accountId: string,
    patch: { status?: string; static_otp?: string; daily_limit_minor?: number },
  ) => {
    try {
      await sandboxApi.patch(`/fake-rails/accounts/${accountId}/state`, patch);
      await loadAccounts();
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to update test account state");
    }
  };

  const handleResetAllAccounts = async () => {
    await sandboxApi.post("/fake-rails/accounts/reset", {});
    await loadAccounts();
  };

  return (
    <div style={{ padding: 24 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 20,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Fake Rails Test Customer Accounts & Balances</h2>
          <p style={{ margin: "4px 0 0", color: "#475569", fontSize: 14 }}>
            Control the simulated customer cards, bank accounts, mobile wallets, and vouchers used on Sandbox Checkout pages.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <select
            value={railFilter}
            onChange={(e) => setRailFilter(e.target.value)}
            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #CBD5E1" }}
          >
            <option value="">All Fake Rails (13 Rails)</option>
            <option value="CARD_LOCAL">Local Cards (Numu / Sahara / Gumhouria)</option>
            <option value="CARD_MPGS">International Cards (MPGS)</option>
            <option value="LYPAY">LYPay Instant Bank Transfer</option>
            <option value="ONEPAY">OnePay</option>
            <option value="YUSSOR_PAY">YussorPay</option>
            <option value="MOBICASH">MobiCash</option>
            <option value="SADAD">Sadad Wallet</option>
            <option value="TADAWUL">Tadawul Card</option>
            <option value="EDFA3LY">Edfa3ly</option>
            <option value="MOAMALAT">Moamalat</option>
            <option value="KURDI_VOUCHER">Kurdi Voucher</option>
          </select>
          <button
            type="button"
            onClick={handleResetAllAccounts}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "1px solid #CBD5E1",
              background: "#F8FAFC",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reset Customer Balances to Defaults
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: "#FEE2E2", color: "#991B1B", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        {accounts.map((acc) => {
          const availLyd = (acc.available_balance_minor / 1000).toFixed(3);
          const heldLyd = (acc.held_balance_minor / 1000).toFixed(3);
          const limitLyd = (acc.daily_limit_minor / 1000).toFixed(3);
          return (
            <div
              key={acc.id}
              style={{
                border: "1px solid #CBD5E1",
                borderRadius: 12,
                padding: 16,
                background: "#FFFFFF",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div>
                  <span
                    style={{
                      background: "#E0E7FF",
                      color: "#3730A3",
                      padding: "2px 8px",
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 700,
                      marginRight: 8,
                    }}
                  >
                    {acc.rail_id}
                  </span>
                  <strong>{acc.label}</strong> ({acc.account_holder_name})
                  <div style={{ fontSize: 13, color: "#334155", marginTop: 6 }}>
                    Credential ({acc.identifier_type}): <code>{acc.identifier_value}</code>
                    {acc.secondary_secret && (
                      <>
                        {" "}
                        | CVV/PIN: <code>{acc.secondary_secret}</code>
                      </>
                    )}
                    {acc.expiry_code && (
                      <>
                        {" "}
                        | Expiry: <code>{acc.expiry_code}</code>
                      </>
                    )}
                    {" "}| Static OTP: <code>{acc.static_otp}</code>
                  </div>
                  <div style={{ fontSize: 13, color: "#0F172A", marginTop: 6 }}>
                    Available Balance: <strong>{availLyd} {acc.currency}</strong> | Auth Holds:{" "}
                    <strong>{heldLyd} {acc.currency}</strong> | Daily Limit:{" "}
                    <strong>{limitLyd} {acc.currency}</strong> | Status:{" "}
                    <strong style={{ color: acc.status === "ACTIVE" ? "#059669" : "#DC2626" }}>
                      {acc.status}
                    </strong>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => adjustBalance(acc.id, "CREDIT", 1000)}
                    style={{ padding: "6px 10px", borderRadius: 6, background: "#ECFDF5", color: "#065F46", border: "1px solid #10B981", cursor: "pointer", fontWeight: 600 }}
                  >
                    +1,000 LYD
                  </button>
                  <button
                    type="button"
                    onClick={() => adjustBalance(acc.id, "SET_EXACT", 0)}
                    style={{ padding: "6px 10px", borderRadius: 6, background: "#FEF2F2", color: "#991B1B", border: "1px solid #EF4444", cursor: "pointer", fontWeight: 600 }}
                  >
                    Drain (0 LYD)
                  </button>
                  <input
                    type="number"
                    step="0.001"
                    placeholder="Set LYD"
                    value={exactBalanceInputs[acc.id] || ""}
                    onChange={(e) =>
                      setExactBalanceInputs((p) => ({ ...p, [acc.id]: e.target.value }))
                    }
                    style={{ width: 95, padding: "6px", borderRadius: 6, border: "1px solid #CBD5E1" }}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      adjustBalance(acc.id, "SET_EXACT", Number(exactBalanceInputs[acc.id] || 0))
                    }
                    style={{ padding: "6px 10px", borderRadius: 6, background: "#1E293B", color: "#FFF", border: "none", cursor: "pointer", fontWeight: 600 }}
                  >
                    Apply Balance
                  </button>

                  <select
                    value={acc.status}
                    onChange={(e) => updateAccountState(acc.id, { status: e.target.value })}
                    style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #CBD5E1" }}
                  >
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="FROZEN">FROZEN</option>
                    <option value="LOCKED">LOCKED</option>
                    <option value="EXPIRED">EXPIRED</option>
                  </select>

                  <input
                    type="text"
                    maxLength={6}
                    placeholder="OTP (e.g. 123456)"
                    value={otpInputs[acc.id] ?? acc.static_otp}
                    onChange={(e) =>
                      setOtpInputs((p) => ({ ...p, [acc.id]: e.target.value }))
                    }
                    style={{ width: 78, padding: "6px", borderRadius: 6, border: "1px solid #CBD5E1" }}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      updateAccountState(acc.id, {
                        static_otp: otpInputs[acc.id] || acc.static_otp,
                      })
                    }
                    style={{ padding: "6px 10px", borderRadius: 6, background: "#4F46E5", color: "#FFF", border: "none", cursor: "pointer", fontWeight: 600 }}
                  >
                    Save OTP
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

---

## 7. Multi-Node Deploy Engine Integration (`deploy/`)

### 7.1 `SANDBOX_NODE` Role in `deploy/engine/lib/config-schema.sh` & `deploy/engine/deploy-engine.sh`

1. **Zero Pressure on Live `CORE_NODE` and `DATABASE_NODE`:**
   - In `deploy/config/environments/*.env`, `SANDBOX_NODE_ENABLED=true` provisions a dedicated `SANDBOX_NODE` (`SANDBOX_NODE_HOST`) running:
     - Its own isolated PostgreSQL database (`payment_gateway_sandbox`)
     - `pg-core-sandbox.service` (`EXECUTION_PLANE=SANDBOX`, `FAKE_RAILS_ENABLED=true`, port `4005`)
     - `pg-fake-rails-back.service` (`PORT=4105`, SQLite WAL `fake-rails.sqlite`)
   - Live `CORE_NODE` hosts run `pg-core-back.service` with `EXECUTION_PLANE=LIVE` and `FAKE_RAILS_ENABLED=false`. `pg-fake-rails-back.service` is **never** installed or started on any Live `CORE_NODE`.
2. **Automatic Discovery & Injection into Edge BFFs:**
   - When `SANDBOX_NODE_ENABLED=true`, `deploy/engine/steps/05-render-env.sh` automatically populates `SANDBOX_CORE_BACK_URLS="http://${SANDBOX_NODE_PRIVATE_IP}:4005"` into `merchant-back.env`, `admin-back.env`, and `checkout-back.env`.
3. **Single-Node Dev/Staging Support Without Table Mixing:**
   - Even when running on a single host (`DEPLOY_TOPOLOGY=single-node`), `prepare-databases.sh` creates **two separate PostgreSQL databases** on the local PostgreSQL instance: `payment_gateway_prod` (`EXECUTION_PLANE=LIVE` on port `4000`) and `payment_gateway_sandbox` (`EXECUTION_PLANE=SANDBOX` on port `4005`). Live and Sandbox rows **never** share a database table in any topology.

---

## 8. Triple-Pass Edge-Case & Security Audit (All 18 Edge Cases Resolved)

| # | Failure / Confusion Scenario | Concrete Architectural Prevention in `v38` |
|---|---|---|
| **1** | **Confused maintainer or coding agent forgets `WHERE env = 'LIVE'` in a query** | Impossible to leak Sandbox rows into Live queries because `payment_gateway_prod` contains **0 Sandbox rows**. All Sandbox Wallets, Applications, Links, Attempts, and Ledger entries live exclusively in the separate `payment_gateway_sandbox` database. |
| **2** | **Merchant or employee confuses Live Wallets/Applications with Sandbox Wallets/Applications** | Live Wallets (`/wallets`) and Sandbox Wallets (`/sandbox/wallets`) are on completely separate UI pages in separate sidebar sections, backed by separate API namespaces (`/api/v1/merchant/*` vs `/api/v1/merchant/sandbox/*`). |
| **3** | **Deactivated or `PENDING` Live merchant, wallet, or application is silently treated as `"SANDBOX"` (`OD-10` / `resolveEnvironment` bug)** | Removed completely in `v38`. `commerceStatus.ts`, `checkout.ts`, `merchant.ts`, and `AttemptGuardPipeline.ts` strictly require `status === "ACTIVE"` on the Live plane (`409 MERCHANT_NOT_ACTIVE` / `WALLET_NOT_ACTIVE` / `APPLICATION_NOT_ACTIVE`). |
| **4** | **Newly registered (`PENDING` KYB) merchant wants to test API integration before Live approval** | The merchant logs into the portal and uses the **`Sandbox Studio` (`/sandbox/*`)** section immediately. `ensureSandboxMerchantEnvelope` provisions their isolated merchant record in `payment_gateway_sandbox` as `ACTIVE` without activating them in `payment_gateway_prod`. |
| **5** | **Merchant uses `pg_test_*` token against Live `/api/external/v1/*` or `pg_live_*` against Sandbox** | `merchant-back` routes `pg_test_*` strictly to `sandboxCorePool` and `pg_live_*` strictly to `liveCorePool`. Furthermore, `trg_fence_plane_*` and `PlaneFenceGuard` reject any mismatched token/plane at the core and database levels. |
| **6** | **Code bug tries to insert `env = 'SANDBOX'` or enable a `FAKE_*` gateway on `payment_gateway_prod`** | Blocked at PostgreSQL trigger level (`trg_fence_plane_*` and `trg_fence_fake_rails_gateways` raise `P0001: SANDBOX_FENCE_VIOLATION`). |
| **7** | **Checkout secret/OTP inspector (`SandboxCheckoutInspector`) accidentally renders on a Live `pl_*` checkout link** | Triple-gated: (a) `checkout-front` requires `linkKey.startsWith('sbx_')` AND `session.environment === 'SANDBOX'`; (b) `checkout-back` refuses `/sandbox-inspector` unless `linkKey` starts with `sbx_`; (c) `pg-core-back` (`LIVE`) does not mount `/internal/sandbox/*` and has no network route to `fake-rails-back`. |
| **8** | **Two concurrent Sandbox checkouts debit the same Fake Rails customer test account simultaneously** | `AccountLedgerService.authorizeOrDebit()` executes inside a `BEGIN IMMEDIATE` SQLite transaction on `fake-rails.sqlite`, atomically checking `available_balance_minor >= amount_minor` and creating an auth hold or debit without race conditions. |
| **9** | **Customer requests OTP resend or wrong OTP attempt lockouts on Fake Rails** | `fake_rail_challenges` tracks `attempt_count`, `max_attempts = 3`, `resend_count`, and reveals the current valid OTP code live in `SandboxCheckoutInspector` so the tester can test both wrong-OTP lockouts and valid OTP completion. |
| **10** | **Two-phase card authorization hold (`AUTH_ONLY`) expires without capture** | `AccountLedgerService` records `expires_at` on `fake_rail_holds` and allows instant manual release or capture, returning held funds to `available_balance_minor`. |
| **11** | **Partial or multiple refunds exceed original captured payment** | `AccountLedgerService.refundCapture()` verifies `cumulative_refunded_minor + refund_minor <= captured_amount_minor` on `fake_rail_movements` and credits the customer's Fake Rails account balance back atomically. |
| **12** | **Merchant wants to test insufficient balance on Checkout and then immediately top up & retry** | The Checkout page's `SandboxCheckoutInspector` drawer includes `+1,000 LYD`, `Drain to 0 LYD`, and `Set Exact Balance` buttons that mutate the selected customer account on `fake-rails-back` in real time without reloading the checkout session. |
| **13** | **Merchant wants to test Cashout or Refund when their Sandbox Wallet has `0 LYD`** | `/sandbox/wallets` includes a self-service **Sandbox Wallet Balance Controller** (`+1,000 LYD`, `Set Exact Balance`, `Drain to 0 LYD`) that posts a balanced journal entry in `payment_gateway_sandbox`. |
| **14** | **Admin updates fee/commission rules on Live and wants Sandbox to match** | Admin clicks **"Sync Live Gateway Blueprints to Sandbox"** on `/sandbox/overview` (`POST /api/v1/admin/sandbox/sync-blueprints`), which copies non-sensitive gateway/fee/guard configs to `pg-core-sandbox` while rewriting all adapter endpoints to `pg-fake-rails-back`. |
| **15** | **Sandbox webhook worker SSRF against internal private IPs** | `pg-core-sandbox` webhook dispatcher blocks RFC1918/loopback targets unless explicitly allowlisted in `SANDBOX_WEBHOOK_ALLOW_LOCALHOST` for local dev, signs payloads with `X-PayGateway-Env: SANDBOX`, and caps concurrency so it never starves CPU. |
| **16** | **Merchant resets their Sandbox workspace while another merchant is testing** | `POST /api/v1/merchant/sandbox/reset` scopes all deletions strictly to `WHERE merchant_id = req.merchantId` in `payment_gateway_sandbox` and `fake_rail_accounts`. |
| **17** | **Testing end-to-end Reconciliation in Sandbox** | `pg-fake-rails-back` maintains `fake_rail_clearing_entries` for every captured/refunded movement and exports a synthetic bank settlement statement directly into `pg-core-sandbox`'s Reconciliation Engine. |
| **18** | **Wrong `DATABASE_URL` configured on `pg-core-sandbox` pointing to `payment_gateway_prod`** | `verifyExecutionPlaneFenceOnBoot()` checks `system_execution_plane.plane` at process startup before Express listens; if `EXECUTION_PLANE=SANDBOX` connects to a `LIVE` database (or vice versa), the process aborts immediately with `FATAL_PLANE_FENCE_VIOLATION`. |

---

## 9. Guides, IT Runbooks & Employee Academy Updates

Update the following documentation and in-app Academy modules so merchants, employees, and IT administrators have complete guidance:
1. **`docs/guides/MERCHANT_SANDBOX_AND_API_INTEGRATION_GUIDE.md`:**
   - Explains the strict separation between Live pages (`/wallets`, `/applications`, `/links`) and **`Sandbox Studio` (`/sandbox/*`)**.
   - Step-by-step guide for testing website/mobile app integrations using `pg_test_*` tokens, testing webhook signatures, controlling Sandbox Wallet balances on `/sandbox/wallets`, controlling Fake Rails customer balances on `/sandbox/accounts`, and using the Checkout Secret & OTP Inspector drawer on `/pay/sbx_*`.
   - Step-by-step Employee POS & Refund Training workflow using `/sandbox/links` and `/sandbox/payments`.
2. **`docs/runbooks/SANDBOX_NODE_DEPLOYMENT_AND_OPERATIONS.md`:**
   - Complete runbook for provisioning `SANDBOX_NODE`, verifying `system_execution_plane`, syncing Live blueprints to Sandbox, and monitoring `pg-core-sandbox` and `pg-fake-rails-back`.
3. **Portal Academy (`merchant-front/src/pages/academy/` & `admin-front/src/pages/academy/`):**
   - Add interactive Academy lesson **"Testing Your Store Integration & Training Staff in Sandbox Studio"** with direct deep-links to `/sandbox/overview`, `/sandbox/wallets`, `/sandbox/applications`, and `/sandbox/accounts`.

---

## 10. Complete 24-Test Verification Matrix (`core-back/test/sandboxPlane.test.ts` & `fake-rails-back/test/accountsAndInspector.test.ts`)

`OpenCode` must create and run both test suites and verify 100% pass rate before completion:

1. **`T01` — Database Plane Trigger Fence (`LIVE` DB rejects `SANDBOX` rows):** Attempting to insert a `payment_links`, `payment_attempts`, or `merchant_api_tokens` row with `env = 'SANDBOX'` into `payment_gateway_prod` (`plane = 'LIVE'`) throws `P0001: SANDBOX_FENCE_VIOLATION`.
2. **`T02` — Database Plane Trigger Fence (`SANDBOX` DB rejects `LIVE` rows):** Attempting to insert a row with `env = 'LIVE'` into `payment_gateway_sandbox` (`plane = 'SANDBOX'`) throws `P0001: SANDBOX_FENCE_VIOLATION`.
3. **`T03` — Fake Rails Gateway Trigger Fence on `LIVE` DB:** Attempting to insert or enable a `Gateway` with `adapterKey = 'FAKE_RAILS'` on `payment_gateway_prod` throws `SANDBOX_FENCE_VIOLATION`.
4. **`T04` — Boot Fence Guard (`PlaneFenceGuard`):** Starting `core-back` with `EXECUTION_PLANE=SANDBOX` against a `plane='LIVE'` database (or with `FAKE_RAILS_ENABLED=true` on `EXECUTION_PLANE=LIVE`) throws `FATAL_PLANE_FENCE_VIOLATION`.
5. **`T05` — Zero Residual `OD-10` Leak on Live:** Creating a payment link or payment attempt on `EXECUTION_PLANE=LIVE` for a `PENDING` or `SUSPENDED` merchant throws `409 MERCHANT_NOT_ACTIVE` (never falls back to `"SANDBOX"`).
6. **`T06` — Zero Residual Inactive Wallet/App Leak on Live:** Creating or paying a link on `EXECUTION_PLANE=LIVE` with a `PENDING` wallet or `PENDING`/`DRAFT` application throws `409 WALLET_NOT_ACTIVE` / `409 APPLICATION_NOT_ACTIVE`.
7. **`T07` — `PENDING` Merchant Can Use Dedicated `/sandbox/*` Plane:** A merchant whose Live KYB status is `PENDING` calls `/api/v1/merchant/sandbox/seed-demo` and `/api/v1/merchant/sandbox/wallets`; `ensureSandboxMerchantEnvelope` provisions their Sandbox envelope in `payment_gateway_sandbox` and succeeds without modifying `payment_gateway_prod`.
8. **`T08` — Strict Separation of Live Wallets (`/wallets`) vs Sandbox Wallets (`/sandbox/wallets`):** Creating a wallet via `POST /api/v1/merchant/sandbox/wallets` creates the row in `payment_gateway_sandbox` and returns `0` matching rows in `payment_gateway_prod`.
9. **`T09` — Strict Separation of Live Applications (`/applications`) vs Sandbox Applications (`/sandbox/applications`):** Creating an application via `POST /api/v1/merchant/sandbox/applications` binds to a Sandbox Wallet in `payment_gateway_sandbox` and never appears in `payment_gateway_prod`.
10. **`T10` — Merchant Self-Service Sandbox Wallet Balance Control:** Calling `POST /api/v1/merchant/sandbox/wallets/:id/balance` (`CREDIT`, `DEBIT`, `SET_EXACT`) updates `availableMinor` in `payment_gateway_sandbox` and records a `WALLET_TOPUP` audit entry; negative target balances are rejected with `409 NEGATIVE_SANDBOX_WALLET_BALANCE`.
11. **`T11` — External API Key Routing (`pg_test_*` vs `pg_live_*`):** Sending `Authorization: Bearer pg_test_...` to `/api/external/v1/links` routes to `pg-core-sandbox` (`sbx_*` link created in `payment_gateway_sandbox`), while `pg_live_...` routes to `pg-core-back` (`pl_*` link created in `payment_gateway_prod`).
12. **`T12` — Fake Rails v2 Customer Account Seeding across All 13 Rails:** Booting `fake-rails-back` seeds default funded, low-balance, frozen, and high-value accounts for all 13 rails (`CARD_LOCAL`, `CARD_MPGS`, `LYPAY`, `ONEPAY`, `YUSSOR_PAY`, `MOBICASH`, `SADAD`, `TADAWUL`, `EDFA3LY`, `MOAMALAT`, `KURDI_VOUCHER`, `BANK_TRANSFER`, `NPG_LEGACY`).
13. **`T13` — Fake Rails v2 Real Balance Debit & Insufficient Funds Check:** Attempting a `200.000 LYD` payment against a customer test account with `50.000 LYD` available fails deterministically with `INSUFFICIENT_FUNDS` (`available_balance_minor` unchanged).
14. **`T14` — Fake Rails v2 Live Balance Top-Up & Immediate Checkout Retry:** Calling `PATCH /api/v1/pay/:sbxLinkKey/sandbox-inspector/account-balance` to add `+500.000 LYD` to the customer test account allows the immediate retry of the `200.000 LYD` payment to succeed, reducing `available_balance_minor` to `350.000 LYD`.
15. **`T15` — Fake Rails v2 Two-Phase Auth Hold, Capture, and Hold Release:** Creating an `AUTH_ONLY` card hold moves funds from `available_balance_minor` to `held_balance_minor`; capturing moves held funds into `fake_rail_clearing_entries`; releasing restores `available_balance_minor`.
16. **`T16` — Fake Rails v2 Customer Daily Limit & Frozen Account Enforcement:** Attempting a payment exceeding `daily_limit_minor` returns `DAILY_LIMIT_EXCEEDED`; setting account `status = 'FROZEN'` returns `ACCOUNT_FROZEN`.
17. **`T17` — Fake Rails v2 Live OTP Challenge Creation & Reveal on Checkout:** Initiating an OTP-gated payment creates a `fake_rail_challenges` row and exposes the exact `otpCode` via `GET /api/v1/pay/:sbxLinkKey/sandbox-inspector` for `sbx_*` links.
18. **`T18` — Checkout Inspector Blocked on Live `pl_*` Links:** Calling `GET /api/v1/pay/pl_live123/sandbox-inspector` returns `403 SANDBOX_INSPECTOR_FORBIDDEN_ON_LIVE_LINK`.
19. **`T19` — Refund Crediting Back to Customer Fake Rails Account & Clearing Pool:** Executing a partial and then remaining refund on a Sandbox payment debits the merchant's Sandbox Wallet in `payment_gateway_sandbox` and credits the customer's `available_balance_minor` in `fake-rails-back`.
20. **`T20` — Over-Refund Prevention on Fake Rails v2:** Attempting a refund whose cumulative total exceeds the captured movement amount is rejected with `REFUND_EXCEEDS_CAPTURED_AMOUNT`.
21. **`T21` — Synthetic Settlement Statement Export to Sandbox Reconciliation:** Calling `POST /api/fake-rails/v1/clearing/generate-statement` generates a settlement batch from `fake_rail_clearing_entries` and reconciles cleanly in `pg-core-sandbox`.
22. **`T22` — Merchant-Scoped Sandbox Reset Isolation:** Calling `POST /api/v1/merchant/sandbox/reset` for Merchant A wipes Merchant A's Sandbox Wallets, Applications, Links, and Attempts in `payment_gateway_sandbox` while leaving Merchant B's Sandbox data and all Live `payment_gateway_prod` data 100% untouched.
23. **`T23` — Live-to-Sandbox Gateway Blueprint Sync Rewrites Endpoints to Fake Rails:** Running `BlueprintSyncService.syncFromLiveToSandbox()` copies gateway/fee/commission configs to `payment_gateway_sandbox` and rewrites every gateway `endpointUrl` to `pg-fake-rails-back` (`http://127.0.0.1:4105`).
24. **`T24` — End-to-End Checkout UI Secret Auto-Fill & 1-Click OTP Verification:** On `checkout-front`, selecting a preset account in `SandboxCheckoutInspector` populates the rail form inputs, reveals the active OTP challenge code, and completes the Sandbox payment end-to-end.

---

## 11. Step-by-Step Execution Order for `OpenCode`

1. **Step 1 — Remove Residual Implicit-Sandbox Leaks & Upgrade Schema to `v38` (`core-back`):**
   - Update `core-back/lib/executionPlane.ts`, `core-back/lib/commerceStatus.ts`, `core-back/engine/guards/AttemptGuardPipeline.ts`, `core-back/api/internal/checkout.ts`, `core-back/api/internal/merchant.ts`, and `core-back/prisma/seed.ts` to eliminate `OD-10` and `resolveEnvironment(merchantStatus)`.
   - Bump `REQUIRED_SCHEMA_VERSION = 38` in `core-back/prisma/schemaVersion.ts`, update `core-back/prisma/schema.prisma`, add the `v38` SQL & trigger fence block to `core-back/prisma/prepare-databases.sh` (ensuring both `payment_gateway_prod` and `payment_gateway_sandbox` databases are prepared), and wire `verifyExecutionPlaneFenceOnBoot()` into `core-back/index.ts`.
2. **Step 2 — Implement Stateful Fake Rails v2 (`fake-rails-back`):**
   - Create `fake-rails-back/engine/db/schema.sql`, `AccountLedgerService.ts`, `defaultAccountsSeed.ts`, `accounts.ts`, `inspector.ts`, and `clearing.ts` (Section 3) so all 13 rails run against real SQLite WAL customer accounts, balances, holds, and OTP challenges.
3. **Step 3 — Wire Checkout Secret & Balance Inspector (`core-back`, `checkout-back`, `checkout-front`):**
   - Add `FakeRailsControlClient.ts` and `/internal/sandbox` routes in `core-back`, mount `/api/v1/pay/:linkKey/sandbox-inspector` in `checkout-back`, and add `SandboxCheckoutInspector.tsx` to `checkout-front` (`pay/[linkKey].tsx`, `redirect/[sessionId].tsx`, `widget-frame.tsx`) (Section 4).
4. **Step 4 — Wire Dual-Pool Routing & Dedicated `/sandbox/*` API Proxies (`merchant-back`, `admin-back`, `checkout-back`):**
   - Add `liveCorePool` and `sandboxCorePool` (`corePools.ts`), mount `/api/v1/merchant/sandbox/*` (`sandboxProxy.ts`) and `/api/v1/admin/sandbox/*`, and route `Bearer pg_test_*` tokens on `/api/external/v1/*` strictly to `sandboxCorePool` (Section 5).
5. **Step 5 — Build Separate `/sandbox/*` UI Sections & Pages (`merchant-front`, `admin-front`):**
   - Create `merchant-front/src/api/sandboxClient.ts`, add the **`Sandbox Studio (Testing & Training)`** sidebar section in `merchant-front/src/layouts/sections.tsx`, and create the dedicated pages (`/sandbox/overview`, `/sandbox/wallets`, `/sandbox/applications`, `/sandbox/links`, `/sandbox/payments`, `/sandbox/accounts`, `/sandbox/tokens`) plus Admin `/sandbox/*` pages (Section 6).
6. **Step 6 — Update Multi-Node Deploy Engine (`deploy/`) & Documentation (`docs/`):**
   - Add `SANDBOX_NODE` support to `deploy/engine/lib/config-schema.sh`, `deploy/engine/deploy-engine.sh`, `deploy/engine/steps/05-render-env.sh`, and `deploy/systemd/pg-core-sandbox.service` (Section 7), and write the Merchant/IT guides and Academy modules (Section 9).
7. **Step 7 — Run the 24-Test Verification Suite:**
   - Implement and run `core-back/test/sandboxPlane.test.ts`, `fake-rails-back/test/accountsAndInspector.test.ts`, `core-back/test/security-regressions/commerce-status-enforcement.test.ts`, and `core-back/test/engine/attempt-guard-pipeline.test.ts` until all tests pass with zero warnings.

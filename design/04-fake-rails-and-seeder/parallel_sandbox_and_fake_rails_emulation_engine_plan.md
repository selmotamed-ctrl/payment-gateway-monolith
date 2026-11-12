# Parallel Sandbox Environment & Stateful Fake Rails v2 Emulation Engine — Complete Implementation Specification (`v38`)

**Target Audience:** Autonomous Coding Agent (`OpenCode`) & Platform Architecture Team

**Baseline Repository State:** `REQUIRED_SCHEMA_VERSION = 37`

**Target Repository State:** `REQUIRED_SCHEMA_VERSION = 38`

**Core Mandate:** Build a **100% self-contained, zero-live-pressure Parallel Sandbox Environment** (`SANDBOX_NODE` running an isolated PostgreSQL 18 database `payment_gateway_sandbox`, a dedicated `pg-core-sandbox` runtime, and a redesigned stateful `pg-fake-rails-back` v2 switch) that mirrors the entire Payment Gateway process (Ledger, Wallets, Applications, Payment Links, Attempts, Webhooks, Cash-outs, Disputes, Adjustments, Reconciliation, and Report Studio), **cryptographically and physically forbids Fake Rails from ever posting to the Live Ledger in production**, gives merchants and testers **full control over customer account/card/wallet/voucher balances on Fake Rails**, and provides an **interactive Checkout Secret & Balance Inspector Drawer** directly on the Sandbox Checkout page (`/pay/sbx_...`) so testers can view generated OTPs/3DS codes, adjust account balances, and trigger mobile Push/QR approvals in one click.

## 1. Executive Architecture & Why the Previous Sandbox Model Was Insufficient

### 1.1 The Five Root Flaws in the Baseline (`v37`) Codebase

1. **Shared Database & Shared Ledger Contamination:**

   * In `v37`, there is only one `journal_entries` table, one `journal_lines` table, one `gl_accounts` / `gl_account_shards` hierarchy, one `wallets` table, one `applications` table, and one `payment_links` table. Any "sandbox" transaction wrote directly into the primary production database and mutated the same tables as real money.

2. **`ACTIVE` Merchants Were Locked Out of Sandbox (`checkout.ts` line 168):**

   * `resolveEnvironment(merchantStatus)` hardcoded `merchantStatus === "ACTIVE" ? "LIVE" : "SANDBOX"`. The moment a merchant passed KYB and became `ACTIVE`, they could no longer run sandbox tests, onboard new developers, or test new rails in Sandbox.

3. **`FAKE_RAILS_ENABLED` Was Blocked in Production (`configSchema.ts` line 811):**

   * Because `seedFakeRails.ts` overwrote all `gateway_environments` in the single database to point at `FAKE_RAILS_PUBLIC_BASE_URL`, enabling Fake Rails in production would have allowed simulated Fake Rails webhooks to credit real merchant wallets on the production ledger.

4. **Stateless Fake Rails With No Customer Accounts or Balance Control (`fake-rails-back`):**

   * `fake-rails-back` had only `fake_transactions` and random percentage chaos sliders. It had **no customer accounts, no card/wallet/voucher balances, no daily limits, and no hold/capture accounting**—typing any arbitrary phone number or card number succeeded with infinite fake money unless a chaos slider fired.

5. **Blind Checkout Experience (`checkout-front` & `hosted.ts`):**

   * When a merchant or developer opened a payment link on `checkout-front`, there was no indication of which test phone numbers/cards existed, what their balances were, what OTP code `fake-rails-back` generated (`expected_otp`), or how to approve a `QR_DISPLAY` / `PUSH_APPROVAL` payment without logging into a separate admin server (`fake-rails-front:8444`).

### 1.2 The `v38` Parallel Sandbox Plane Architecture (Zero Pressure on Real Nodes)

```
====================================================================================================
                                EDGE TIER (SHARED PORTALS & ROUTERS)
   admin-front / admin-back          merchant-front / merchant-back        checkout-front / checkout-back
   [Header: X-Pg-Env: LIVE|SANDBOX]  [Header: X-Pg-Env: LIVE|SANDBOX]      [Link prefix: pay_* vs sbx_*]
                                     [API Token: pg_live_* vs pg_test_*]   [Inbound: /live/ vs /sandbox/]
====================================================================================================
                     |                                                                   |
     LIVE Traffic    | mTLS (CN=*-back)                                  SANDBOX Traffic | mTLS (CN=*-back)
     (Zero Sandbox   |                                                   (100% Isolated  |
      Load!)         v                                                    on SANDBOX_NODE)v
+---------------------------------------------------+   +---------------------------------------------------+
|            LIVE PRODUCTION PLANE                  |   |           PARALLEL SANDBOX PLANE                  |
|  Host(s): CORE_NODES (core-1, core-2, ...)        |   |  Host: SANDBOX_NODE (sandbox-1:4005)              |
|  Service: pg-core-back (EXECUTION_PLANE="LIVE")   |   |  Service: pg-core-sandbox (EXECUTION_PLANE="SANDBOX")|
|  - ALLOW_FAKE_RAILS_HOSTS="false" (Hard-blocked)  |   |  - ALLOW_FAKE_RAILS_HOSTS="true" (Fake Rails ONLY)|
|  - Rejects pg_test_*, sbx_*, and SANDBOX webhooks |   |  - Runs all 24 workers on pg_sandbox_db           |
|  - Connects ONLY to Real Partner Bank Switches    |   |  - Connects ONLY to co-hosted pg-fake-rails-back  |
+-------------------------+-------------------------+   +------------+----------------------------+---------+
                          |                                          |                            |
                          v                                          v                            v
+---------------------------------------------------+   +-------------------------+  +----------------------+
|         LIVE POSTGRESQL 18 CLUSTER                |   |  SANDBOX POSTGRESQL 18  |  | STATEFUL FAKE RAILS  |
|  DB: payment_gateway_prod (PG_PRIMARY_NODE)       |   |  DB: payment_gateway_   |  | v2 (fake-rails-back) |
|  Trigger: enforce_execution_plane_fence_trg       |   |      sandbox            |  | - fake_accounts      |
|  - FORBIDS any row with env='SANDBOX' or 'FK-%'   |   |  100% Mirrored Tables:  |  | - fake_account_holds |
|  - Real Ledger (journal_entries / journal_lines)  |   |  - Sandbox Ledger       |  | - fake_account_      |
|  - Real Wallets, Applications, Links, Attempts    |   |  - Sandbox Wallets/Apps |  |   movements          |
|  - Redis DB 0 & Object Storage /hot/live/...      |   |  - Sandbox Links/Webhooks| | - Checkout Secret &  |
+---------------------------------------------------+   |  - Redis DB 1 & /sandbox|  |   Balance API        |
                                                        +-------------------------+  +----------------------+

```

### 1.3 Five Defense-in-Depth Guarantees That Fake Rails Can NEVER Touch the Live Ledger

| Layer | Enforcement Point | Exact Mechanism & Error Code | 
| ----- | ----- | ----- | 
| **1. Process & Network Plane Fence** | `core-back` (`EXECUTION_PLANE="LIVE"`) | Live `core-back` boots with `EXECUTION_PLANE="LIVE"` and `ALLOW_FAKE_RAILS_HOSTS="false"`. `StepExecutor` and `ApiConsumer` reject any outbound URL matching `FAKE_RAILS_PUBLIC_BASE_URL`, `FAKE_RAILS_ALLOWED_HOSTS`, or `/rails/` with `403 FAKE_RAILS_FORBIDDEN_ON_LIVE_PLANE`. Conversely, `pg-core-sandbox` (`EXECUTION_PLANE="SANDBOX"`) rejects any outbound call to a non-Fake-Rails host (`403 LIVE_GATEWAY_FORBIDDEN_ON_SANDBOX_PLANE`). | 
| **2. Database Trigger Fence (`v38`)** | PostgreSQL 18 (`enforce_execution_plane_fence_trg`) | `platform_settings` stores `key = 'database.execution_plane'` (`'LIVE'` on `payment_gateway_prod`, `'SANDBOX'` on `payment_gateway_sandbox`). A `BEFORE INSERT OR UPDATE` trigger on `payment_attempts`, `journal_entries`, `gl_accounts`, `wallets`, `applications`, and `payment_links` blocks any `env = 'SANDBOX'` or `provider_reference LIKE 'FK-%'` row on the `LIVE` database (`23514: LIVE_LEDGER_SANDBOX_POST_FORBIDDEN`) and blocks any `env = 'LIVE'` row on the `SANDBOX` database (`23514: SANDBOX_LEDGER_LIVE_POST_FORBIDDEN`). | 
| **3. Cryptographic Token & Link Prefixes** | `authDoubleCheck.ts` & `checkout.ts` | Live API tokens use `pg_live_<random>`; Sandbox API tokens use `pg_test_<random>`. Live payment links use `pay_<slug>`; Sandbox payment links use `sbx_<slug>`. Live POS terminals use `POS-<code >`; Sandbox POS terminals use `SBX-POS-<code>`. A `pg_test_*` token or `sbx_*` link presented to a `LIVE` core node is immediately rejected with `403 SANDBOX_ARTIFACT_ON_LIVE_PLANE`. | 
| **4. Dual-Pool Edge Routing** | `admin-back`, `merchant-back`, `checkout-back` | Edge services maintain two isolated mTLS pools: `liveCorePool` (`CORE_BACK_URLS`) and `sandboxCorePool` (`SANDBOX_CORE_BACK_URLS`). Requests with `X-Pg-Env: SANDBOX`, `Bearer pg_test_*`, `/pay/sbx_*`, or `/inbound/:gw/sandbox/:token` are routed exclusively to `sandboxCorePool`. | 
| **5. Host Firewall & mTLS Scoping** | `firewallConfigurator.ts` & `pkiManager.ts` | `PG_PRIMARY_NODE` port `5432`/`6432` only accepts packets from `CORE_NODES` private IPs (never `SANDBOX_NODE`). `fake-rails-back` only accepts traffic from `SANDBOX_NODE` and browser `/hosted/*`, `/sdk/*` requests. | 

## 2. Database Schema `v38`: Execution Plane Fence & Sandbox Sync Metadata (`core-back/prisma/`)

### 2.1 Update `core-back/prisma/schemaVersion.ts`

```
// core-back/prisma/schemaVersion.ts
export const REQUIRED_SCHEMA_VERSION = 38;

```

### 2.2 Update `core-back/prisma/schema.prisma`

Because `payment_gateway_prod` (Live) and `payment_gateway_sandbox` (Sandbox) run the **exact same `schema.prisma`**, every model in `schema.prisma` exists in both databases as physically separate tables. In addition, we add explicit `env` plane tags and sandbox configuration fields to `Application`, `Wallet`, `PaymentLink`, `AccessToken`, `JournalEntry`, and a `SandboxSyncWatermark` table:

```
// ============================================================================
// ADD / UPDATE IN core-back/prisma/schema.prisma (v38 Parallel Sandbox Plane)
// ============================================================================

enum SandboxCheckoutInspectorMode {
  OPEN_IN_SANDBOX
  PIN_PROTECTED
  DISABLED
}

// Add to model Application (around line 1085):
//   env                          GatewayEnvironmentType       @default(LIVE)
//   sandboxInspectorMode         SandboxCheckoutInspectorMode @default(OPEN_IN_SANDBOX) @map("sandbox_inspector_mode")
//   sandboxInspectorPin          String?                      @map("sandbox_inspector_pin") @db.VarChar(16)

// Add to model Wallet (around line 1173):
//   env                          GatewayEnvironmentType       @default(LIVE)

// Add to model AccessToken (around line 1195):
//   env                          GatewayEnvironmentType       @default(LIVE)

// Add to model PaymentLink (around line 1241):
//   env                          GatewayEnvironmentType       @default(LIVE)

// Add to model JournalEntry (around line 1326):
//   env                          GatewayEnvironmentType       @default(LIVE)

model SandboxSyncWatermark {
  id                  String   @id @default("singleton") @db.VarChar(32)
  executionPlane      GatewayEnvironmentType @default(LIVE) @map("execution_plane")
  lastCatalogSyncAt   DateTime? @map("last_catalog_sync_at") @db.Timestamptz(6)
  lastMerchantSyncAt  DateTime? @map("last_merchant_sync_at") @db.Timestamptz(6)
  catalogVersionHash  String?   @map("catalog_version_hash") @db.Char(64)
  updatedAt           DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("sandbox_sync_watermarks")
}

```

### 2.3 Complete Migration SQL (`core-back/prisma/migrations/20261114000000_v38_parallel_sandbox_plane_and_ledger_fence/migration.sql`)

```
-- ============================================================================
-- Migration: 20261114000000_v38_parallel_sandbox_plane_and_ledger_fence
-- Schema Version: 38
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE "SandboxCheckoutInspectorMode" AS ENUM ('OPEN_IN_SANDBOX', 'PIN_PROTECTED', 'DISABLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "applications"
  ADD COLUMN IF NOT EXISTS "env" "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE',
  ADD COLUMN IF NOT EXISTS "sandbox_inspector_mode" "SandboxCheckoutInspectorMode" NOT NULL DEFAULT 'OPEN_IN_SANDBOX',
  ADD COLUMN IF NOT EXISTS "sandbox_inspector_pin" VARCHAR(16);

ALTER TABLE "wallets"
  ADD COLUMN IF NOT EXISTS "env" "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE';

ALTER TABLE "access_tokens"
  ADD COLUMN IF NOT EXISTS "env" "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE';

ALTER TABLE "payment_links"
  ADD COLUMN IF NOT EXISTS "env" "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE';

ALTER TABLE "journal_entries"
  ADD COLUMN IF NOT EXISTS "env" "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE';

CREATE TABLE IF NOT EXISTS "sandbox_sync_watermarks" (
  "id"                    VARCHAR(32) PRIMARY KEY DEFAULT 'singleton',
  "execution_plane"       "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE',
  "last_catalog_sync_at"  TIMESTAMPTZ(6),
  "last_merchant_sync_at" TIMESTAMPTZ(6),
  "catalog_version_hash"  CHAR(64),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

INSERT INTO "sandbox_sync_watermarks" ("id", "execution_plane", "updated_at")
VALUES ('singleton', 'LIVE', NOW())
ON CONFLICT ("id") DO NOTHING;

-- ============================================================================
-- TRIGGER: enforce_execution_plane_fence_trg
-- Guarantees at the PostgreSQL engine level that:
-- 1. When sandbox_sync_watermarks.execution_plane = 'LIVE' AND strict plane fencing
--    is active (current_setting('pgw.strict_plane_fence', true) = 'on'),
--    NO row with env = 'SANDBOX' or provider_reference LIKE 'FK-%' can ever be
--    written to journal_entries, payment_attempts, wallets, applications, or payment_links.
-- 2. When sandbox_sync_watermarks.execution_plane = 'SANDBOX', every row written to
--    those tables is forced to env = 'SANDBOX' and LIVE postings are forbidden.
-- ============================================================================
CREATE OR REPLACE FUNCTION enforce_execution_plane_fence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_plane "GatewayEnvironmentType";
  v_strict TEXT;
BEGIN
  SELECT "execution_plane" INTO v_plane
    FROM "sandbox_sync_watermarks"
   WHERE "id" = 'singleton';

  v_strict := COALESCE(current_setting('pgw.strict_plane_fence', true), 'off');

  IF v_plane = 'SANDBOX' THEN
    -- On the dedicated Sandbox database, force or verify env = 'SANDBOX'
    IF NEW.env != 'SANDBOX' AND v_strict = 'on' THEN
      RAISE EXCEPTION 'SANDBOX_LEDGER_LIVE_POST_FORBIDDEN: cannot write LIVE row into SANDBOX database (table=%)', TG_TABLE_NAME
        USING ERRCODE = '23514';
    END IF;
    NEW.env := 'SANDBOX';
    RETURN NEW;
  END IF;

  -- On the LIVE production database when strict plane fencing is enabled:
  IF v_plane = 'LIVE' AND v_strict = 'on' THEN
    IF NEW.env = 'SANDBOX' THEN
      RAISE EXCEPTION 'LIVE_LEDGER_SANDBOX_POST_FORBIDDEN: SANDBOX row rejected by LIVE database fence (table=%)', TG_TABLE_NAME
        USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'payment_attempts' AND NEW.provider_reference IS NOT NULL AND NEW.provider_reference LIKE 'FK-%' THEN
      RAISE EXCEPTION 'LIVE_LEDGER_FAKE_RAILS_POST_FORBIDDEN: Fake Rails provider_reference (%) is forbidden on the LIVE database', NEW.provider_reference
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_fence_journal_entries" ON "journal_entries";
CREATE TRIGGER "trg_fence_journal_entries"
BEFORE INSERT OR UPDATE ON "journal_entries"
FOR EACH ROW EXECUTE FUNCTION enforce_execution_plane_fence();

DROP TRIGGER IF EXISTS "trg_fence_payment_attempts" ON "payment_attempts";
CREATE TRIGGER "trg_fence_payment_attempts"
BEFORE INSERT OR UPDATE ON "payment_attempts"
FOR EACH ROW EXECUTE FUNCTION enforce_execution_plane_fence();

DROP TRIGGER IF EXISTS "trg_fence_wallets" ON "wallets";
CREATE TRIGGER "trg_fence_wallets"
BEFORE INSERT OR UPDATE ON "wallets"
FOR EACH ROW EXECUTE FUNCTION enforce_execution_plane_fence();

DROP TRIGGER IF EXISTS "trg_fence_applications" ON "applications";
CREATE TRIGGER "trg_fence_applications"
BEFORE INSERT OR UPDATE ON "applications"
FOR EACH ROW EXECUTE FUNCTION enforce_execution_plane_fence();

DROP TRIGGER IF EXISTS "trg_fence_payment_links" ON "payment_links";
CREATE TRIGGER "trg_fence_payment_links"
BEFORE INSERT OR UPDATE ON "payment_links"
FOR EACH ROW EXECUTE FUNCTION enforce_execution_plane_fence();

UPDATE "schema_versions" SET "version" = 38 WHERE "id" = 1;

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

## 5. Dual-Pool Edge Routing & Live-to-Sandbox Mirror Sync (`core-back`, `merchant-back`, `admin-back`, `checkout-back`)

### 5.1 Dual mTLS Pool Routing in `merchant-back`, `admin-back`, and `checkout-back`

Update `coreInternalClient.ts` (and `mtlsClient/index.ts` in `checkout-back`) across all three edge services so that `SANDBOX_CORE_BACK_URLS` (pointing to `https://<sandboxPrivateIp>:4005`) is maintained as a completely separate `CoreNodeState[]` pool (`sandboxNodes`) alongside `liveNodes` (`CORE_BACK_URLS`):

```
// Added to merchant-back/lib/env/index.ts, admin-back/lib/env/index.ts, checkout-back/lib/env/index.ts
// SANDBOX_CORE_BACK_URLS: comma-separated list of https://<sandboxIp>:4005 URLs.
export const sandboxCoreBackUrls = (): string[] => {
  const raw = process.env.SANDBOX_CORE_BACK_URLS?.trim() ?? "";
  if (raw.length > 0) {
    return raw.split(",").map((u) => u.trim()).filter(Boolean);
  }
  return coreBackUrls(); // Single-process local unit test fallback only
};

```

And in `merchant-back/api/forward.ts`, `admin-back/api/forward.ts`, and `checkout-back/api/public/{pay.ts,inbound.ts}`:

1. **`merchant-back` Target Plane Resolution (`resolveRequestPlane(req)`):**

   * If `req.headers.authorization` starts with `Bearer pg_test_`, target plane is `"SANDBOX"`.

   * If `req.headers.authorization` starts with `Bearer pg_live_`, target plane is `"LIVE"`.

   * For session-authenticated portal requests, if `req.header("x-pg-env")?.toUpperCase() === "SANDBOX"`, target plane is `"SANDBOX"`; otherwise `"LIVE"`.

2. **`admin-back` Target Plane Resolution:**

   * If `req.header("x-pg-env")?.toUpperCase() === "SANDBOX"`, target plane is `"SANDBOX"`; otherwise `"LIVE"`.

3. **`checkout-back` Target Plane Resolution:**

   * In `pay.ts`: `const targetPlane = req.params.linkKey?.startsWith("sbx_") ? "SANDBOX" : "LIVE";`

   * In `inbound.ts`: `const targetPlane = translateInboundEnvironment(req.params.env) === "SANDBOX" ? "SANDBOX" : "LIVE";`

### 5.2 Complete `FakeRailsControlClient.ts` & `SandboxSyncService.ts` (`core-back/engine/sandbox/`)

First, update `generateAccessToken` in `core-back/lib/auth/index.ts` (line 79) so tokens minted on the Sandbox plane receive `pg_test_` and tokens minted on the Live plane receive `pg_live_`:

```
// core-back/lib/auth/index.ts
export const generateAccessToken = (
  plane: "LIVE" | "SANDBOX" = process.env.EXECUTION_PLANE === "SANDBOX" ? "SANDBOX" : "LIVE",
): string =>
  `${plane === "SANDBOX" ? "pg_test_" : "pg_live_"}${randomBytes(32).toString("base64url")}`;

```

Next, create `core-back/engine/sandbox/FakeRailsControlClient.ts` so `pg-core-sandbox` (`EXECUTION_PLANE="SANDBOX"`) can query and control `fake-rails-back`'s accounts, balances, and checkout secrets (while throwing `403 FAKE_RAILS_FORBIDDEN_ON_LIVE_PLANE` if ever invoked on `EXECUTION_PLANE="LIVE"`):

```
// core-back/engine/sandbox/FakeRailsControlClient.ts
import { ApiError } from "../../lib/error";

function assertSandboxPlane(): void {
  if (process.env.EXECUTION_PLANE === "LIVE" && process.env.ALLOW_FAKE_RAILS_HOSTS !== "true") {
    throw new ApiError(
      403,
      "FAKE_RAILS_FORBIDDEN_ON_LIVE_PLANE",
      "Fake Rails control operations are strictly forbidden on the Live production plane",
    );
  }
}

function fakeRailsBaseUrl(): string {
  return (process.env.FAKE_RAILS_PUBLIC_BASE_URL ?? "http://127.0.0.1:8444").replace(/\/+$/, "");
}

function controlHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-seeder-token": process.env.FAKE_RAILS_SEEDER_TOKEN ?? "",
  };
}

export class FakeRailsControlClient {
  async listAccounts(params?: { railCode?: string; gatewayCode?: string; merchantId?: string }) {
    assertSandboxPlane();
    const qs = new URLSearchParams();
    if (params?.railCode) qs.set("railCode", params.railCode);
    if (params?.gatewayCode) qs.set("gatewayCode", params.gatewayCode);
    if (params?.merchantId) qs.set("merchantId", params.merchantId);
    const res = await fetch(`${fakeRailsBaseUrl()}/portal-api/accounts?${qs.toString()}`, {
      headers: controlHeaders(),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { accounts?: any[] };
    return data.accounts ?? [];
  }

  async patchAccount(accountId: string, payload: Record<string, unknown>) {
    assertSandboxPlane();
    const res = await fetch(
      `${fakeRailsBaseUrl()}/portal-api/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        headers: controlHeaders(),
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      throw new ApiError(res.status, "FAKE_RAILS_ACCOUNT_UPDATE_FAILED", "Failed to update Fake Rails test account");
    }
    return res.json();
  }

  async createAccount(payload: Record<string, unknown>) {
    assertSandboxPlane();
    const res = await fetch(`${fakeRailsBaseUrl()}/portal-api/accounts`, {
      method: "POST",
      headers: controlHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new ApiError(res.status, "FAKE_RAILS_ACCOUNT_CREATE_FAILED", "Failed to create Fake Rails test account");
    }
    return res.json();
  }

  async getCheckoutHelperSecrets(reference: string) {
    assertSandboxPlane();
    const res = await fetch(
      `${fakeRailsBaseUrl()}/portal-api/checkout-helper/${encodeURIComponent(reference)}`,
      { headers: controlHeaders() },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { activeAttemptSecrets?: any };
    return data.activeAttemptSecrets ?? null;
  }

  async simulateCheckoutAction(reference: string, action: string) {
    assertSandboxPlane();
    const res = await fetch(
      `${fakeRailsBaseUrl()}/portal-api/checkout-helper/${encodeURIComponent(reference)}/simulate-action`,
      {
        method: "POST",
        headers: controlHeaders(),
        body: JSON.stringify({ action }),
      },
    );
    if (!res.ok) {
      throw new ApiError(res.status, "FAKE_RAILS_SIMULATE_FAILED", "Failed to simulate checkout action on Fake Rails");
    }
    return res.json();
  }
}

export const fakeRailsControlClient = new FakeRailsControlClient();

```

Next, create `core-back/engine/sandbox/SandboxSyncService.ts`. Because `SessionClaims` in `core-back/lib/auth/index.ts` is HMAC-SHA256 signed by `KMS_MASTER_KEY` and already carries `{ sub: userId, role, merchantId, authorities, appScopeIds }`, `pg-core-sandbox` (`payment_gateway_sandbox`) can auto-provision the logged-in user and merchant's Sandbox Workspace on their very first Sandbox request with **zero database queries to `payment_gateway_prod`**:

```
// core-back/engine/sandbox/SandboxSyncService.ts
import { client } from "../../prisma/client";
import type { SessionClaims } from "../../lib/auth";
import { ApiError } from "../../lib/error";

/**
 * Ensures that a user & merchant authenticated by a valid KMS-signed SessionClaims JWT
 * has a complete, active Sandbox Workspace in `payment_gateway_sandbox`, including:
 *   - Active Merchant row (`status = 'ACTIVE'` in Sandbox even if still `PENDING` on Live)
 *   - Active User row with matching authorities
 *   - Default Sandbox LYD Wallet + MERCHANT_WALLET GlAccount + GlAccountShard (shard 0)
 *   - Default Sandbox Application linked to the Sandbox Wallet
 */
export async function ensureSandboxPrincipalProvisioned(claims: SessionClaims) {
  const existingUser = await client.user.findUnique({ where: { id: claims.sub } });
  if (existingUser) {
    return existingUser;
  }

  return client.$transaction(async (tx) => {
    if (claims.merchantId) {
      const existingMerchant = await tx.merchant.findUnique({ where: { id: claims.merchantId } });
      if (!existingMerchant) {
        await tx.merchant.create({
          data: {
            id: claims.merchantId,
            legalName: `Sandbox Merchant (${claims.merchantId.slice(0, 8)})`,
            tradeName: `Sandbox Store (${claims.merchantId.slice(0, 8)})`,
            registrationNumber: `SBX-REG-${claims.merchantId.slice(0, 8)}`,
            taxId: `SBX-TAX-${claims.merchantId.slice(0, 8)}`,
            contactEmail: `sandbox+${claims.merchantId.slice(0, 8)}@merchant.internal`,
            contactPhone: "0910000000",
            status: "ACTIVE",
            riskTier: "LOW",
          },
        });
      } else if (existingMerchant.status !== "ACTIVE") {
        await tx.merchant.update({
          where: { id: claims.merchantId },
          data: { status: "ACTIVE" },
        });
      }

      // Ensure default Sandbox Wallet + MERCHANT_WALLET GlAccount exist
      const existingWallet = await tx.wallet.findFirst({
        where: { merchantId: claims.merchantId },
      });
      if (!existingWallet) {
        const glAccount = await tx.glAccount.create({
          data: {
            accountType: "MERCHANT_WALLET",
            ownerId: claims.merchantId,
            env: "SANDBOX",
            currency: "LYD",
            shardCount: 1,
          },
        });
        const wallet = await tx.wallet.create({
          data: {
            merchantId: claims.merchantId,
            glAccountId: glAccount.id,
            currency: "LYD",
            status: "ACTIVE",
            env: "SANDBOX",
          },
        });
        await tx.application.create({
          data: {
            merchantId: claims.merchantId,
            name: "Default Sandbox Application",
            businessUseDescription: "Auto-provisioned sandbox application for Fake Rails testing",
            assignedWalletId: wallet.id,
            status: "ACTIVE",
            env: "SANDBOX",
          },
        });
      }
    }

    const authoritiesMap = Object.fromEntries(claims.authorities.map((a) => [a, true]));
    return tx.user.upsert({
      where: { id: claims.sub },
      create: {
        id: claims.sub,
        email: `user-${claims.sub.slice(0, 8)}@sandbox.internal`,
        fullName: `Sandbox User (${claims.role})`,
        role: claims.role as any,
        merchantId: claims.merchantId ?? null,
        authoritiesMap,
        appScopeIds: claims.appScopeIds,
        status: "ACTIVE",
        mfaRequired: false,
      },
      update: {
        role: claims.role as any,
        authoritiesMap,
        appScopeIds: claims.appScopeIds,
        status: "ACTIVE",
      },
    });
  });
}

/**
 * Resets a merchant's Sandbox Workspace (clears sandbox attempts & links) without touching Live.
 */
export async function resetMerchantSandboxWorkspace(merchantId: string) {
  if (process.env.EXECUTION_PLANE !== "SANDBOX") {
    throw new ApiError(403, "SANDBOX_RESET_FORBIDDEN_ON_LIVE", "Workspace reset is only permitted on the Sandbox plane");
  }
  await client.$transaction(async (tx) => {
    await tx.paymentAttempt.deleteMany({ where: { merchantId, env: "SANDBOX" } });
    await tx.paymentLink.deleteMany({
      where: { application: { merchantId }, env: "SANDBOX" },
    });
  });
  return { ok: true, merchantId };
}

```

And in `core-back/api/middleware/authDoubleCheck.ts` inside `resolveSessionPrincipal(token)`:

```
  let user = await client.user.findUnique({ where: { id: claims.sub } });
  if (!user && process.env.EXECUTION_PLANE === "SANDBOX") {
    user = await ensureSandboxPrincipalProvisioned(claims);
  }

```

### 5.3 Fix `core-back/api/internal/checkout.ts` & `core-back/api/middleware/authDoubleCheck.ts`

1. In `core-back/api/internal/checkout.ts`:

   * Replace the broken `resolveEnvironment(merchantStatus)` with:

     ```
     const resolveEnvironment = (linkKey: string): "SANDBOX" | "LIVE" =>
       process.env.EXECUTION_PLANE === "SANDBOX" || linkKey.startsWith("sbx_") ? "SANDBOX" : "LIVE";
     
     ```

   * When creating a `PaymentLink` in `core-back/api/internal/merchant.ts`:

     * If `process.env.EXECUTION_PLANE === "SANDBOX"`, prefix the generated `link.key` with `sbx_` (e.g., `sbx_${randomSlug}`) and set `env: "SANDBOX"`.

     * If `process.env.EXECUTION_PLANE === "LIVE"`, prefix with `pay_` and set `env: "LIVE"`.

2. In `core-back/api/middleware/authDoubleCheck.ts`:

   * Update `authenticate()` (around line 179):

     ```
     export const authenticate = async (request: Request): Promise<Principal> => {
       const token = bearerToken(request);
       if (!token) {
         throw new ApiError(401, "AUTH_REQUIRED", "A bearer token is required for this endpoint");
       }
       const plane = process.env.EXECUTION_PLANE === "SANDBOX" ? "SANDBOX" : "LIVE";
       if (token.startsWith("pg_live_")) {
         if (plane === "SANDBOX") {
           throw new ApiError(403, "LIVE_TOKEN_ON_SANDBOX_PLANE", "Live API tokens cannot be used on the Sandbox plane");
         }
         return resolveApiTokenPrincipal(token, request);
       }
       if (token.startsWith("pg_test_")) {
         if (plane === "LIVE") {
           throw new ApiError(403, "SANDBOX_TOKEN_ON_LIVE_PLANE", "Sandbox test API tokens are strictly forbidden on the Live production plane");
         }
         return resolveApiTokenPrincipal(token, request);
       }
       return resolveSessionPrincipal(token);
     };
     
     ```

## 6. Merchant & Admin Portal UI: Global `LIVE | SANDBOX` Switcher & Test Accounts Manager

### 6.1 Global Environment Mode Switcher (`merchant-front` & `admin-front`)

1. **`merchant-front/src/state/app/index.ts` & `merchant-front/src/state/api/index.ts`:**

   * Add reactive state `activeEnvironment = ref<"LIVE" | "SANDBOX">(localStorage.getItem("pg_merchant_env") === "SANDBOX" ? "SANDBOX" : "LIVE")`.

   * In the Axios request interceptor (`merchant-front/src/state/api/index.ts`), attach header: `config.headers["X-Pg-Env"] = activeEnvironment.value;`

   * Whenever `activeEnvironment.value` changes between `"LIVE"` and `"SANDBOX"`, persist to `localStorage` and refresh the active page's data (`router.go(0)` or reactive query invalidation) so Wallets, Applications, Payment Links, Payments, Cash-outs, Disputes, Webhooks, API Tokens, and Reports immediately display the selected plane's data!

2. **`merchant-front/src/layouts/default.tsx`:**

   * In the top `VAppBar`, add a prominent segmented toggle **`[ LIVE | SANDBOX ]`**.

   * Whenever `activeEnvironment.value === "SANDBOX"`, render a persistent amber top banner across `merchant-front`: `SANDBOX ENVIRONMENT — All wallets, applications, payment links (sbx_*), and ledger postings run on the isolated Sandbox Plane via Fake Rails. Zero real money moves.`

3. **New Merchant Portal Page: `merchant-front/src/pages/sandbox/accounts/index.tsx` ("Sandbox Test Accounts & Fake Rails Balances"):**

   * Visible in the left navigation drawer under **Sandbox & Developers** (`merchant-front/src/layouts/sections.tsx`).

   * Displays:

     * **Tab 1 — Fake Rails Customer Test Accounts & Cards:** Filterable by rail (`Edfali`, `Sadad`, `MobiCash`, `Moamalat`, `MPGS`, `LYPay`, `OnePay`, `NeomPay`, etc.). Shows each test account's `identifier` (phone/PAN/wallet ID), `secretPin`, `availableBalanceLyd`, `reservedBalanceLyd`, `dailyLimitLyd`, `dailySpentLyd`, and `status`, with inline buttons to **Edit Balance**, **Top Up +5,000 LYD**, **Set to 0 LYD (Test Insufficient Funds)**, **Freeze/Unfreeze**, **View Account Movements**, or **Create Custom Test Account**.

     * **Tab 2 — Sandbox Settlement & Reconciliation Generator:** One-click button **`[Generate & Ingest Fake Rails Settlement Statement]`** (with optional anomaly toggles for fee variance or missing rows) so merchants and admins can test T+N settlement sweeps and reconciliation in Sandbox.

     * **Tab 3 — Sandbox Workspace Controls:** **`[Seed Sample Sandbox Transactions]`** and **`[Reset Sandbox Workspace]`**.

4. **`admin-front/src/layouts/default.tsx`:**

   * Add the same **`[ LIVE PLANE | SANDBOX PLANE ]`** switcher in the Admin top bar (`X-Pg-Env: LIVE | SANDBOX`), plus a **"Sandbox Fast-Track Checker Approve"** button on `/approvals` when viewing `SANDBOX` plane approval requests so a single tester can test maker-checker workflows in Sandbox without logging into a second staff account.

## 7. Multi-Node Deploy Engine Integration (`deploy/`)

Just like `PG_PRIMARY_NODE`, `BACKUP_NODE`, and `OBJECT_STORAGE_NODE`, the Parallel Sandbox Plane is configured in `deploy/deploy.env`, automatically detected by `sandboxPlaneConfigured(config)` in `deploy/lib/configSchema.ts`, validated, and provisioned onto its dedicated host (`SANDBOX_NODE`) without putting any load on `CORE_NODES` or `PG_PRIMARY_NODE`.

### 7.1 `deploy/deploy.env.example` — Update Section `7` (`PARALLEL SANDBOX PLANE & FAKE RAILS EMULATION TIER`)

Replace Section `7` in `deploy/deploy.env.example` with:

```
# --- 7. PARALLEL SANDBOX ENVIRONMENT & FAKE RAILS EMULATION TIER (v38+) -------
# Self-contained parallel sandbox node (`SANDBOX_NODE`) hosting:
#   1. Isolated PostgreSQL 18 sandbox database (`SANDBOX_DB_NAME="payment_gateway_sandbox"`)
#   2. Dedicated sandbox core runtime (`pg-core-sandbox` on SANDBOX_CORE_PORT=4005, EXECUTION_PLANE="SANDBOX")
#   3. Co-hosted Stateful Fake Payment Rails v2 (`pg-fake-rails-back` on 4104 + Nginx 8444)
#
# Automatic Detection:
# Whenever SANDBOX_ENABLED="true", SANDBOX_MANAGE_VIA_SSH="true", or SANDBOX_NODE
# is non-empty, `sandboxPlaneConfigured(config)` is true and `deploy.ts` automatically:
#   - Provisions `payment_gateway_sandbox` on the sandbox host, runs Prisma migrations,
#     sets `sandbox_sync_watermarks.execution_plane = 'SANDBOX'`, and seeds the 20
#     Fake Rails gateway blueprints into `payment_gateway_sandbox` ONLY (never touching
#     `payment_gateway_prod`!).
#   - Deploys `pg-core-sandbox` (port 4005) and `pg-fake-rails-back` (port 4104 / Nginx 8444)
#     onto `SANDBOX_NODE`.
#   - Injects `SANDBOX_CORE_BACK_URLS="https://<sandboxPrivateIp>:4005"` into
#     `admin-back`, `merchant-back`, and `checkout-back` so all `X-Pg-Env: SANDBOX`,
#     `pg_test_*`, and `/pay/sbx_*` traffic routes strictly to `SANDBOX_NODE` with
#     ZERO CPU/IO/lock pressure on live `CORE_NODES` or `PG_PRIMARY_NODE`!
#
# PRODUCTION SAFETY GUARD:
# Because Fake Rails is fenced inside the isolated Sandbox Plane (`SANDBOX_NODE`) and
# blocked from `CORE_NODES` (`EXECUTION_PLANE="LIVE"`), `SANDBOX_ENABLED="true"` and
# `FAKE_RAILS_ENABLED="true"` ARE PERMITTED in `DEPLOY_ENV="production"` ONLY when
# `SANDBOX_NODE` is configured on a separate service/database from `PG_PRIMARY_NODE`.
SANDBOX_ENABLED="true"
SANDBOX_MANAGE_VIA_SSH="true"
SANDBOX_NODE="sandbox-1@10.10.15.10:22:10.10.15.10:4005"
SANDBOX_SSH_USER="ubuntu"
SANDBOX_SSH_PORT="22"
SANDBOX_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_sandbox"
SANDBOX_SUDO_PASSWORD="change-me-sandbox-sudo"
SANDBOX_REMOTE_DIR="/var/www/pg-core-sandbox"
SANDBOX_DB_PORT="5432"
SANDBOX_DB_NAME="payment_gateway_sandbox"
SANDBOX_DB_USER="gw_sandbox_owner"
SANDBOX_DB_PASSWORD="change-me-strong-sandbox-db-password"
SANDBOX_APP_USER="pgw_sandbox_app"
SANDBOX_APP_PASSWORD="change-me-strong-sandbox-app-password"
SANDBOX_REDIS_DB_INDEX="1"

FAKE_RAILS_ENABLED="true"
FAKE_RAILS_NODE="fakerails-1@10.10.15.10:22:10.10.15.10:4104"
FAKE_RAILS_SSH_HOST="10.10.15.10"
FAKE_RAILS_SSH_PORT="22"
FAKE_RAILS_SSH_USER="ubuntu"
FAKE_RAILS_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_sandbox"
FAKE_RAILS_SUDO_PASSWORD="change-me-sandbox-sudo"
FAKE_RAILS_PRIVATE_IP="10.10.15.10"
FAKE_RAILS_BACK_PORT="4104"
FAKE_RAILS_NGINX_PORT="8444"
FAKE_RAILS_SSL="false"
FAKE_RAILS_SSL_MODE="self_signed"
FAKE_RAILS_DOMAIN="fakerails.internal"
FAKE_RAILS_PUBLIC_BASE_URL="http://10.10.15.10:8444"
FAKE_RAILS_REMOTE_DIR="/var/www/pg-fake-rails"
FAKE_RAILS_ALLOWED_CIDRS="127.0.0.1/32,10.0.0.0/8,192.168.0.0/16"
FAKE_RAILS_ALLOWED_HOSTS="fakerails.internal,10.10.15.10,127.0.0.1,localhost"
FAKE_RAILS_ADMIN_USER="tester_admin"
FAKE_RAILS_ADMIN_PASSWORD="change-me-generate-a-tester-password"
FAKE_RAILS_JWT_SECRET="change-me-64-byte-random-secret-for-fake-rails-portal-jwt"
FAKE_RAILS_SEEDER_TOKEN="change-me-64-byte-shared-token-for-synthetic-seeder-sync"
SEED_FAKE_RAILS_BLUEPRINTS="true"

```

### 7.2 Update `deploy/lib/configSchema.ts` & `deploy/lib/hostPlanner.ts`

1. **In `deploy/lib/configSchema.ts`:**

   * Add the `SANDBOX_*` fields to the Zod `base` schema.

   * Export the auto-detection helper:

     ```
     export const sandboxPlaneConfigured = (config: DeployConfig): boolean =>
       config.SANDBOX_ENABLED
       || config.SANDBOX_MANAGE_VIA_SSH
       || config.SANDBOX_NODE.trim().length > 0;
     
     ```

   * Update `productionGuardProblems(config: DeployConfig)`:

     * When `config.DEPLOY_ENV === "production"`:

       * If `config.FAKE_RAILS_ENABLED` is true and `!sandboxPlaneConfigured(config)`, push: `"FAKE_RAILS_PRODUCTION_GUARD_BLOCKED: In DEPLOY_ENV=production, FAKE_RAILS_ENABLED requires the isolated Parallel Sandbox Plane (SANDBOX_ENABLED=true and SANDBOX_NODE set) so Fake Rails can only post to payment_gateway_sandbox and never to the live ledger."`

       * If `sandboxPlaneConfigured(config)` is true:

         * Verify `config.SANDBOX_DB_NAME !== config.PG_DB_NAME && config.SANDBOX_DB_NAME !== config.DB_NAME` (otherwise push `"SANDBOX_DB_NAME must differ from PG_DB_NAME / DB_NAME so the Sandbox ledger never shares the Live database"`).

         * Verify `SANDBOX_NODE` is valid and `SANDBOX_DB_PASSWORD` passes `weakSecretReason()`.

2. **In `deploy/lib/hostPlanner.ts`:**

   * Add `"core-sandbox"` to `DeployRole` / `HostRole`.

   * In `coreEnv(config, node)` for **Live** `core` nodes:

     * Set `EXECUTION_PLANE: "LIVE"`, `ALLOW_FAKE_RAILS_HOSTS: "false"`, `FAKE_RAILS_ALLOWED_HOSTS: ""` (Live core nodes NEVER receive Fake Rails hosts!).

   * Build `sandboxCoreEnv(config, node)` for `pg-core-sandbox` (`SANDBOX_NODE`):

     * Set `EXECUTION_PLANE: "SANDBOX"`, `DATABASE_URL: "postgresql://...@<sandboxIp>:<sandboxDbPort>/payment_gateway_sandbox"`, `ALLOW_FAKE_RAILS_HOSTS: "true"`, `FAKE_RAILS_ALLOWED_HOSTS: config.FAKE_RAILS_ALLOWED_HOSTS`, `FAKE_RAILS_PUBLIC_BASE_URL: config.FAKE_RAILS_PUBLIC_BASE_URL`, `FAKE_RAILS_SEEDER_TOKEN: config.FAKE_RAILS_SEEDER_TOKEN`.

   * In `edgeEnv(config, role, node)` for `admin-back`, `merchant-back`, and `checkout-back`:

     * Inject `SANDBOX_CORE_BACK_URLS: sandboxCoreUrls(config).join(",")` (pointing to `https://<sandboxPrivateIp>:4005`).

3. **In `deploy/deploy.ts`:**

   * Never run `seed-fake-rails` against the **Live** `core-back` when `DEPLOY_ENV === "production"`!

   * Instead, run `migrate-deploy`, `db-seed`, and `seed-fake-rails` against **`pg-core-sandbox` (`payment_gateway_sandbox`)** on `SANDBOX_NODE`, and execute `UPDATE "sandbox_sync_watermarks" SET "execution_plane" = 'SANDBOX'` on `payment_gateway_sandbox` and `UPDATE "sandbox_sync_watermarks" SET "execution_plane" = 'LIVE'` on `payment_gateway_prod`!

## 8. Triple-Pass Edge-Case & Security Audit (All 15 Edge Cases Resolved)

| \# | Edge Case / Failure Scenario | How This Design Resolves It | 
| ----- | ----- | ----- | 
| **EC-01** | **Fake Rails webhook sent to Live `/api/v1/inbound/:gw/live/:token`** | Live `core-back` never runs `seedFakeRails`, so Live `confirmation_channels` secrets are partner bank secrets (never `deriveFakeRailsSecret`). Even if a token matched, `trg_fence_payment_attempts` on `payment_gateway_prod` rejects any `provider_reference LIKE 'FK-%'` with `23514: LIVE_LEDGER_FAKE_RAILS_POST_FORBIDDEN`. | 
| **EC-02** | **Merchant uses `pg_test_...` API key against Live plane (or `pg_live_...` against Sandbox plane)** | `merchant-back` routes `pg_test_*` exclusively to `sandboxCorePool` (`SANDBOX_NODE`). Furthermore, `authDoubleCheck.ts` on `EXECUTION_PLANE="LIVE"` rejects `pg_test_*` with `403 SANDBOX_TOKEN_ON_LIVE_PLANE` and on `EXECUTION_PLANE="SANDBOX"` rejects `pg_live_*` with `403 LIVE_TOKEN_ON_SANDBOX_PLANE`. | 
| **EC-03** | **Customer tampers with `/pay/pay_live123` URL to call `/sandbox-accounts` or `/sandbox-simulate`** | Both `checkout-back` and `core-back` check `linkKey.startsWith("sbx_")` and `EXECUTION_PLANE === "SANDBOX"`. Calling any `/sandbox-*` endpoint on a Live link returns `403 SANDBOX_ONLY_ENDPOINT`. | 
| **EC-04** | **Two concurrent Sandbox checkouts use the same Fake Rails customer account (`0912222222`) when balance only covers one** | `reserveAccountFundsForTransaction()` in `AccountLedgerService.ts` runs inside an immediate SQLite transaction (`db.transaction(...)`). The first checkout places the hold and decrements `available_balance_lyd`; the second checkout sees `available_balance_lyd < requested_amount_lyd` and receives a realistic `INSUFFICIENT_FUNDS` decline. | 
| **EC-05** | **Customer abandons Sandbox checkout after `INITIATE` placed a hold on their Fake Rails account** | When `ExpirySweeperWorker` or `cancel` transitions the attempt to `EXPIRED` / `CANCELLED`, or when the user clicks `Release Hold` / `Cancel`, `releaseAccountHoldForTransaction()` restores `reserved_balance_lyd` back to `available_balance_lyd` and logs a `RELEASE` movement. | 
| **EC-06** | **Refund executed in Sandbox (`FULL_REFUND` / `INTERNAL_REFUND`)** | When `pg-core-sandbox` executes a refund against `fake-rails-back` (`POST /rails/:gw/.../refund`), `fake-rails-back` credits the refunded amount back to the customer's `available_balance_lyd` in `fake_accounts` and records a `REFUND_CREDIT` movement! | 
| **EC-07** | **Active Live merchant switches to `SANDBOX` in `merchant-front` for the first time** | `SandboxSyncService` auto-provisions their Sandbox Merchant row (`status = 'ACTIVE'`), default Sandbox `LYD` Wallet, and default Sandbox Application in `pg_sandbox_db` on the fly with zero manual setup. | 
| **EC-08** | **Pre-active (`PENDING` / `KYB_REVIEW`) merchant wants to integrate and test in `SANDBOX` before KYB approval** | On `pg_sandbox_db`, the merchant's Sandbox status is set to `ACTIVE` so `assertCommerceActive()` passes in Sandbox while remaining blocked on the `LIVE` plane until real KYB approval! | 
| **EC-09** | **Redis cache / velocity counter collision between Live and Sandbox** | `pg-core-sandbox` connects to Redis database index `1` (`SANDBOX_REDIS_DB_INDEX="1"`) and prefixes all keys with `sbx:`, so a sandbox load test never triggers velocity rate limits or circuit breakers on Live! | 
| **EC-10** | **Circuit breaker & route health contamination** | Because `pg-core-sandbox` has its own `gateway_health_samples` and `rail_routes` tables in `pg_sandbox_db`, injecting a 100% `HTTP_500_GATEWAY_FAULT` outage in Fake Rails trips the circuit breaker **only in Sandbox**—never on Live! | 
| **EC-11** | **Object Storage contamination from Sandbox KYB/Dispute/Statement uploads** | `pg-core-sandbox` prefixes all object storage keys with `sandbox/` and tags `metadata.executionPlane = "SANDBOX"`, allowing `POST /internal/merchant/sandbox/reset` to purge sandbox test blobs cleanly. | 
| **EC-12** | **Single developer testing 4-Eyes Maker-Checker approvals in Sandbox** | In `EXECUTION_PLANE="SANDBOX"`, `ApprovalService.ts` exposes `POST /internal/admin/approvals/:id/sandbox-fast-approve` (which synthesizes a distinct virtual checker `sandbox-checker-bot` and is hard-blocked on `EXECUTION_PLANE="LIVE"`). | 
| **EC-13** | **Merchant webhook endpoint SSRF or accidental production webhook spam from Sandbox** | Sandbox webhook deliveries (`MerchantWebhookWorker` on `pg-core-sandbox`) include header `X-Pg-Environment: SANDBOX` and sign payloads with the Sandbox webhook secret (`whsec_test_...`). | 
| **EC-14** | **Backup daemon (`BACKUP_NODE`) resource isolation** | `backup-daemon` backs up `payment_gateway_prod` (`pg-primary`), `pg_audit_db`, and `pg_logs_db` only; ephemeral `payment_gateway_sandbox` data is excluded from production compliance backups so sandbox churn never bloats production WAL archives. | 
| **EC-15** | **Client demo mode where merchant wants to hide the Checkout Secret Inspector temporarily** | Application setting `sandboxInspectorMode` supports `OPEN_IN_SANDBOX` (default), `PIN_PROTECTED` (collapsed until 4-digit PIN is entered), or `DISABLED`. | 

## 9. Guides, IT Runbooks & Employee Academy Updates

1. **Interactive Guide (`design/07-guides-and-academy/guide_system_design_and_content.md` & `admin-front/src/content/guide/booksPart2.ts`):**

   * Update article `b01-08` ("Sandbox vs. Live") and add article `b12-14` ("Operating the Parallel Sandbox Plane, Fake Rails Account Balances & Checkout Inspector") explaining:

     * How the `[ LIVE | SANDBOX ]` switcher works in `merchant-front` and `admin-front`.

     * How to manage test customer balances (`0911111111`, `6280001111111111`, etc.) in `/sandbox/accounts` and directly inside the Checkout Sandbox Helper drawer.

     * How to use the Checkout Sandbox Helper to view live OTPs, simulate mobile Push/QR approvals, and test failure modes (`INSUFFICIENT_FUNDS`, `LIMIT_EXCEEDED`, `WRONG_OTP`, `SUSPENSE`).

   * Run `bun run admin-front/scripts/extract-guide-content.ts`.

2. **Employee Academy (`design/07-guides-and-academy/academy_system_design_and_content.md`):**

   * Add Lesson `l-m8-6` ("Testing in the Parallel Sandbox Plane & Controlling Fake Rails Balances") and practice checks `c-l-m8-6-1`, `c-l-m8-6-2`, then run `bun run admin-front/scripts/extract-academy-content.ts`.

3. **IT Operations Documentation (`docs/architecture/parallel-sandbox-and-fake-rails-v2.md`):**

   * Document the `SANDBOX_NODE` deployment topology, the 5-layer Live vs. Sandbox fence, and how to scale or reset `payment_gateway_sandbox`.

## 10. Complete 20-Test Verification Matrix (`core-back/test/sandboxPlane.test.ts` & `fake-rails-back/test/accountsAndInspector.test.ts`)

| Test ID | Test Name | Exact Assertion | 
| ----- | ----- | ----- | 
| **SBX-T01** | `default_fake_accounts_seeded_for_all_20_rails` | `ensureDefaultFakeAccountsSeeded()` creates the 5 canonical personas (`50,000 LYD`, `1,500 LYD`, `5 LYD`, `Limit Exhausted`, `Frozen`) for all 20 rails. | 
| **SBX-T02** | `initiate_places_hold_and_debits_available_balance` | Initiating a `150.0000 LYD` payment with `0912222222` (`1,500 LYD`) reduces `available_balance_lyd` to `1350.0000` and sets `reserved_balance_lyd` to `150.0000`. | 
| **SBX-T03** | `confirm_captures_hold_and_increments_daily_spent` | Confirming the OTP transitions the hold to `CAPTURED`, sets `reserved_balance_lyd = 0.0000`, and sets `daily_spent_lyd = 150.0000`. | 
| **SBX-T04** | `cancel_or_decline_releases_hold_back_to_available` | Cancelling an initiated attempt restores `available_balance_lyd` back to `1500.0000` and marks the hold `RELEASED`. | 
| **SBX-T05** | `low_balance_account_returns_insufficient_funds` | Initiating a `100.0000 LYD` payment with `0910000005` (`5.0000 LYD` balance) returns `INSUFFICIENT_FUNDS` without placing a hold. | 
| **SBX-T06** | `daily_limit_exhausted_returns_limit_exceeded` | Initiating a `20.0000 LYD` payment with `0910000061` (`50 LYD` limit, `45 LYD` spent) returns `LIMIT_EXCEEDED`. | 
| **SBX-T07** | `frozen_account_rejected_at_initiate` | Initiating with `0910000999` (`status = 'FROZEN'`) returns `ACCOUNT_FROZEN` / `TERMINAL_DECLINE`. | 
| **SBX-T08** | `checkout_inspector_adjusts_balance_and_unblocks_payment` | Calling `PATCH /api/v1/pay/sbx_.../sandbox-accounts/:id` to raise `0910000005`'s balance from `5.0000` to `500.0000 LYD` allows the next `100.0000 LYD` payment to succeed! | 
| **SBX-T09** | `checkout_inspector_reveals_live_otp_in_sandbox` | After `POST /api/v1/pay/sbx_.../initiate` on an `OTP_PULL` rail, `sandboxInspector.activeAttemptSecrets.expectedOtp` contains the exact 6-digit OTP that confirms the payment. | 
| **SBX-T10** | `checkout_inspector_simulates_qr_and_push_approval` | Calling `POST /api/v1/pay/sbx_.../logs/:attemptId/sandbox-simulate` with `action: "APPROVE_PUSH_OR_QR"` captures the Fake Rails hold, dispatches the signed webhook, and settles the Sandbox attempt to `SUCCEEDED`. | 
| **SBX-T11** | `refund_credits_fake_rails_customer_account` | Executing a `FULL_REFUND` in Sandbox credits the refunded amount back to the customer's `available_balance_lyd` in `fake_accounts` (`REFUND_CREDIT`). | 
| **SBX-T12** | `live_link_never_exposes_sandbox_inspector_or_endpoints` | `GET /api/v1/pay/pay_live_...` returns `sandboxInspector: undefined`, and `GET /api/v1/pay/pay_live_.../sandbox-accounts` returns `403 SANDBOX_ONLY_ENDPOINT`. | 
| **SBX-T13** | `live_plane_blocks_fake_rails_outbound_and_webhooks` | On `EXECUTION_PLANE="LIVE"`, `StepExecutor` rejects any Fake Rails URL (`403 FAKE_RAILS_FORBIDDEN_ON_LIVE_PLANE`) and `inbound.ts` rejects any `SANDBOX` webhook. | 
| **SBX-T14** | `postgres_trigger_blocks_sandbox_or_fake_rails_on_live_db` | With `execution_plane = 'LIVE'` and `pgw.strict_plane_fence = 'on'`, inserting `env = 'SANDBOX'` or `provider_reference = 'FK-123'` into `payment_attempts` or `journal_entries` throws `23514: LIVE_LEDGER_SANDBOX_POST_FORBIDDEN`. | 
| **SBX-T15** | `pg_test_token_rejected_on_live_and_pg_live_rejected_on_sandbox` | Presenting `Bearer pg_test_...` to a `LIVE` core instance returns `403 SANDBOX_TOKEN_ON_LIVE_PLANE`; presenting `Bearer pg_live_...` to `SANDBOX` returns `403 LIVE_TOKEN_ON_SANDBOX_PLANE`. | 
| **SBX-T16** | `active_merchant_can_use_both_live_and_sandbox_simultaneously` | An `ACTIVE` merchant creates a Sandbox link (`sbx_...`) and a Live link (`pay_...`); settling `sbx_...` credits only their Sandbox Wallet in `pg_sandbox_db` and leaves their Live Wallet in `payment_gateway_prod` untouched (`0.0000 LYD` change). | 
| **SBX-T17** | `pending_kyb_merchant_can_test_full_checkout_in_sandbox` | A merchant whose Live status is `PENDING` switches to `SANDBOX` in `merchant-front`, creates a `sbx_...` link, and completes a full Fake Rails payment into their Sandbox Wallet. | 
| **SBX-T18** | `sandbox_statement_generator_runs_reconciliation_sweep` | Generating a Fake Rails statement in Sandbox and running `StatementIngestor` sweeps `GATEWAY_CLEARING` -> `TREASURY` in the Sandbox Ledger. | 
| **SBX-T19** | `sandbox_workspace_reset_clears_attempts_and_restores_personas` | `POST /internal/merchant/sandbox/reset` clears the merchant's sandbox attempts/links and resets modified Fake Rails test account balances to defaults. | 
| **SBX-T20** | `deploy_config_permits_fake_rails_in_prod_only_with_sandbox_node` | `validateDeployConfig()` allows `FAKE_RAILS_ENABLED=true` in `DEPLOY_ENV=production` when `SANDBOX_ENABLED=true` and `SANDBOX_NODE` + distinct `SANDBOX_DB_NAME` are set, and rejects it with `FAKE_RAILS_PRODUCTION_GUARD_BLOCKED` when `SANDBOX_NODE` is missing. | 

## 11. Step-by-Step Execution Order for `OpenCode`

1. **Step 1 (Schema `v38` & Execution Plane Trigger):** Update `core-back/prisma/schemaVersion.ts` (`38`), update `core-back/prisma/schema.prisma`, create `core-back/prisma/migrations/20261114000000_v38_parallel_sandbox_plane_and_ledger_fence/migration.sql`, and run `bunx prisma generate`.

2. **Step 2 (Stateful Fake Rails v2 — Accounts, Holds & Clearing Pools):** Update `fake-rails-back/engine/db/schema.sql`, create `fake-rails-back/engine/accounts/AccountLedgerService.ts`, wire `reserveAccountFundsForTransaction` / `captureAccountHoldForTransaction` / `releaseAccountHoldForTransaction` into `fake-rails-back/api/rails/{common.ts,handlers.ts}` and `fake-rails-back/api/portal/hosted.ts`, and create `fake-rails-back/api/portal/accounts.ts`.

3. **Step 3 (Core Sandbox Plane, Sync Service & Checkout Inspector API):** Create `core-back/engine/sandbox/SandboxSyncService.ts`, update `core-back/api/middleware/authDoubleCheck.ts` (`pg_test_*` vs `pg_live_*`), and update `core-back/api/internal/{checkout.ts,merchant.ts,admin.ts}` to expose the Sandbox Checkout Inspector, Sandbox Account Balance API, Sandbox Fast-Track Checker Approval, and Sandbox Reset endpoints.

4. **Step 4 (Dual-Pool Edge Routing):** Update `admin-back`, `merchant-back`, and `checkout-back` (`coreInternalClient.ts`, `forward.ts`, `pay.ts`, `inbound.ts`) to route `X-Pg-Env: SANDBOX`, `Bearer pg_test_*`, `/pay/sbx_*`, and `/inbound/:gw/sandbox/:token` to `SANDBOX_CORE_BACK_URLS`.

5. **Step 5 (Frontend Portals & Checkout Inspector Drawer):** Create `checkout-front/src/components/sandbox/SandboxCheckoutInspector.tsx` and mount it in `checkout-front/src/pages/pay/[linkKey]/index.tsx`; update `fake-rails-front/src/pages/hosted/{widget-frame.tsx,redirect/[sessionId].tsx}`; add the `[ LIVE | SANDBOX ]` switcher to `merchant-front/src/layouts/default.tsx` and `admin-front/src/layouts/default.tsx`; and create `merchant-front/src/pages/sandbox/accounts/index.tsx`.

6. **Step 6 (Deploy Engine, Guides/Academy & 20-Test Verification Suite):** Update `deploy/deploy.env.example`, `deploy/lib/configSchema.ts`, `deploy/lib/hostPlanner.ts`, `deploy/lib/pkiManager.ts`, and `deploy/deploy.ts` for `SANDBOX_NODE`; update `design/07-guides-and-academy/` and run the extractors; and run `bun test` on `core-back/test/sandboxPlane.test.ts` and `fake-rails-back/test/accountsAndInspector.test.ts`.
---
id: core.sandbox-plane
title: Parallel Sandbox Plane and Stateful Fake Rails v2
status: partial
confidence: high
last_verified: 2026-11-13
verified_against: working-tree
code:
  - core-back/prisma/schema.prisma
  - core-back/prisma/schemaVersion.ts
  - core-back/prisma/migrations/20261114000000_v38_parallel_sandbox_plane_and_ledger_fence
  - core-back/lib/plane.ts
  - core-back/api/middleware/authDoubleCheck.ts
  - core-back/api/internal/checkout.ts
  - core-back/api/internal/merchant.ts
  - core-back/api/internal/admin.ts
  - core-back/engine/sandbox/FakeRailsControlClient.ts
  - core-back/engine/sandbox/SandboxSyncService.ts
  - core-back/scripts/setExecutionPlane.ts
  - fake-rails-back/engine/accounts/AccountLedgerService.ts
  - fake-rails-back/api/portal/accounts.ts
  - fake-rails-back/engine/db/schema.sql
  - admin-back/lib/coreInternalClient.ts
  - merchant-back/lib/coreInternalClient.ts
  - checkout-back/lib/coreInternalClient.ts
  - admin-back/api/forward.ts
  - merchant-back/api/forward.ts
  - checkout-back/api/public/pay.ts
  - checkout-back/api/public/inbound.ts
  - checkout-front/src/components/sandbox/SandboxCheckoutInspector.tsx
  - merchant-front/src/pages/sandbox/accounts/index.tsx
  - merchant-front/src/state/environment.ts
  - admin-front/src/state/environment.ts
design_sources:
  - design/04-fake-rails-and-seeder/parallel_sandbox_and_fake_rails_emulation_engine_plan.md
tests:
  - core-back/test/sandboxPlane.test.ts
  - core-back/test/sandbox-plane-integration.test.ts
  - fake-rails-back/test/accountsAndInspector.test.ts
  - admin-back/test/sandbox-plane-routing.test.ts
  - merchant-back/test/sandbox-plane-routing.test.ts
  - checkout-back/test/sandbox-plane-routing.test.ts
  - deploy/test/sandboxPlane.test.ts
gaps:
  - The complete 20-case verification matrix is represented by focused suites rather than one file; dedicated deployment-lab coverage of the two-host sandbox topology is still manual.
  - Object-storage keys are not yet prefixed `sandbox/`; a sandbox and live deployment that share one object vault share the blob namespace.
  - Sandbox Redis key prefixing (`sbx:`) is not implemented; isolation relies on the configured Redis database index.
  - The merchant settlement generator runs the reconciliation ingestor directly, not the queued object-storage upload path, so the sandbox does not exercise the full upload pipeline.
---

# Parallel Sandbox Plane and Stateful Fake Rails v2

## 1. Purpose

The Sandbox Plane is a fully isolated copy of the payment process: its own
process (`EXECUTION_PLANE="SANDBOX"`), its own PostgreSQL database
(`payment_gateway_sandbox`), its own API tokens (`pg_test_*`), its own payment
links (`sbx_*`) and the stateful Fake Rails emulator. The Live process is hard
fenced away from it, and the database fence refuses cross-plane writes.

Schema version **38** introduces the plane tags, the `sandbox_sync_watermarks`
singleton and the database trigger.

## 2. Plane tagging

`GatewayEnvironmentType` (`LIVE` / `SANDBOX`) is stored on `applications`,
`wallets`, `access_tokens`, `payment_links` and `journal_entries`. A v38
`payment_link` resolves its plane from its own `env`; legacy rows fall back to
the `sbx_` key prefix and then to the historic merchant-status rule. A merchant
who is `PENDING` on the Live plane can still pay in sandbox; an `ACTIVE`
merchant can keep using sandbox for new developers and rails.

API tokens are minted with the plane prefix: `pg_live_` on Live and `pg_test_`
on Sandbox. `authenticate()` refuses a token of the other plane before any
database lookup (`SANDBOX_TOKEN_ON_LIVE_PLANE` / `LIVE_TOKEN_ON_SANDBOX_PLANE`).
Payment links use `pay_` on Live and `sbx_` on Sandbox.

## 3. Defense in depth

| Layer | Enforcement |
| :--- | :--- |
| Process/URL fence | `core-back/lib/plane.ts`: a `LIVE` core refuses Fake Rails URLs (`FAKE_RAILS_FORBIDDEN_ON_LIVE_PLANE`); a `SANDBOX` core refuses non-Fake-Rails URLs (`LIVE_GATEWAY_FORBIDDEN_ON_SANDBOX_PLANE`). Enforced in `StepExecutor.assertUrlAllowed` and `ApiConsumer.send`. |
| Database fence | `enforce_execution_plane_fence()` on `payment_attempts`, `journal_entries`, `wallets`, `applications` and `payment_links`. The strict mode (`pgw.strict_plane_fence=on`) rejects SANDBOX rows on LIVE and LIVE rows on SANDBOX (`23514`), and also rejects `FK-%` provider references on `payment_attempts`. In a single-plane development/staging stack the strict mode stays off so the historic Fake Rails test flow keeps working; the parallel deployment isolates Fake Rails in its own process and database. The plane is read from `pgw.execution_plane` when set, otherwise from the singleton watermark. |
| Token/link prefixes | Edge routing and core authentication. |
| Separate database | `SANDBOX_DB_NAME` must differ from the Live database; the deploy engine creates the sandbox role/database on the sandbox host. |
| Edge pools | `SANDBOX_CORE_BACK_URLS` is a second mTLS pool. Admin uses `X-Pg-Env`; merchant uses `X-Pg-Env` or the token prefix; checkout uses the `sbx_` link prefix; inbound uses the `/sandbox/` URL segment. |
| Inbound | A Live core rejects `env=SANDBOX` webhooks; a Sandbox core rejects `env=LIVE`. |

`EXECUTION_PLANE` is optional: unset preserves the historic single-process
development behaviour (both planes allowed). The deploy engine always writes
`LIVE` for the live core and `SANDBOX` for `pg-core-sandbox`.

## 4. Stateful Fake Rails v2

`fake-rails-back/engine/accounts/AccountLedgerService.ts` adds:

- `fake_accounts`, `fake_account_holds`, `fake_account_movements`,
  `fake_merchant_clearing_pools`;
- five canonical personas per rail (rich 50,000 LYD, standard 1,500 LYD,
  low-balance 5 LYD, near-limit 5 LYD remaining, frozen);
- auto-created ad-hoc accounts (2,500 LYD);
- integer micro-unit arithmetic inside one SQLite transaction;
- hold on initiate, capture on confirm/hosted approve/simulator approve,
  release on cancel/decline, refund credit;
- a clearing pool per gateway/rail.

The `fake_transactions` row keeps the unmasked customer identifier and links to
its bound account and held amount. The port of the old schema is additive: the
database adds `customer_identifier`, `account_id` and `held_amount_lyd` on
startup, so an existing SQLite file upgrades in place.

### Control API

`/portal-api/accounts` (seeder token or tester JWT): list, create, reset, patch,
movements. `/portal-api/checkout-helper/:reference` reveals the live OTP, the
bound account, the held amount and recent wire events;
`/checkout-helper/:reference/simulate-action` can approve/reject a push/QR,
approve with a variance, replay a duplicate webhook or fire a tampered one.

## 5. Checkout Secret & Balance Inspector

`GET /internal/checkout/pay/:linkKey` includes `env`, `sandboxInspector` and the
inspector's `railAccounts` when the plane is SANDBOX. The app-level
`sandboxInspectorMode` is `OPEN_IN_SANDBOX` (default), `PIN_PROTECTED` or
`DISABLED`; a protected inspector requires the `x-pg-sandbox-pin` header. The
inspector is never included for a Live link.

`GET /pay/:linkKey/logs/:attemptId` includes the active attempt secrets and the
simulator flag. Sandbox-only endpoints:

- `GET /pay/:linkKey/sandbox-accounts`
- `PATCH /pay/:linkKey/sandbox-accounts/:accountId`
- `POST /pay/:linkKey/logs/:attemptId/sandbox-simulate`

All three return `403 SANDBOX_ONLY_ENDPOINT` for a Live or non-`sbx_` link and
`403 SANDBOX_INSPECTOR_DISABLED` / `SANDBOX_INSPECTOR_LOCKED` as appropriate.

## 6. Sandbox provisioning and reset

On the first sandbox request, a valid merchant session is auto-provisioned in
the sandbox database: merchant `ACTIVE` (also when the Live merchant is still
`PENDING` or in review), a `LYD` `MERCHANT_WALLET` GL account, an `ACTIVE`
wallet, a default `ACTIVE` application and the user row. `resetMerchantSandbox
Workspace` deletes the merchant's sandbox attempts, groups and links inside one
transaction (it does not touch immutable ledger rows) and a conflicting
dependent (for example a dispute) returns `409 SANDBOX_RESET_CONFLICT`.

## 7. Admin and merchant portals

The Admin and Merchant portals have a `LIVE | SANDBOX` switch. It persists to
`pg_admin_env` / `pg_merchant_env`, adds `X-Pg-Env` to every API call and
reloads to refresh every list. The Merchant portal adds
`Sandbox & Developers → Sandbox Test Accounts`: account balances, movements,
settlement-statement generation through the reconciliation ingestor, sample
sandbox links and workspace reset. The Admin approvals drawer adds
`Sandbox Fast-Track Approve`, which synthesizes a distinct sandbox checker
(`sandbox-checker-bot`) so a single tester can exercise maker-checker without a
second account; it is hard-blocked on the Live plane.

## 8. Deploy

`SANDBOX_ENABLED`, `SANDBOX_NODE` and the `SANDBOX_*` fields are optional. When
configured:

- the Live core receives `EXECUTION_PLANE="LIVE"`, no Fake Rails host and no
  sandbox URL;
- a `pg-core-sandbox` service is planned on `SANDBOX_NODE` with its own
  `core-sandbox` certificate, firewall and database;
- edges receive `SANDBOX_CORE_BACK_URLS`;
- the sandbox database role/database are created on the sandbox host and
  `bun run set-execution-plane SANDBOX` sets the watermark and database GUC;
- Fake Rails is no longer accepted on the Live plane in production unless the
  sandbox plane is configured and `SANDBOX_DB_NAME` differs from the live
  database.

## 9. Verification

The suites cover plane tags, the token prefixes, the database fence, auto
provisioning, outbound/inbound fences, the account maths, the inspector and
simulator, reset, dual-pool routing in all three edges and the deploy plan.

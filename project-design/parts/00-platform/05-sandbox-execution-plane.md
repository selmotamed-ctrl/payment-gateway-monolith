---
id: platform.sandbox
title: Parallel Sandbox Execution Plane
status: partial
confidence: high
last_verified: 2026-11-13
verified_against: working-tree
code:
  - core-back/lib/executionPlane.ts
  - core-back/lib/commerceStatus.ts
  - core-back/engine/PlaneFenceGuard.ts
  - core-back/api/internal/sandboxControl.ts
  - core-back/api/internal/checkout.ts
  - core-back/api/internal/merchant.ts
  - core-back/api/middleware/authDoubleCheck.ts
  - core-back/prisma/schema.prisma
  - core-back/prisma/migrations/20261113120000_v38_sandbox_execution_plane
  - core-back/prisma/migrations/20261114090000_v39_sandbox_studio
  - core-back/scripts/prepare-databases.sh
  - merchant-back/api/sandboxProxy.ts
  - merchant-back/lib/corePools.ts
  - admin-back/api/sandboxProxy.ts
  - checkout-back/api/public/pay.ts
  - checkout-back/api/public/inbound.ts
  - checkout-back/lib/corePools.ts
  - checkout-front/src/components/sandbox/SandboxCheckoutInspector.tsx
  - merchant-front/src/pages/sandbox/**
  - admin-front/src/pages/sandbox/**
  - fake-rails-back/engine/accounts/AccountLedgerService.ts
  - fake-rails-back/api/portal/accounts.ts
  - fake-rails-back/api/control/index.ts
  - deploy/lib/configSchema.ts
  - deploy/lib/hostPlanner.ts
  - deploy/deploy.ts
  - deploy/provisioners/postgres18Provisioner.ts
  - deploy/lib/pkiManager.ts
design_sources:
  - design/13-sandbox/parallel_sandbox_and_fake_rails_emulation_engine_plan.md
tests:
  - core-back/test/sandboxPlane.test.ts
  - core-back/test/fake-rails-control-client.test.ts
  - core-back/test/phase1-mtls-and-schema.test.ts
  - core-back/test/security-regressions/commerce-status-enforcement.test.ts
  - core-back/test/engine/attempt-guard-pipeline.test.ts
  - fake-rails-back/test/accountsAndInspector.test.ts
  - fake-rails-back/test/api.test.ts
  - merchant-back/test/sandbox-routing.test.ts
  - admin-back/test/sandbox-routing.test.ts
  - checkout-back/test/sandbox-routing.test.ts
  - tests/unit/guide-content.test.ts
gaps:
  - Live-to-sandbox sync of operator-customised gateways, fee profiles and blueprints is not implemented; the deploy seeds the reference catalog and Fake Rails endpoints, not Live customizations.
  - The fake-rails challenge counters (`attempt_count`, `resend_count`) remain implicit in the transaction row rather than a dedicated challenge table.
  - Sandbox role preview (signing in as another sandbox role from Admin) is not implemented.
---

# Parallel Sandbox Execution Plane

## 1. Purpose and scope

`v38` makes Sandbox a physically separate world instead of a per-row flag:

- **Live:** `pg-core-back` with `EXECUTION_PLANE=LIVE` against `payment_gateway_prod`.
- **Sandbox:** `pg-core-sandbox` with `EXECUTION_PLANE=SANDBOX` against `payment_gateway_sandbox`, with every outbound rail routed to `fake-rails-back`.

The separation is enforced in four layers: separate database, separate process, database trigger fence, and edge route namespaces. A missing `WHERE env = 'LIVE'` can therefore never leak sandbox wallets, attempts or journal lines into Live reports, cash-outs or reconciliation.

This part owns the plane model, the fence, the sandbox control API, the edge routing, the Sandbox Studio UI and the Fake Rails v2 stateful accounts. Fake Rails protocol/chaos behaviour remains in `parts/06-fake-rails/**`; deploy topology remains in `parts/07-deploy/**`.

## 2. Non-negotiable rules

1. **Live and Sandbox never share operational tables.** `payment_gateway_prod` contains only LIVE rows; `payment_gateway_sandbox` contains only SANDBOX rows.
2. **The environment is the process plane, never a merchant status.** `core-back/lib/executionPlane.ts` resolves `EXECUTION_PLANE` (default `LIVE`, invalid values abort). `checkout.ts` and `merchant.ts` no longer contain `resolveEnvironment(merchantStatus)`.
3. **No implicit OD-10 fallback.** A `PENDING`, `SUSPENDED`, `DRAFT` or `PENDING` wallet/application is refused on both planes with `409 MERCHANT_NOT_ACTIVE` / `APPLICATION_NOT_ACTIVE` / `WALLET_NOT_ACTIVE`. A pending Live merchant trains on the Sandbox plane through an ACTIVE sandbox envelope.
4. **A sandbox link is `sbx_*`; a Live link is `pl_*`.** `checkout-back` selects the pool from the prefix; it never falls back to Live for a sandbox link.
5. **API tokens are plane-bound.** `pg_live_*` is refused on the SANDBOX plane with `LIVE_TOKEN_ON_SANDBOX_PLANE`; `pg_test_*` is refused on the LIVE plane with `SANDBOX_TOKEN_ON_LIVE_PLANE`. The core also checks the token row's `env` column.
6. **The checkout inspector only exists on `sbx_` links.** Three gates: the front end requires `env === "SANDBOX"`/`sbx_`, `checkout-back` refuses any other link key, and core mounts the sandbox routes only on the SANDBOX plane.

## 3. Schema v38-v39

Migration `20261113120000_v38_sandbox_execution_plane` (schema version 38) and `20261114090000_v39_sandbox_studio` (schema version 39) add:

- `payment_links.env` and `access_tokens.env` (`GatewayEnvironmentType`, default `LIVE`); `payment_attempts.env` already existed.
- `system_execution_plane` singleton (`id = 1`, `plane`, `allow_fake_rails`, `live_sync_revision`, `last_synced_from_live`).
- `sandbox_sync_audits` (blueprint sync, demo seed, reset, wallet top-up).
- `enforce_execution_plane_env_fence()` attached to `payment_links`, `payment_attempts` and `access_tokens`.
- `enforce_no_fake_rails_on_live_plane()` attached to `gateways` and `gateway_environments`.
- v39 Studio parity: nullable `wallets.name`, `payment_links.title` and `payment_links.description`; both were accepted by portal contracts but discarded before v39.

A SANDBOX database always rejects LIVE rows. A LIVE database rejects SANDBOX rows in strict mode (`app.plane_fence_strict=true`), which the migration stores at database level for real deployments. The test suite deliberately disables strict mode because it keeps both kinds of rows in one throwaway database; `test/sandboxPlane.test.ts` re-enables it per transaction and proves both directions. `PLANE_FENCE_ALLOW_FAKE_RAILS_ON_LIVE=true` is the development-only escape hatch that lets a single-box Live process keep using the emulator (deploy sets it only outside production).

`verifyExecutionPlaneFenceOnBoot()` runs before Express listens. It refuses a process whose plane differs from `system_execution_plane.plane`, and refuses `FAKE_RAILS_ENABLED=true` on LIVE without the development escape hatch.

## 4. Sandbox control API (`core-back/api/internal/sandboxControl.ts`)

Mounted at `/internal/sandbox` for the merchant and admin edges only, and guarded by `isSandboxPlane()`:

| Route | Behaviour |
| :--- | :--- |
| `GET /merchant/overview` | Creates the merchant sandbox envelope on first use and returns wallet/application/link/attempt/token counts and live wallet balances. |
| `POST /merchant/wallets/:walletId/balance` | `CREDIT`, `DEBIT` or `SET_EXACT`; posts a balanced `ADJUSTMENT` journal entry (`DR TREASURY / CR wallet` or the reverse) and audits `WALLET_TOPUP`. Negative results are refused. |
| `POST /merchant/seed-demo` | Creates a funded 5,000 LYD wallet (opened with a real journal entry), an ACTIVE application, three `sbx_` links, a POS terminal and a one-time `pg_test_` token. |
| `POST /merchant/seed-history` | Adds 1-100 balanced historical sandbox payments (`PAYMENT_ATTEMPT` journal entries) for the merchant's first demo link, for realistic tables/charts. |
| `POST /merchant/reset` | Deletes only that merchant's sandbox attempts, links, applications, wallets, tokens, webhooks, disputes and dependent rows; the append-only journal is retained as the sandbox history. |
| `GET /merchant/wallets/:walletId`, `GET /merchant/wallets/:walletId/ledger` | Wallet detail, live balance and paginated shard ledger. |
| `GET /merchant/payments/:attemptId`, `POST /merchant/payments/:attemptId/refund`, `POST /merchant/payments/:attemptId/simulate-dispute`, `POST /merchant/disputes/:disputeId/resolve` | Payment detail, real sandbox ledger refund, dispute simulation and resolution (lost dispute books a chargeback through governance). |
| `GET/POST/PATCH /fake-rails/accounts*` | Proxies the Fake Rails v2 account controller with merchant scoping; shared presets are read-only and cloned into merchant-owned copies. |
| `POST /merchant/reconciliation/import-fake-rails` | Generates the merchant's synthetic clearing CSV, ingests it through `StatementIngestor`, marks the entries statement-included and returns matched/mismatch/missing counts. |
| `POST /merchant/webhooks/test-ping` | Queues a test delivery to every ACTIVE merchant webhook endpoint. |
| `GET/POST /fake-rails/clearing/*` | Pools, synthetic clearing statement and settle. |
| `GET /admin/overview`, `GET /admin/merchants`, `GET /admin/merchants/:id/overview`, `POST /admin/reset` | Staff inspection and scoped/global reset (staff principal required). |
| `GET/PUT /admin/fake-rails/scenarios*`, `GET/POST /admin/fake-rails/transactions*`, `GET/POST /admin/fake-rails/webhooks*`, `GET/POST /admin/fake-rails/statements*` | Staff Fake Rails control center: chaos profiles, transaction actions, webhook replay/fire, tester statements. |

The core trusts the edge identity (mTLS) and the signed session. On the SANDBOX plane, a merchant or staff session minted by Live is mirrored into the sandbox database on first use (merchant envelope + user with the signed authorities), so no second login is needed and a pending Live merchant can train immediately.

## 5. Edge routing

- **merchant-back:** `/api/v1/merchant/sandbox/*` → `SANDBOX_CORE_BACK_URLS` via `api/sandboxProxy.ts`. `/overview`, `/seed-demo`, `/seed-history`, `/reset`, `/wallets/:id/*`, `/payments/:id/*`, `/disputes/:id/resolve`, `/reconciliation/*`, `/fake-rails/*` and `/webhooks/test-ping` map to the sandbox control routes; list/create resources (`/wallets`, `/applications`, `/links`, `/payments`, `/tokens`) map to the sandbox core's `/internal/merchant/*` (same router, separate database). `/mirror/*` is a raw forward to `/internal/merchant/*` for Live-parity pages. The external API accepts both `pg_live_*` and `pg_test_*` and selects the pool from the prefix.
- **admin-back:** `/api/v1/admin/sandbox/*` → sandbox core only (`overview`, merchant overview/reset, wallet balance, fake-rails accounts/clearing/scenarios/transactions/webhooks/statements). `/mirror/*` raw-forwards to `/internal/admin/*` for Live-parity pages.
- **checkout-back:** `sbx_*` links and `SANDBOX` inbound webhook environments → sandbox core. `pl_*` and LIVE inbound → Live core. The inspector routes (`sandbox-accounts`, `sandbox-inspector`, `sandbox-simulate`) refuse a non-`sbx_` key with `403 SANDBOX_INSPECTOR_FORBIDDEN_ON_LIVE_LINK`.
- All three edges keep one connection pool per URL set; a failure inside the sandbox pool never fails over to Live (and the reverse). An unconfigured sandbox node answers `503 SANDBOX_NODE_UNAVAILABLE`.

## 6. Sandbox Studio UI

- **merchant-front:** a separate sidebar section "Sandbox Studio (Testing & Training)" with `/sandbox/overview`, `/wallets`, `/wallets/:id`, `/applications`, `/links`, `/payments`, `/payments/:id`, `/accounts`, `/tokens`, each wrapped in the amber `SandboxBanner`. Wallet detail has balance controls, a simulated cash-out and the sandbox ledger; payment detail has refund, dispute simulation/resolution, inspector secrets and journal lines. A "Sandbox Live Mirror" section reuses Live pages under `/sandbox/mirror/*` (cash-outs, disputes, POS, credentials, team, webhooks, tokens, statements, reports); the API interceptor rewrites Live paths and the router aliases Live navigation into the mirror.
- **admin-front:** `/sandbox/overview`, `/sandbox/merchants`, `/sandbox/merchants/:id` and `/sandbox/fake-rails` (accounts/clearing/chaos/transactions tabs), all built with the standard ApiTable/TableFilters/SummaryExportCard/detail-drawer system, plus a "Sandbox Live Mirror" section for merchants, wallets, applications, transactions, approvals, audit log, operator cases, disputes, adjustments, cash-outs, reconciliation, pricing, profitability, liquidity, journal entries, invariant, credential sets, gateways/routes, reports, platform settings, jobs/outbox and object storage.
- **checkout-front:** `SandboxCheckoutInspector` renders only when the summary is `env: "SANDBOX"` or the key starts with `sbx_`. It lists Fake Rails test accounts, auto-fills the rail form, reveals the live OTP/hold/QR/deep-link/redirect data, offers the push/QR/webhook simulator, creates merchant test accounts, shows account movements and can freeze or drain a merchant-owned test account without leaving checkout.
- The Admin Guide context map's `Sandbox` screen covers the Studio and all mirror routes; the guide extractor count is regenerated by `content:guide`.

## 7. Stateful Fake Rails v2

`fake-rails-back/engine/accounts/AccountLedgerService.ts` adds `fake_accounts`, `fake_account_holds`, `fake_account_movements`, `fake_merchant_clearing_pools` and `fake_clearing_entries`. Five default personas are seeded per rail (high balance, standard, low balance 5 LYD, daily-limit-exhausted, frozen), plus ad-hoc auto-enrolment with a 2,500 LYD default.

- INITIATE reserves atomically (`BEGIN IMMEDIATE`), checking status, available balance and daily limit.
- SUBMIT/APPROVE captures and credits the per-rail clearing pool; CANCEL/DECLINE/expiry releases.
- REFUND credits the customer and refuses a cumulative refund above the captured amount (`REFUND_EXCEEDS_CAPTURED_AMOUNT`).
- `fake_transactions.account_id`/`held_amount_lyd` link the rail transaction to the account.
- The control plane at `/control/*` is shared with `core-back` (`x-fake-rails-control-token` when configured); the tester portal keeps its JWT.

## 8. Deploy configuration

`deploy/lib/configSchema.ts` adds `SANDBOX_ENABLED` (default false), `SANDBOX_NODE`, `SANDBOX_CORE_PORT` (4005), `SANDBOX_DB_NAME` (`payment_gateway_sandbox`), `SANDBOX_REMOTE_DIR`, `SANDBOX_CORE_BACK_URLS` and `FAKE_RAILS_CONTROL_TOKEN`; validation requires Fake Rails, a distinct database/remote dir/port and HTTPS edge URLs. `sandboxDatabase()` derives the transaction (`pgw_sandbox`) and session (`pgw_sandbox_session`) PgBouncer aliases. `postgres18Provisioner` creates the database and writes both aliases; `hostPlanner` emits a second core `ServicePlan` (`pg-core-sandbox`, port 4005, own release tree, sandbox `DATABASE_URL`/`LEADER_ELECTION_DATABASE_URL`, Fake Rails enabled, backups disabled) on `SANDBOX_NODE` or the first core node, with its own firewall rule and core certificate SAN. `deployService` migrates/seeds that database with the direct sandbox owner URL carrying `app.execution_plane=SANDBOX` (PgBouncer rejects custom startup options, so migrations deliberately bypass the pooler); the seed path runs `db-seed` and `seed-fake-rails`, and the Fake Rails seeder stamps an existing sandbox database row as SANDBOX only when `current_database()` equals `SANDBOX_DB_NAME`. Edges receive the sandbox URL list when enabled. The sandbox database and Fake Rails SQLite are deliberately not backup targets.

## 9. Verification

- Core: `sandboxPlane.test.ts` (plane resolution, token prefixes, boot fence, strict DB fence both directions, Fake Rails gateway fence), `fake-rails-control-client.test.ts`, `phase1-mtls-and-schema.test.ts` (v39 migration is newest), commerce/guard regressions.
- Fake Rails: `accountsAndInspector.test.ts` (personas, reserve/capture/release/refund/over-reserve, auto-enrolment, merchant reset, clearing statement) and the v2 control/inspector tests in `api.test.ts`.
- Edges: `sandbox-routing.test.ts` in merchant-back and admin-back, merchant `sandbox-proxy.test.ts` (control vs resource vs mirror routing). checkout-back routes are covered by its sandbox routing suite.
- Deploy: 708 tests including sandbox database creation, PgBouncer aliases, host planning and PKI SAN; `./deploy.sh --dry-run` shows `pg-core-sandbox :4005`.
- Root unit: guide context map, route-authority coverage and i18n catalogues include the sandbox screens/keys.

## 10. Gaps

See the frontmatter. Deployment now provisions/migrates/seeds the second core and database, and the synthetic clearing statement is ingested through `StatementIngestor`. Remaining: Live-to-sandbox sync of operator-customised reference data (GAP-070), a dedicated Fake Rails challenge table, and sandbox role preview. Both deployment and the full Live mirror require a live two-database run that has not been performed in this workspace.

## PROJECT CONTINUATION CONTEXT — MULTI-RAIL PAYMENT GATEWAY MONOLITH

This context is part of the session compaction prompt. Preserve it in the continuation summary and keep the resulting summary detailed enough for a fresh agent to resume safely.

### 1. Product and repository architecture

- **Monorepo**:
  - `core-back/` — Bun + Express 5 + Prisma/PostgreSQL 18 core (`@prisma/adapter-pg` + `pg`). It is the only service with relational database credentials and `KMS_MASTER_KEY`; it owns payments, ledger, governance, reconciliation, AML, operator cases, gateway inquiry schedules and background workers. Persistence goes through `lib/storageEngine/` (UnitOfWork, ReadStore, Redis cache/velocity, audit DB, log DB, backup control).
  - `admin-back/`, `merchant-back/`, `checkout-back/` — edge BFF services. They connect to core only through mTLS using their own client certificate and a least-in-flight/round-robin `CORE_BACK_URLS` pool with `x-pg-min-lsn` propagation. They must never receive `DATABASE_URL` or the master key.
  - `admin-front/`, `merchant-front/`, `checkout-front/` — Vue 3 + Vuetify 3 + TSX SPAs. Admin is LAN-only; merchant and checkout are public behind Nginx. `fake-rails-back/` and `fake-rails-front/` are an optional sandbox/test harness.
  - `deploy/` — multi-host deployment engine with compute node arrays and storage provisioners (PostgreSQL 18 primary/replicas, PgBouncer, Redis, audit/log DBs, backup daemon). `deploy/backup-daemon/` is the WAL-G/Barman + restore/invariant-drill control plane.
  - `tests/` — Playwright/Vitest suites.
  - `project-design/` — canonical architecture, product, implementation state and tracker. `design/` is historical/reference only.

- **Network topology**: PostgreSQL 18 primary accepts replicas (and core when PgBouncer is off); PgBouncer, Redis, audit/log DBs and the backup daemon accept only the allowed core/backup private IPs; core mTLS only accepts the three edge certificates; admin Nginx is LAN-restricted; merchant/checkout are public TLS vhosts. mTLS certificate CN is verified again in core middleware.

- **Deployment architecture**: `deploy/deploy.sh` invokes `deploy/deploy.ts`. The current **14-step** pipeline validates `deploy/deploy.env` with `deploy/lib/configSchema.ts`, plans compute and storage hosts with `hostPlanner.ts`, builds SPAs locally, ensures multi-node PKI, bootstraps hosts/UFW, runs the storage provisioners (PostgreSQL 18 primary/replicas + PgBouncer, Redis, audit/log DBs, backup engine) or the legacy single-host DB backup, deploys core, optional Fake Rails, admin/merchant/checkout (rolling batches with `--rolling-batch` / `--nodes`), seeds optional data, verifies health, prunes releases and prints an audit summary. Nginx/PM2 templates live in `deploy/templates/`. The deploy engine injects per-release frontend runtime values into `runtime-config.js`.

- **Frontend conventions**: manual router (`admin-front/src/router/index.ts`), file-based page folders, `urlsMap` for API paths, `ApiTable`/`DataTable` for lists and XLSX export, `tableRegistry` for filters, `constants/env` for runtime/build flags, `i18nCatalogue` for English/Arabic strings, and `layouts/sections.tsx` for navigation/authorities.

### 2. Source-of-truth files to re-read before changing behavior

Never rely only on this summary for implementation details. Re-read the relevant files:

- Canonical design:
  - `project-design/INDEX.md` (entrypoint)
  - `project-design/STATUS.md` (generated status)
  - `project-design/TRACKER.md` (change/gap/decision log)
  - the relevant `project-design/parts/**` file for the area being changed
  - `design/**` only as historical/reference material (never current authority)
- Schema/data:
  - `core-back/prisma/schema.prisma`
  - `core-back/prisma/migrations/**` (PostgreSQL 18 baseline, storage engine and CQRS read models)
  - `core-back/prisma/schemaVersion.ts`
- Storage/backup:
  - `core-back/lib/storageEngine/**`
  - `deploy/backup-daemon/src/**`
  - `deploy/provisioners/**`
- Core:
  - `core-back/api/internal/admin.ts` (admin internal contract)
  - `core-back/api/internal/merchant.ts`, `core-back/api/internal/checkout.ts`
  - `core-back/engine/**` (flow, governance, ledger, workers, guards)
  - `core-back/lib/**`, `core-back/api/middleware/**`
- Edge BFFs:
  - `admin-back/api/**`, especially `protected/operations.ts` and `contract.ts`
  - `merchant-back/api/**`, `checkout-back/api/**`
- Admin frontend:
  - `admin-front/src/router/index.ts`
  - `admin-front/src/constants/urlsMap/index.ts`
  - `admin-front/src/constants/env/index.ts`
  - `admin-front/src/constants/i18nCatalogue.ts`
  - `admin-front/src/components/Table/**`
  - `admin-front/src/layouts/sections.tsx`
  - the specific page under `admin-front/src/pages/**`
- Deploy:
  - `deploy/deploy.ts`, `deploy/lib/configSchema.ts`, `deploy/lib/hostPlanner.ts`, `deploy/lib/sshRunner.ts`, `deploy/templates/**`, `deploy/deploy.env.example`
- Tests:
  - `core-back/test/**`, `admin-back/test/**`, `tests/e2e/**`, `tests/unit/**`

## 4. Documentation update rule

Any behavior, API, schema/migration, env/config, deploy, UI-route, test or invariant change must update the affected `project-design/parts/**` file and `project-design/TRACKER.md` in the same change. Run `bun scripts/project-design/build.ts --check` before finishing. Never hand-edit generated design files (`PROJECT_DESIGN.md`, `STATUS.md`, appendices, `*/blueprint.md`).

If the compaction cannot fit a required detail, explicitly instruct the resumed agent: **“Before acting, read the relevant design, Prisma schema/migration, and code files listed above.”**

### 3. Non-negotiable invariants

- Money is `Decimal`/`decimal.js`; never use floating point. Ledger effects must be idempotent and audited.
- Sensitive actions use maker-checker; maker ≠ checker is enforced server-side.
- Authorities are checked on the server. UI checks are UX only.
- Never expose or log secrets, ciphertext, AML-confidential data or master keys. Edge hosts must not receive DB/KMS secrets.
- Every material state change writes an audit record where the design requires it.
- PostgreSQL 18 is the only supported runtime database (`postgresql://` URLs, `@prisma/adapter-pg` + `pg`); MySQL/MariaDB are historical. `DATABASE_URL`, `DATABASE_REPLICA_URLS`, `AUDIT_DATABASE_URL` and `LOG_DATABASE_URL` must all be PostgreSQL URLs.
- New Prisma models require a committed migration and `prisma generate`; deploy applies `migrate-deploy` before restarting core.
- Do not bypass `core-back` from an edge service.
- Keep English/Arabic catalogue entries in sync when adding user-facing text.
- Use the shared XLSX pipeline (`admin-front/src/utils/xlsx`) for spreadsheet exports; do not add new CSV downloads.
- Admin operational visibility flags are deploy-engine/runtime-config controlled:
  - `ADMIN_SHOW_CHECKLISTS` (legacy `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST` alias)
  - `ADMIN_SHOW_HELP_PANELS`
  - runtime values are written to `runtime-config.js` by the deploy engine.

### 4. Recently implemented areas that must not be regressed

- IBM Plex Sans (English/LTR) and IBM Plex Sans Arabic (RTL) fonts are self-hosted; CSP-sensitive external font/CDN links were removed.
- Strict CSP-safe build: Vite assets are not inlined (`assetsInlineLimit: 0`); fonts and Leaflet CSS are local.
- Checklist visibility and help-panel visibility are deploy-engine runtime flags (not frontend `.env` defaults).
- All spreadsheet exports are XLSX; `exportExcel` handlers use the shared XLSX utility.
- Gateway inquiry schedule feature:
  - table `gateway_inquiry_schedules`; states `SCHEDULED`, `RUNNING`, `RETRYING`, `COMPLETED`, `FAILED`, `CANCELLED`, `EXPIRED`
  - `PollWorker` drives statuses and retries; the manual schedule owns its own polling window (`window_started_at`)
  - admin page `/operator-cases/inquiries`; APIs under `/api/v1/admin/gateway-inquiries`
  - actions: run now, cancel, retry, view/detail; operator case list/detail show latest schedule.

### 5. Required contents of the compacted continuation summary

1. Current objective and status (completed / in progress / blocked).
2. System architecture and the exact components/paths affected.
3. Decisions and contracts changed, including API shapes, DB migrations, env flags and state machines.
4. Files created/modified and why.
5. Verification performed (typechecks, tests, build, deploy, browser checks) and outstanding failures.
6. Explicit next steps.
7. A "Before next action, re-read" list naming the relevant design docs, `schema.prisma`/migration, and main code files.

If space is insufficient, preserve this requirement and the re-read list rather than dropping it.

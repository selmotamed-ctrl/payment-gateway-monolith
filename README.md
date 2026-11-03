# Payment Gateway Monorepo

A multi-rail payment gateway and payment-links platform. One private core service owns PostgreSQL 18, the encryption keys, the double-entry ledger and outbound gateway execution. Three mutually-authenticated edge BFFs serve the admin, merchant and payer surfaces, and three Vue portals plus an optional Fake Payment Rails emulator exercise them.

The only supported runtime database is PostgreSQL 18. Money is handled with `Decimal`/`decimal.js` and `NUMERIC(18,4)`, never floating point. Edge services never receive `DATABASE_URL`, `KMS_MASTER_KEY` or another service's certificates.

## Design entrypoint

Read the canonical design before changing behavior:

- [`project-design/INDEX.md`](project-design/INDEX.md) — canonical entrypoint and part map.
- [`project-design/PROJECT_DESIGN.md`](project-design/PROJECT_DESIGN.md) — generated consolidated design.
- [`project-design/STATUS.md`](project-design/STATUS.md) — generated implementation status.
- [`project-design/TRACKER.md`](project-design/TRACKER.md) — append-only change, gap and verification log.
- [`project-design/appendices/`](project-design/appendices/) — generated schema, migration, API, environment and test inventories.

`project-design/parts/**` is the editable source of truth. `design/**` is historical/reference material only and is not current authority.

## Repository map

| Workspace | Role |
| :--- | :--- |
| `core-back/` | PostgreSQL 18 storage engine, domain and rail engine, double-entry ledger, governance, workers, backup control client and synthetic seeder. |
| `admin-back/` | LAN-only admin edge BFF. mTLS client to core; least-in-flight `CORE_BACK_URLS` pool. |
| `merchant-back/` | Merchant portal and external `pg_live_` API edge BFF. mTLS client to core. |
| `checkout-back/` | Public checkout, return and raw webhook edge BFF. mTLS client to core. |
| `admin-front/` | Vue 3 + Vuetify 3 + TSX admin portal. |
| `merchant-front/` | Vue 3 + Vuetify 3 + TSX merchant portal. |
| `checkout-front/` | Vue 3 + Vuetify 3 + TSX hosted payer checkout. |
| `fake-rails-back/`, `fake-rails-front/` | Optional Fake Payment Rails emulator and tester portal. |
| `deploy/` | Multi-host deploy engine, PKI, firewall, storage provisioners, templates and `pg-backup-daemon`. |
| `tests/` | Playwright and Vitest suites, including mocked UI, exhaustive surface and live-stack journeys. |
| `project-design/` | Canonical design, generated status, tracker and appendices. |
| `scripts/` | Local deployment, exhaustive-suite and storage-benchmark runners. |

## Service topology

```text
Admin browser
  -> LAN nginx :8443 (admin vhost)
  -> admin-back :4101
  -> mTLS 1.3 /internal/admin/* -> core-back :4000

Merchant browser / merchant server
  -> public nginx :80/:443
  -> merchant-back :4102
  -> mTLS 1.3 /internal/merchant/* -> core-back

Payer browser
  -> public nginx :80/:443
  -> checkout-back :4103
  -> mTLS 1.3 /internal/checkout/* -> core-back

Gateway webhook
  -> checkout-back /api/v1/inbound/:gateway/:env/:pathToken (raw body)
  -> mTLS 1.3 -> core-back

core-back
  -> PostgreSQL 18 primary and optional replicas
  -> Redis (optional cache/velocity, never authoritative for money)
  -> AUDIT_DATABASE_URL (optional dedicated append-only audit DB)
  -> LOG_DATABASE_URL (optional dedicated step/access log DB)
  -> external gateways (HTTPS, host allowlist, SSRF guard)
  -> pg-backup-daemon :4090 over mTLS -> WAL-G or Barman -> S3 and optional secondary vault

Admin portal :5101, Merchant portal :5102, Checkout portal :5103, Fake Rails portal :5104
Fake Rails backend :4104 (optional)
```

Default ports are schema defaults; every deployment can override them. `core-back` is never published by a reverse proxy. Each internal namespace accepts exactly one client-certificate common name: `admin-back`, `merchant-back` or `checkout-back`.

## Prerequisites

- Bun installed and on `PATH`.
- Node.js `^20.19.0` or `>=22.12.0` for the Vue/Vite toolchain and PM2.
- PostgreSQL 18 (the only supported runtime database).
- Redis (optional for runtime, required by the live cache/velocity test suites and benchmarks).
- OpenSSL (the local mTLS certificate generator invokes it).
- PM2 for the all-in-one local stack.
- Playwright Chromium for the UI suites (`bunx playwright install chromium`).
- Linux or macOS. `scripts/deploy-localhost.sh` is written for an Arch Linux workstation; the multi-host deploy engine supports Debian-style `apt` and Arch-style `pacman` hosts.

The repository has no root package manifest. Install dependencies per workspace with `bun install`.

## Quick start

### 1. All-in-one local stack

`scripts/deploy-localhost.sh` is the fastest supported path. By default it creates the PostgreSQL database on `127.0.0.1:5432`, generates mTLS certificates if missing, applies migrations, runs the baseline seed, creates development users, seeds the Fake Rails catalogue, builds four portals and starts nine PM2 processes.

```bash
./scripts/deploy-localhost.sh
pm2 list
```

It serves:

| Surface | URL |
| :--- | :--- |
| Admin portal | `http://127.0.0.1:5101` |
| Merchant portal | `http://127.0.0.1:5102` |
| Checkout portal | `http://127.0.0.1:5103/pay/<linkKey>` |
| Fake Rails portal | `http://127.0.0.1:5104` |
| Core mTLS API | `https://127.0.0.1:4000` |

The script reads `deploy/deploy.env` when present and lets explicit environment variables win. Its defaults include `DEV_PASSWORD=DevPassword123!`, Fake Rails tester `tester_admin` / `Strong-Tester-Pass-2026!`, and the local KMS key `local-payment-gateway-master-key-32chars!`. Change these before using a shared or deployed environment.

### 2. Core service only

```bash
cd core-back
bun install
bun run generate-mtls-certs

export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith
export KMS_MASTER_KEY=local-payment-gateway-master-key-32chars!

bun run migrate-generate
bun run migrate-deploy
bun run db-seed
bun run start
```

Probe the private listener with a client certificate:

```bash
curl --cert certs/admin-back-client.crt \
     --key certs/admin-back-client.key \
     --cacert certs/internal-ca.crt \
     https://127.0.0.1:4000/health
```

Use `POSTGRES_TEST_DATABASE_URL` or a test-specific `DATABASE_URL` for tests; `core-back` tests default to `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`. The local deploy script uses PostgreSQL `5432`, while the test harness defaults to `55432`. They are separate setups.

### 3. Edge services and portals

Each edge backend needs a core URL, its own mTLS client certificate, key and the internal CA. The frontends need their matching edge API base URL. See the workspace READMEs:

- [`admin-back/README.md`](admin-back/README.md)
- [`merchant-back/README.md`](merchant-back/README.md)
- [`checkout-back/README.md`](checkout-back/README.md)
- [`admin-front/README.md`](admin-front/README.md)
- [`merchant-front/README.md`](merchant-front/README.md)
- [`checkout-front/README.md`](checkout-front/README.md)

The deploy engine injects the admin UI flags (`ADMIN_SHOW_CHECKLISTS`, `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST`, `ADMIN_SHOW_HELP_PANELS`) as build constants and runtime config.

## Command matrix

| Workspace | Install | Start / develop | Test | Typecheck / build |
| :--- | :--- | :--- | :--- | :--- |
| `core-back` | `bun install` | `bun run start`, `bun run dev` | `bun test` | `bun run typecheck`, `bun run lint` |
| `admin-back` | `bun install` | `bun run start`, `bun run dev` | `bun test` | `bun run typecheck` |
| `merchant-back` | `bun install` | `bun run start`, `bun run dev` | `bun test` | `bun run typecheck` |
| `checkout-back` | `bun install` | `bun run start`, `bun run dev` | `bun test` | `bun run typecheck` |
| `fake-rails-back` | `bun install` | `bun run start`, `bun run dev` | `bun test` | `bun run typecheck` |
| `admin-front` | `bun install` | `bun run dev`, `bun run preview` | `bun run test:unit` | `bun run build`, `bun run type-check` |
| `merchant-front` | `bun install` | `bun run dev`, `bun run preview` | `bun run test:unit` | `bun run build`, `bun run type-check` |
| `checkout-front` | `bun install` | `bun run dev`, `bun run preview` | n/a | `bun run build`, `bun run type-check` |
| `fake-rails-front` | `bun install` | `bun run dev`, `bun run preview` | n/a | `bun run build`, `bun run type-check` |
| `tests` | `bun install` | n/a | `bun run test`, `bun run test:unit`, `bun run test:live` | n/a |
| `deploy` | `bun install` | `bun run deploy` | `bun test` | `bun run typecheck` |
| `deploy/backup-daemon` | `bun install` | `bun run start` | `bun test` | `bun run typecheck` |

Core lifecycle scripts:

```bash
cd core-back

bun run migrate             # prisma migrate deploy
bun run migrate-dev         # create, patch and apply a development migration
bun run migrate-deploy      # apply committed migrations
bun run migrate-reset       # drop/recreate the database and apply migrations
bun run migrate-generate    # regenerate the Prisma client
bun run db-seed             # platform settings, GL accounts, blueprints, templates, guides
bun run seed-fake-rails     # point seeded gateways at Fake Rails
bun run seed-synthetic-history
bun run create-admin --email admin@example.com --password 'Str0ngPassw0rd!'
bun run create-dev-users
bun run generate-mtls-certs
```

`create-admin` activates a seeded administrator (the baseline seed intentionally leaves passwords unset). `create-dev-users` refuses production unless `--allow-production` or `DEV_USERS_ALLOW_PRODUCTION=true` is supplied.

## Testing and benchmarks

Run the smallest relevant suite first. Database-backed suites require PostgreSQL 18; Redis-backed suites require Redis. Suites skip explicitly when the service is absent, so a green run does not prove every suite executed. Report skips explicitly.

```bash
# Full workspace gate
bun scripts/project-design/build.ts --check
git diff --check
(cd core-back && bun run typecheck && bun test)
(cd deploy && bun run typecheck && bun test)
(cd deploy/backup-daemon && bun run typecheck && bun test)
(cd admin-back && bun run typecheck && bun test)
(cd merchant-back && bun run typecheck && bun test)
(cd checkout-back && bun run typecheck && bun test)
(cd admin-front && bun run build)
(cd merchant-front && bun run build)
(cd checkout-front && bun run build)

# Exhaustive runner (DB suites forced to one worker; skipped suites are reported)
./scripts/run-exhaustive-suite.sh
./scripts/run-exhaustive-suite.sh --deploy
E2E_LIVE=1 ./scripts/run-exhaustive-suite.sh

# Storage benchmarks (a database URL is required)
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test \
  ./scripts/run-benchmarks.sh
BENCHMARK_FILTER=write-path ./scripts/run-benchmarks.sh

# Mocked UI, exhaustive UI and deployed-stack live smoke
(cd tests && bun run test)
(cd tests && bunx playwright test -c playwright.exhaustive.config.ts -g "cross-service lifecycle")
(cd tests && bun run test:live)
```

The exhaustive runner does not provision PostgreSQL, Redis, browsers or a live stack. The cross-service journeys require `E2E_LIVE=1` and a running stack; the link journey also requires `E2E_LINK_KEY`. See [`tests/README.md`](tests/README.md) for the full layer, provisioning and troubleshooting guide.

## Deploy summary

Production and multi-host deployment use the engine in `deploy/`:

```bash
cp deploy/deploy.env.example deploy/deploy.env
chmod 600 deploy/deploy.env
$EDITOR deploy/deploy.env

./deploy/deploy.sh --dry-run
./deploy/deploy.sh --fresh       # first deploy; bootstraps OS, packages, firewall
./deploy/deploy.sh --update      # subsequent deploys; no OS or firewall changes
```

Useful flags: `--env=<path>`, `--only=core,checkout`, `--enforce-firewall`, `--skip-build`, `--skip-verify`, `--rotate-certs`, `--keep=<n>`, `--rolling-batch=<n>`, `--nodes=<id,...>` and `--dry-run`.

The engine validates the configuration with Zod before the first SSH connection, plans hosts, builds SPAs, provisions or reuses the internal PKI, applies firewall rules, provisions PostgreSQL 18 primary/replicas/PgBouncer, Redis, audit and log databases, optionally runs WAL-G/Barman and `pg-backup-daemon`, deploys core and then the edge tiers, verifies mTLS health, prunes old releases and optionally seeds.

The full operator manual is [`deploy/DEPLOYMENT_GUIDE.md`](deploy/DEPLOYMENT_GUIDE.md). The backup control plane is documented in [`project-design/parts/01-core-back/09-backup-control.md`](project-design/parts/01-core-back/09-backup-control.md) and [`project-design/parts/07-deploy/06-backup-daemon.md`](project-design/parts/07-deploy/06-backup-daemon.md).

## Security invariants

- PostgreSQL 18 is the only runtime database (`@prisma/adapter-pg` + `pg`). Do not reintroduce MySQL or MariaDB.
- Money uses `Decimal`/`decimal.js`; never floating point.
- Sensitive actions use maker-checker; maker != checker is enforced server-side and by the database.
- Authorities are enforced by `core-back`; edge and UI checks are advisory.
- Edge services never receive `DATABASE_URL`, `KMS_MASTER_KEY`, another host's client key or database drivers.
- `core-back` is private and requires TLS 1.3 client certificates. Each internal namespace is bound to one edge certificate common name.
- Ledger, outbox and audit writes for critical paths are atomic.
- Secrets, ciphertext, AML-confidential data and master keys must never be logged.
- Outbound gateway calls are HTTPS-only with a host allowlist, DNS/SSRF guard, redirect blocking and response caps. The Fake Rails exception is exact-host and requires three simultaneous conditions.
- Browser callbacks and return URLs are untrusted hints; webhooks are verified before money is posted.
- Keep English and Arabic catalogues in sync for user-facing text.
- All spreadsheet exports use the shared XLSX pipeline.
- Deploy-generated UI flags (`ADMIN_SHOW_CHECKLISTS`, `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST`, `ADMIN_SHOW_HELP_PANELS`) are runtime-config controlled.

## Documentation workflow

Any change to behavior, APIs, schema or migrations, environment or configuration, deploy, UI routes, tests or invariants must update the affected `project-design/parts/**` file and `project-design/TRACKER.md` in the same change.

1. Edit the relevant `project-design/parts/**` file and keep its YAML frontmatter accurate (`status`, `last_verified`, `code`, `design_sources`, `tests`, `gaps`).
2. Add a dated entry to `project-design/TRACKER.md`.
3. Run `bun scripts/project-design/build.ts`.
4. Run `bun scripts/project-design/build.ts --check` and `git diff --check`.
5. Run the smallest relevant typecheck/test/build commands, then the full gate when practical.

Never hand-edit generated files: `project-design/PROJECT_DESIGN.md`, `project-design/STATUS.md`, `project-design/INDEX.md`, `project-design/appendices/*-catalog.md`, `*-matrix.md`, `*-inventory.md`, `project-design/appendices/code-surface-map.md`, or any `*/blueprint.md`. Edit the parts (or the generator) and regenerate. Unimplemented features belong under `project-design/parts/09-future-and-unimplemented/`.

## Further reading

- [`core-back/README.md`](core-back/README.md) — complete core service manual, runtime, storage, backup control, environment reference and troubleshooting.
- [`tests/README.md`](tests/README.md) — test layers, PostgreSQL/Redis provisioning, skip behavior and live-stack instructions.
- [`deploy/DEPLOYMENT_GUIDE.md`](deploy/DEPLOYMENT_GUIDE.md) — multi-host deployment, PKI, firewall, backups and recovery.
- [`project-design/parts/00-platform/01-service-topology.md`](project-design/parts/00-platform/01-service-topology.md) — canonical topology and trust boundaries.
- [`project-design/parts/00-platform/02-security-and-mtls.md`](project-design/parts/00-platform/02-security-and-mtls.md) — security controls and known limitations.

# Tests — Layers, Provisioning and Commands

This directory contains the cross-workspace Playwright and Vitest suites. Most test files live beside the code they exercise in `core-back/test`, `admin-back/test`, `merchant-back/test`, `checkout-back/test`, `fake-rails-back/test`, `deploy/test` and `deploy/backup-daemon/test`.

The generated [`project-design/appendices/test-inventory.md`](../project-design/appendices/test-inventory.md) is authoritative for the file list, line counts and literal test declarations. The canonical strategy is [`project-design/parts/08-testing/00-strategy.md`](../project-design/parts/08-testing/00-strategy.md); the suite catalog, fixtures/live stack and benchmark parts are linked at the end.

## 1. Test layers

| Layer | Location | Runner | What it proves | Live dependencies |
| :--- | :--- | :--- | :--- | :--- |
| Pure unit | `core-back/test/engine`, `core-back/test/runtime`, `core-back/test/globalSearch.test.ts`, edge helpers, deploy planners, frontend `src/content/__tests__` | `bun test`, Playwright/Vitest for UI | Real production modules without a database: transforms, crypto, URL compiler, ledger math, parsers, state helpers, planners. | None |
| Route/integration | `core-back/test/*.test.ts`, `admin-back/test`, `merchant-back/test`, `checkout-back/test`, `fake-rails-back/test` | `bun test` | Express routers, validation, auth/authority helpers, forwarding, contracts and error envelopes. Some tests use fakes; some use PostgreSQL. | PostgreSQL for the DB-backed files |
| Storage-engine | `core-back/test/storage-engine` | `bun test` | Unit of work, outbox/audit shipping, replica routing, Redis/memory velocity, sharding, log sink, read models and schema-scoped sandboxes. | PostgreSQL 18; Redis for the live velocity path |
| Exhaustive | `core-back/test/exhaustive`, edge `test/exhaustive`, `deploy/test`, `deploy/backup-daemon/test` | `bun test` via `scripts/run-exhaustive-suite.sh` | Schema catalogs/constraints, ledger matrices/fuzzer, transforms/crypto, rail flows, API/RBAC matrix, concurrency, workflows, security catalogue, seeder safety. | PostgreSQL for schema/concurrency/checkpoint suites; Redis where relevant |
| Mocked UI | `tests/e2e`, `tests/unit` | Playwright, Vitest | Portal rendering, shell geometry, direction/theme, auth body shapes, route surfaces, search palette and deep links. APIs are intercepted. | Node/Bun, Playwright Chromium; preview servers |
| Live E2E | `tests/e2e-live`, opt-in journeys in `tests/e2e/exhaustive` | Playwright | Deployed-stack login/shell smoke and optional cross-service health/link probes. | A running local or external stack |
| Benchmarks | `core-back/test/storage-engine/performance` | `bun test` via `scripts/run-benchmarks.sh` | Storage write-path, UoW, outbox drain, shard reads, audit chain and Redis velocity regression ceilings. | PostgreSQL 18; Redis optional |

The mocked UI layer is not backend integration evidence. `tests/e2e/fixtures.ts` intercepts `**/api/v1/**` and returns fixture or empty JSON, so a green UI run proves rendering and navigation, not permissions, validation, persistence or payment state.

## 2. Layout and package scripts

| Path | Purpose |
| :--- | :--- |
| `core-back/test/setup.ts` | Preloaded by `core-back/bunfig.toml`; sets `NODE_ENV=test`, default test database URL, test KMS key, certificate paths and `LOG_LEVEL`. |
| `core-back/test/helpers/**` | Fake Prisma, repositories, guards, governance, retention and background-job doubles. |
| `core-back/test/exhaustive/_harness.ts` | Deterministic xoshiro128** PRNG, schema parser, catalog readers and the double-entry invariant hook. |
| `core-back/test/exhaustive/_dbFactory.ts` | Fixture builder driven by the real schema and seed catalogs. |
| `core-back/test/storage-engine/helpers/db.ts` | PostgreSQL/Redis probes, sandbox schemas, audit sandbox and cleanup. |
| `tests/e2e/fixtures.ts` | Admin/merchant session injection, wildcard API mock, geometry helpers. |
| `tests/playwright.config.ts` | Admin, merchant and checkout projects; starts three Vite preview servers. |
| `tests/playwright.exhaustive.config.ts` | Four portal projects plus the live journey project; starts four preview servers. |
| `tests/playwright.live.config.ts` | Deployed-stack smoke; no web server. |
| `tests/vitest.config.ts` | Unit tests with the `@` alias pointed at `admin-front/src`. |
| `tests/run-playwright.sh` | Wrapper that prepends the local Playwright library path and calls `bunx playwright test`. |

`tests/package.json` scripts:

```bash
bun run test        # playwright test (mocked admin/merchant/checkout)
bun run test:headed # headed Playwright
bun run test:unit   # vitest run
bun run test:e2e    # playwright test
bun run test:live   # playwright test -c playwright.live.config.ts
```

## 3. Prerequisites

- Bun on `PATH`; run commands from the workspace that owns the suite.
- Node.js `^20.19.0` or `>=22.12.0` for the Vue/Vite frontends and PM2.
- PostgreSQL 18 with permission to create databases, schemas and tables.
- Redis for the live cache/velocity suites and benchmarks. Runtime and most correctness suites work without it.
- OpenSSL and the generated core certificates for mTLS/router tests:

  ```bash
  cd core-back
  bun run generate-mtls-certs
  ```

- Playwright Chromium for the UI suites:

  ```bash
  cd tests
  bun install
  bunx playwright install chromium
  ```

- `psql`, `createdb` and `redis-server` (or equivalent managed services).
- Free ports: test PostgreSQL `55432`, test Redis `56379`, and the portal/backend ports `4000`, `4101`-`4104`, `5101`-`5104` when a local stack is running.

The local all-in-one deployment defaults to PostgreSQL `5432`; the test harness defaults to `55432`. They are separate configurations. Do not assume the deployed database is the test database.

## 4. Provision PostgreSQL 18

Install and start PostgreSQL 18 with your distribution packages or a container image; confirm `psql --version` reports 18. None of the repository scripts start the server.

### Option A: repository helper

`core-back/scripts/prepare-databases.sh` creates the application role, the application database, the test database, and applies Prisma migrations to both:

```bash
POSTGRES_HOST=127.0.0.1 \
POSTGRES_PORT=55432 \
POSTGRES_ADMIN_USER=postgres \
./core-back/scripts/prepare-databases.sh
```

Defaults: role `gateway`, password `gateway`, database `payment_gateway_monolith`, test database `payment_gateway_monolith_test`. Override with `POSTGRES_APP_USER`, `POSTGRES_APP_PASSWORD`, `POSTGRES_DATABASE` and `POSTGRES_TEST_DATABASE`. Set `POSTGRES_ADMIN_PASSWORD` when the admin role requires a password.

The script does not start PostgreSQL. If it is not running, start the service or your container first.

After it finishes, point the test suites at the test database:

```bash
export DATABASE_URL=postgresql://gateway:gateway@127.0.0.1:55432/payment_gateway_monolith_test
export POSTGRES_TEST_DATABASE_URL="$DATABASE_URL"
export STORAGE_TEST_DATABASE_URL="$DATABASE_URL"
export EXHAUSTIVE_DATABASE_URL="$DATABASE_URL"
```

### Option B: manual database

```bash
createdb -h 127.0.0.1 -p 55432 payment_gateway_monolith_test

cd core-back
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test \
  bun run migrate-deploy
```

The test database must already be migrated. Missing tables or a partial migration history causes schema, ledger, storage, backup and exhaustive suites to fail at query time. The test harness does not assert schema version 8; that guard is enforced by the seeders.

The storage suites create and drop their own schemas inside the configured database. Use a disposable test database, not the application database. Run database suites with one worker because they share the database and the double-entry invariant:

```bash
cd core-back
bun test --parallel=1
```

## 5. Provision Redis

The storage helpers default to `redis://127.0.0.1:56379`:

```bash
redis-server --port 56379 --daemonize yes
redis-cli -p 56379 ping
```

Export one or both variables before starting the test process:

```bash
export STORAGE_TEST_REDIS_URL=redis://127.0.0.1:56379
export REDIS_URL=redis://127.0.0.1:56379
```

`STORAGE_TEST_REDIS_URL` is used by `core-back/test/storage-engine/helpers/db.ts`; `REDIS_URL` is also consulted by the storage performance/production adapter suites. Setting both avoids ambiguity. The live Redis velocity suite is skipped when the `PING` fails; the in-memory cache tests still run.

## 6. Environment variables

| Key | Default / precedence | Used by |
| :--- | :--- | :--- |
| `DATABASE_URL` | `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test` in `core-back/test/setup.ts` | Core integration/e2e, storage fallback |
| `POSTGRES_TEST_DATABASE_URL` | Preferred over `DATABASE_URL` where read | `postgres-payment.test.ts`, `phase1-mtls-and-schema.test.ts`, exhaustive fallback |
| `EXHAUSTIVE_DATABASE_URL` | First choice; then `POSTGRES_TEST_DATABASE_URL`; then the default | `core-back/test/exhaustive/_harness.ts` |
| `STORAGE_TEST_DATABASE_URL` | First choice; then `DATABASE_URL`; then the default | `core-back/test/storage-engine/helpers/db.ts` |
| `STORAGE_TEST_REDIS_URL` | `redis://127.0.0.1:56379` | Storage cache/velocity and performance |
| `REDIS_URL` | Test fallback `redis://127.0.0.1:56379` | Storage performance and production adapters |
| `KMS_MASTER_KEY` | `phase-test-master-key-value` from setup | Core tests that derive keys or encrypt |
| `MTLS_CA_CERT_PATH`, `MTLS_SERVER_CERT_PATH`, `MTLS_SERVER_KEY_PATH` | `core-back/certs/*` from setup | mTLS/router tests |
| `NODE_ENV` | Forced to `test` by setup | Env loader cache behavior |
| `E2E_LIVE` | Off unless `1` | Cross-service lifecycle journeys |
| `E2E_LINK_KEY` | Unset | Optional checkout link journey |
| `E2E_ADMIN_URL`, `E2E_MERCHANT_URL`, `E2E_CHECKOUT_URL`, `E2E_FAKE_RAILS_URL` | `127.0.0.1:5101`-`5104` | Cross-service journeys |
| `E2E_ADMIN_BACK_URL`, `E2E_MERCHANT_BACK_URL`, `E2E_CHECKOUT_BACK_URL`, `E2E_FAKE_RAILS_BACK_URL` | `127.0.0.1:4101`-`4104` | Cross-service journeys |
| `PG_ADMIN_URL`, `PG_MERCHANT_URL`, `PG_CHECKOUT_URL` | Hard-coded external defaults in `tests/e2e-live/live.spec.ts` | Deployed-stack smoke |
| `PG_ADMIN_EMAIL`, `PG_MERCHANT_EMAIL`, `PG_FINANCE_EMAIL`, `PG_PASSWORD` | Hard-coded test defaults in the live spec | Deployed-stack login |
| `PLAYWRIGHT_CHROME_PATH` | Playwright-managed Chromium | All Playwright configs |
| `BENCHMARK_FILTER` | Unset | Storage benchmark runner filter |
| `FAKE_RAILS_*` | Unset | Fake Rails, seeder and synthetic-history live flows |

The database and Redis reachability probes run at module load. Changing an environment variable after the process has imported the helper does not re-probe it. Export the values before `bun test` or Playwright.

## 7. Commands

### 7.1 Full gate

```bash
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
```

### 7.2 Core service

```bash
cd core-back

bun run typecheck
bun test
bun test --parallel=1

# Focused suites
bun test test/engine/ledger.test.ts
bun test test/engine/transform-pipeline.test.ts
bun test test/storage-engine
bun test test/storage-engine/performance
bun test test/backup-admin
bun test test/e2e/postgres-payment.test.ts
bun test test/exhaustive/01-schema
bun test test/exhaustive/02-ledger
bun test test/exhaustive/06-concurrency
```

### 7.3 Edge backends and Fake Rails

```bash
(cd admin-back && bun test)
(cd merchant-back && bun test)
(cd checkout-back && bun test)
(cd fake-rails-back && bun test)
```

### 7.4 Deploy engine and backup daemon

```bash
(cd deploy && bun test)
(cd deploy/backup-daemon && bun test)
```

These are unit-level suites. The daemon tests use fake command runners and file systems; they do not run a real WAL-G/Barman backup, S3 upload or PostgreSQL restore. The deploy tests plan and render hosts; they do not deploy a multi-host cluster.

### 7.5 Frontend unit checks

```bash
(cd admin-front && bun run test:unit)
(cd merchant-front && bun run test:unit)
(cd checkout-front && bun run build)
```

`tests/unit` is separate from the frontend `src/content/__tests__` checks:

```bash
(cd tests && bun run test:unit)
```

### 7.6 Mocked UI

```bash
cd tests
bun install
bunx playwright install chromium

bun run test                                              # admin, merchant, checkout
bunx playwright test -c playwright.exhaustive.config.ts   # four portals + live project
bunx playwright test -c playwright.exhaustive.config.ts e2e/exhaustive/exhaustive-admin-surface.spec.ts
```

The default and exhaustive configs start Vite preview servers on `5101`-`5104`. They run one worker, headless, with `ignoreHTTPSErrors`, `--no-sandbox`, no trace and screenshots only on failure. `reuseExistingServer: true` means a stale preview server can serve old assets; stop old previews before a debugging run.

### 7.7 Exhaustive runner

```bash
./scripts/run-exhaustive-suite.sh
./scripts/run-exhaustive-suite.sh --deploy
E2E_LIVE=1 ./scripts/run-exhaustive-suite.sh
```

The runner:

- forces `bun test --parallel=1` for database suites;
- runs core exhaustive groups, edge BFF suites, deploy tests and the backup daemon;
- runs `tests` unit plus the exhaustive Playwright config;
- runs the seeder/deploy suite;
- runs the cross-service journey only when `E2E_LIVE=1`;
- runs the full `core-back` regression last;
- optionally runs `scripts/deploy-localhost.sh` with `--deploy`.

`--deploy` runs the local deployment after the suites. If you want the cross-service journeys against a freshly deployed stack, deploy first with `./scripts/deploy-localhost.sh`, then run `E2E_LIVE=1 ./scripts/run-exhaustive-suite.sh` or the targeted Playwright command.

The runner does not preflight PostgreSQL, Redis, browsers or a live stack. A green run means "nothing that ran failed"; it does not mean every suite executed. Check the reported skips.

### 7.8 Benchmarks

```bash
export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test
export STORAGE_TEST_REDIS_URL=redis://127.0.0.1:56379
export REDIS_URL=redis://127.0.0.1:56379

./scripts/run-benchmarks.sh
BENCHMARK_FILTER=write-path ./scripts/run-benchmarks.sh

# Direct
cd core-back && bun test test/storage-engine/performance
```

The runner exits with code 2 when no database URL is configured. It prints p50/p95 values; it does not store a baseline. Benchmarks are regression ceilings, not capacity proofs. Run them on an idle machine and compare with a previous run on the same hardware.

## 8. Skip behavior

Suites skip explicitly when a required service is absent:

- `core-back/test/storage-engine/helpers/db.ts` probes PostgreSQL with `SELECT 1` and Redis with `PING` at module load. `describeDatabase` and `describeRedis` become `describe.skip` on failure.
- `core-back/test/exhaustive/_harness.ts` computes `databaseIsReachable` and several exhaustive files use `databaseIsReachable ? describe : describe.skip`.
- `core-back/test/e2e/postgres-payment.test.ts` uses `test.skipIf(!reachable)` for every live payment/invariant test.
- Storage-engine files register visible `test.skip("... requires the live database")` placeholders so a skipped file is still reported.
- `tests/e2e/exhaustive/full-platform-lifecycle-journeys.spec.ts` skips unless `E2E_LIVE=1`; the link journey also skips unless `E2E_LINK_KEY` is set.
- `tests/e2e-live/live.spec.ts` has no skip guard; it fails when the configured deployed host is unreachable.

Consequences:

- A green `bun test` can contain skipped schema, ledger, storage, backup-admin, postgres-payment or exhaustive database coverage.
- A green Playwright run can be entirely mocked.
- A green exhaustive run can contain skips because the runner has no fail-on-skip policy.
- Benchmark database and Redis tests can skip while the script still exits successfully after the runner's URL check.

Always report whether PostgreSQL and Redis were available. A skipped suite is not a passing suite.

## 9. Run the local live stack

`scripts/deploy-localhost.sh` provisions and starts the full local stack:

```bash
./scripts/deploy-localhost.sh
pm2 list
```

It expects PostgreSQL 18 on `127.0.0.1:5432`, generates certificates if missing, applies migrations, seeds the baseline, creates development users, seeds Fake Rails, builds the four portals and starts nine PM2 processes:

| Process | Port |
| :--- | ---: |
| `pg-core-back` | 4000 (mTLS) |
| `pg-fake-rails-back` | 4104 |
| `pg-admin-back` | 4101 |
| `pg-merchant-back` | 4102 |
| `pg-checkout-back` | 4103 |
| `pg-admin-front` | 5101 |
| `pg-merchant-front` | 5102 |
| `pg-checkout-front` | 5103 |
| `pg-fake-rails-front` | 5104 |

It reads `deploy/deploy.env` when present, but explicit environment variables win. Development defaults include `DEV_PASSWORD=DevPassword123!`, Fake Rails tester `tester_admin` / `Strong-Tester-Pass-2026!` and the local KMS key. Change these outside a disposable workstation.

After the stack is up:

```bash
# Cross-service lifecycle probes
(cd tests && E2E_LIVE=1 E2E_LINK_KEY=<seeded-link-key> \
  bunx playwright test -c playwright.exhaustive.config.ts -g "cross-service lifecycle")

# Or run the whole exhaustive gate against the running stack
E2E_LIVE=1 ./scripts/run-exhaustive-suite.sh
```

`E2E_LINK_KEY` must identify an existing seeded payment link. There is no fixture generator for it; the link journey skips without one. The cross-service suite checks portals and backend health, the Fake Rails scenario guard and an optional checkout link lookup. It is not a full merchant-onboarding-to-cash-out browser journey.

### 9.1 External deployed stack

`tests/e2e-live/live.spec.ts` targets a deployed host. Override its committed defaults with environment variables:

```bash
cd tests
PG_ADMIN_URL=https://admin.example.internal:8443 \
PG_MERCHANT_URL=https://merchant.example.internal \
PG_CHECKOUT_URL=https://pay.example.internal \
PG_ADMIN_EMAIL=admin@example.internal \
PG_MERCHANT_EMAIL=merchant@example.internal \
PG_FINANCE_EMAIL=finance@example.internal \
PG_PASSWORD='...' \
bun run test:live
```

The spec probes both schemes, logs in, asserts the shell below the app bar, checks for no scaling transform or horizontal overflow, opens Disputes as finance, creates a gateway through the UI and renders the missing-link checkout surface. It does not provision the host, install certificates or clean up created records.

The committed defaults include a host address, internal emails and a test password. Treat them as compromised test credentials and always override them for a real environment.

### 9.2 Health checks

```bash
# Edge health
curl -fsS http://127.0.0.1:4101/health
curl -fsS http://127.0.0.1:4102/health
curl -fsS http://127.0.0.1:4103/health
curl -fsS http://127.0.0.1:4104/health

# Core health over mTLS
curl --cert core-back/certs/admin-back-client.crt \
     --key core-back/certs/admin-back-client.key \
     --cacert core-back/certs/internal-ca.crt \
     https://127.0.0.1:4000/health
```

Core `/health` always returns HTTP 200; read `status` and `queue.degraded` in the body. Edge `/health` does not check core reachability, so a healthy edge can still return 502s.

## 10. Test data and cleanup

- Core/storage tests generate unique IDs and clean their own rows. Storage and audit tests create dedicated schemas and drop them.
- Fake-rails tests use temporary SQLite files and remove `-wal`/`-shm` siblings.
- Playwright UI tests mostly mock APIs and persist nothing.
- `tests/.gitignore` ignores `node_modules`; `tests/test-results` contains run output and is covered by the root ignore rules.
- The test database is disposable. Never point the suites at the application or production database.

## 11. Troubleshooting

| Symptom | Likely cause | Action |
| :--- | :--- | :--- |
| Every database suite is skipped | PostgreSQL is unreachable, the URL is wrong, or the probe ran before the URL was exported. | Start PostgreSQL, export the URL first, run `bun test --parallel=1`, verify with `psql "$DATABASE_URL" -c 'SELECT 1'`. |
| `database ... does not exist` | The test database was never created. | `createdb`, then run `bun run migrate-deploy` with the test URL. |
| `relation ... does not exist` | Migrations were not applied to the test database. | Apply migrations to the exact URL the suite uses. |
| Schema-version or stale-schema failure | Partial migration history or version below 8. | Apply all committed migrations; do not rely on the HTTP start path to check. |
| Redis suites are skipped | Redis is not on `56379`, or only one URL variable is set. | Start Redis, set `STORAGE_TEST_REDIS_URL` and `REDIS_URL` before `bun test`. |
| mTLS/router tests fail on missing files | Certificates were not generated. | `cd core-back && bun run generate-mtls-certs`. |
| Typecheck or tests fail after a schema change | Generated Prisma client is stale. | `cd core-back && bun run migrate-generate`. |
| Playwright complains the browser is missing | Chromium is not installed. | `cd tests && bunx playwright install chromium`, or set `PLAYWRIGHT_CHROME_PATH`. |
| UI tests serve stale assets | `reuseExistingServer: true` reused an old preview. | Stop the old preview processes, then rerun. |
| Cross-service journeys are skipped | `E2E_LIVE` is not `1`, or `E2E_LINK_KEY` is missing. | Deploy the stack, export both values, rerun the targeted Playwright command. |
| Live spec cannot reach the host | The deployed URLs or credentials are wrong. | Export the `PG_*` variables; verify the host and both schemes manually. |
| Exhaustive runner is green but coverage looks low | Database, Redis, browser or live suites skipped. | Read the output; the runner has no fail-on-skip mode. Report the skipped groups. |
| Benchmark exits with code 2 | No database URL was supplied. | Export `DATABASE_URL`, `POSTGRES_TEST_DATABASE_URL` or `STORAGE_TEST_DATABASE_URL`. |
| Benchmark prints skips | PostgreSQL is unreachable, or Redis is absent for the live velocity path. | Fix the service and rerun; treat the previous result as partial. |
| `EADDRINUSE` on preview/backend ports | Another process owns `4000`, `4101`-`4104` or `5101`-`5104`. | Stop the old process (`pm2 delete`, `pm2 kill`) or change the port for a manual run. |
| `bun test` from the repository root finds nothing | There is no root package manifest; suites are per workspace. | Run the command in the workspace that owns the tests. |
| Storage suites interfere with each other | Database suites ran in parallel against one database. | Use `bun test --parallel=1` for database suites. |

## 12. Design references

- [`../project-design/INDEX.md`](../project-design/INDEX.md) — canonical design entrypoint.
- [`../project-design/parts/08-testing/00-strategy.md`](../project-design/parts/08-testing/00-strategy.md) — testing philosophy, gates and skip policy.
- [`../project-design/parts/08-testing/01-suite-catalog.md`](../project-design/parts/08-testing/01-suite-catalog.md) — actual suites and the gap against the historical plan.
- [`../project-design/parts/08-testing/02-fixtures-and-live-stack.md`](../project-design/parts/08-testing/02-fixtures-and-live-stack.md) — database/Redis fixtures, mock API and live stack.
- [`../project-design/parts/08-testing/03-benchmarks.md`](../project-design/parts/08-testing/03-benchmarks.md) — benchmark thresholds and missing capacity benchmarks.
- [`../project-design/parts/01-core-back/11-tests-and-benchmarks.md`](../project-design/parts/01-core-back/11-tests-and-benchmarks.md) — core test and benchmark inventory.
- [`../project-design/appendices/test-inventory.md`](../project-design/appendices/test-inventory.md) — generated file inventory.
- [`../project-design/appendices/env-and-config-matrix.md`](../project-design/appendices/env-and-config-matrix.md) — generated environment matrix.
- [`../project-design/appendices/api-route-matrix.md`](../project-design/appendices/api-route-matrix.md) — route surfaces exercised by the API matrices.

Historical test plans live under [`../design/`](../design/). They are reference only. Current behavior and coverage are the parts plus the code.

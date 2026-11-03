---
id: testing.fixtures
title: Fixtures, Mock API and Live Stack
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - tests/e2e/fixtures.ts
  - tests/playwright.config.ts
  - tests/playwright.exhaustive.config.ts
  - tests/playwright.live.config.ts
  - tests/e2e-live/live.spec.ts
  - tests/e2e/exhaustive/full-platform-lifecycle-journeys.spec.ts
  - scripts/deploy-localhost.sh
  - core-back/test/setup.ts
  - core-back/test/exhaustive/_harness.ts
  - core-back/test/storage-engine/helpers/db.ts
design_sources:
  - design/master_exhaustive_test_plan_for_opencode.md#10-2-environment
  - design/master_exhaustive_test_plan_for_opencode.md#12-suite-11-full-cross-service-end-to-end-journeys-synthetic-seeder-deploy-engine-verification-1200-tests
tests:
  - tests/e2e/fixtures.ts
  - tests/e2e-live/live.spec.ts
  - tests/e2e/exhaustive/full-platform-lifecycle-journeys.spec.ts
  - core-back/test/exhaustive/_harness.ts
  - core-back/test/storage-engine/helpers/db.ts
gaps:
  - tests/e2e-live/live.spec.ts contains hard-coded deployed IPs and default passwords.
  - The live stack has no automated provisioning for the external host used by e2e-live.
  - The cross-service journey suite skips unless E2E_LIVE=1 and a payment link key are supplied.
  - Most UI fixtures mock every API and do not exercise real backends.
---

# Fixtures, Mock API and Live Stack

## 1. Purpose and scope

This part documents the environment and fixtures used by the test suites:

- The PostgreSQL/Redis test environment and variable precedence.
- The Playwright fixture that fakes admin/merchant sessions and API responses.
- The exhaustive UI fixture that mocks every API.
- The local all-in-one stack started by `scripts/deploy-localhost.sh`.
- The external live-stack spec in `tests/e2e-live/live.spec.ts` and its hard-coded credentials.
- The opt-in cross-service journey file.

It does not catalogue the suites (`testing.suites`) or the benchmarks (`testing.benchmarks`).

## 2. Design intent (extracted and synthesized from ./design)

The design requires two environments:

1. **CI/local correctness environment.** A dedicated PostgreSQL 18 test database, an optional streaming replica, Redis for velocity/cache tests, and skip-with-reason behaviour when a dependency is absent.
2. **Live deployed environment.** The full stack on the single-node deployment: core over mTLS, three edge BFFs, four portals, fake rails and PostgreSQL. Cross-service journeys should exercise merchant onboarding, checkout, fake-rails approval, ledger posting, reconciliation and cash-out.

The live environment is expected to be provisioned by the deploy engine, not by the test suite. The test suite should discover URLs and credentials from the environment.

## 3. As-built architecture

### 3.1 Database and Redis environment

| Variable | Default / precedence | Consumer |
| :--- | :--- | :--- |
| `DATABASE_URL` | `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test` in `test/setup.ts` | Core integration/e2e tests |
| `POSTGRES_TEST_DATABASE_URL` | preferred by `core-back/test/e2e/postgres-payment.test.ts` | Payment E2E |
| `EXHAUSTIVE_DATABASE_URL` | preferred; then `POSTGRES_TEST_DATABASE_URL`; then `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test` | Exhaustive harness |
| `STORAGE_TEST_DATABASE_URL` | preferred; then `DATABASE_URL`; then `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test` | Storage helpers |
| `STORAGE_TEST_REDIS_URL` | `redis://127.0.0.1:56379` | Storage cache/velocity |
| `REDIS_URL` | `redis://127.0.0.1:56379` | Storage performance, production adapters |

`core-back/test/setup.ts` also defaults `KMS_MASTER_KEY`, the mTLS certificate paths and `LOG_LEVEL=error`. The certificate paths point at `core-back/certs/*`; the files must exist or the mTLS tests fail.

The expected local services are PostgreSQL 18 on 55432 and Redis on 56379. The production port (5432) is not assumed by the test harness.

Before a database suite can run, the test database must exist and be migrated:

```bash
createdb -h 127.0.0.1 -p 55432 payment_gateway_monolith_test
cd core-back
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test \
  bun run migrate-deploy
```

`_harness.ts` creates a dedicated Prisma client with `@prisma/adapter-pg`. `helpers/db.ts` creates pools and schema-scoped clients for storage tests. Storage files can create and drop schemas under a shared database; the runner forces `--parallel=1` for DB suites.

### 3.2 Skip gates

- `probeDatabase()` caches the first `SELECT 1` result. `databaseIsReachable` is computed at module load.
- `describeDatabase` is `describe` or `describe.skip`.
- `probe` in the storage helpers also checks Redis with `PING`.
- `describeRedis` is `describe` or `describe.skip`.
- Files register a visible `test.skip("... requires the live database")` placeholder.
- `postgres-payment.test.ts` uses `test.skipIf(!reachable)`.
- The cross-service journey file uses `test.skip(!LIVE, ...)`.

Because the skip decision is made at import time, changing `DATABASE_URL` after import does not re-probe.

### 3.3 Playwright mock fixture

`tests/e2e/fixtures.ts` exports:

- `ADMIN_KEY = "PAYMENT_GATEWAY:ADMIN:USER"` and `MERCHANT_KEY = "PAYMENT_GATEWAY:MERCHANT:USER"`.
- `adminSession` with token `test-admin-token`, role `GATEWAY_ADMIN`, maker flags and a full UI authority map.
- `merchantSession` with token `test-merchant-token`, role `MERCHANT_ADMIN`, merchant id, trade name and a full merchant UI authority map.
- `seedSession(page, key, session)` injects the locale (`en`) and session into `localStorage` via `addInitScript`.
- `mockApi(page, overrides)` installs a `page.route("**/api/v1/**")` handler. It returns an override when a path suffix matches, a realistic stats overview for `/stats/overview`, and `{}` otherwise.
- `geometry(page)` reads `.pg-app-bar`, `.pg-drawer` and `.pg-page` bounding boxes.
- `noHorizontalOverflow(page)` compares `scrollWidth` and `clientWidth`.

The fixture does not sign a JWT, contact a backend, or enforce authorities. It only makes the SPA render.

### 3.4 Playwright configs

| Config | Test directory | Projects | Web servers |
| :--- | :--- | :--- | :--- |
| `playwright.config.ts` | `./e2e` | admin 5101, merchant 5102, checkout 5103 | Three Vite preview servers |
| `playwright.exhaustive.config.ts` | `./e2e/exhaustive` | admin, merchant, checkout, fake-rails 5104, live | Four preview servers |
| `playwright.live.config.ts` | `./e2e-live` | none | None; URLs come from env/defaults |

All configs run headless, one worker, `ignoreHTTPSErrors: true`, `--no-sandbox`, trace off and screenshot only on failure. `PLAYWRIGHT_CHROME_PATH` can override the browser executable. `tests/run-playwright.sh` prepends `/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu` to `LD_LIBRARY_PATH` and calls `bunx playwright test`.

### 3.5 Local all-in-one stack

`scripts/deploy-localhost.sh` is the supported way to create a live local stack. It:

1. Reads `deploy/deploy.env` if present; explicit environment variables win.
2. Checks PostgreSQL on `127.0.0.1:5432` and creates `payment_gateway_monolith` if absent.
3. Generates mTLS certificates if `core-back/certs/core-back.crt` is absent.
4. Runs `migrate-deploy`, `db-seed`, `create-dev-users` and `seedFakeRails.ts`.
5. Builds all four portals.
6. Writes `.local/ecosystem.config.cjs` and starts nine PM2 processes:
   - `pg-core-back` on 4000 (mTLS)
   - `pg-fake-rails-back` on 4104
   - `pg-admin-back` on 4101
   - `pg-merchant-back` on 4102
   - `pg-checkout-back` on 4103
   - `pg-admin-front` on 5101
   - `pg-merchant-front` on 5102
   - `pg-checkout-front` on 5103
   - `pg-fake-rails-front` on 5104
7. Waits for health endpoints, including core over mTLS with the admin client certificate.

Development defaults include `DEV_PASSWORD=DevPassword123!`, fake-rails tester `tester_admin` / `Strong-Tester-Pass-2026!`, JWT/seeder secret `0123456789abcdef0123456789abcdef`, and KMS key `local-payment-gateway-master-key-32chars!`.

The fake-rails service uses `.local/fake-rails-data/fake-rails.sqlite` unless a deployed `shared/data` directory exists. `CORE_INBOUND_BASE_URL` is set to `http://127.0.0.1:4103/api/v1/inbound`.

### 3.6 Cross-service journey fixture

`tests/e2e/exhaustive/full-platform-lifecycle-journeys.spec.ts` defines URL defaults:

- Portals: 5101, 5102, 5103, 5104.
- Backends: 4101, 4102, 4103, 4104.
- Overrides: `E2E_ADMIN_URL`, `E2E_MERCHANT_URL`, `E2E_CHECKOUT_URL`, `E2E_FAKE_RAILS_URL`, `E2E_ADMIN_BACK_URL`, `E2E_MERCHANT_BACK_URL`, `E2E_CHECKOUT_BACK_URL`, `E2E_FAKE_RAILS_BACK_URL`.

The five tests are:

1. Every portal is served (status below 500 and HTML body).
2. Every backend health endpoint answers 200.
3. The fake-rails scenario catalog is refused unauthenticated or returns 200 (401 accepted, proving the guard).
4. A checkout link journey runs only when `E2E_LINK_KEY` is supplied.
5. (The file's remaining lifecycle structure is a single describe block; there is no merchant-onboarding-to-cash-out browser journey.)

`E2E_LIVE=1` is required for the whole describe. `scripts/run-exhaustive-suite.sh` passes `-g "cross-service lifecycle"` only when `E2E_LIVE=1`.

### 3.7 External live-stack spec

`tests/e2e-live/live.spec.ts` targets a deployed host with hard-coded defaults:

| Setting | Default |
| :--- | :--- |
| Admin URL | `https://10.84.183.205:8443` |
| Merchant URL | `https://10.84.183.205:8081` |
| Checkout URL | `https://10.84.183.205:8082` |
| Admin email | `gateway-admin@payment-gateway.internal` |
| Merchant email | `merchant@pgtest.lan` |
| Password | `DeployTest!2026` |
| Finance email | `finance@payment-gateway.internal` |

All are overridable by `PG_ADMIN_URL`, `PG_MERCHANT_URL`, `PG_CHECKOUT_URL`, `PG_ADMIN_EMAIL`, `PG_MERCHANT_EMAIL`, `PG_PASSWORD`, `PG_FINANCE_EMAIL`.

The spec probes http/https for each host, logs in, asserts the shell below the app bar, asserts no scaling transform and no overflow, opens Disputes as finance, creates a gateway through the UI as gateway admin, opens the mobile drawer, and renders the checkout 404 surface.

There is no CI provisioning script for this host, no certificate bootstrap and no cleanup. The credentials are committed defaults, which violates the "no secrets in source" invariant even though they are test credentials.

### 3.8 Test data and cleanup

- Core and storage tests generate unique references with random UUID/run ids and clean their own rows.
- The storage helpers create dedicated schemas for audit/log sandboxes and drop them.
- Fake-rails tests use `/tmp/fake-rails-*` SQLite files and remove `-wal`/`-shm` siblings.
- Playwright tests do not persist data because most APIs are mocked.
- `tests/.gitignore` ignores `node_modules` only; `tests/test-results/.last-run.json` is present in the working tree.

## 4. Contracts and invariants

1. **The test database is separate from the application database.** Use the `_test` database name.
2. **DB-backed suites skip only with a named reason.** Do not convert a failed connection into a silent green pass.
3. **Mock APIs are fixtures, not integration evidence.** A mocked UI suite proves render/layout only.
4. **Live URLs and credentials must come from the environment.** The hard-coded external defaults are a known violation.
5. **The local stack must be reproducible from a clean checkout.** `scripts/deploy-localhost.sh` is the reference.
6. **Fake-rails data is disposable.** Deleting the SQLite file resets the tester catalogue and history.
7. **Playwright is single-worker in every checked-in config.** Parallel UI runs are not supported.

## 5. Data / API / config / deployment surface

### 5.1 Mocked API paths

`mockApi()` intercepts:

- `/api/v1/admin/**`
- `/api/v1/merchant/**`
- `/api/v1/pay/**`
- `/api/v1/**` fallback

The default stats payload includes `attemptsByState`, `unknownBacklog`, `unknownOldestAgeSeconds`, `openCircuitBreakers`, `webhookInboxLagSeconds`, `reconciliationMatchRate`, `approvalQueueAgeing`, `joinRequestSlaBreaches`, `amlSlaBreaches`, `merchantsActive` and `merchantsPending`.

### 5.2 Live stack ports

| Service | Port |
| :--- | ---: |
| core-back | 4000 (HTTPS/mTLS) |
| admin-back | 4101 |
| merchant-back | 4102 |
| checkout-back | 4103 |
| fake-rails-back | 4104 |
| admin-front | 5101 |
| merchant-front | 5102 |
| checkout-front | 5103 |
| fake-rails-front | 5104 |

### 5.3 Test environment variables

`DATABASE_URL`, `POSTGRES_TEST_DATABASE_URL`, `EXHAUSTIVE_DATABASE_URL`, `STORAGE_TEST_DATABASE_URL`, `STORAGE_TEST_REDIS_URL`, `REDIS_URL`, `AUDIT_DATABASE_URL`, `LOG_DATABASE_URL`, `E2E_LIVE`, `E2E_LINK_KEY`, the `E2E_*_URL` family, the `PG_*` family and `PLAYWRIGHT_CHROME_PATH`.

## 6. Operational usage

```bash
# Local database and Redis
createdb -h 127.0.0.1 -p 55432 payment_gateway_monolith_test
redis-server --port 56379 --daemonize yes

# Migrate and run core
cd core-back
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test \
  bun run migrate-deploy
bun test

# Mocked UI
cd tests
bun run test

# Local deployed stack
./scripts/deploy-localhost.sh

# Journeys against the local stack
E2E_LIVE=1 E2E_LINK_KEY=<seeded-link-key> ./scripts/run-exhaustive-suite.sh

# External live smoke
cd tests
PG_ADMIN_URL=... PG_MERCHANT_URL=... PG_CHECKOUT_URL=... \
PG_ADMIN_EMAIL=... PG_MERCHANT_EMAIL=... PG_PASSWORD=... \
bun run test:live
```

## 7. Status and deviations

### Implemented

- Dedicated test database defaults and multiple override variables.
- Database/Redis reachability probes and named skips.
- Admin/merchant session fixture and wildcard API mock.
- Four Playwright configs and a local wrapper.
- Local all-in-one deployment script with health checks.
- Opt-in cross-service health probes.
- External live smoke spec.

### Partial

- The live stack uses HTTP for fake rails and internal service links while the documented deployment example can use HTTPS.
- The cross-service journeys are health probes, not the full onboarding-to-cash-out journey.
- The UI fixtures mock too much to qualify as behaviour tests.
- `tests/.gitignore` does not ignore test results.

### Missing / deferred

- Automated provisioning of the external live host.
- Environment-only credential enforcement (hard-coded defaults remain).
- A seeded-link fixture generator for `E2E_LINK_KEY`.
- Real backend data fixtures for browser journeys.
- Cleanup of live-created gateways.

### Known bugs / risks

- **Security risk:** `tests/e2e-live/live.spec.ts` commits a default password, host IP and internal email addresses. Treat them as compromised test credentials.
- **False-green risk:** `E2E_LIVE` defaults off and `E2E_LINK_KEY` is optional, so the journey suite can be reported as passing with only skipped tests.
- **Environment drift:** the local script uses PostgreSQL 5432 while the core test harness defaults to 55432. The two are separate setups and can confuse operators.
- **Data risk:** the local script can use a deployed fake-rails data directory when one exists, which may mix test history with deployment history.

## 8. Verification and tests

- `core-back/test/setup.ts` and `core-back/test/storage-engine/helpers/db.ts` define the DB defaults.
- `tests/e2e/fixtures.ts` defines the mock session and API fixture.
- `tests/playwright*.config.ts` define the web servers and projects.
- `scripts/deploy-localhost.sh` is executable and was read for this part; it was not run.
- `tests/e2e-live/live.spec.ts` contains the hard-coded defaults.

No test in this part verifies the fixture itself. The fixture is exercised indirectly by every mocked Playwright suite.

## 9. Source references

### Old design sections

- `design/master_exhaustive_test_plan_for_opencode.md` section 10.2.
- `design/master_exhaustive_test_plan_for_opencode.md` section 12.
- `design/master_exhaustive_test_plan_for_opencode.md` section 13.

### Code paths

- `tests/e2e/fixtures.ts`
- `tests/playwright.config.ts`
- `tests/playwright.exhaustive.config.ts`
- `tests/playwright.live.config.ts`
- `tests/run-playwright.sh`
- `tests/e2e-live/live.spec.ts`
- `tests/e2e/exhaustive/full-platform-lifecycle-journeys.spec.ts`
- `scripts/deploy-localhost.sh`
- `core-back/test/setup.ts`
- `core-back/test/exhaustive/_harness.ts`
- `core-back/test/storage-engine/helpers/db.ts`

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03: initial canonical part. Verified against `5a24f6f+working-tree`.

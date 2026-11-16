import { setDefaultTimeout } from "bun:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";
process.env.KMS_MASTER_KEY = process.env.KMS_MASTER_KEY ?? "phase-test-master-key-value";
process.env.MTLS_CA_CERT_PATH = process.env.MTLS_CA_CERT_PATH ?? "./certs/internal-ca.crt";
process.env.MTLS_SERVER_CERT_PATH = process.env.MTLS_SERVER_CERT_PATH ?? "./certs/core-back.crt";
process.env.MTLS_SERVER_KEY_PATH = process.env.MTLS_SERVER_KEY_PATH ?? "./certs/core-back.key";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";

// Queue-wait budgets for the test run (see lib/db/waitBudgets.ts). Production fails fast after 2 to 5 s
// waiting for a connection; the concurrency suites deliberately queue 50 transactions on a small pool, and
// on a busy developer machine the starved event loop crossed those budgets (P2028, "timeout exceeded when
// trying to connect") while PostgreSQL itself was idle. The suites' assertions do not depend on the budget.
process.env.PG_POOL_CONNECT_TIMEOUT_MS = process.env.PG_POOL_CONNECT_TIMEOUT_MS ?? "20000";
process.env.PG_TX_MAX_WAIT_MS = process.env.PG_TX_MAX_WAIT_MS ?? "20000";

// Bun's default per-test limit is 5 s; the live-database concurrency suites run longer on a busy host.
// A real hang or deadlock still fails, after this limit. Override with TEST_TIMEOUT_MS.
setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 30_000));
// v38: the test database deliberately keeps Live and Sandbox rows together,
// so the database-level strict plane fence is disabled here. The fence itself
// is still covered by `test/sandboxPlane.test.ts`, which enables it per
// session. Production databases keep the strict default from the migration.
try {
  const { Pool } = await import("pg");
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1_000 });
    try {
      await pool.query(`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET app.plane_fence_strict = %L', current_database(), 'false'); EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;`);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
} catch {
  // The database may be unavailable in this environment; the suites that need it skip themselves.
}

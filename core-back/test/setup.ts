process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";
process.env.KMS_MASTER_KEY = process.env.KMS_MASTER_KEY ?? "phase-test-master-key-value";
process.env.MTLS_CA_CERT_PATH = process.env.MTLS_CA_CERT_PATH ?? "./certs/internal-ca.crt";
process.env.MTLS_SERVER_CERT_PATH = process.env.MTLS_SERVER_CERT_PATH ?? "./certs/core-back.crt";
process.env.MTLS_SERVER_KEY_PATH = process.env.MTLS_SERVER_KEY_PATH ?? "./certs/core-back.key";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";

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

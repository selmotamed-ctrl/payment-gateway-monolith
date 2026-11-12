process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";
process.env.KMS_MASTER_KEY = process.env.KMS_MASTER_KEY ?? "phase-test-master-key-value";
process.env.MTLS_CA_CERT_PATH = process.env.MTLS_CA_CERT_PATH ?? "./certs/internal-ca.crt";
process.env.MTLS_SERVER_CERT_PATH = process.env.MTLS_SERVER_CERT_PATH ?? "./certs/core-back.crt";
process.env.MTLS_SERVER_KEY_PATH = process.env.MTLS_SERVER_KEY_PATH ?? "./certs/core-back.key";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";

// A developer's core-back/.env points at a deployed stack. The suites build
// their own catalogues and must not inherit its Fake Rails switches, scanner
// mode or execution plane; each suite that needs them sets them explicitly.
for (const key of [
  "FAKE_RAILS_ENABLED",
  "FAKE_RAILS_ALLOW_IN_PRODUCTION",
  "IS_TEST_SERVER",
  "FAKE_RAILS_PUBLIC_BASE_URL",
  "ALLOW_FAKE_RAILS_HOSTS",
  "ALLOW_EMPTY_OUTBOUND_HOST_ALLOWLIST",
  "FAKE_RAILS_ALLOWED_HOSTS",
  "FAKE_RAILS_ALLOWED_CIDRS",
  "FAKE_RAILS_SEEDER_TOKEN",
  "EXECUTION_PLANE",
  "KYB_SCANNER_MODE",
  "KYB_CLAMD_ADDRESS",
  "RUN_SYNTHETIC_HISTORY_SEED",
]) {
  delete process.env[key];
}

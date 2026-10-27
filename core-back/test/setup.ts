process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://admin:admin@127.0.0.1:3306/payment_gateway_monolith";
process.env.KMS_MASTER_KEY = process.env.KMS_MASTER_KEY ?? "phase-test-master-key-value";
process.env.MTLS_CA_CERT_PATH = process.env.MTLS_CA_CERT_PATH ?? "./certs/internal-ca.crt";
process.env.MTLS_SERVER_CERT_PATH = process.env.MTLS_SERVER_CERT_PATH ?? "./certs/core-back.crt";
process.env.MTLS_SERVER_KEY_PATH = process.env.MTLS_SERVER_KEY_PATH ?? "./certs/core-back.key";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";

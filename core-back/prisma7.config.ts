import "dotenv/config";
import { defineConfig } from "prisma/config";

const databaseUrl =
  process.env.DATABASE_URL ??
  "mysql://admin:admin@127.0.0.1:3306/payment_gateway_monolith";

process.env.MTLS_CA_CERT_PATH = "non-of-your-business";
process.env.MTLS_SERVER_CERT_PATH = "non-of-your-business";
process.env.MTLS_SERVER_KEY_PATH = "non-of-your-business";
process.env.KMS_MASTER_KEY = "non-of-your-business";



const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "bun prisma/seed.ts",
  },
  datasource: {
    url: databaseUrl,
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});

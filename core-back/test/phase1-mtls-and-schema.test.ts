import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";

const repositoryRoot = path.join(import.meta.dirname, "..");
const schemaPath = path.join(repositoryRoot, "prisma", "schema.prisma");

process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/payment_gateway";
process.env.KMS_MASTER_KEY =
  process.env.KMS_MASTER_KEY ?? "phase1-test-master-key-value";

const designModelNames = [
  "Merchant",
  "User",
  "Application",
  "Wallet",
  "AccessToken",
  "AccessTokenIp",
  "PaymentLink",
  "PosTerminal",
  "PosScreen",
  "GlAccount",
  "JournalEntry",
  "JournalLine",
  "CommissionProfile",
  "VelocityRule",
  "AmlCase",
  "Adjustment",
  "CashoutRequest",
  "ApprovalRequest",
  "Gateway",
  "GatewayVersion",
  "GatewayEnvironment",
  "GatewayAuth",
  "GatewaySetting",
  "CredentialSet",
  "Asset",
  "Rail",
  "RailField",
  "RailRoute",
  "CryptoProfile",
  "Flow",
  "FlowStep",
  "StepParameter",
  "StepOutput",
  "StatusRule",
  "ErrorMap",
  "ConfirmationChannel",
  "PollPolicy",
  "WidgetDefinition",
  "RedirectDefinition",
  "StatementSource",
  "ManualInstruction",
  "AttemptGroup",
  "PaymentAttempt",
  "AttemptStepLog",
  "InboundEvent",
  "OperatorCase",
  "ReconciliationRun",
  "ReconciliationItem",
  "GatewayHealthSample",
  "DetailChangeLog",
  "AuditLog",
  "UserIdentity",
  "JoinRequest",
  "KybDocument",
  "BeneficialOwner",
  "AmlScreening",
  "AmlScreeningMatch",
  "AmlRule",
  "ReportingRule",
  "RegulatoryReport",
  "Dispute",
  "NotificationTemplate",
  "Notification",
  "PlatformSetting",
  // The durable job queue of the background workers.
  "BackgroundJob",
  // The persisted evidence the 12 go-live gates are evaluated against.
  "GatewayVersionEvidence",
];

describe("prisma schema", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");

  test("declares exactly the 66 design models", () => {
    const modelNames = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map(
      (match) => match[1] as string,
    );
    expect(modelNames.length).toBe(66);
    expect([...modelNames].sort()).toEqual([...designModelNames].sort());
  });

  test("every model carries id, createdAt and updatedAt", () => {
    const modelBlocks = schema.split(/^model\s+/m).slice(1);
    for (const block of modelBlocks) {
      const modelName = block.split(/\s/)[0] as string;
      expect(block).toMatch(/^\s*id\s+\S+\s+@id/m);
      expect(block).toMatch(/^\s*createdAt\s+DateTime\s+@default\(now\(\)\)/m);
      expect(block).toMatch(/^\s*updatedAt\s+DateTime\s+@updatedAt/m);
      expect(modelName.length).toBeGreaterThan(0);
    }
  });

  test("uses MySQL with no floating point money", () => {
    expect(schema).toMatch(/provider\s*=\s*"mysql"/);
    expect(schema).not.toMatch(/\b(Float|Double)\b/);
    const decimalFields = [
      ...schema.matchAll(/^\s*(\w+)\s+Decimal\b[^\n]*$/gm),
    ];
    expect(decimalFields.length).toBeGreaterThan(0);
    for (const field of decimalFields) {
      expect(field[0]).toMatch(/@db\.Decimal\(\d+,\s*\d+\)/);
    }
  });

  test("keeps JSON columns and the domain unique constraints", () => {
    expect(schema).toMatch(/\bJson\b/);
    expect(schema).toMatch(/@@unique\(\[refType, refId\]\)/);
    expect(schema).toMatch(/@@unique\(\[gatewayId, env, externalMerchantId\]\)/);
    expect(schema).toMatch(/@@unique\(\[railId, gatewayId, credentialPolicy\]\)/);
    expect(schema).toMatch(/@@unique\(\[key, scope, version\]\)/);
    expect(schema).toMatch(/@@unique\(\[code, channel, lang, version\]\)/);
    expect(schema).toMatch(/@@unique\(\[kind, identifierNormalized\]\)/);
    expect(schema).toMatch(/@@unique\(\[gatewayId, externalDisputeRef\]\)/);
    expect(schema).toMatch(/@@unique\(\[channelId, dedupeKey\]\)/);
  });
});

type CoreServer = {
  close: (callback?: (error?: Error) => void) => void;
  listen: (port: number, host: string, callback?: () => void) => CoreServer;
  address: () => AddressInfo | string | null;
};

const request = (
  options: {
    port: number;
    path: string;
    clientCertificate?: string;
    clientKey?: string;
  },
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const clientRequest = https.request(
      {
        host: "127.0.0.1",
        port: options.port,
        path: options.path,
        method: "GET",
        ca: [fs.readFileSync(process.env.MTLS_CA_CERT_PATH as string)],
        cert: options.clientCertificate
          ? fs.readFileSync(options.clientCertificate)
          : undefined,
        key: options.clientKey
          ? fs.readFileSync(options.clientKey)
          : undefined,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    clientRequest.on("error", reject);
    clientRequest.end();
  });

describe("core-back mTLS server", () => {
  let server: CoreServer | undefined;
  let port = 0;
  let certificateDirectory = "";

  beforeAll(async () => {
    certificateDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "core-back-phase1-"),
    );
    execFileSync("bun", [path.join(repositoryRoot, "scripts", "generate-mtls-certs.ts")], {
      cwd: repositoryRoot,
      env: { ...process.env, MTLS_CERT_DIR: certificateDirectory },
      stdio: "pipe",
    });

    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ??
      "mysql://admin:admin@127.0.0.1:3306/payment_gateway_monolith";
    process.env.MTLS_CA_CERT_PATH = path.join(
      certificateDirectory,
      "internal-ca.crt",
    );
    process.env.MTLS_SERVER_CERT_PATH = path.join(
      certificateDirectory,
      "core-back.crt",
    );
    process.env.MTLS_SERVER_KEY_PATH = path.join(
      certificateDirectory,
      "core-back.key",
    );
    process.env.KMS_MASTER_KEY =
      process.env.KMS_MASTER_KEY ?? "phase1-test-master-key-value";

    const { createHttpsServer } = await import("../index");
    server = createHttpsServer() as unknown as CoreServer;
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server?.address() as AddressInfo).port;
  });

  afterAll(() => {
    server?.close();
    if (certificateDirectory) {
      fs.rmSync(certificateDirectory, { recursive: true, force: true });
    }
  });

  test("serves the health endpoint over mutual TLS", async () => {
    const response = await request({
      port,
      path: "/health",
      clientCertificate: path.join(certificateDirectory, "admin-back-client.crt"),
      clientKey: path.join(certificateDirectory, "admin-back-client.key"),
    });
    expect(response.status).toBe(200);
  });

  test("allows each edge service on its own channel", async () => {
    const admin = await request({
      port,
      path: "/internal/admin/health",
      clientCertificate: path.join(certificateDirectory, "admin-back-client.crt"),
      clientKey: path.join(certificateDirectory, "admin-back-client.key"),
    });
    expect(admin.status).toBe(200);

    const merchant = await request({
      port,
      path: "/internal/merchant/health",
      clientCertificate: path.join(
        certificateDirectory,
        "merchant-back-client.crt",
      ),
      clientKey: path.join(certificateDirectory, "merchant-back-client.key"),
    });
    expect(merchant.status).toBe(200);

    const checkout = await request({
      port,
      path: "/internal/checkout/health",
      clientCertificate: path.join(
        certificateDirectory,
        "checkout-back-client.crt",
      ),
      clientKey: path.join(certificateDirectory, "checkout-back-client.key"),
    });
    expect(checkout.status).toBe(200);
  });

  test("rejects the checkout-back identity on the admin channel", async () => {
    const response = await request({
      port,
      path: "/internal/admin/health",
      clientCertificate: path.join(
        certificateDirectory,
        "checkout-back-client.crt",
      ),
      clientKey: path.join(certificateDirectory, "checkout-back-client.key"),
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body).code).toBe("FORBIDDEN_SERVICE_IDENTITY");
  });

  test("rejects the admin identity on the checkout channel", async () => {
    const response = await request({
      port,
      path: "/internal/checkout/health",
      clientCertificate: path.join(certificateDirectory, "admin-back-client.crt"),
      clientKey: path.join(certificateDirectory, "admin-back-client.key"),
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body).code).toBe("FORBIDDEN_SERVICE_IDENTITY");
  });

  test("rejects a client without a certificate", async () => {
    await expect(request({ port, path: "/health" })).rejects.toThrow();
  });

  test("keeps the schema version table when patching migrations", async () => {
    const { patchMigrationSql } = await import("../prisma/migrateDev");
    const patched = patchMigrationSql(
      "-- DropTable\nDROP TABLE `schema_versions`;\nCREATE TABLE `sample` (`id` TEXT);",
    );
    expect(patched).not.toContain("DROP TABLE `schema_versions`");
    expect(patched).toContain("CREATE TABLE IF NOT EXISTS `schema_versions`");
    expect(patched).toContain("ON DUPLICATE KEY UPDATE `version`");
    expect(patched).toContain("CREATE TABLE `sample`");
  });

  test("issues the peer certificate common names expected by the guard", async () => {
    const { getPeerCommonName } = await import(
      "../api/middleware/mtlsGuard"
    );
    const socket = {
      authorized: true,
      getPeerCertificate: () => ({
        subject: { CN: "merchant-back" },
      }),
    } as unknown as TLSSocket;
    expect(getPeerCommonName(socket)).toBe("merchant-back");
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { REQUIRED_SCHEMA_VERSION } from "../prisma/schemaVersion";

const repositoryRoot = path.join(import.meta.dirname, "..");
const schemaPath = path.join(repositoryRoot, "prisma", "schema.prisma");

process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.POSTGRES_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";
process.env.KMS_MASTER_KEY =
  process.env.KMS_MASTER_KEY ?? "phase1-test-master-key-value";

const designModelNames = [
  "Merchant",
  "User",
  "MfaChallenge",
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
  "GatewayInquirySchedule",
  "ReconciliationRun",
  "ReconciliationItem",
  "GatewayHealthSample",
  "DetailChangeLog",
  "AuditLog",
  "UserIdentity",
  "JoinRequest",
  "KybDocument",
  "KybRevalidationRequest",
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
  // The PostgreSQL storage engine additions.
  "GlAccountShard",
  // Per-shard (balance, sequence) checkpoints of the sequenced ledger.
  "GlShardCheckpoint",
  // Append-only history of every ledger shard repair.
  "GlShardRepair",
  "SessionRevocation",
  "OutboxEvent",
  "AuditOutbox",
  "BackupCatalogRun",
  "BackupRestoreDrill",
  // CQRS read models.
  "RmMerchantDailyStat",
  "RmRouteDailyVolume",
];

describe("prisma schema", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");

  test("declares exactly the current PostgreSQL model set", () => {
    const modelNames = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map(
      (match) => match[1] as string,
    );
    expect(modelNames.length).toBe(designModelNames.length);
    expect([...modelNames].sort()).toEqual([...designModelNames].sort());
  });

  test("every model has a primary key and valid timestamps", () => {
    const modelBlocks = schema.split(/^model\s+/m).slice(1);
    for (const block of modelBlocks) {
      const modelName = block.split(/\s/)[0] as string;
      expect(block).toMatch(/@id\b|@@id\(/);
      if (/^\s*createdAt\s+DateTime/m.test(block)) {
        expect(block).toMatch(/^\s*createdAt\s+DateTime[^\n]*@default\(now\(\)\)/m);
      }
      if (/^\s*updatedAt\s+DateTime/m.test(block)) {
        expect(block).toMatch(
          /^\s*updatedAt\s+DateTime[^\n]*(@updatedAt|@default\(now\(\)\))/m,
        );
      }
      expect(modelName.length).toBeGreaterThan(0);
    }
  });

  test("uses PostgreSQL with native UUID, BYTEA and no floating point money", () => {
    expect(schema).toMatch(/provider\s*=\s*"postgresql"/);
    expect(schema).not.toMatch(/\b(Float|Double)\b/);
    expect(schema).toMatch(/@db\.Uuid/);
    expect(schema).toMatch(/@db\.ByteA/);
    const decimalFields = [
      ...schema.matchAll(/^\s*(\w+)\s+Decimal\b[^\n]*$/gm),
    ];
    expect(decimalFields.length).toBeGreaterThan(0);
    for (const field of decimalFields) {
      expect(field[0]).toMatch(/@db\.Decimal\(\d+,\s*\d+\)/);
    }
  });

  test("uses only the PostgreSQL migration history", () => {
    const migrationsDirectory = path.join(repositoryRoot, "prisma", "migrations");
    expect(fs.existsSync(migrationsDirectory)).toBe(true);
    expect(fs.existsSync(path.join(repositoryRoot, "prisma", "migrations-mysql-legacy"))).toBe(false);
    const postgresMigrations = fs.readdirSync(migrationsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(postgresMigrations).toContain("20261103000000_postgres18_init");
    expect(postgresMigrations).toContain("20261107090000_shard_sequenced_checkpoints");
    const ordered = [...postgresMigrations].sort();
    // The newest migration adds the durable inbound-event claim lease; the
    // shard-sequenced checkpoint redesign raised the version to 12.
    expect(ordered).toContain("20261107090000_shard_sequenced_checkpoints");
    expect(ordered).toContain("20261107120000_inbound_event_claims");
    // The newest migration adds the ledger query/index optimisation (schema version 16): journal_entries
    // pagination and trigram indexes, covering journal_lines indexes and insert-autovacuum tuning.
    expect(ordered.at(-1)).toBe("20261108150000_ledger_query_and_index_optimization");
    expect(ordered).toContain("20261108100000_session_revocations");
    expect(ordered).toContain("20261108090000_partition_truncate_guard");
    const guard = fs.readFileSync(path.join(migrationsDirectory, "20261108090000_partition_truncate_guard", "migration.sql"), "utf8");
    expect(guard).toContain("pgw_guard_journal_line_partition");
    expect(guard).not.toContain("schema_versions");
    const newest = fs.readFileSync(path.join(migrationsDirectory, ordered.at(-1) as string, "migration.sql"), "utf8");
    expect(newest).toMatch(/UPDATE "schema_versions"\s+SET "version" = 16\b/);
    expect(REQUIRED_SCHEMA_VERSION).toBe(16);
    for (const migration of postgresMigrations) {
      const sql = fs.readFileSync(
        path.join(migrationsDirectory, migration, "migration.sql"),
        "utf8",
      );
      expect(sql).toContain("CREATE");
      expect(sql.toLowerCase()).not.toContain("engine=innodb");
      // MySQL identifier quoting is forbidden in executable SQL; a backtick inside a `--` comment is just prose.
      const executable = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
      expect(executable).not.toContain("`");
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
      process.env.POSTGRES_TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";
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
      '-- DropTable\nDROP TABLE "schema_versions";\nCREATE TABLE "sample" ("id" TEXT);',
    );
    expect(patched).not.toContain('DROP TABLE "schema_versions"');
    expect(patched).toContain('CREATE TABLE IF NOT EXISTS "schema_versions"');
    expect(patched).toContain('ON CONFLICT ("id") DO UPDATE');
    expect(patched).toContain('CREATE TABLE "sample"');
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

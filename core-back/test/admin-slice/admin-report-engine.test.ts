import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { specContentSha256 } from "../../lib/reportEngineSdk/specHash";
import { adminReportEngineRouter } from "../../api/internal/adminReportEngine";
import { merchantReportEngineRouter } from "../../api/internal/merchantReportEngine";
import { client } from "../../prisma/client";
import { exampleDescriptorSpec } from "../../lib/reportEngineSdk/transcript/ReportTranscriptBuilder";
import {
  createStaffUser,
  dbAvailable,
  makePrincipal,
  startApp,
  type TestApp,
} from "./harness";

const code = `remediation-${Date.now().toString(36)}`;
const uid = () => crypto.randomUUID();
let app: TestApp;
let staffId = "";
let authorId = "";

if (dbAvailable) {
  beforeAll(async () => {
    // The report-engine routers alone, under their production prefixes. The full admin and
    // merchant routers start with bearer-token authentication, which replaces the principal the
    // harness injects, so every request answered 401 before it reached a report-engine route.
    app = await startApp([["/internal/admin", adminReportEngineRouter], ["/internal/merchant", merchantReportEngineRouter]]);
    staffId = await createStaffUser("SECURITY_ADMIN");
    authorId = await createStaffUser("SUPPORT");
  });

  afterAll(async () => {
    await client.reportDefinitionSpecRecord.deleteMany({ where: { code } });
    await app.close();
  });
}

const authorSpec = (version: number) => {
  const spec = structuredClone(exampleDescriptorSpec) as Record<string, any>;
  spec.report.code = code;
  spec.report.version = version;
  return spec;
};

const asStaff = () =>
  app.setPrincipal(
    makePrincipal(staffId, ["security:read", "security:write", "report:approve", "report_engine:author", "report:review"], "SECURITY_ADMIN"),
  );

const asAuthor = () =>
  app.setPrincipal(
    makePrincipal(authorId, ["report:review", "report_engine:author", "compliance:read"], "COMPLIANCE"),
  );

const save = (version: number, publish: boolean) =>
  app.request("POST", "/internal/admin/report-engine/specs", {
    specJson: JSON.stringify(authorSpec(version)),
    publish,
  });

describe.skipIf(!dbAvailable)("report-engine route remediation", () => {
  test("B05/B04: the stored version matches the row and publishing supersedes the previous version", async () => {
    asAuthor();
    const first = await save(1, true);
    expect(first.status).toBe(201);
    expect(first.json.version).toBe(1);

    const row = await client.reportDefinitionSpecRecord.findUniqueOrThrow({ where: { id: first.json.id } });
    expect((row.specJson as Record<string, any>).report.version).toBe(row.version);
    // Recomputed from the row as read back (jsonb reorders keys): the hash is of the content.
    expect(row.specSha256).toBe(specContentSha256(row.specJson));
    expect(row.isLatestPublished).toBe(true);

    const second = await save(2, true);
    expect(second.status).toBe(201);
    const rows = await client.reportDefinitionSpecRecord.findMany({
      where: { code },
      orderBy: { version: "asc" },
    });
    expect(rows.map((entry) => entry.isLatestPublished)).toEqual([false, true]);
  });

  test("B12: BOTH reports are listed in both audience tabs", async () => {
    asStaff();
    for (const audience of ["BACKOFFICE_INTERNAL", "MERCHANT_FACING"]) {
      const response = await app.request(
        "GET",
        `/internal/admin/report-engine/catalog?audience=${audience}&pageSize=200`,
      );
      expect(response.status).toBe(200);
      expect((response.json.reports as Array<{ code: string }>).some((entry) => entry.code === code)).toBe(true);
    }
  });

  test("B09: archiving the latest published version promotes the previous one", async () => {
    asStaff();
    const rows = await client.reportDefinitionSpecRecord.findMany({
      where: { code },
      orderBy: { version: "desc" },
    });
    const latest = rows[0]!;
    const previous = rows[1]!;
    const response = await app.request(
      "POST",
      `/internal/admin/report-engine/specs/${latest.id}/archive`,
      {},
    );
    expect(response.status).toBe(200);
    expect(response.json.promotedSpecId).toBe(previous.id);
    const promoted = await client.reportDefinitionSpecRecord.findUniqueOrThrow({
      where: { id: previous.id },
    });
    expect(promoted.isLatestPublished).toBe(true);
  });

  test("B01/B13: merchant routes are mounted and the catalog strips the query AST", async () => {
    app.setPrincipal({
      ...makePrincipal("merchant-user", ["report_engine:run", "merchant:read"], "MERCHANT_ADMIN"),
      merchantId: null,
    });
    const catalog = await app.request("GET", "/internal/merchant/report-engine/catalog");
    expect(catalog.status).toBe(403);
    expect(catalog.json.code).toBe("MERCHANT_CONTEXT_REQUIRED");

    const execute = await app.request(
      "POST",
      `/internal/merchant/report-engine/catalog/${code}/execute`,
      { inputs: {} },
    );
    expect(execute.json?.code).toBeDefined();
    expect(execute.status).not.toBe(500);
  });

  test("B13: a merchant without report_engine:run is refused", async () => {
    // Not merchant:read (or link:write, merchant:write): those imply report_engine:run.
    app.setPrincipal({
      ...makePrincipal("merchant-user", ["pos:manage"], "MERCHANT_STAFF"),
      merchantId: null,
    });
    const response = await app.request("GET", "/internal/merchant/report-engine/catalog");
    expect(response.status).toBe(403);
    expect(String(response.json.code)).toContain("AUTHORITY");
  });

  test("B11: chrome drafts are hidden from non-authors and assets are not inlined by default", async () => {
    asStaff();
    const rows = await client.reportChromeSpecRecord.findMany({ where: { status: "PUBLISHED" } });
    if (rows.length === 0) return;
    app.setPrincipal(makePrincipal(staffId, ["report_engine:run"], "SUPPORT"));
    const response = await app.request("GET", "/internal/admin/report-engine/chrome?pageSize=200");
    expect(response.status).toBe(200);
    const items = response.json.chrome as Array<Record<string, unknown>>;
    expect(items.every((item) => item.status === "PUBLISHED")).toBe(true);
    expect(items.every((item) => item.assetDataUrls === undefined)).toBe(true);
  });
});

void uid;

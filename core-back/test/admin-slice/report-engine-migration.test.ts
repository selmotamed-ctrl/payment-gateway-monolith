import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { adminInternalRouter } from "../../api/internal/admin";
import { assertNoChromeAssetKeyCollision } from "../../api/internal/adminReportEngine";
import { merchantInternalRouter } from "../../api/internal/merchant";
import { client } from "../../prisma/client";
import { exampleDescriptorSpec } from "../../lib/reportEngineSdk/transcript/ReportTranscriptBuilder";
import { REPORT_CHROME_SPEC_VERSION, REPORT_SPEC_VERSION } from "../../lib/reportEngineSdk/version";
import {
  dbAvailable,
  createStaffUser,
  makePrincipal,
  startApp,
  type TestApp,
} from "./harness";

const code = `migration-${Date.now().toString(36)}`;
const chromeCode = `migration-chrome-${Date.now().toString(36)}`;
let app: TestApp;
let staffId = "";
let previousDefaultId: string | null = null;

const reportSpec = () => {
  const spec = structuredClone(exampleDescriptorSpec) as Record<string, any>;
  spec.report.code = code;
  spec.report.version = 1;
  return spec;
};

const chromeSpec = {
  spec_kind: "REPORT_CHROME",
  spec_version: REPORT_CHROME_SPEC_VERSION,
  chrome: {
    code: chromeCode,
    name: "Migration Test Header",
    chrome_type: "HEADER",
    height_mm: 22,
    show_on_first_page: true,
    border_style: "NONE",
  },
  required_assets: [],
  i18n: {
    default_locale: "en",
    locales: { en: { "chrome.test": "Test" }, ar: { "chrome.test": "اختبار" } },
  },
  template: { html: "<div>{{institutionName}}</div>", scoped_css: "", used_variables: ["institutionName"] },
};

const asStaff = () =>
  app.setPrincipal(
    makePrincipal(staffId, [
      "security:read",
      "security:write",
      "report:approve",
      "report_engine:author",
      "report:review",
    ], "SECURITY_ADMIN"),
  );

if (dbAvailable) {
  beforeAll(async () => {
    app = await startApp([adminInternalRouter, merchantInternalRouter], { channelPrefixes: true });
    staffId = await createStaffUser("SECURITY_ADMIN");
  });

  afterAll(async () => {
    await client.reportDefinitionSpecRecord.deleteMany({ where: { code } });
    await client.reportChromeSpecRecord.deleteMany({ where: { code: chromeCode } });
    if (previousDefaultId) {
      await client.reportChromeSpecRecord.updateMany({
        where: { id: previousDefaultId },
        data: { isDefaultGlobal: true },
      });
    }
    await app.close();
  });
}

describe.skipIf(!dbAvailable)("report engine migration safety", () => {
  test("report and chrome asset keys cannot collide", () => {
    const spec = reportSpec() as unknown as Parameters<typeof assertNoChromeAssetKeyCollision>[0];
    spec.required_assets = [
      {
        asset_key: "shared_logo",
        file_name: "logo.png",
        mime_type: "image/png",
        purpose: "VISUAL_IMAGE",
      },
    ];
    const entry = {
      spec: {
        ...chromeSpec,
        required_assets: [
          {
            asset_key: "shared_logo",
            file_name: "logo.png",
            mime_type: "image/png",
            alt_i18n_key: "chrome.test",
          },
        ],
      },
      isDefaultGlobal: false,
      status: "PUBLISHED" as const,
      scope: "PLATFORM" as const,
      version: 1,
    };
    expect(() =>
      assertNoChromeAssetKeyCollision(spec, [entry as never]),
    ).toThrow("Report and header/footer asset keys must be unique");
  });

  test("a version-mismatched report is excluded from the catalog and cannot run", async () => {
    asStaff();
    await client.reportDefinitionSpecRecord.create({
      data: {
        code,
        version: 1,
        category: "FINANCE_LEDGER",
        audienceScope: "BACKOFFICE_INTERNAL",
        status: "PUBLISHED",
        isLatestPublished: true,
        supportedLocales: ["en", "ar"],
        defaultLocale: "en",
        engineVersion: "0.9.0",
        specSchemaVersion: REPORT_SPEC_VERSION,
        specJson: reportSpec() as never,
        specSha256: "a".repeat(64),
        verificationReportJson: {} as never,
        createdByUserId: staffId,
      },
    });

    const catalog = await app.request("GET", "/internal/admin/report-engine/catalog?pageSize=200");
    expect(catalog.status).toBe(200);
    expect((catalog.json.reports as Array<{ code: string }>).some((entry) => entry.code === code)).toBe(false);
    expect(catalog.json.health.brokenReportSpecs).toBeGreaterThan(0);

    const execute = await app.request("POST", `/internal/admin/report-engine/catalog/${code}/execute`, {
      inputs: {},
    });
    expect(execute.status).toBe(409);
    expect(execute.json.code).toBe("REPORT_NEEDS_MIGRATION");

    const migration = await app.request("GET", "/internal/admin/report-engine/specs/needs-migration");
    expect(migration.status).toBe(200);
    const row = (migration.json.specs as Array<Record<string, any>>).find((entry) => entry.code === code);
    expect(row?.compatibility?.status).toBe("NEEDS_MIGRATION");

    const prompt = await app.request("GET", `/internal/admin/report-engine/specs/${row!.id}/migration-prompt`);
    expect(prompt.status).toBe(200);
    expect(String(prompt.json.prompt)).toContain("Report Descriptor Migration");
    expect(String(prompt.json.prompt)).toContain(code);
  });

  test("a broken default header blocks dependent reports and reconciliation clears the default", async () => {
    asStaff();
    const previousDefault = await client.reportChromeSpecRecord.findFirst({
      where: { chromeType: "HEADER", isDefaultGlobal: true, status: "PUBLISHED" },
    });
    previousDefaultId = previousDefault?.id ?? null;
    if (previousDefault) {
      await client.reportChromeSpecRecord.update({
        where: { id: previousDefault.id },
        data: { isDefaultGlobal: false },
      });
    }
    const chrome = await client.reportChromeSpecRecord.create({
      data: {
        code: chromeCode,
        version: 1,
        name: "Migration Test Header",
        chromeType: "HEADER",
        status: "PUBLISHED",
        isDefaultGlobal: true,
        engineVersion: "0.9.0",
        specSchemaVersion: REPORT_CHROME_SPEC_VERSION,
        supportedLocales: ["en", "ar"],
        specJson: chromeSpec as never,
        specSha256: "b".repeat(64),
        createdByUserId: staffId,
      },
    });
    const current = await client.reportDefinitionSpecRecord.findFirstOrThrow({ where: { code } });
    await client.reportDefinitionSpecRecord.update({
      where: { id: current.id },
      data: { engineVersion: "1.0.0", specSchemaVersion: REPORT_SPEC_VERSION },
    });

    const catalog = await app.request("GET", "/internal/admin/report-engine/catalog?pageSize=200");
    expect(catalog.status).toBe(200);
    expect((catalog.json.reports as Array<{ code: string }>).some((entry) => entry.code === code)).toBe(false);

    const execute = await app.request("POST", `/internal/admin/report-engine/catalog/${code}/execute`, { inputs: {} });
    expect(execute.status).toBe(409);
    expect(execute.json.code).toBe("REPORT_CHROME_NEEDS_MIGRATION");

    const noneSpec = reportSpec();
    noneSpec.page_layout.header_mode = "NONE";
    noneSpec.page_layout.footer_mode = "NONE";
    await client.reportDefinitionSpecRecord.update({
      where: { id: current.id },
      data: { specJson: noneSpec as never, engineVersion: "1.0.0", specSchemaVersion: REPORT_SPEC_VERSION },
    });
    const overrideDefault = await app.request("POST", `/internal/admin/report-engine/catalog/${code}/execute`, {
      inputs: {},
      chromeOverride: { headerMode: "GLOBAL_DEFAULT" },
    });
    expect(overrideDefault.status).toBe(409);
    expect(overrideDefault.json.code).toBe("REPORT_CHROME_NEEDS_MIGRATION");

    const overrideSpecific = await app.request("POST", `/internal/admin/report-engine/catalog/${code}/execute`, {
      inputs: {},
      chromeOverride: { headerMode: "SPECIFIC_CHROME_CODE", headerChromeCode: chromeCode },
    });
    expect(overrideSpecific.status).toBe(409);
    expect(overrideSpecific.json.code).toBe("REPORT_CHROME_NEEDS_MIGRATION");

    const chromeMigration = await app.request("GET", "/internal/admin/report-engine/chrome/needs-migration");
    expect(chromeMigration.status).toBe(200);
    expect((chromeMigration.json.specs as Array<{ code: string }>).some((entry) => entry.code === chromeCode)).toBe(true);
    expect(chromeMigration.json.defaults.header).toBe("REVOKED");

    const firstReportPage = await app.request(
      "GET",
      "/internal/admin/report-engine/specs/needs-migration?page=1&pageSize=1",
    );
    expect(firstReportPage.status).toBe(200);
    expect((firstReportPage.json.specs as unknown[]).length).toBeLessThanOrEqual(1);
    expect(Number(firstReportPage.json.total)).toBeGreaterThanOrEqual((firstReportPage.json.specs as unknown[]).length);

    const firstChromePage = await app.request(
      "GET",
      "/internal/admin/report-engine/chrome/needs-migration?page=1&pageSize=1",
    );
    expect(firstChromePage.status).toBe(200);
    expect((firstChromePage.json.specs as unknown[]).length).toBeLessThanOrEqual(1);
    expect(Number(firstChromePage.json.total)).toBeGreaterThanOrEqual((firstChromePage.json.specs as unknown[]).length);

    const reconcile = await app.request("POST", "/internal/admin/report-engine/chrome/reconcile-defaults", {});
    expect(reconcile.status).toBe(200);
    expect(Number(reconcile.json.platformRevoked)).toBeGreaterThan(0);
    const updated = await client.reportChromeSpecRecord.findUniqueOrThrow({ where: { id: chrome.id } });
    expect(updated.isDefaultGlobal).toBe(false);
    expect(updated.defaultRevokedReason).toBe("ENGINE_MAJOR_VERSION_MISMATCH");
    const afterReconcile = await app.request("GET", "/internal/admin/report-engine/chrome/needs-migration");
    expect(afterReconcile.json.defaults.header).toBe("REVOKED");
  });
});

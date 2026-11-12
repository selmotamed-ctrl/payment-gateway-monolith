import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { adminInternalRouter } from "../../api/internal/admin";
import { merchantInternalRouter } from "../../api/internal/merchant";
import { client } from "../../prisma/client";
import { reconcileReportChromeDefaults } from "../../engine/reportStudio/reconcileChromeDefaults";
import { REPORT_CHROME_SPEC_VERSION } from "../../lib/reportEngineSdk/version";
import { dbAvailable, makePrincipal, startApp, type TestApp } from "./harness";

const suffix = Date.now().toString(36);
const merchantId = randomUUID();
const otherMerchantId = randomUUID();
const userId = randomUUID();
const otherUserId = randomUUID();
const code = `brand-header-${suffix}`;
let app: TestApp;
let chromeId = "";

const chromeSpec = {
  spec_kind: "REPORT_CHROME",
  spec_version: REPORT_CHROME_SPEC_VERSION,
  chrome: {
    code,
    name: "Merchant Brand Header",
    chrome_type: "HEADER",
    height_mm: 22,
    show_on_first_page: true,
    border_style: "NONE",
  },
  required_assets: [],
  i18n: {
    default_locale: "en",
    locales: { en: { "chrome.company": "Company" }, ar: { "chrome.company": "الشركة" } },
  },
  template: {
    html: "<div><strong>{{merchantTradeName}}</strong> — {{$rtl}}</div>".replace("{{$rtl}}", "{{$t.chrome.company}}"),
    scoped_css: "",
    used_variables: ["merchantTradeName"],
  },
};

const loginAs = (id: string, tenant: string) =>
  app.setPrincipal({
    ...makePrincipal(id, ["report_engine:author", "report_engine:run"], "MERCHANT_ADMIN"),
    merchantId: tenant,
    sessionChannel: "merchant" as never,
  });

if (dbAvailable) {
  beforeAll(async () => {
    app = await startApp([adminInternalRouter, merchantInternalRouter], { channelPrefixes: true });
    for (const [id, tenant, name] of [
      [userId, merchantId, "Tenant One"],
      [otherUserId, otherMerchantId, "Tenant Two"],
    ] as const) {
      await client.merchant.create({
        data: {
          id: tenant,
          legalName: `${name} LLC`,
          tradeName: name,
          displayName: name,
          onboardingChannel: "SELF_SERVICE",
          country: "LY",
        },
      });
      await client.user.create({
        data: {
          id,
          merchantId: tenant,
          email: `${name.replaceAll(" ", "").toLowerCase()}-${suffix}@example.test`,
          role: "MERCHANT_ADMIN",
          authoritiesMap: { "report_engine:author": true, "report_engine:run": true },
          status: "ACTIVE",
          mfaRequired: false,
        },
      });
    }
  });

  afterAll(async () => {
    await client.merchantReportChromeSpecRecord.deleteMany({ where: { merchantId } });
    // Audit rows are append-only and reference the test users; keep the
    // uniquely-named test users and merchants instead of failing cleanup.
    await app.close();
  });
}

describe.skipIf(!dbAvailable)("merchant-owned chrome", () => {
  test("a merchant can publish a default header and another merchant cannot see it", async () => {
    loginAs(userId, merchantId);
    const created = await app.request("POST", "/internal/merchant/report-engine/studio/chrome", {
      specJson: JSON.stringify(chromeSpec),
      publish: true,
      makeDefault: true,
    });
    expect(created.status).toBe(201);
    chromeId = String(created.json.id);
    expect(created.json.isDefaultForMerchant).toBe(true);

    const own = await app.request("GET", "/internal/merchant/report-engine/studio/chrome?includeAssets=1");
    expect(own.status).toBe(200);
    const rows = own.json.specs as Array<Record<string, any>>;
    expect(rows.some((row) => row.code === code)).toBe(true);
    expect(rows.find((row) => row.code === code)?.compatibility?.status).toBe("COMPATIBLE");

    loginAs(otherUserId, otherMerchantId);
    const other = await app.request("GET", "/internal/merchant/report-engine/studio/chrome");
    expect(other.status).toBe(200);
    expect((other.json.specs as Array<{ code: string }>).some((row) => row.code === code)).toBe(false);
  });

  test("malformed merchant chrome JSON returns 400, not 500", async () => {
    loginAs(userId, merchantId);
    const response = await app.request("POST", "/internal/merchant/report-engine/studio/chrome", {
      specJson: "{not-json",
      publish: false,
    });
    expect(response.status).toBe(400);
    expect(["INVALID_JSON_SYNTAX", "SCHEMA_VALIDATION_ERROR"]).toContain(response.json.code);
  });

  test("a suspended merchant gets a 403 guard response, not a 500", async () => {
    loginAs(userId, merchantId);
    await client.merchantReportStudioStatus.create({
      data: { merchantId, suspendedAt: new Date(), reason: "test suspension" },
    });
    const response = await app.request("GET", "/internal/merchant/report-engine/studio/chrome");
    expect(response.status).toBe(403);
    expect(response.json.code).toBe("MERCHANT_REPORT_STUDIO_SUSPENDED");
    await client.merchantReportStudioStatus.deleteMany({ where: { merchantId } });
  });

  test("an incompatible merchant default is revoked, listed for migration, and produces a prompt", async () => {
    await client.merchantReportChromeSpecRecord.update({
      where: { id: chromeId },
      data: { engineVersion: "0.9.0" },
    });
    loginAs(userId, merchantId);
    const migration = await app.request("GET", "/internal/merchant/report-engine/studio/chrome/needs-migration");
    expect(migration.status).toBe(200);
    const row = (migration.json.specs as Array<Record<string, any>>).find((entry) => entry.code === code);
    expect(row?.compatibility?.status).toBe("NEEDS_MIGRATION");

    const firstPage = await app.request(
      "GET",
      "/internal/merchant/report-engine/studio/chrome/needs-migration?page=1&pageSize=1",
    );
    expect(firstPage.status).toBe(200);
    expect((firstPage.json.specs as unknown[]).length).toBeLessThanOrEqual(1);
    expect(Number(firstPage.json.total)).toBeGreaterThanOrEqual((firstPage.json.specs as unknown[]).length);

    const prompt = await app.request(
      "GET",
      `/internal/merchant/report-engine/studio/chrome/${chromeId}/migration-prompt`,
    );
    expect(prompt.status).toBe(200);
    expect(String(prompt.json.prompt)).toContain("Report Header/Footer Migration");
    expect(String(prompt.json.prompt)).toContain("merchantTradeName");

    const revoked = await reconcileReportChromeDefaults();
    expect(revoked.some((entry) => entry.id === chromeId && entry.subject === "MERCHANT")).toBe(true);
    const updated = await client.merchantReportChromeSpecRecord.findUniqueOrThrow({ where: { id: chromeId } });
    expect(updated.isDefaultForMerchant).toBe(false);
    expect(updated.defaultRevokedAt).not.toBeNull();
    expect(updated.defaultRevokedReason).toBe("ENGINE_MAJOR_VERSION_MISMATCH");
  });
});

import { describe, expect, test } from "bun:test";
import {
  assertMerchantAssetsEnabled,
  invalidateMerchantReportPolicyCache,
  MERCHANT_REPORT_POLICY_KEY,
  readMerchantReportPolicy,
} from "../../engine/reportStudio/merchantReportEngine";

const dbWith = (value: unknown, version = 3) => ({
  platformSetting: {
    findFirst: async () => (value === undefined ? null : { valueJson: value, version }),
  },
});

describe("merchant_reports.policy platform setting", () => {
  test("missing policy keeps the previous behaviour", async () => {
    invalidateMerchantReportPolicyCache();
    const policy = await readMerchantReportPolicy(dbWith(undefined) as never);
    expect(policy).toMatchObject({ enabled: true, assetsEnabled: true, version: null });
  });

  test("staff can disable the line and/or assets", async () => {
    invalidateMerchantReportPolicyCache();
    const disabled = await readMerchantReportPolicy(dbWith({ enabled: false, assetsEnabled: false }) as never);
    expect(disabled).toMatchObject({ enabled: false, assetsEnabled: false, version: 3 });

    invalidateMerchantReportPolicyCache();
    const aliased = await readMerchantReportPolicy(dbWith({ enabled: true, assets_enabled: false }) as never);
    expect(aliased.assetsEnabled).toBe(false);
  });

  test("assertMerchantAssetsEnabled refuses when the policy disables assets", async () => {
    invalidateMerchantReportPolicyCache();
    // Seed the cache through the normal reader; assert reads the cached value.
    await readMerchantReportPolicy(dbWith({ enabled: true, assetsEnabled: false }) as never);
    await expect(assertMerchantAssetsEnabled()).rejects.toMatchObject({
      code: "MERCHANT_REPORT_ASSETS_DISABLED",
    });
    invalidateMerchantReportPolicyCache();
  });

  test("the policy key is the documented platform setting", () => {
    expect(MERCHANT_REPORT_POLICY_KEY).toBe("merchant_reports.policy");
  });
});

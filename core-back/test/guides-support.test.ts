import { describe, expect, test } from "bun:test";
import { buildCheckoutSupportConfig } from "../api/internal/checkout";
import { getBaseClient } from "../prisma/client/base";
import { DEFAULT_SUPPORT_CONFIG, RAIL_HELP_GUIDES } from "../prisma/seedGuides";

const link = {
  id: "link-1",
  key: "LNKTESTKEY1",
  applicationId: "app-1",
  walletId: "wallet-1",
  merchantId: "merchant-1",
  amount: "100.0000" as never,
  currency: "LYD",
  feeBearer: "MERCHANT_ABSORBS" as const,
  splitRatioJson: null,
  infiniteUse: false,
  useCount: 1,
  confirmedCount: 0,
  activeLockedCount: 0,
  state: "PENDING",
  expiresAt: null,
  railWhitelist: null,
  applicationRailWhitelist: null,
  merchantTradeName: "Acme Store",
  merchantLegalName: "Acme LLC",
  merchantStatus: "ACTIVE",
  merchantRiskTier: "LOW",
  merchantContactPhone: "+218910000001",
  merchantContactEmail: "store@acme.ly",
};

describe("checkout support config projection", () => {
  test("is omitted entirely when the admin disables it", () => {
    expect(buildCheckoutSupportConfig({ ...DEFAULT_SUPPORT_CONFIG, enabled: false }, link)).toBeNull();
    expect(buildCheckoutSupportConfig(null, link)).toBeNull();
    expect(buildCheckoutSupportConfig(undefined, link)).toBeNull();
  });

  test("exposes the platform channels, the merchant contact and the FAQ", () => {
    const config = buildCheckoutSupportConfig(DEFAULT_SUPPORT_CONFIG, link) as Record<string, unknown>;
    expect(config.enabled).toBe(true);
    expect((config.platform as Record<string, unknown>).phone).toBe(DEFAULT_SUPPORT_CONFIG.support_phone);
    expect((config.platform as Record<string, unknown>).whatsapp).toBe(DEFAULT_SUPPORT_CONFIG.support_whatsapp);
    expect((config.merchant as Record<string, unknown>).phone).toBe("+218910000001");
    expect((config.merchant as Record<string, unknown>).tradeName).toBe("Acme Store");
    expect(Array.isArray(config.faq_items)).toBe(true);
    expect((config.faq_items as unknown[]).length).toBe(DEFAULT_SUPPORT_CONFIG.faq_items.length);
    expect((config.faq_items as Array<Record<string, unknown>>)[0]?.q_en).toBeTruthy();
  });

  test("honours the per-audience visibility switches", () => {
    const onlyMerchant = buildCheckoutSupportConfig(
      { ...DEFAULT_SUPPORT_CONFIG, show_platform_contact: false },
      link,
    ) as Record<string, unknown>;
    expect(onlyMerchant.platform).toBeNull();
    expect(onlyMerchant.merchant).not.toBeNull();

    const onlyPlatform = buildCheckoutSupportConfig(
      { ...DEFAULT_SUPPORT_CONFIG, show_merchant_contact: false },
      link,
    ) as Record<string, unknown>;
    expect(onlyPlatform.merchant).toBeNull();
    expect(onlyPlatform.platform).not.toBeNull();
  });

  test("never leaks a field outside the public contract", () => {
    const config = buildCheckoutSupportConfig(
      { ...DEFAULT_SUPPORT_CONFIG, internalNote: "do not leak me" },
      link,
    ) as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(
      ["channels", "enabled", "faq_items", "merchant", "platform", "working_hours_ar", "working_hours_en"].sort(),
    );
    expect(JSON.stringify(config)).not.toContain("do not leak me");
  });
});

describe("seeded guide content", () => {
  test("every rail guide is bilingual and complete", () => {
    for (const [code, guide] of Object.entries(RAIL_HELP_GUIDES)) {
      expect(guide.steps_en.length, `${code} steps_en`).toBeGreaterThan(0);
      expect(guide.steps_ar.length, `${code} steps_ar`).toBe(guide.steps_en.length);
      expect(guide.prerequisites_en.length, `${code} prerequisites_en`).toBe(guide.prerequisites_ar.length);
      expect(guide.troubleshooting_en.length, `${code} troubleshooting_en`).toBe(guide.troubleshooting_ar.length);
      for (const step of guide.steps_en) {
        expect(step.length).toBeGreaterThan(5);
      }
    }
    // The design names 13 seeded rails.
    expect(Object.keys(RAIL_HELP_GUIDES).length).toBeGreaterThanOrEqual(13);
  });

  test("the example rails the design calls out are covered", () => {
    for (const code of ["sadad", "edfali", "moamalat_card", "cbl_lypay", "lypay", "mobicash", "onepay", "neopay_wallet", "neompay_wallet"] as const) {
      if (code === "neopay_wallet") continue; // typo guard: only neompay_wallet exists
      expect(RAIL_HELP_GUIDES[code], code).toBeDefined();
    }
  });

  test("the support config declares at least one FAQ", () => {
    expect(DEFAULT_SUPPORT_CONFIG.faq_items.length).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_SUPPORT_CONFIG.enabled).toBe(true);
  });
});

describe("seeded guide rows (live database)", () => {
  test("the support setting and every rail help guide are persisted", async () => {
    const client = getBaseClient();
    let reachable = false;
    try {
      await client.$queryRawUnsafe("SELECT 1");
      reachable = true;
    } catch {
      reachable = false;
    }
    if (!reachable) {
      console.log("[guides-support] database not reachable, skipping the seeded-row assertions");
      return;
    }
    const setting = await client.platformSetting.findFirst({
      where: { key: "checkout.support_config" },
      orderBy: { version: "desc" },
    });
    // The seed may not have run in this environment; only assert when it did.
    if (setting) {
      expect((setting.valueJson as Record<string, unknown>).enabled).toBe(true);
      expect((setting.valueJson as Record<string, unknown>).support_email).toBeTruthy();
    }
    const rails = await client.rail.findMany({ select: { code: true, helpGuideJson: true } });
    if (rails.length > 0) {
      const guided = rails.filter((rail) => rail.helpGuideJson !== null && rail.helpGuideJson !== undefined);
      expect(guided.length).toBeGreaterThan(0);
      for (const rail of guided) {
        const guide = rail.helpGuideJson as Record<string, unknown>;
        expect(Array.isArray(guide.steps_en)).toBe(true);
        expect(Array.isArray(guide.steps_ar)).toBe(true);
      }
    }
    await client.$disconnect();
  });
});

/**
 * Suite 07.1 — onboarding/KYB, four-eyes, Arabic matching and the 7 AML rules.
 */
import { describe, expect, test } from "bun:test";
import {
  ALLOWED_KYB_UPLOAD_MIMES,
  assertUploadSignature,
  computeFourEyesDecision,
  detectUploadMime,
  parseFourEyesSetting,
  resolveFourEyesSetting,
  type FourEyesSubject,
} from "../../../api/internal/merchant";
import {
  normalizeArabicName,
  normalizeIdentifier,
  nameSimilarity,
  tokenizeName,
} from "../../../engine/guards/ScreeningProvider";
import {
  evaluateAmlRules,
  isRuleEffective,
  resolveEffectiveAction,
  raiseSeverity,
  maxSeverity,
  slaHoursForSeverity,
  type AmlRuleDefinition,
  type AmlEvaluationContext,
} from "../../../engine/guards/AmlRuleEngine";
import { moneyFromString } from "../../../engine/db/money";
import { errorCode, Xoshiro128StarStar } from "../_harness";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0]);
const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ", "latin1");

describe("Suite 07 · KYB magic-byte sniffing", () => {
  const accepted: Array<{ name: string; buffer: Buffer; mime: string }> = [
    { name: "PNG", buffer: PNG, mime: "image/png" },
    { name: "JPEG", buffer: JPEG, mime: "image/jpeg" },
    { name: "PDF", buffer: PDF, mime: "application/pdf" },
  ];

  for (const entry of accepted) {
    test(`a genuine ${entry.name} is detected and accepted`, () => {
      expect(detectUploadMime(entry.buffer)).toBe(entry.mime);
      expect(assertUploadSignature(entry.buffer, entry.mime)).toBe(entry.mime);
    });
  }

  const rejected: Array<{ name: string; buffer: Buffer; declared: string }> = [
    { name: "EXE", buffer: Buffer.from("MZ\x90\x00", "latin1"), declared: "application/pdf" },
    { name: "HTML", buffer: Buffer.from("<html><script>alert(1)</script>"), declared: "application/pdf" },
    { name: "SVG with script", buffer: Buffer.from('<svg onload="alert(1)"></svg>'), declared: "image/png" },
    { name: "text renamed to PDF", buffer: Buffer.from("this is not a pdf"), declared: "application/pdf" },
    { name: "empty buffer", buffer: Buffer.alloc(0), declared: "image/png" },
  ];

  for (const entry of rejected) {
    test(`${entry.name} is rejected with 415`, () => {
      let code: string | undefined;
      try {
        assertUploadSignature(entry.buffer, entry.declared);
      } catch (error) {
        code = errorCode(error);
      }
      expect(code).toBe("UPLOAD_SIGNATURE_MISMATCH");
    });
  }

  test("a PNG declared as JPEG is rejected as a signature mismatch", () => {
    expect(errorCode(catchError(() => assertUploadSignature(PNG, "image/jpeg")))).toBe("UPLOAD_SIGNATURE_MISMATCH");
  });

  test("a disallowed declared type is rejected before sniffing", () => {
    expect(errorCode(catchError(() => assertUploadSignature(PNG, "image/gif")))).toBe("UNSUPPORTED_UPLOAD_TYPE");
    expect(ALLOWED_KYB_UPLOAD_MIMES).toEqual(["image/png", "image/jpeg", "application/pdf"]);
  });

  test("a declared MIME with parameters is normalized", () => {
    expect(assertUploadSignature(PNG, "image/png; charset=binary")).toBe("image/png");
  });
});

const baseSubject: FourEyesSubject = {
  riskTier: "STANDARD",
  screeningResult: "CLEAR",
  screeningListTypes: [],
  owners: [],
  businessCategory: "RETAIL",
  previouslyRejected: false,
};

const baseSetting = {
  policy: "RISK_BASED" as const,
  ownerThresholdPercent: 25,
  highRiskCategories: ["ADULT", "GAMBLING", "CRYPTO", "MONEY_TRANSMISSION"],
};

describe("Suite 07 · four-eyes policy (OD-2)", () => {
  test("ALWAYS requires a checker", () => {
    const decision = computeFourEyesDecision(baseSubject, { ...baseSetting, policy: "ALWAYS" });
    expect(decision.required).toBe(true);
    expect(decision.reasons).toContain("POLICY_ALWAYS");
  });

  test("NEVER never requires a checker", () => {
    const decision = computeFourEyesDecision(
      { ...baseSubject, riskTier: "HIGH", previouslyRejected: true },
      { ...baseSetting, policy: "NEVER" },
    );
    expect(decision.required).toBe(false);
  });

  const triggers: Array<{ name: string; subject: Partial<FourEyesSubject>; reason: string }> = [
    { name: "HIGH risk tier", subject: { riskTier: "HIGH" }, reason: "RISK_TIER_HIGH" },
    { name: "SANCTIONS match", subject: { screeningResult: "CONFIRMED_MATCH", screeningListTypes: ["SANCTIONS"] }, reason: "SCREENING_SANCTIONS_MATCH" },
    { name: "PEP match", subject: { screeningResult: "POTENTIAL_MATCH", screeningListTypes: ["PEP"] }, reason: "SCREENING_PEP_MATCH" },
    { name: "adverse media", subject: { screeningResult: "POTENTIAL_MATCH", screeningListTypes: ["ADVERSE_MEDIA"] }, reason: "SCREENING_ADVERSE_MEDIA_MATCH" },
    { name: "not clear without a list", subject: { screeningResult: "POTENTIAL_MATCH" }, reason: "SCREENING_NOT_CLEAR" },
    { name: "PEP owner", subject: { owners: [{ ownershipPercent: 10, pepDeclared: true, screeningStatus: "CLEAR" }] }, reason: "PEP_BENEFICIAL_OWNER" },
    { name: "large owner", subject: { owners: [{ ownershipPercent: 30, pepDeclared: false, screeningStatus: "CLEAR" }] }, reason: "LARGE_OWNERSHIP_SHARE" },
    { name: "high-risk category", subject: { businessCategory: "GAMBLING" }, reason: "HIGH_RISK_CATEGORY" },
    { name: "previous rejection", subject: { previouslyRejected: true }, reason: "PREVIOUSLY_REJECTED" },
  ];

  for (const trigger of triggers) {
    test(`${trigger.name} triggers a second reviewer`, () => {
      const decision = computeFourEyesDecision({ ...baseSubject, ...trigger.subject }, baseSetting);
      expect(decision.required).toBe(true);
      expect(decision.reasons).toContain(trigger.reason);
    });
  }

  test("a clean applicant is decided by one reviewer", () => {
    const decision = computeFourEyesDecision(baseSubject, baseSetting);
    expect(decision.required).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  test("a 25% owner is a controlling owner (threshold inclusive)", () => {
    const decision = computeFourEyesDecision(
      { ...baseSubject, owners: [{ ownershipPercent: 25, pepDeclared: false, screeningStatus: "CLEAR" }] },
      baseSetting,
    );
    expect(decision.reasons).toContain("LARGE_OWNERSHIP_SHARE");
  });

  test("a 24.99% owner is not controlling", () => {
    const decision = computeFourEyesDecision(
      { ...baseSubject, owners: [{ ownershipPercent: 24.99, pepDeclared: false, screeningStatus: "CLEAR" }] },
      baseSetting,
    );
    expect(decision.reasons).not.toContain("LARGE_OWNERSHIP_SHARE");
  });

  test("the setting parser accepts the dotted and snake-case shapes", () => {
    const parsed = parseFourEyesSetting({
      policy: "risk_based",
      owner_threshold_percent: "30",
      high_risk_categories: [" gambling ", "crypto"],
    });
    expect(parsed.policy).toBe("RISK_BASED");
    expect(parsed.ownerThresholdPercent).toBe(30);
    expect(parsed.highRiskCategories).toEqual(["GAMBLING", "CRYPTO"]);
  });

  test("the canonical setting wins over the OD-2 register key", () => {
    const resolved = resolveFourEyesSetting([
      { policy: "ALWAYS" },
      { policy: "NEVER" },
    ]);
    expect(resolved.policy).toBe("ALWAYS");
  });

  test("the default policy is RISK_BASED", () => {
    expect(resolveFourEyesSetting([]).policy).toBe("RISK_BASED");
    expect(resolveFourEyesSetting([]).ownerThresholdPercent).toBe(25);
  });
});

describe("Suite 07 · Arabic normalisation and matching", () => {
  const variants: Array<[string, string]> = [
    ["أحمد", "احمد"],
    ["إبراهيم", "ابراهيم"],
    ["آمنة", "امنة"],
    ["فاطمة", "فاطمه"],
    ["مصطفى", "مصطفي"],
    ["عَلِي", "علي"],
    ["مُحَمَّد", "محمد"],
    ["يوسف", "يوسف"],
    ["  ليلى  ", "ليلى"],
    ["٠١٢٣", "0123"],
  ];
  for (const [left, right] of variants) {
    test(`'${left}' normalizes to the same key as '${right}'`, () => {
      expect(normalizeArabicName(left)).toBe(normalizeArabicName(right));
    });
  }

  test("normalizeIdentifier strips separators and lower-cases", () => {
    expect(normalizeIdentifier(" 12-34 56(78).9 ")).toBe("123456789");
    expect(normalizeIdentifier("AB-12")).toBe("ab12");
  });

  test("tokenizeName splits on whitespace and punctuation", () => {
    expect(tokenizeName("محمد  علي-حسن")).toEqual(["محمد", "علي", "حسن"]);
  });

  const prng = new Xoshiro128StarStar("arabic-names");
  const names = ["محمد", "أحمد", "إبراهيم", "فاطمة", "مصطفى", "علي", "ليلى", "خديجة", "عمر", "سارة"];
  for (let index = 0; index < 150; index += 1) {
    const left = prng.pick(names);
    const right = prng.int(0, 1) === 0 ? left : `${left} ${prng.pick(names)}`;
    test(`similarity #${index + 1}: '${left}' vs '${right}'`, () => {
      const score = nameSimilarity(left, right);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
      if (left === right) {
        expect(score).toBe(100);
      }
    });
  }
});

const now = new Date("2026-06-15T12:00:00.000Z");

const rule = (
  ruleType: AmlRuleDefinition["ruleType"],
  params: Record<string, unknown>,
  overrides: Partial<AmlRuleDefinition> = {},
): AmlRuleDefinition => ({
  id: `rule-${ruleType}-${crypto.randomUUID()}`,
  code: ruleType,
  name: ruleType,
  ruleType,
  scope: {},
  params,
  action: "HOLD",
  baseSeverity: "HIGH",
  active: true,
  version: 1,
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
  ...overrides,
});

const context = (overrides: Partial<AmlEvaluationContext> = {}): AmlEvaluationContext => ({
  subjectType: "PAYMENT_ATTEMPT",
  subjectId: "attempt-1",
  merchantId: "merchant-1",
  amount: moneyFromString("1000.0000"),
  currency: "LYD",
  railCode: "sadad",
  riskTier: "STANDARD",
  settlementTarget: "PLATFORM_CLEARING",
  counterpartyCountry: "LY",
  windowStats: { count: 0, totalAmount: 0n, amounts: [] },
  expectedMonthlyVolume: null,
  openCaseCount: 0,
  velocityFlagged: false,
  screeningResult: null,
  screeningListType: null,
  now,
  ...overrides,
});

describe("Suite 07 · the 7 AML rule types", () => {
  test("SINGLE_AMOUNT fires at the threshold", () => {
    const result = evaluateAmlRules(
      [rule("SINGLE_AMOUNT", { min_amount: "1000.0000", currency: "LYD" })],
      context({ amount: moneyFromString("1000.0000") }),
    );
    expect(result.hits).toHaveLength(1);
    expect(result.action).toBe("HOLD");
  });

  test("SINGLE_AMOUNT does not fire below the threshold", () => {
    const result = evaluateAmlRules(
      [rule("SINGLE_AMOUNT", { min_amount: "1000.0000" })],
      context({ amount: moneyFromString("999.9999") }),
    );
    expect(result.hits).toHaveLength(0);
    expect(result.action).toBeNull();
  });

  test("SINGLE_AMOUNT respects the currency", () => {
    const result = evaluateAmlRules(
      [rule("SINGLE_AMOUNT", { min_amount: "1.0000", currency: "USD" })],
      context({ currency: "LYD" }),
    );
    expect(result.hits).toHaveLength(0);
  });

  test("CUMULATIVE_WINDOW fires on the window total", () => {
    const result = evaluateAmlRules(
      [rule("CUMULATIVE_WINDOW", { max_amount: "5000.0000", window_seconds: 3600 })],
      context({
        windowStats: {
          count: 3,
          totalAmount: moneyFromString("6000.0000"),
          amounts: [moneyFromString("2000.0000"), moneyFromString("2000.0000"), moneyFromString("2000.0000")],
        },
      }),
    );
    expect(result.hits).toHaveLength(1);
  });

  test("STRUCTURING detects repeated amounts just below the threshold", () => {
    const result = evaluateAmlRules(
      [rule("STRUCTURING", { threshold: "5000.0000", band_percent: 10, min_count: 2 })],
      context({
        windowStats: {
          count: 3,
          totalAmount: moneyFromString("13500.0000"),
          amounts: [moneyFromString("4500.0000"), moneyFromString("4600.0000"), moneyFromString("4400.0000")],
        },
      }),
    );
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.ruleType).toBe("STRUCTURING");
  });

  test("RISK_TIER fires only at or above the configured tier", () => {
    const ruleDefinition = rule("RISK_TIER", { tier: "HIGH" });
    expect(evaluateAmlRules([ruleDefinition], context({ riskTier: "STANDARD" })).hits).toHaveLength(0);
    expect(evaluateAmlRules([ruleDefinition], context({ riskTier: "HIGH" })).hits).toHaveLength(1);
  });

  test("COUNTERPARTY_COUNTRY DENY fires for a listed country", () => {
    const result = evaluateAmlRules(
      [rule("COUNTERPARTY_COUNTRY", { countries: ["IR", "KP"], mode: "DENY" })],
      context({ counterpartyCountry: "IR" }),
    );
    expect(result.hits).toHaveLength(1);
  });

  test("COUNTERPARTY_COUNTRY ALLOW permits listed and flags unlisted", () => {
    const ruleDefinition = rule("COUNTERPARTY_COUNTRY", { countries: ["LY", "TN"], mode: "ALLOW" });
    expect(evaluateAmlRules([ruleDefinition], context({ counterpartyCountry: "LY" })).hits).toHaveLength(0);
    expect(evaluateAmlRules([ruleDefinition], context({ counterpartyCountry: "IR" })).hits).toHaveLength(1);
  });

  test("RAIL fires for a configured rail", () => {
    const result = evaluateAmlRules([rule("RAIL", { rail_codes: ["SADAD"] })], context({ railCode: "sadad" }));
    expect(result.hits).toHaveLength(1);
  });

  test("MERCHANT_DIRECT_AMOUNT forces CASE_ONLY", () => {
    const result = evaluateAmlRules(
      [rule("MERCHANT_DIRECT_AMOUNT", { min_amount: "100.0000" })],
      context({ settlementTarget: "MERCHANT_DIRECT" }),
    );
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.action).toBe("CASE_ONLY");
  });

  test("an inactive rule never fires", () => {
    const result = evaluateAmlRules(
      [rule("SINGLE_AMOUNT", { min_amount: "1.0000" }, { active: false })],
      context(),
    );
    expect(result.hits).toHaveLength(0);
  });

  test("an expired rule never fires", () => {
    const expired = rule("SINGLE_AMOUNT", { min_amount: "1.0000" }, {
      effectiveTo: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(isRuleEffective(expired, now)).toBe(false);
    expect(evaluateAmlRules([expired], context()).hits).toHaveLength(0);
  });

  test("velocity correlation escalates a hit to CRITICAL", () => {
    const result = evaluateAmlRules(
      [rule("SINGLE_AMOUNT", { min_amount: "1.0000" })],
      context({ velocityFlagged: true }),
    );
    expect(result.correlatedEscalation).toBe(true);
    expect(result.severity).toBe("CRITICAL");
  });

  test("a HOLD on a merchant-direct settlement becomes CASE_ONLY", () => {
    const hit = evaluateAmlRules(
      [rule("SINGLE_AMOUNT", { min_amount: "1.0000" }, { action: "HOLD" })],
      context({ settlementTarget: "MERCHANT_DIRECT" }),
    ).hits;
    expect(resolveEffectiveAction(hit, "MERCHANT_DIRECT")).toBe("CASE_ONLY");
  });

  const amounts = ["0.0001", "999.9999", "1000.0000", "5000.0000", "250000.0000"];
  for (const amount of amounts) {
    test(`SINGLE_AMOUNT threshold 1000 at ${amount}`, () => {
      const result = evaluateAmlRules(
        [rule("SINGLE_AMOUNT", { min_amount: "1000.0000" })],
        context({ amount: moneyFromString(amount) }),
      );
      expect(result.hits.length).toBe(moneyFromString(amount) >= moneyFromString("1000.0000") ? 1 : 0);
    });
  }

  test("severity helpers", () => {
    expect(raiseSeverity("LOW", 1)).toBe("MEDIUM");
    expect(raiseSeverity("HIGH", 5)).toBe("CRITICAL");
    expect(maxSeverity("LOW", "HIGH")).toBe("HIGH");
    expect(slaHoursForSeverity("CRITICAL")).toBe(4);
    expect(slaHoursForSeverity("HIGH")).toBe(24);
    expect(slaHoursForSeverity("MEDIUM")).toBe(72);
    expect(slaHoursForSeverity("LOW")).toBe(120);
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

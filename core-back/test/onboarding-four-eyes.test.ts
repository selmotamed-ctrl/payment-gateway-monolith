import { describe, expect, test } from "bun:test";
import {
  computeFourEyesDecision,
  DEFAULT_FOUR_EYES_POLICY,
  DEFAULT_HIGH_RISK_CATEGORIES,
  DEFAULT_OWNER_THRESHOLD_PERCENT,
  FOUR_EYES_SETTING_KEYS,
  parseFourEyesSetting,
  resolveFourEyesSetting,
  type FourEyesPolicySetting,
} from "../api/internal/merchant";

/**
 * The setting of the decision register (OD-2) and the setting of the design
 * (`join_request.four_eyes_policy`) carry the same value.
 */
const SEEDED_SETTING = {
  policy: "RISK_BASED",
  description: "Join request four-eyes decisions are selected by risk assessment.",
};

const setting = (overrides: Partial<FourEyesPolicySetting> = {}): FourEyesPolicySetting => ({
  policy: "RISK_BASED",
  ownerThresholdPercent: DEFAULT_OWNER_THRESHOLD_PERCENT,
  highRiskCategories: DEFAULT_HIGH_RISK_CATEGORIES,
  ...overrides,
});

const lowRiskApplicant = {
  riskTier: "LOW",
  screeningResult: "CLEAR",
  screeningListTypes: [] as string[],
  owners: [{ ownershipPercent: "20.00", pepDeclared: false, screeningStatus: "CLEAR" }],
  businessCategory: "RETAIL",
  previouslyRejected: false,
};

describe("the join request four-eyes policy (design §18, OD-2)", () => {
  test("the policy is read from the `policy` field of the setting", () => {
    const parsed = parseFourEyesSetting(SEEDED_SETTING);
    expect(parsed.policy).toBe("RISK_BASED");
  });

  test("the canonical key and the decision register key are both read", () => {
    expect(FOUR_EYES_SETTING_KEYS).toContain("join_request.four_eyes_policy");
    expect(FOUR_EYES_SETTING_KEYS).toContain("OD-2");
  });

  test("the canonical key takes precedence over the decision register key", () => {
    const resolved = resolveFourEyesSetting([
      { policy: "NEVER" },
      SEEDED_SETTING,
    ]);
    expect(resolved.policy).toBe("NEVER");
  });

  test("a deployment without any setting falls back to RISK_BASED", () => {
    expect(resolveFourEyesSetting([]).policy).toBe(DEFAULT_FOUR_EYES_POLICY);
    expect(DEFAULT_FOUR_EYES_POLICY).toBe("RISK_BASED");
  });

  test("a low risk applicant is not forced into four eyes", () => {
    const decision = computeFourEyesDecision(lowRiskApplicant, setting());
    expect(decision.required).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  test("a high risk tier forces a second reviewer", () => {
    const decision = computeFourEyesDecision(
      { ...lowRiskApplicant, riskTier: "HIGH" },
      setting(),
    );
    expect(decision.required).toBe(true);
    expect(decision.reasons).toContain("RISK_TIER_HIGH");
  });

  test("a sanctions match forces a second reviewer", () => {
    const decision = computeFourEyesDecision(
      {
        ...lowRiskApplicant,
        screeningResult: "CONFIRMED_MATCH",
        screeningListTypes: ["SANCTIONS"],
      },
      setting(),
    );
    expect(decision.required).toBe(true);
    expect(decision.reasons).toContain("SCREENING_SANCTIONS_MATCH");
  });

  test("a potential PEP match forces a second reviewer", () => {
    const decision = computeFourEyesDecision(
      {
        ...lowRiskApplicant,
        screeningResult: "POTENTIAL_MATCH",
        screeningListTypes: ["PEP"],
      },
      setting(),
    );
    expect(decision.required).toBe(true);
    expect(decision.reasons).toContain("SCREENING_PEP_MATCH");
  });

  test("an adverse media flag forces a second reviewer", () => {
    const decision = computeFourEyesDecision(
      {
        ...lowRiskApplicant,
        screeningResult: "POTENTIAL_MATCH",
        screeningListTypes: ["ADVERSE_MEDIA"],
      },
      setting(),
    );
    expect(decision.required).toBe(true);
    expect(decision.reasons).toContain("SCREENING_ADVERSE_MEDIA_MATCH");
  });

  test("a controlling beneficial owner forces a second reviewer", () => {
    const decision = computeFourEyesDecision(
      {
        ...lowRiskApplicant,
        owners: [{ ownershipPercent: "50.00", pepDeclared: false, screeningStatus: "CLEAR" }],
      },
      setting(),
    );
    expect(decision.required).toBe(true);
    expect(decision.reasons).toContain("LARGE_OWNERSHIP_SHARE");
  });

  test("a declared PEP owner forces a second reviewer", () => {
    const decision = computeFourEyesDecision(
      {
        ...lowRiskApplicant,
        owners: [{ ownershipPercent: "10.00", pepDeclared: true, screeningStatus: "CLEAR" }],
      },
      setting(),
    );
    expect(decision.required).toBe(true);
    expect(decision.reasons).toContain("PEP_BENEFICIAL_OWNER");
  });

  test("a high risk business category forces a second reviewer", () => {
    const decision = computeFourEyesDecision(
      { ...lowRiskApplicant, businessCategory: "gambling" },
      setting(),
    );
    expect(decision.required).toBe(true);
    expect(decision.reasons).toContain("HIGH_RISK_CATEGORY");
  });

  test("an applicant that was rejected before forces a second reviewer", () => {
    const decision = computeFourEyesDecision(
      { ...lowRiskApplicant, previouslyRejected: true },
      setting(),
    );
    expect(decision.required).toBe(true);
    expect(decision.reasons).toContain("PREVIOUSLY_REJECTED");
  });

  test("the ALWAYS policy always requires a second reviewer", () => {
    const decision = computeFourEyesDecision(lowRiskApplicant, setting({ policy: "ALWAYS" }));
    expect(decision.required).toBe(true);
    expect(decision.reasons).toContain("POLICY_ALWAYS");
  });

  test("the NEVER policy never requires a second reviewer", () => {
    const decision = computeFourEyesDecision(
      { ...lowRiskApplicant, riskTier: "HIGH" },
      setting({ policy: "NEVER" }),
    );
    expect(decision.required).toBe(false);
    expect(decision.reasons).toEqual([]);
  });
});

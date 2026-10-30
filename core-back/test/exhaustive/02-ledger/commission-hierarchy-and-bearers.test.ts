/**
 * Suite 02.2 — commission-profile hierarchy and effective-dating.
 *
 * The real `VisibleRailsResolver.resolveCommissionProfile` is exercised across
 * 15 core precedence scenarios × 20 noise permutations = 300 cases.
 */
import { describe, expect, test } from "bun:test";
import {
  VisibleRailsResolver,
  type CommissionProfileRecord,
} from "../../../engine/flow/VisibleRailsResolver";

const MERCHANT = "merchant-1";
const APPLICATION = "application-1";
const RAIL = "sadad";
const NOW = new Date("2026-06-15T12:00:00.000Z");

const day = (offset: number): string =>
  new Date(NOW.getTime() + offset * 86_400_000).toISOString();

interface Profile extends CommissionProfileRecord {
  id: string;
}

const profile = (
  id: string,
  overrides: Partial<Profile> = {},
): Profile => ({
  id,
  merchantId: MERCHANT,
  applicationId: APPLICATION,
  railCode: RAIL,
  effectiveFrom: day(-30),
  effectiveTo: day(30),
  status: "ACTIVE",
  ...overrides,
});

interface BaseCase {
  label: string;
  profiles: () => Profile[];
  expected: string | undefined;
}

const CASES: readonly BaseCase[] = [
  {
    label: "application > merchant > global",
    profiles: () => [
      profile("app", {}),
      profile("merchant", { applicationId: null }),
      profile("global", { merchantId: null, applicationId: null }),
    ],
    expected: "app",
  },
  {
    label: "merchant profile when no application profile exists",
    profiles: () => [
      profile("merchant", { applicationId: null }),
      profile("global", { merchantId: null, applicationId: null }),
    ],
    expected: "merchant",
  },
  {
    label: "global profile when no merchant profile exists",
    profiles: () => [profile("global", { merchantId: null, applicationId: null })],
    expected: "global",
  },
  {
    label: "default profile catches a rail without a specific profile",
    profiles: () => [profile("default", { merchantId: null, applicationId: null, railCode: "default" })],
    expected: "default",
  },
  {
    label: "no profile at all",
    profiles: () => [],
    expected: undefined,
  },
  {
    label: "expired application profile falls through to merchant",
    profiles: () => [
      profile("app-expired", { effectiveTo: day(-1) }),
      profile("merchant", { applicationId: null }),
    ],
    expected: "merchant",
  },
  {
    label: "future application profile falls through to merchant",
    profiles: () => [
      profile("app-future", { effectiveFrom: day(1) }),
      profile("merchant", { applicationId: null }),
    ],
    expected: "merchant",
  },
  {
    label: "DRAFT application profile falls through to merchant",
    profiles: () => [
      profile("app-draft", { status: "DRAFT" }),
      profile("merchant", { applicationId: null }),
    ],
    expected: "merchant",
  },
  {
    label: "SUPERSEDED merchant profile falls through to global",
    profiles: () => [
      profile("merchant-superseded", { applicationId: null, status: "SUPERSEDED" }),
      profile("global", { merchantId: null, applicationId: null }),
    ],
    expected: "global",
  },
  {
    label: "DRAFT global profile falls through to default",
    profiles: () => [
      profile("global-draft", { merchantId: null, applicationId: null, status: "DRAFT" }),
      profile("default", { merchantId: null, applicationId: null, railCode: "default" }),
    ],
    expected: "default",
  },
  {
    label: "latest effective application profile wins",
    profiles: () => [
      profile("app-old", { effectiveFrom: day(-60) }),
      profile("app-new", { effectiveFrom: day(-2) }),
    ],
    expected: "app-new",
  },
  {
    label: "latest effective merchant profile wins",
    profiles: () => [
      profile("merchant-old", { applicationId: null, effectiveFrom: day(-90) }),
      profile("merchant-new", { applicationId: null, effectiveFrom: day(-9) }),
    ],
    expected: "merchant-new",
  },
  {
    label: "effective_from boundary is inclusive",
    profiles: () => [profile("app-boundary", { effectiveFrom: NOW.toISOString() })],
    expected: "app-boundary",
  },
  {
    label: "effective_to boundary is exclusive",
    profiles: () => [
      profile("app-one-second-left", { effectiveTo: new Date(NOW.getTime() + 1_000).toISOString() }),
      profile("merchant", { applicationId: null }),
    ],
    expected: "app-one-second-left",
  },
  {
    label: "a profile ending exactly now is excluded",
    profiles: () => [
      profile("app-ending-now", { effectiveTo: NOW.toISOString() }),
      profile("merchant", { applicationId: null }),
    ],
    expected: "merchant",
  },
];

const noise = (index: number, core: Profile[]): Profile[] => {
  const participants: Profile[] = [];
  if (index % 2 === 0) {
    participants.push(profile(`noise-other-rail-${index}`, { railCode: "moamalat" }));
  }
  if (index % 3 === 0) {
    participants.push(profile(`noise-other-merchant-${index}`, { merchantId: "merchant-2" }));
  }
  if (index % 5 === 0) {
    participants.push(profile(`noise-other-app-${index}`, { applicationId: "application-2" }));
  }
  if (index % 7 === 0) {
    participants.push(profile(`noise-expired-${index}`, { effectiveTo: day(-2) }));
  }
  if (index % 11 === 0) {
    participants.push(profile(`noise-draft-${index}`, { status: "DRAFT" }));
  }
  return [...participants, ...core];
};

describe("Suite 02 · commission hierarchy & effective dating", () => {
  const resolver = new VisibleRailsResolver();
  const total = CASES.length * 20;

  test(`the hierarchy matrix expands to ${total} cases`, () => {
    expect(total).toBe(300);
  });

  for (const baseCase of CASES) {
    for (let variant = 0; variant < 20; variant += 1) {
      test(`${baseCase.label} · permutation ${variant + 1}`, () => {
        const profiles = noise(variant, baseCase.profiles());
        const resolved = resolver.resolveCommissionProfile(profiles, MERCHANT, APPLICATION, RAIL, NOW);
        expect(resolved?.id).toBe(baseCase.expected);
      });
    }
  }

  test("hierarchical precedence is deterministic for a pinned merchant/application/rail", () => {
    const profiles = [
      profile("global", { merchantId: null, applicationId: null }),
      profile("merchant", { applicationId: null }),
      profile("app", {}),
    ];
    const outcomes = new Set(
      Array.from({ length: 50 }, () =>
        resolver.resolveCommissionProfile(profiles, MERCHANT, APPLICATION, RAIL, NOW)?.id,
      ),
    );
    expect([...outcomes]).toEqual(["app"]);
  });

  test("a profile for another rail never leaks into this rail", () => {
    const profiles = [profile("other", { railCode: "moamalat" })];
    expect(resolver.resolveCommissionProfile(profiles, MERCHANT, APPLICATION, RAIL, NOW)).toBeUndefined();
  });
});

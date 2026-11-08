import { describe, expect, test } from "bun:test";
import { Prisma } from "../generated/prisma/client";
import { commissionForProfile, commissionTiers } from "../api/internal/checkout";

const D = (value: string) => new Prisma.Decimal(value);
const profile = (tiersJson: unknown, extra: Partial<{ minFee: string; maxFee: string | null }> = {}) => ({
  calcType: "TIERED",
  flatFee: D("0"),
  percentageRate: D("0"),
  minFee: D(extra.minFee ?? "0"),
  maxFee: extra.maxFee === undefined || extra.maxFee === null ? null : D(extra.maxFee),
  tiersJson,
}) as never;

describe("commission tiers (admin-created TIERED profiles priced as the minimum fee)", () => {
  const tiers = [
    { upTo: "100.0000", flat: "1.0000" },
    { upTo: "1000.0000", flat: "2.0000", percent: "0.01" },
    { flat: "5.0000", percent: "0.005" },
  ];

  test("commissionTiers accepts the ordered array", () => {
    expect(commissionTiers(tiers)).toEqual(tiers);
  });

  test("commissionTiers repairs the legacy index-keyed object, ordering keys numerically", () => {
    const legacy = { "10": tiers[2]!, "0": tiers[0]!, "2": tiers[1]! };
    expect(commissionTiers(legacy)).toEqual([tiers[0]!, tiers[1]!, tiers[2]!]);
  });

  test("commissionTiers ignores junk safely", () => {
    for (const junk of [null, undefined, "x", 5, [], {}, [1, "a", null], { a: { flat: "1" } }, { "0": 3 }]) {
      expect(Array.isArray(commissionTiers(junk))).toBe(true);
    }
    expect(commissionTiers({ a: { flat: "1" } })).toEqual([]);
    expect(commissionTiers([1, { flat: "1" }, null])).toEqual([{ flat: "1" }]);
  });

  test("an array prices by the first matching tier", () => {
    expect(commissionForProfile(profile(tiers), D("50")).toString()).toBe("1");
    expect(commissionForProfile(profile(tiers), D("500")).toString()).toBe("7"); // 2 + 500 * 0.01
    expect(commissionForProfile(profile(tiers), D("5000")).toString()).toBe("30"); // 5 + 5000 * 0.005
  });

  test("a legacy index-keyed row prices the same as the array (it used to collapse to the minimum fee)", () => {
    const legacy = { "0": tiers[0]!, "1": tiers[1]!, "2": tiers[2]! };
    expect(commissionForProfile(profile(legacy), D("500")).toString()).toBe("7");
    expect(commissionForProfile(profile(legacy, { minFee: "0.5" }), D("5000")).toString()).toBe("30");
  });

  test("min and max fee still clamp the tiered result", () => {
    expect(commissionForProfile(profile(tiers, { minFee: "3" }), D("50")).toString()).toBe("3");
    expect(commissionForProfile(profile(tiers, { maxFee: "10" }), D("5000")).toString()).toBe("10");
  });

  test("with no usable tiers a TIERED profile falls back to its minimum fee (unchanged behaviour)", () => {
    expect(commissionForProfile(profile(undefined, { minFee: "1.5" }), D("500")).toString()).toBe("1.5");
  });
});

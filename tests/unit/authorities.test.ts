import { describe, expect, test } from "vitest";
import { mapHasAllAuthorities, mapHasAuthority } from "@/utils/authorities";

describe("authority helpers", () => {
  const map = { "merchants.read": true, "links.create": true };

  test("no requirement always passes", () => {
    expect(mapHasAuthority(undefined, undefined)).toBe(true);
    expect(mapHasAuthority(undefined, [])).toBe(true);
    expect(mapHasAuthority({}, null)).toBe(true);
  });

  test("a missing map denies a requirement", () => {
    expect(mapHasAuthority(null, ["merchants.read"])).toBe(false);
  });

  test("any-of semantics", () => {
    expect(mapHasAuthority(map, ["merchants.read", "aml.review"])).toBe(true);
    expect(mapHasAuthority(map, ["aml.review", "profit.read"])).toBe(false);
  });

  test("all-of semantics", () => {
    expect(mapHasAllAuthorities(map, ["merchants.read", "links.create"])).toBe(true);
    expect(mapHasAllAuthorities(map, ["merchants.read", "aml.review"])).toBe(false);
  });
});

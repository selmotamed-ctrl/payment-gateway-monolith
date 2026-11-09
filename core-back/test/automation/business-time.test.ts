import { describe, expect, test } from "bun:test";
import { businessHoursBetween, isBusinessDay, localClock, parseHolidays } from "../../engine/workers/deadlines/businessTime";

// Tripoli is UTC+2 all year. 2030-06-02 is a Sunday.
const at = (iso: string): Date => new Date(iso);

describe("Libyan business time", () => {
  test("Sunday to Thursday are business days, Friday and Saturday are not", () => {
    const week = ["2030-06-02", "2030-06-03", "2030-06-04", "2030-06-05", "2030-06-06", "2030-06-07", "2030-06-08"];
    const flags = week.map((day) => isBusinessDay(localClock(at(`${day}T10:00:00Z`))));
    expect(flags).toEqual([true, true, true, true, true, false, false]);
  });

  test("the local day starts at 22:00Z the evening before", () => {
    expect(localClock(at("2030-06-01T22:00:00Z"))).toMatchObject({ date: "2030-06-02", weekday: 0, minutes: 0 });
    expect(localClock(at("2030-06-02T21:59:00Z"))).toMatchObject({ date: "2030-06-02", minutes: 23 * 60 + 59 });
  });

  test("hours on a business day count in full", () => {
    expect(businessHoursBetween(at("2030-06-02T06:00:00Z"), at("2030-06-02T18:00:00Z"))).toBeCloseTo(12, 6);
    expect(businessHoursBetween(at("2030-06-02T06:00:00Z"), at("2030-06-03T06:00:00Z"))).toBeCloseTo(24, 6);
  });

  test("a request that spans the weekend only counts the business hours", () => {
    // Thursday 2030-06-06 20:00 local (18:00Z) to Sunday 2030-06-09 08:00 local (06:00Z):
    // Thursday 20:00-24:00 = 4 h, Fri/Sat = 0, Sunday 00:00-08:00 = 8 h.
    expect(businessHoursBetween(at("2030-06-06T18:00:00Z"), at("2030-06-09T06:00:00Z"))).toBeCloseTo(12, 6);
    // entirely inside the weekend
    expect(businessHoursBetween(at("2030-06-07T00:00:00Z"), at("2030-06-08T12:00:00Z"))).toBe(0);
  });

  test("a holiday removes its day", () => {
    const holidays = parseHolidays(["2030-06-03", "bad", 5, "2030-6-4"]);
    expect([...holidays]).toEqual(["2030-06-03"]);
    // Sunday 06:00Z to Tuesday 06:00Z = 48 h, minus Monday (24 h)
    expect(businessHoursBetween(at("2030-06-02T06:00:00Z"), at("2030-06-04T06:00:00Z"), { holidays })).toBeCloseTo(24, 6);
  });

  test("zero or negative spans are zero, and the walk is bounded", () => {
    expect(businessHoursBetween(at("2030-06-02T06:00:00Z"), at("2030-06-02T06:00:00Z"))).toBe(0);
    expect(businessHoursBetween(at("2030-06-03T06:00:00Z"), at("2030-06-02T06:00:00Z"))).toBe(0);
    expect(businessHoursBetween(at("2020-01-01T00:00:00Z"), at("2030-01-01T00:00:00Z"))).toBeGreaterThan(0); // does not hang
  });
});

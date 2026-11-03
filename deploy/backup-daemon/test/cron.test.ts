import { describe, expect, test } from "bun:test";
import { isValidCronExpression, nextCronRun, parseCron, parseCronField } from "../src/cron";

const bounds = { min: 0, max: 59, name: "minute" };

describe("cron field parser", () => {
  test("supports wildcards, steps, ranges, lists and range steps", () => {
    expect(parseCronField("*", bounds)).toEqual(Array.from({ length: 60 }, (_, index) => index));
    expect(parseCronField("*/15", bounds)).toEqual([0, 15, 30, 45]);
    expect(parseCronField("1,3,5", bounds)).toEqual([1, 3, 5]);
    expect(parseCronField("5-10", bounds)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(parseCronField("5-11/3", bounds)).toEqual([5, 8, 11]);
    expect(parseCronField("50/5", bounds)).toEqual([50, 55]);
  });

  test("normalizes day-of-week 7 to Sunday 0", () => {
    expect(parseCron("0 2 * * 0").daysOfWeek).toEqual([0]);
    expect(parseCron("0 2 * * 7").daysOfWeek).toEqual([0]);
    expect(parseCron("0 2 * * 1-7").daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("rejects malformed or out-of-range expressions", () => {
    expect(() => parseCron("60 * * * *")).toThrow();
    expect(() => parseCron("* 24 * * *")).toThrow();
    expect(() => parseCron("* * 0 * *")).toThrow();
    expect(() => parseCron("* * * 13 *")).toThrow();
    expect(() => parseCron("* * * * 8")).toThrow();
    expect(() => parseCron("*/0 * * * *")).toThrow();
    expect(() => parseCron("10-5 * * * *")).toThrow();
    expect(() => parseCron("0 2 * *")).toThrow();
    expect(isValidCronExpression("0 2 * * 0")).toBe(true);
    expect(isValidCronExpression("0 2 * * nope")).toBe(false);
  });
});

describe("next cron run", () => {
  test("steps through minutes and is strictly after the base time", () => {
    expect(nextCronRun("*/15 * * * *", new Date("2026-11-03T12:07:45.000Z")).toISOString()).toBe(
      "2026-11-03T12:15:00.000Z",
    );
    expect(nextCronRun("*/15 * * * *", new Date("2026-11-03T12:15:00.000Z")).toISOString()).toBe(
      "2026-11-03T12:30:00.000Z",
    );
  });

  test("handles lists of hours and minutes", () => {
    expect(nextCronRun("5,10 1,2 * * *", new Date("2026-11-03T01:07:00.000Z")).toISOString()).toBe(
      "2026-11-03T01:10:00.000Z",
    );
    expect(nextCronRun("5,10 1,2 * * *", new Date("2026-11-03T01:10:00.000Z")).toISOString()).toBe(
      "2026-11-03T02:05:00.000Z",
    );
  });

  test("skips weekends for weekday ranges", () => {
    expect(nextCronRun("0 9-17 * * 1-5", new Date("2026-11-06T18:00:00.000Z")).toISOString()).toBe(
      "2026-11-09T09:00:00.000Z",
    );
  });

  test("treats both 0 and 7 as Sunday", () => {
    const saturday = new Date("2026-10-31T12:00:00.000Z");
    expect(nextCronRun("0 2 * * 0", saturday).toISOString()).toBe("2026-11-01T02:00:00.000Z");
    expect(nextCronRun("0 2 * * 7", saturday).toISOString()).toBe("2026-11-01T02:00:00.000Z");
    expect(nextCronRun("0 2 * * 0", new Date("2026-11-01T03:00:00.000Z")).toISOString()).toBe(
      "2026-11-08T02:00:00.000Z",
    );
  });

  test("crosses month and year boundaries", () => {
    expect(nextCronRun("0 0 1 * *", new Date("2026-01-31T23:59:30.000Z")).toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );
    expect(nextCronRun("30 23 31 12 *", new Date("2026-12-31T23:00:00.000Z")).toISOString()).toBe(
      "2026-12-31T23:30:00.000Z",
    );
    expect(nextCronRun("30 23 31 12 *", new Date("2026-12-31T23:31:00.000Z")).toISOString()).toBe(
      "2027-12-31T23:30:00.000Z",
    );
  });
});

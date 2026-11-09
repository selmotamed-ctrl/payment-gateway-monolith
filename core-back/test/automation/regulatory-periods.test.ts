/**
 * AUTO-16 reporting periods and due dates in Africa/Tripoli (UTC+2, no daylight saving): month, quarter and year
 * roll-over, the business-day batches (a Thursday batch holds the weekend), holiday handling and business-day lead.
 */
import { describe, expect, test } from "bun:test";
import {
  addLocalDays,
  businessDayBatches,
  closedPeriods,
  dueAfterBatch,
  dueAfterPeriod,
  localDate,
  minusBusinessDays,
  startOfLocalDay,
} from "../../engine/workers/regulatory/periods";

const iso = (date: Date): string => date.toISOString();

describe("local day boundaries", () => {
  test("a local midnight in Tripoli is 22:00 UTC of the day before", () => {
    expect(iso(startOfLocalDay("2026-11-01"))).toBe("2026-10-31T22:00:00.000Z");
    expect(iso(startOfLocalDay("2026-01-01"))).toBe("2025-12-31T22:00:00.000Z");
    expect(localDate(new Date("2026-10-31T22:00:00.000Z"))).toBe("2026-11-01");
    expect(localDate(new Date("2026-10-31T21:59:59.000Z"))).toBe("2026-10-31");
  });

  test("date arithmetic crosses months and years", () => {
    expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addLocalDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addLocalDays("2028-03-01", -1)).toBe("2028-02-29");
  });
});

describe("closed periods", () => {
  test("months: the last two closed months and their keys, boundaries at local midnight", () => {
    const periods = closedPeriods("MONTHLY", new Date("2026-11-09T10:00:00.000Z"), 2);
    expect(periods.map((p) => p.key)).toEqual(["2026-10", "2026-09"]);
    expect(iso(periods[0]!.start)).toBe("2026-09-30T22:00:00.000Z");
    expect(iso(periods[0]!.end)).toBe("2026-10-31T22:00:00.000Z");
    expect(iso(periods[1]!.end)).toBe(iso(periods[0]!.start));
  });

  test("a month closes at local midnight, not at UTC midnight", () => {
    // 21:59 UTC on 31 Oct = 23:59 local: October is still running
    expect(closedPeriods("MONTHLY", new Date("2026-10-31T21:59:59.000Z"), 1).map((p) => p.key)).toEqual(["2026-09"]);
    // 22:00 UTC on 31 Oct = 00:00 local on 1 Nov: October is closed
    expect(closedPeriods("MONTHLY", new Date("2026-10-31T22:00:00.000Z"), 1).map((p) => p.key)).toEqual(["2026-10"]);
  });

  test("month roll-over across a year boundary", () => {
    const periods = closedPeriods("MONTHLY", new Date("2027-01-15T10:00:00.000Z"), 2);
    expect(periods.map((p) => p.key)).toEqual(["2026-12", "2026-11"]);
    expect(iso(periods[0]!.end)).toBe("2026-12-31T22:00:00.000Z");
  });

  test("quarters, including Q4 into the next year and the first quarter looking back", () => {
    const q = closedPeriods("QUARTERLY", new Date("2026-11-09T10:00:00.000Z"), 2);
    expect(q.map((p) => p.key)).toEqual(["2026-Q3", "2026-Q2"]);
    expect(iso(q[0]!.start)).toBe("2026-06-30T22:00:00.000Z");
    expect(iso(q[0]!.end)).toBe("2026-09-30T22:00:00.000Z");
    const early = closedPeriods("QUARTERLY", new Date("2027-02-10T10:00:00.000Z"), 2);
    expect(early.map((p) => p.key)).toEqual(["2026-Q4", "2026-Q3"]);
    expect(iso(early[0]!.end)).toBe("2026-12-31T22:00:00.000Z");
  });

  test("years", () => {
    const y = closedPeriods("ANNUAL", new Date("2027-01-02T10:00:00.000Z"), 2);
    expect(y.map((p) => p.key)).toEqual(["2026", "2025"]);
    expect(iso(y[0]!.start)).toBe("2025-12-31T22:00:00.000Z");
    expect(iso(y[0]!.end)).toBe("2026-12-31T22:00:00.000Z");
    // on 31 Dec local the year is still open
    expect(closedPeriods("ANNUAL", new Date("2026-12-30T10:00:00.000Z"), 1).map((p) => p.key)).toEqual(["2025"]);
  });

  test("periods tile without gaps or overlaps", () => {
    for (const period of ["MONTHLY", "QUARTERLY", "ANNUAL"] as const) {
      const list = closedPeriods(period, new Date("2029-06-15T10:00:00.000Z"), 5);
      for (let index = 0; index < list.length - 1; index += 1) {
        expect(iso(list[index]!.start)).toBe(iso(list[index + 1]!.end));
      }
    }
  });
});

describe("filing due dates", () => {
  test("PSP-M is due at the end of the 10th of the following month, AML-Q 15 days after quarter end, AML-A at the end of 31 January", () => {
    const month = closedPeriods("MONTHLY", new Date("2026-11-09T10:00:00.000Z"), 1)[0]!;
    expect(iso(dueAfterPeriod(month.end, 10))).toBe("2026-11-10T22:00:00.000Z"); // 11 Nov 00:00 local
    const quarter = closedPeriods("QUARTERLY", new Date("2026-11-09T10:00:00.000Z"), 1)[0]!;
    expect(iso(dueAfterPeriod(quarter.end, 15))).toBe("2026-10-15T22:00:00.000Z"); // 16 Oct 00:00 local
    const year = closedPeriods("ANNUAL", new Date("2027-01-02T10:00:00.000Z"), 1)[0]!;
    expect(iso(dueAfterPeriod(year.end, 31))).toBe("2027-01-31T22:00:00.000Z"); // 1 Feb 00:00 local
  });
});

describe("business-day batches (Sunday to Thursday)", () => {
  // 2026-11-08 is a Sunday; 2026-11-05 is a Thursday
  test("Sunday morning: the complete batches are Thursday (with the weekend), Wednesday and Tuesday", () => {
    const batches = businessDayBatches(new Date("2026-11-08T06:00:00.000Z"), 3);
    expect(batches.map((b) => b.key)).toEqual(["2026-11-05", "2026-11-04", "2026-11-03"]);
    // Thursday's batch ends at Sunday's local midnight, so it holds Friday and Saturday
    expect(iso(batches[0]!.start)).toBe("2026-11-04T22:00:00.000Z");
    expect(iso(batches[0]!.end)).toBe("2026-11-07T22:00:00.000Z");
    expect(iso(batches[1]!.end)).toBe(iso(batches[0]!.start));
  });

  test("a batch is not complete before the next business day starts", () => {
    // Saturday: Thursday's batch is not complete until Sunday 00:00 local
    const saturday = businessDayBatches(new Date("2026-11-07T10:00:00.000Z"), 1);
    expect(saturday.map((b) => b.key)).toEqual(["2026-11-04"]);
    const sundayJustAfter = businessDayBatches(new Date("2026-11-07T22:00:00.000Z"), 1);
    expect(sundayJustAfter.map((b) => b.key)).toEqual(["2026-11-05"]);
  });

  test("a holiday joins the previous business day's batch", () => {
    const holidays = new Set(["2026-11-03"]); // Tuesday
    const batches = businessDayBatches(new Date("2026-11-05T10:00:00.000Z"), 2, { holidays });
    expect(batches.map((b) => b.key)).toEqual(["2026-11-04", "2026-11-02"]);
    // Monday's batch runs to Wednesday's midnight (Tuesday is a holiday)
    expect(iso(batches[1]!.end)).toBe("2026-11-03T22:00:00.000Z");
  });

  test("the batch due date is the end of the next business day", () => {
    const batch = businessDayBatches(new Date("2026-11-08T06:00:00.000Z"), 1)[0]!; // Thursday's, closes Sunday 00:00
    expect(iso(dueAfterBatch(batch.end))).toBe("2026-11-08T22:00:00.000Z"); // end of Sunday 8 Nov
    const holidayDue = dueAfterBatch(batch.end, { holidays: new Set(["2026-11-08"]) });
    expect(iso(holidayDue)).toBe("2026-11-09T22:00:00.000Z"); // Sunday is a holiday: end of Monday
  });
});

describe("business-day lead", () => {
  test("three business days before a Sunday due date lands on the Tuesday before (the weekend is skipped)", () => {
    const due = startOfLocalDay("2026-11-08"); // Sunday 00:00 local
    expect(localDate(minusBusinessDays(due, 3))).toBe("2026-11-03");
    expect(localDate(minusBusinessDays(due, 1))).toBe("2026-11-05");
    expect(localDate(minusBusinessDays(due, 0))).toBe("2026-11-08");
  });

  test("holidays are skipped too", () => {
    const due = startOfLocalDay("2026-11-08");
    expect(localDate(minusBusinessDays(due, 3, { holidays: new Set(["2026-11-04"]) }))).toBe("2026-11-02");
  });
});

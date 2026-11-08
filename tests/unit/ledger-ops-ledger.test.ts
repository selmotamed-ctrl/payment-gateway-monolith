import { describe, expect, test } from "vitest";
import {
  checkpointLag,
  entryTotalsOf,
  flipToNatural,
  isDebitNatural,
  journalReferenceTarget,
  naturalEffect,
  summarizeLines,
  tAccountSides,
} from "../../admin-front/src/components/ledger/journalModel";
import { isValidReason, normalizeReason } from "../../admin-front/src/components/ledger/mutationReason";
import { buildCapViews, capTone, toCapView } from "../../admin-front/src/pages/finance/liquidity/routeCaps";

describe("journal model", () => {
  test("a balanced entry has equal debit and credit totals", () => {
    const totals = summarizeLines([
      { direction: "DEBIT", amount: "10.5000" },
      { direction: "CREDIT", amount: "10.5" },
    ]);
    expect(totals).toMatchObject({ lineCount: 2, totalDebit: "10.5000", totalCredit: "10.5000", difference: "0.0000", balanced: true });
  });

  test("an entry without lines is broken, an off-balance entry reports the difference", () => {
    expect(summarizeLines([]).balanced).toBe(false);
    const totals = summarizeLines([
      { direction: "DEBIT", amount: "10" },
      { direction: "CREDIT", amount: "9.9999" },
    ]);
    expect(totals.balanced).toBe(false);
    expect(totals.difference).toBe("0.0001");
  });

  test("decimal arithmetic never drifts like floating point", () => {
    const totals = summarizeLines([
      { direction: "DEBIT", amount: "0.1" },
      { direction: "DEBIT", amount: "0.2" },
      { direction: "CREDIT", amount: "0.3" },
    ]);
    expect(totals.balanced).toBe(true);
  });

  test("natural balance flips only credit-natural account types", () => {
    expect(isDebitNatural("TREASURY")).toBe(true);
    expect(isDebitNatural("MERCHANT_WALLET")).toBe(false);
    expect(flipToNatural("MERCHANT_WALLET", "-100")).toBe("100.0000");
    expect(flipToNatural("TREASURY", "50")).toBe("50.0000");
    expect(flipToNatural("MERCHANT_WALLET", "0")).toBe("0.0000");
    expect(flipToNatural(null, null)).toBe("0.0000");
  });

  test("a posting grows the natural balance only on the natural side", () => {
    expect(naturalEffect("TREASURY", "DEBIT", "5")).toBe("5.0000");
    expect(naturalEffect("TREASURY", "CREDIT", "5")).toBe("-5.0000");
    expect(naturalEffect("MERCHANT_WALLET", "CREDIT", "5")).toBe("5.0000");
    expect(naturalEffect("MERCHANT_WALLET", "DEBIT", "5")).toBe("-5.0000");
  });

  test("T-account sides carry the amount on exactly one side", () => {
    expect(tAccountSides({ direction: "DEBIT", amount: "7" })).toEqual({ debit: "7.0000", credit: null });
    expect(tAccountSides({ direction: "CREDIT", amount: "7" })).toEqual({ debit: null, credit: "7.0000" });
  });

  test("server totals win, but a missing or false balanced flag never reads as balanced", () => {
    const lines = [
      { direction: "DEBIT" as const, amount: "5" },
      { direction: "CREDIT" as const, amount: "5" },
    ];
    expect(entryTotalsOf({ totalDebit: "5", totalCredit: "5", balanced: true, lines }).balanced).toBe(true);
    expect(entryTotalsOf({ totalDebit: "5", totalCredit: "5", balanced: false, lines }).balanced).toBe(false);
    expect(entryTotalsOf({ lines }).balanced).toBe(true);
    expect(entryTotalsOf({ totalDebit: "5", totalCredit: "4", balanced: true, lines }).balanced).toBe(false);
  });

  test("only references with an open-by-id page become links", () => {
    expect(journalReferenceTarget({ route: "attempt", id: "a1" })).toEqual({ kind: "link", location: { name: "Transactions", query: { open: "a1" } } });
    expect(journalReferenceTarget({ route: "adjustment", id: "j1" })).toEqual({ kind: "link", location: { name: "Adjustments", query: { open: "j1" } } });
    expect(journalReferenceTarget({ route: "settlement", id: "s1" })).toEqual({ kind: "plain" });
    expect(journalReferenceTarget({ route: "attempt", id: "  " })).toEqual({ kind: "plain" });
    expect(journalReferenceTarget(null)).toEqual({ kind: "plain" });
  });

  test("checkpoint lag is what was posted since the last rollup", () => {
    expect(checkpointLag("110", "100")).toEqual({ lag: "10.0000", inSync: false });
    expect(checkpointLag("100", "100.0000")).toEqual({ lag: "0.0000", inSync: true });
    expect(checkpointLag(undefined, "5").lag).toBe("-5.0000");
  });
});

describe("mutation reason", () => {
  test("requires 10 to 500 trimmed characters", () => {
    expect(isValidReason("short")).toBe(false);
    expect(isValidReason("   too short ")).toBe(false);
    expect(isValidReason("long enough reason")).toBe(true);
    expect(isValidReason("x".repeat(501))).toBe(false);
    expect(normalizeReason("  hello  ")).toBe("hello");
    expect(normalizeReason(null)).toBe("");
  });
});

describe("route cap utilisation", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    routeId: "r1",
    railCode: "CARD",
    gatewayId: "g1",
    dailyCapAmount: "1000.0000",
    dailyProcessedAmount: "850.0000",
    dailyCapRemaining: "150.0000",
    capExhausted: false,
    exclusionReason: null,
    utilisation: "85.00",
    ...overrides,
  });

  test("tones follow the 80 and 100 percent thresholds", () => {
    expect(capTone(10, false)).toBe("success");
    expect(capTone(80, false)).toBe("warning");
    expect(capTone(100, false)).toBe("danger");
    expect(capTone(null, false)).toBe("neutral");
    expect(capTone(10, true)).toBe("danger");
  });

  test("a capped route shows its utilisation and remaining headroom", () => {
    const view = toCapView(row());
    expect(view).toMatchObject({ capped: true, cap: "1000.0000", processed: "850.0000", remaining: "150.0000", barPercent: 85, utilisationLabel: "85%", exhausted: false, tone: "warning" });
  });

  test("an exceeded cap clamps the bar but keeps the real figure and the exceeded flag", () => {
    const view = toCapView(row({ dailyProcessedAmount: "1200.0000", dailyCapRemaining: "0.0000", capExhausted: true, exclusionReason: "DAILY_CAP_EXCEEDED", utilisation: "120.00" }));
    expect(view.barPercent).toBe(100);
    expect(view.utilisationLabel).toBe("120%");
    expect(view.exhausted).toBe(true);
    expect(view.tone).toBe("danger");
  });

  test("utilisation is computed when the server omits it, and uncapped routes only count", () => {
    expect(toCapView(row({ utilisation: null, dailyProcessedAmount: "250.0000" })).barPercent).toBe(25);
    const uncapped = toCapView(row({ dailyCapAmount: null, dailyCapRemaining: null, utilisation: null }));
    expect(uncapped).toMatchObject({ capped: false, cap: null, remaining: null, barPercent: 0, utilisationLabel: "—" });
  });

  test("capped routes are listed exhausted first, then most utilised", () => {
    const views = buildCapViews([
      row({ routeId: "a", railCode: "A", utilisation: "20.00", dailyProcessedAmount: "200.0000" }),
      row({ routeId: "b", railCode: "B", utilisation: "90.00", dailyProcessedAmount: "900.0000" }),
      row({ routeId: "c", railCode: "C", dailyCapAmount: null, utilisation: null }),
      row({ routeId: "d", railCode: "D", utilisation: "100.00", dailyProcessedAmount: "1000.0000", capExhausted: true }),
    ]);
    expect(views.capped.map((view) => view.routeId)).toEqual(["d", "b", "a"]);
    expect(views.uncappedCount).toBe(1);
    expect(views.exhaustedCount).toBe(1);
  });
});

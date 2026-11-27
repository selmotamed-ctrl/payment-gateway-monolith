import { describe, expect, it } from "vitest";
import { toIsoDate } from "../src/lib/date";
import { formatMoney, currencyPrecision, DEFAULT_CURRENCY } from "../src/lib/money";
import { normalizeOptions } from "../src/lib/options";
import { runRules } from "../src/lib/rules";
import { formatHumanStatus, statusToTone } from "../src/lib/status";

describe("date helpers", () => {
    it("formats a date as YYYY-MM-DD without timezone drift", () => {
        expect(toIsoDate(new Date(2026, 10, 27, 12))).toBe("2026-11-27");
        expect(toIsoDate(new Date(2026, 0, 3, 23))).toBe("2026-01-03");
    });
});

describe("money formatting", () => {
    it("keeps three decimals for LYD", () => {
        expect(currencyPrecision("LYD")).toBe(3);
        expect(formatMoney("125", { currency: "LYD" })).toBe("125.000 LYD");
        expect(formatMoney("1234.5", { currency: DEFAULT_CURRENCY })).toBe("1,234.500 LYD");
    });

    it("uses two decimals for USD", () => {
        expect(formatMoney("125", { currency: "USD" })).toBe("125.00 USD");
    });
});

describe("option adapter", () => {
    it("normalises plain values and Vuetify accessors", () => {
        expect(normalizeOptions(["LOW", "HIGH"])).toEqual([
            { value: "LOW", label: "LOW" },
            { value: "HIGH", label: "HIGH" },
        ]);
        const items = [{ id: 7, title: "Tripoli", subtitle: "LY-TIP" }];
        expect(normalizeOptions(items, { itemValue: "id", itemTitle: "title" })).toEqual([
            { value: 7, label: "Tripoli", subtitle: "LY-TIP", icon: undefined, badge: undefined, disabled: false },
        ]);
    });
});

describe("rule adapter", () => {
    it("returns the first failing rule and respects errorMessages", () => {
        expect(runRules({ rules: [(value: string) => (value ? true : "Required")] }, "")).toBe("Required");
        expect(runRules({ rules: [() => true], errorMessages: ["Server says no"] }, "x")).toBe("Server says no");
        expect(runRules({}, "x")).toBe("");
    });
});

describe("status vocabulary", () => {
    it("maps the financial lifecycle to semantic tones", () => {
        expect(statusToTone("SUCCEEDED")).toBe("success");
        expect(statusToTone("PENDING_CHECKER")).toBe("warning");
        expect(statusToTone("REJECTED")).toBe("danger");
        expect(statusToTone("UNKNOWN_STATE")).toBe("neutral");
    });

    it("humanises state names", () => {
        expect(formatHumanStatus("PENDING_CHECKER")).toBe("Pending Checker");
        expect(formatHumanStatus("AML_HOLD")).toBe("AML Hold");
        expect(formatHumanStatus("KYB")).toBe("KYB");
    });
});

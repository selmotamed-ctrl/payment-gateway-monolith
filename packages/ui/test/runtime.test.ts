import { describe, expect, it, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { compareMoney, currencyPrecision, formatMoney, isZeroMoney } from "../src/lib/money";
import {
    fromIsoDate,
    last30Days,
    monthToDate,
    quarterToDate,
    sameDay,
    startOfDay,
    toIsoDate,
    weekdayLabels,
    yearToDate,
} from "../src/lib/date";
import { iconName, normalizeOptions, normalizeSize, sameValue } from "../src/lib/options";
import { isEmpty, runRules, visibleError } from "../src/lib/rules";
import { formatHumanStatus, statusToTone } from "../src/lib/status";
import { LOCALE_STORAGE_KEY, currentLocale, isRtlLocale, readLocale, setLocale, syncDocumentLocale } from "../src/lib/locale";
import { THEME_STORAGE_KEY, readThemeMode, resolveTheme, setThemeMode, themeMode } from "../src/lib/theme";
import { copyToClipboard, lockBodyScroll } from "../src/lib/dom";
import { setDisplayViewport, useDisplay } from "../src/lib/display";

describe("locale engine", () => {
    it("defaults to English LTR", () => {
        localStorage.clear();
        expect(readLocale()).toBe("en");
        syncDocumentLocale("en");
        expect(document.documentElement.lang).toBe("en");
        expect(document.documentElement.dir).toBe("ltr");
        expect(isRtlLocale.value).toBe(false);
    });

    it("switches to Arabic RTL and back, persisting the choice", async () => {
        setLocale("ar");
        expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ar");
        expect(document.documentElement.lang).toBe("ar");
        expect(document.documentElement.dir).toBe("rtl");
        expect(currentLocale.value).toBe("ar");
        expect(isRtlLocale.value).toBe(true);
        setLocale("en");
        expect(document.documentElement.dir).toBe("ltr");
        expect(isRtlLocale.value).toBe(false);
        await nextTick();
    });
});

describe("theme store", () => {
    beforeEach(() => {
        localStorage.clear();
        themeMode.value = "system";
    });

    it("persists the mode and resolves light/dark", () => {
        setThemeMode("dark");
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
        expect(resolveTheme("dark")).toBe("dark");
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
        setThemeMode("light");
        expect(readThemeMode()).toBe("light");
        expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
});

describe("money formatting", () => {
    it("formats LYD with three Latin decimals", () => {
        expect(currencyPrecision("LYD")).toBe(3);
        expect(formatMoney("1250.5", "LYD")).toBe("1,250.500 LYD");
        expect(formatMoney("-45.2", { currency: "USD", showSign: true })).toBe("-45.20 USD");
        expect(formatMoney(null, "LYD")).toBe("—");
        expect(isZeroMoney("0.000")).toBe(true);
        expect(isZeroMoney("-0.00")).toBe(true);
        expect(compareMoney("90.000", "100.000")).toBeLessThan(0);
    });

    it("keeps very large amounts precise", () => {
        expect(formatMoney("999999999999.999", "LYD")).toBe("999,999,999,999.999 LYD");
    });
});

describe("date helpers", () => {
    it("round-trips ISO dates without timezone drift", () => {
        expect(toIsoDate(fromIsoDate("2026-11-26")!)).toBe("2026-11-26");
        expect(fromIsoDate("2026-02-31")).toBeNull();
        expect(fromIsoDate("garbage")).toBeNull();
        expect(toIsoDate(fromIsoDate("2028-02-29")!)).toBe("2028-02-29");
    });

    it("compares calendar days and builds fintech ranges", () => {
        expect(sameDay(new Date(2026, 10, 26, 0, 1), new Date(2026, 10, 26, 23, 59))).toBe(true);
        expect(toIsoDate(startOfDay(new Date(2026, 10, 26, 14, 31)))).toBe("2026-11-26");
        const seven = last30Days(new Date(2026, 10, 30, 12));
        expect(seven.end).toBe("2026-11-30");
        expect(seven.start).toBe("2026-11-01");
        expect(monthToDate(new Date(2026, 10, 30)).start).toBe("2026-11-01");
        expect(quarterToDate(new Date(2026, 10, 30)).start).toBe("2026-10-01");
        expect(yearToDate(new Date(2026, 10, 30)).start).toBe("2026-01-01");
        expect(weekdayLabels("en")).toEqual(["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]);
    });
});

describe("option adapter", () => {
    it("supports string and function accessors", () => {
        expect(normalizeOptions(["A", "B"])).toMatchObject([
            { label: "A", value: "A" },
            { label: "B", value: "B" },
        ]);
        const rows = [{ id: 7, title: "Tripoli", meta: "LY-TIP" }];
        expect(normalizeOptions(rows, "title", "id")).toMatchObject([{ label: "Tripoli", value: 7 }]);
        expect(normalizeOptions(rows, { itemTitle: (r: any) => r.title.toUpperCase(), itemValue: "id" })).toMatchObject([
            { label: "TRIPOLI", value: 7 },
        ]);
        expect(normalizeOptions(null)).toEqual([]);
    });

    it("matches numeric and string ids and normalises sizes/icons", () => {
        expect(sameValue(123, "123")).toBe(true);
        expect(sameValue({ a: 1 }, { a: 1 })).toBe(true);
        expect(sameValue("a", "b")).toBe(false);
        expect(normalizeSize(undefined)).toBeUndefined();
        expect(normalizeSize("compact")).toBe("sm");
        expect(normalizeSize("comfortable")).toBe("md");
        expect(normalizeSize("large")).toBe("lg");
        expect(iconName("check")).toBe("mdi-check");
        expect(iconName("mdi-check")).toBe("mdi-check");
        expect(iconName(null)).toBeNull();
    });
});

describe("rules engine", () => {
    it("treats zero and false as valid values", () => {
        expect(isEmpty(0)).toBe(false);
        expect(isEmpty(false)).toBe(false);
        expect(isEmpty("")).toBe(true);
        expect(isEmpty("   ")).toBe(true);
        expect(isEmpty([])).toBe(true);
        expect(isEmpty(null)).toBe(true);
    });

    it("runs rules in order and resolves visibility", () => {
        expect(runRules("", [(v: any) => !!v || "Required"] as any)).toBe("Required");
        expect(runRules("x", [() => true])).toBe("");
        expect(runRules({ rules: [() => false] }, "x")).toBe("Invalid value");
        expect(visibleError("", "Required", false, false)).toBe("");
        expect(visibleError("", "Required", true, false)).toBe("Required");
        expect(visibleError("Server says no", "Required", true, true)).toBe("Server says no");
        expect(visibleError({ error: "Server says no", hideDetails: true }, "")).toBe("");
    });
});

describe("status vocabulary", () => {
    it("maps critical statuses to danger and preserves acronyms", () => {
        expect(statusToTone("CRITICAL")).toBe("danger");
        expect(statusToTone("SETTLED")).toBe("success");
        expect(statusToTone("PENDING_KYB")).toBe("warning");
        expect(statusToTone("unknown-state")).toBe("neutral");
        expect(formatHumanStatus("PENDING_KYB_API_CHECK")).toBe("Pending KYB API Check");
        expect(formatHumanStatus("CRITICAL")).toBe("Critical");
        expect(formatHumanStatus(null)).toBe("—");
    });
});

describe("display engine", () => {
    it("reacts to viewport width with shared refs", () => {
        const display = useDisplay();
        setDisplayViewport(500, 800);
        expect(display.xs.value).toBe(true);
        expect(display.mobile.value).toBe(true);
        setDisplayViewport(1280, 900);
        expect(display.lg.value).toBe(true);
        expect(display.mobile.value).toBe(false);
        expect(display.name.value).toBe("lg");
        setDisplayViewport(1280, 800);
    });
});

describe("dom helpers", () => {
    it("locks body scroll with a reference count", () => {
        const releaseA = lockBodyScroll();
        const releaseB = lockBodyScroll();
        expect(document.body.style.overflow).toBe("hidden");
        releaseA();
        expect(document.body.style.overflow).toBe("hidden");
        releaseB();
        expect(document.body.style.overflow).toBe("");
    });

    it("copies text through the clipboard when available", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        await expect(copyToClipboard("TXN-1")).resolves.toBe(true);
        expect(writeText).toHaveBeenCalledWith("TXN-1");
    });
});

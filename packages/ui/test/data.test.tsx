import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dc } from "../src/lib/dc";
import { providePgUiConfig } from "../src/lib/config";
import { mount } from "./helpers/render";
import { PgMetricStrip, PgMiniStats } from "../src/data/PgMetricStrip";
import { PgSummaryExportCard } from "../src/data/PgSummaryExportCard";
import { PgMonoRef } from "../src/data/PgMonoRef";
import { PgMoneyText } from "../src/data/PgMoneyText";
import { PgFormChecklist, type PgChecklistItem } from "../src/data/PgFormChecklist";
import { PgFieldsSection } from "../src/data/PgFieldsSection";
import { PgDescriptionList } from "../src/data/PgDescriptionList";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataCss = fs.readFileSync(path.resolve(here, "../src/tokens/parts/data.css"), "utf-8");

const stubClipboard = () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
    });
    return writeText;
};

const flushAsync = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
};

afterEach(() => {
    vi.useRealTimers();
    try {
        delete (navigator as any).clipboard;
    } catch {
        /* read-only in some environments */
    }
});

const metricItems = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
        key: `metric-${index}`,
        label: `Metric ${index + 1}`,
        value: `${index + 1}00`,
        subLabel: `Sub label ${index + 1}`,
    }));

const checklistItems: PgChecklistItem[] = [
    { id: "scope", label: "Scope verified" },
    { id: "expiry", label: "Expiry reviewed" },
    { id: "breakdown", label: "Breakdown reviewed" },
    { id: "approval", label: "Approval confirmed" },
];

describe("PgMetricStrip", () => {
    it("renders five metrics in the five-column wide layout", () => {
        const { el, unmount } = mount(PgMetricStrip, { items: metricItems(5) });
        const strip = el.querySelector(".pg-metric-strip") as HTMLElement;
        expect(strip.dataset.cols).toBe("5");
        expect(strip.getAttribute("aria-label")).toBe("Key metrics");
        expect(el.querySelectorAll(".pg-metric-tile")).toHaveLength(5);
        expect(el.querySelector(".pg-metric-label")?.textContent).toContain("Metric 1");
        expect(el.querySelector(".pg-metric-sublabel")?.textContent).toBe("Sub label 1");
        unmount();
    });

    it("balances six metrics into a 3x2 grid", () => {
        const { el, unmount } = mount(PgMetricStrip, { items: metricItems(6) });
        expect((el.querySelector(".pg-metric-strip") as HTMLElement).dataset.cols).toBe("3");
        expect(el.querySelectorAll(".pg-metric-tile")).toHaveLength(6);
        unmount();
    });

    it("announces loading and renders skeleton bars", () => {
        const { el, unmount } = mount(PgMetricStrip, { items: metricItems(4), loading: true });
        expect(el.querySelector(".pg-metric-strip")?.getAttribute("aria-busy")).toBe("true");
        expect(el.querySelectorAll(".pg-metric-tile")).toHaveLength(4);
        expect(el.querySelectorAll(".pg-metric-loading .pg-skeleton")).toHaveLength(4);
        unmount();
    });

    it("keeps the 5-column rule for wide screens and collapses to 2/1 (CSS contract)", () => {
        expect(dataCss).toMatch(/@media \(min-width: 1280px\)[\s\S]*?data-cols="5"[\s\S]*?--pg-metric-cols: 5/);
        expect(dataCss).toMatch(/@media \(max-width: 1200px\)[\s\S]*?data-cols="4"[\s\S]*?--pg-metric-cols: 2/);
        expect(dataCss).toMatch(/@media \(max-width: 640px\)[\s\S]*?--pg-metric-cols: 1/);
    });
});

describe("PgMiniStats", () => {
    it("renders seamless dl/dt/dd cells", () => {
        const { el, unmount } = mount(PgMiniStats, { items: metricItems(4) });
        expect(el.querySelectorAll("dl.pg-mini-stats .pg-mini-stats__cell")).toHaveLength(4);
        expect(el.querySelectorAll(".pg-mini-stats dt")).toHaveLength(4);
        expect(el.querySelectorAll(".pg-mini-stats dd.pg-mini-stats__value")).toHaveLength(4);
        expect(dataCss).toMatch(/\.pg-mini-stats__cell\s*\{[\s\S]*?border-inline-start: 1px solid var\(--pg-border-subtle\)/);
        unmount();
    });

    it("supports the legacy stats shape and loading", () => {
        const { el, unmount } = mount(PgMiniStats, {
            stats: [{ title: "Pending", value: 12, tone: "warning" }],
            loading: true,
        });
        expect(el.querySelector(".pg-mini-stats")?.getAttribute("aria-busy")).toBe("true");
        expect(el.querySelector(".pg-mini-stats__value--warning")).toBeTruthy();
        expect(el.querySelector(".pg-skeleton")).toBeTruthy();
        unmount();
    });
});

describe("PgSummaryExportCard", () => {
    it("renders the title once, keeps the export button unclipped and enables it only when complete", async () => {
        const exportSpy = vi.fn();
        const Host = dc(() => {
            const checklist = ref<Record<string, boolean>>({});
            const complete = () => checklistItems.every((item) => checklist.value[item.id!] === true);
            return () => (
                <PgSummaryExportCard
                    title="Portfolio health"
                    metrics={[{ key: "total", label: "Merchants", value: "1,250" }]}
                    checks={checklistItems}
                    checklist={checklist.value}
                    showChecklists
                    checklistComplete={complete()}
                    exportLabel="Export summary"
                    onUpdate:checklist={(value: Record<string, boolean>) => (checklist.value = value)}
                    onExport={() => exportSpy()}
                />
            );
        }, { props: {} });

        const { el, unmount } = mount(Host, {});
        expect(el.querySelectorAll(".pg-card__title")).toHaveLength(1);
        expect(el.querySelector(".pg-card__title")?.textContent).toBe("Portfolio health");
        const button = el.querySelector(".pg-summary-export__button") as HTMLButtonElement;
        expect(button).toBeTruthy();
        expect(button.disabled).toBe(true);
        expect(dataCss).toMatch(/\.pg-summary-export__button\s*\{[\s\S]*?flex-shrink: 0/);
        expect(dataCss).toMatch(/\.pg-summary-export \.pg-card__header\s*\{[\s\S]*?flex-wrap: wrap/);

        const inputs = () => [...el.querySelectorAll<HTMLInputElement>(".pg-checklist__list input[type='checkbox']")];
        for (let index = 0; index < checklistItems.length; index += 1) {
            inputs()[index]!.click();
            await nextTick();
        }

        expect(el.querySelectorAll(".pg-checklist__list input:checked")).toHaveLength(4);
        expect((el.querySelector(".pg-summary-export__button") as HTMLButtonElement).disabled).toBe(false);
        (el.querySelector(".pg-summary-export__button") as HTMLButtonElement).click();
        await nextTick();
        expect(exportSpy).toHaveBeenCalledTimes(1);
        unmount();
    });
});

describe("PgMonoRef", () => {
    it("copies the full value by default even when the label is truncated", async () => {
        vi.useFakeTimers();
        const writeText = stubClipboard();
        const copied = vi.fn();
        const { el, unmount } = mount(PgMonoRef, {
            value: "TXN-987654321",
            truncate: 8,
            onCopied: () => copied,
        } as any);
        const chip = el.querySelector(".pg-mono-ref") as HTMLButtonElement;
        expect(chip.textContent).toContain("TXN-9876…");
        expect(chip.textContent).not.toContain("TXN-987654321");

        chip.click();
        await vi.advanceTimersByTimeAsync(0);
        await nextTick();

        expect(writeText).toHaveBeenCalledWith("TXN-987654321");
        const copiedChip = el.querySelector(".pg-mono-ref") as HTMLButtonElement;
        expect(copiedChip.classList.contains("pg-mono-ref--copied")).toBe(true);
        expect(copiedChip.querySelector(".pg-mono-ref__check")).toBeTruthy();
        expect(copiedChip.querySelector(".pg-sr-only")?.textContent).toBe("Copied");
        expect(copied).toHaveBeenCalledWith("TXN-987654321");

        await vi.advanceTimersByTimeAsync(1600);
        await nextTick();
        const restoredChip = el.querySelector(".pg-mono-ref") as HTMLButtonElement;
        expect(restoredChip.classList.contains("pg-mono-ref--copied")).toBe(false);
        expect(restoredChip.querySelector(".pg-mono-ref__check")).toBeNull();
        unmount();
    });

    it("prefers the host config.copyText hook over the browser clipboard", async () => {
        let configCopied = "";
        const Host = dc(() => {
            providePgUiConfig({
                copyText: async (text: string) => {
                    configCopied = text;
                    return true;
                },
            });
            return () => <PgMonoRef value="CFG-REF-1" />;
        }, { props: {} });
        const { el, unmount } = mount(Host, {});
        (el.querySelector(".pg-mono-ref") as HTMLButtonElement).click();
        await flushAsync();
        expect(configCopied).toBe("CFG-REF-1");
        expect(el.querySelector(".pg-mono-ref")?.classList.contains("pg-mono-ref--copied")).toBe(true);
        unmount();
    });

    it("renders an empty reference as a disabled dash without an icon", () => {
        const { el, unmount } = mount(PgMonoRef, { value: "" });
        const chip = el.querySelector(".pg-mono-ref") as HTMLButtonElement;
        expect(chip.disabled).toBe(true);
        expect(chip.textContent).toContain("—");
        expect(chip.querySelector("svg")).toBeNull();
        unmount();
    });
});

describe("PgMoneyText", () => {
    it("formats LYD with three decimals and a muted currency code", () => {
        const { el, unmount } = mount(PgMoneyText, { amount: "125.5", currency: "LYD" });
        const money = el.querySelector(".pg-money") as HTMLElement;
        expect(money.getAttribute("dir")).toBe("ltr");
        expect(money.textContent).toContain("125.500");
        expect(money.querySelector(".pg-money__currency")?.textContent).toBe("LYD");
        expect(money.classList.contains("pg-money--md")).toBe(true);
        expect(dataCss).toMatch(/\.pg-money\s*\{[\s\S]*?unicode-bidi: isolate/);
        unmount();
    });

    it("uses danger ink and a visible minus for signed negatives", () => {
        const { el, unmount } = mount(PgMoneyText, { amount: "-250.5", currency: "LYD", signed: true });
        const money = el.querySelector(".pg-money") as HTMLElement;
        expect(money.textContent).toContain("-250.500");
        expect(money.classList.contains("pg-money--negative")).toBe(true);
        expect(money.getAttribute("dir")).toBe("ltr");
        unmount();
    });

    it("treats zero as neutral and empty input as a dash", () => {
        const zero = mount(PgMoneyText, { amount: 0, currency: "LYD", signed: true });
        expect(zero.el.querySelector(".pg-money")?.textContent).toContain("0.000");
        expect(zero.el.querySelector(".pg-money")?.classList.contains("pg-money--zero")).toBe(true);
        expect(zero.el.querySelector(".pg-money")?.textContent).not.toContain("+");
        zero.unmount();

        const empty = mount(PgMoneyText, { amount: null, currency: "LYD" });
        expect(empty.el.querySelector(".pg-money")?.textContent).toBe("—");
        expect(empty.el.querySelector(".pg-money")?.classList.contains("pg-money--empty")).toBe(true);
        empty.unmount();
    });
});

describe("PgFormChecklist", () => {
    it("starts empty, then completes when every row is clicked", async () => {
        const Host = dc(() => {
            const selected = ref<string[]>([]);
            return () => (
                <PgFormChecklist
                    items={checklistItems}
                    modelValue={selected.value}
                    complete={selected.value.length === checklistItems.length}
                    incompleteMessage="Complete all checklist items"
                    onUpdate:modelValue={(value: string[]) => (selected.value = value)}
                />
            );
        }, { props: {} });

        const { el, unmount } = mount(Host, {});
        expect(el.querySelectorAll(".pg-checklist__list input:checked")).toHaveLength(0);
        expect(el.querySelectorAll(".pg-checklist__row")).toHaveLength(4);
        expect(el.querySelector(".pg-checklist__select-all")).toBeTruthy();
        expect(el.querySelector(".pg-checklist__hint")?.textContent).toContain("Complete all");

        const inputs = () => [...el.querySelectorAll<HTMLInputElement>(".pg-checklist__list input[type='checkbox']")];
        for (let index = 0; index < checklistItems.length; index += 1) {
            inputs()[index]!.click();
            await nextTick();
        }

        expect(el.querySelectorAll(".pg-checklist__list input:checked")).toHaveLength(4);
        expect(el.querySelector(".pg-checklist__hint")).toBeNull();
        unmount();
    });

    it("emits update:modelValue and toggle for a single row", async () => {
        const updated = vi.fn();
        const toggled = vi.fn();
        const { el, unmount } = mount(PgFormChecklist, {
            items: [{ id: "a", label: "Row A" }],
            modelValue: [],
            "onUpdate:modelValue": () => updated,
            onToggle: () => toggled,
        } as any);
        (el.querySelector(".pg-checklist__list input") as HTMLInputElement).click();
        await nextTick();
        expect(updated).toHaveBeenCalledWith(["a"]);
        expect(toggled).toHaveBeenCalledWith("a", true);
        unmount();
    });

    it("renders read-only status icons, never disabled checkboxes", () => {
        const { el, unmount } = mount(PgFormChecklist, {
            items: [
                { id: "a", label: "Verified", status: "done" },
                { id: "b", label: "Waiting", status: "pending" },
                { id: "c", label: "Blocked", status: "error" },
            ],
            interactive: false,
            modelValue: [],
        });
        expect(el.querySelectorAll("input[type='checkbox']")).toHaveLength(0);
        expect(el.querySelectorAll(".pg-checklist__status--done")).toHaveLength(1);
        expect(el.querySelectorAll(".pg-checklist__status--pending")).toHaveLength(1);
        expect(el.querySelectorAll(".pg-checklist__status--error")).toHaveLength(1);
        expect(el.querySelector(".pg-checklist__label")?.textContent).toBe("Verified");
        unmount();
    });

    it("selects every row from the select-all header", async () => {
        const Host = dc(() => {
            const selected = ref<string[]>([]);
            return () => (
                <PgFormChecklist
                    items={checklistItems}
                    modelValue={selected.value}
                    onUpdate:modelValue={(value: string[]) => (selected.value = value)}
                />
            );
        }, { props: {} });
        const { el, unmount } = mount(Host, {});
        (el.querySelector(".pg-checklist__select-all input") as HTMLInputElement).click();
        await nextTick();
        expect(el.querySelectorAll(".pg-checklist__list input:checked")).toHaveLength(4);
        unmount();
    });
});

describe("PgFieldsSection & PgField", () => {
    it("uses a 1px hairline grid with filler cells and a calm dash for empty values", () => {
        const { el, unmount } = mount(PgFieldsSection, {
            title: "Merchant details",
            columns: 3,
            fields: [
                { label: "Legal name", value: "Acme" },
                { label: "Registry", value: "LY-123" },
                { label: "Tier", value: "STANDARD" },
                { label: "IBAN", value: "" },
                { label: "Note", value: "Long note", span: "full" },
            ],
        });
        expect(el.querySelectorAll(".pg-field-grid .pg-field-item")).toHaveLength(5);
        expect(el.querySelectorAll(".pg-field-grid__filler")).toHaveLength(1);
        expect((el.querySelector(".pg-field-grid") as HTMLElement).dataset.cols).toBe("3");
        const empty = el.querySelectorAll(".pg-field-item")[3]?.querySelector(".pg-field-item__value");
        expect(empty?.textContent).toBe("—");
        expect(el.querySelector(".pg-fields-section__title")?.textContent).toBe("Merchant details");
        expect(dataCss).toMatch(/\.pg-field-grid\s*\{[\s\S]*?gap: 1px/);
        expect(dataCss).toMatch(/\.pg-field-grid\s*\{[\s\S]*?background: var\(--pg-border-subtle\)/);
        unmount();
    });

    it("copies a copyable tile with a success check", async () => {
        const writeText = stubClipboard();
        const { el, unmount } = mount(PgFieldsSection, {
            fields: [{ label: "IBAN", value: "LY00 0000 0000", type: "mono", copyable: true }],
        });
        const tile = el.querySelector(".pg-field-item") as HTMLElement;
        expect(tile.classList.contains("pg-field-item--interactive")).toBe(true);
        expect(tile.getAttribute("tabindex")).toBe("0");
        tile.click();
        await flushAsync();
        expect(writeText).toHaveBeenCalledWith("LY00 0000 0000");
        expect(tile.classList.contains("pg-field-item--copied")).toBe(true);
        expect(tile.querySelector(".pg-field-item__copy-check")).toBeTruthy();
        unmount();
    });

    it("supports legacy text/value fields and boolean/status types", () => {
        const { el, unmount } = mount(PgFieldsSection, {
            fields: [
                { text: "Legacy label", value: "Legacy value" },
                { label: "Active", value: true, type: "boolean" },
                { label: "State", value: "ACTIVE", type: "status" },
            ],
        });
        expect(el.querySelector(".pg-field-item__label")?.textContent).toBe("Legacy label");
        expect(el.querySelector(".pg-field-item__boolean--on")).toBeTruthy();
        expect(el.querySelector(".pg-badge")).toBeTruthy();
        unmount();
    });
});

describe("PgDescriptionList", () => {
    it("uses dl/dt/dd semantics with money, mono and status values", () => {
        const { el, unmount } = mount(PgDescriptionList, {
            items: [
                { label: "Status", value: "ACTIVE", type: "status" },
                { label: "Amount", value: "125.5", money: true, currency: "LYD" },
                { label: "Reference", value: "TXN-1", mono: true },
            ],
        });
        const list = el.querySelector("dl.pg-description-list") as HTMLElement;
        expect(list).toBeTruthy();
        expect(list.querySelectorAll("dt")).toHaveLength(3);
        expect(list.querySelectorAll("dd")).toHaveLength(3);
        expect(el.querySelector(".pg-money")?.textContent).toContain("125.500");
        expect(el.querySelector(".pg-mono")?.getAttribute("dir")).toBe("ltr");
        expect(el.querySelector(".pg-badge")).toBeTruthy();
        expect(dataCss).toMatch(/\.pg-description-list__row\s*\{[\s\S]*?border-block-end: 1px solid var\(--pg-border-subtle\)/);
        unmount();
    });

    it("switches to a stacked two-column grid", () => {
        const { el, unmount } = mount(PgDescriptionList, {
            columns: 2,
            layout: "stacked",
            items: [
                { label: "A", value: "1" },
                { label: "B", value: "2" },
            ],
        });
        const list = el.querySelector(".pg-description-list") as HTMLElement;
        expect(list.classList.contains("pg-description-list--stacked")).toBe(true);
        expect(list.classList.contains("pg-description-list--grid")).toBe(true);
        expect(list.dataset.columns).toBe("2");
        unmount();
    });
});

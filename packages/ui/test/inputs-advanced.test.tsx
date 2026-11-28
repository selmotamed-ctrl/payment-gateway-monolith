import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ref } from "vue";
import { dc } from "../src/lib/dc";
import { providePgUiConfig } from "../src/lib/config";
import { PgAutocomplete } from "../src/inputs/PgAutocomplete";
import { PgApiAutocomplete } from "../src/inputs/PgApiAutocomplete";
import { PgDateInput, PgDateRangeInput } from "../src/inputs/PgDateInput";
import { TableFilters } from "../src/data/table/TableFilters";
import { last30Days, toIsoDate } from "../src/lib/date";
import { mount, nextFrame, wait } from "./helpers/render";

const here = path.dirname(fileURLToPath(import.meta.url));
const advancedCss = fs.readFileSync(
    path.resolve(here, "../src/tokens/parts/inputs-advanced.css"),
    "utf-8",
);

const press = (node: Element, key: string) => {
    node.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
};

const typeInto = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
};

const clickOption = (node: Element) => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};

const openAutocomplete = async (el: HTMLElement) => {
    (el.querySelector("[data-pg-autocomplete]") as HTMLElement).click();
    await nextFrame();
};

const optionLabels = (el: HTMLElement) =>
    [...el.querySelectorAll(".pg-ac-option-label")].map((node) => node.textContent);

const SingleHarness = dc(
    (props: any) => {
        const value = ref<any>(props.initial ?? null);
        return () => (
            <div>
                <span class="out">{JSON.stringify(value.value)}</span>
                <PgAutocomplete
                    items={props.items ?? ["ACTIVE", "PENDING", "BLOCKED"]}
                    modelValue={value.value}
                    creatable={props.creatable}
                    allowCustom={props.allowCustom}
                    onUpdate:modelValue={(next: any) => (value.value = next)}
                />
            </div>
        );
    },
    {
        props: {
            initial: { type: null, default: null },
            items: { type: Array, default: undefined },
            creatable: { type: Boolean, default: false },
            allowCustom: { type: Boolean, default: false },
        },
    },
);

const MultiHarness = dc(
    () => {
        const value = ref<any[]>([]);
        return () => (
            <div>
                <span class="out">{JSON.stringify(value.value)}</span>
                <PgAutocomplete
                    items={["A", "B", "C"]}
                    multiple
                    modelValue={value.value}
                    onUpdate:modelValue={(next: any) => (value.value = next)}
                />
            </div>
        );
    },
    { props: {} },
);

const DateHarness = dc(
    (props: any) => {
        const value = ref<any>(props.initial ?? null);
        return () => (
            <div>
                <span class="out">{JSON.stringify(value.value)}</span>
                <PgDateInput
                    modelValue={value.value}
                    sheet={props.sheet}
                    onUpdate:modelValue={(next: any) => (value.value = next)}
                />
            </div>
        );
    },
    { props: { initial: { type: null, default: null }, sheet: { type: [Boolean, String], default: "auto" } } },
);

const RangeHarness = dc(
    (props: any) => {
        const value = ref<any>(props.initial ?? null);
        return () => (
            <div>
                <span class="out">{JSON.stringify(value.value)}</span>
                <PgDateRangeInput
                    modelValue={value.value}
                    sheet={props.sheet}
                    onUpdate:modelValue={(next: any) => (value.value = next)}
                />
            </div>
        );
    },
    { props: { initial: { type: null, default: null }, sheet: { type: [Boolean, String], default: "auto" } } },
);

/** Legacy `multiple="range"` contract: `modelValue` is a `Date[]`. */
const LegacyRangeHarness = dc(
    (props: any) => {
        const value = ref<any[]>(props.initial ?? []);
        return () => (
            <div>
                <span class="out">
                    {JSON.stringify(value.value.map((date: any) => toIsoDate(date)))}
                </span>
                <PgDateInput
                    multiple="range"
                    modelValue={value.value}
                    onUpdate:modelValue={(next: any) => (value.value = next)}
                />
            </div>
        );
    },
    { props: { initial: { type: Array, default: () => [] } } },
);

const readOut = (el: HTMLElement) =>
    JSON.parse(el.querySelector(".out")?.textContent ?? "null");

describe("PgAutocomplete — single select", () => {
    it("filters, selects with ArrowDown + Enter and closes", async () => {
        const { el, unmount } = mount(SingleHarness, {});
        await openAutocomplete(el);
        const input = el.querySelector("input") as HTMLInputElement;
        input.focus();
        typeInto(input, "pen");
        await nextFrame();
        expect(optionLabels(el)).toEqual(["PENDING"]);
        press(input, "ArrowDown");
        press(input, "Enter");
        await nextFrame();
        expect(readOut(el)).toBe("PENDING");
        expect(el.querySelector("[data-pg-ac-panel]")).toBeNull();
        expect(el.querySelector(".pg-ac-chip")).toBeNull();
        unmount();
    });

    it("wraps the active highlight with ArrowUp from the first option", async () => {
        const { el, unmount } = mount(SingleHarness, { items: ["A", "B", "C"] });
        await openAutocomplete(el);
        const input = el.querySelector("input") as HTMLInputElement;
        press(input, "ArrowUp");
        await nextFrame();
        const active = el.querySelector(".pg-ac-option--active");
        expect(active?.textContent).toContain("C");
        unmount();
    });
});

describe("PgAutocomplete — multi select", () => {
    it("stays open after clicking A and B, and a chip removes only its value", async () => {
        const { el, unmount } = mount(MultiHarness, {});
        await openAutocomplete(el);
        const options = el.querySelectorAll(".pg-ac-option");
        clickOption(options[0]!);
        await nextFrame();
        expect(readOut(el)).toEqual(["A"]);
        expect(el.querySelector("[data-pg-ac-panel]")).not.toBeNull();

        clickOption(el.querySelectorAll(".pg-ac-option")[1]!);
        await nextFrame();
        expect(readOut(el)).toEqual(["A", "B"]);
        expect(el.querySelector("[data-pg-ac-panel]")).not.toBeNull();
        expect(
            [...el.querySelectorAll(".pg-ac-chip__label")].map((node) => node.textContent),
        ).toEqual(["A", "B"]);
        expect(el.querySelectorAll(".pg-ac-option-check").length).toBe(3);
        expect(el.querySelectorAll(".pg-ac-option-check--on").length).toBe(2);

        (el.querySelector(".pg-ac-chip__remove") as HTMLElement).click();
        await nextFrame();
        expect(readOut(el)).toEqual(["B"]);
        unmount();
    });

    it("keeps the same option nodes on hover and stays open after the click", async () => {
        const { el, unmount } = mount(MultiHarness, {});
        await openAutocomplete(el);
        const option = el.querySelectorAll(".pg-ac-option")[0]!;
        option.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
        await nextFrame();
        expect(option.isConnected).toBe(true);
        clickOption(option);
        await nextFrame();
        expect(el.querySelector("[data-pg-ac-panel]")).not.toBeNull();
        expect(option.isConnected).toBe(true);
        expect(option.getAttribute("aria-selected")).toBe("true");
        unmount();
    });

    it("reverses a Backspace on an empty query into removing the last chip", async () => {
        const { el, unmount } = mount(MultiHarness, {});
        await openAutocomplete(el);
        clickOption(el.querySelectorAll(".pg-ac-option")[0]!);
        await nextFrame();
        clickOption(el.querySelectorAll(".pg-ac-option")[1]!);
        await nextFrame();
        expect(readOut(el)).toEqual(["A", "B"]);
        const input = el.querySelector("input") as HTMLInputElement;
        expect(input.value).toBe("");
        press(input, "Backspace");
        await nextFrame();
        expect(readOut(el)).toEqual(["A"]);
        unmount();
    });
});

describe("PgApiAutocomplete — multiple", () => {
    it("stays open after selecting two server options", async () => {
        const value = ref<string[]>([]);
        const items = [
            { title: "Alpha", value: "a" },
            { title: "Beta", value: "b" },
            { title: "Gamma", value: "c" },
        ];
        const Harness = dc(
            () => () => (
                <div>
                    <span class="out">{JSON.stringify(value.value)}</span>
                    <PgApiAutocomplete
                        fetcher={async () => ({ items, hasMore: false })}
                        debounceMs={0}
                        multiple
                        itemTitle="title"
                        itemValue="value"
                        modelValue={value.value}
                        onUpdate:modelValue={(next: string[]) => (value.value = next)}
                    />
                </div>
            ),
            { props: {} },
        );
        const { el, unmount } = mount(Harness, {});
        await openAutocomplete(el);
        await wait(30);
        expect(optionLabels(el)).toEqual(["Alpha", "Beta", "Gamma"]);
        clickOption(el.querySelectorAll(".pg-ac-option")[0]!);
        await nextFrame();
        expect(el.querySelector("[data-pg-ac-panel]")).not.toBeNull();
        clickOption(el.querySelectorAll(".pg-ac-option")[1]!);
        await nextFrame();
        expect(el.querySelector("[data-pg-ac-panel]")).not.toBeNull();
        expect(JSON.parse(el.querySelector(".out")!.textContent!)).toEqual(["a", "b"]);
        expect([...el.querySelectorAll(".pg-ac-chip__label")].map((node) => node.textContent)).toEqual(["Alpha", "Beta"]);
        unmount();
    });
});

describe("PgAutocomplete — DOM and input hygiene", () => {
    it("keeps the chip row on one line and preserves the full chip labels", async () => {
        expect(advancedCss).toMatch(/\.pg-ac-values\s*\{[^}]*flex-wrap:\s*nowrap/s);
        expect(advancedCss).toMatch(/\.pg-control-box \.pg-ac-input,[\s\S]*?flex:\s*0 1 52px/s);
        expect(advancedCss).toMatch(/\.pg-ac-panel\s*\{[^}]*padding:\s*0 !important/s);
        expect(advancedCss).toMatch(/\.pg-ac-panel \.pg-ac-option--selected\s*\{[^}]*color-mix/s);
    });

    it("renders zero <select> nodes and a borderless inner input", async () => {
        const { el, unmount } = mount(SingleHarness, {});
        expect(el.querySelectorAll("select").length).toBe(0);
        const input = el.querySelector("input") as HTMLInputElement;
        expect(input.classList.contains("pg-ac-input")).toBe(true);
        expect(input.classList.contains("pg-control-box")).toBe(false);
        expect(input.classList.contains("pg-control-native")).toBe(true);
        // The border/focus ring is owned by .pg-control-box; the CSS contract
        // below proves the inner input can never paint a second one.
        expect(advancedCss).toMatch(/\.pg-ac-input,[\s\S]*?border:\s*0 !important/);
        unmount();
    });
});

describe("PgAutocomplete — non-searchable select", () => {
    it("still opens, selects a number value and closes (page-size contract)", async () => {
        const PageSizeHarness = dc(
            () => {
                const value = ref<any>(25);
                return () => (
                    <div>
                        <span class="out">{JSON.stringify(value.value)}</span>
                        <PgAutocomplete
                            items={[
                                { label: "10", value: 10 },
                                { label: "25", value: 25 },
                            ]}
                            itemTitle="label"
                            itemValue="value"
                            searchable={false}
                            clearable={false}
                            size="sm"
                            density="compact"
                            hideDetails
                            modelValue={value.value}
                            onUpdate:modelValue={(next: any) => (value.value = next)}
                        />
                    </div>
                );
            },
            { props: {} },
        );
        const { el, unmount } = mount(PageSizeHarness, {});
        expect((el.querySelector(".pg-ac-input") as HTMLInputElement).value).toBe("25");
        await openAutocomplete(el);
        clickOption(el.querySelectorAll(".pg-ac-option")[0]!);
        await nextFrame();
        expect(readOut(el)).toBe(10);
        expect((el.querySelector(".pg-ac-input") as HTMLInputElement).value).toBe("10");
        expect(el.querySelector("[data-pg-ac-panel]")).toBeNull();
        unmount();
    });
});

describe("PgAutocomplete — creatable", () => {    it("commits a custom value on Enter", async () => {
        const { el, unmount } = mount(SingleHarness, { items: [], creatable: true });
        await openAutocomplete(el);
        const input = el.querySelector("input") as HTMLInputElement;
        input.focus();
        typeInto(input, "10.0.0.0/8");
        await nextFrame();
        expect(el.querySelector(".pg-ac-create-row")?.textContent).toContain("10.0.0.0/8");
        press(input, "Enter");
        await nextFrame();
        expect(readOut(el)).toBe("10.0.0.0/8");
        unmount();
    });
});

describe("PgApiAutocomplete", () => {
    it("aborts the stale request and only renders the newest query", async () => {
        const aborted: boolean[] = [];
        const started: string[] = [];
        const fetcher = async (
            query: string,
            _page: number,
            signal: AbortSignal,
        ) => {
            const index = started.length;
            started.push(query);
            aborted[index] = false;
            signal.addEventListener("abort", () => {
                aborted[index] = true;
            });
            if (query === "a") {
                await wait(60);
                return {
                    items: [{ title: "slow-result", value: "slow" }],
                    hasMore: false,
                };
            }
            await wait(0);
            return {
                items: [{ title: "ab-result", value: "ab" }],
                hasMore: false,
            };
        };
        const Harness = dc(
            () => () => (
                <PgApiAutocomplete
                    fetcher={fetcher}
                    preloadOnOpen={false}
                    debounceMs={10}
                />
            ),
            { props: {} },
        );
        const { el, unmount } = mount(Harness, {});
        await openAutocomplete(el);
        const input = el.querySelector("input") as HTMLInputElement;
        input.focus();
        typeInto(input, "a");
        await wait(30);
        typeInto(input, "ab");
        await wait(140);
        expect(started).toEqual(["a", "ab"]);
        expect(aborted[0]).toBe(true);
        expect(aborted[1]).toBeFalsy();
        expect(optionLabels(el)).toEqual(["ab-result"]);
        // No bordered refresh control inside the input.
        expect(el.querySelector('[aria-label="Refresh options"]')).toBeNull();
        expect(el.querySelector(".pg-control-box .pg-btn")).toBeNull();
        expect(el.querySelector(".pg-ac-refresh")).toBeNull();
        unmount();
    });

    it("keeps a selected label from the initial cache instead of a raw id", async () => {
        const Harness = dc(
            () => () => (
                <PgApiAutocomplete
                    fetcher={async () => ({ items: [], hasMore: false })}
                    preloadOnOpen={false}
                    items={[{ id: "m_1", title: "Acme Markets" }]}
                    itemTitle="title"
                    itemValue="id"
                    modelValue="m_1"
                />
            ),
            { props: {} },
        );
        const { el, unmount } = mount(Harness, {});
        await nextFrame();
        expect(el.querySelector(".pg-ac-chip, input")?.textContent ?? "").not.toContain("m_1");
        const input = el.querySelector("input") as HTMLInputElement;
        expect(input.value).toBe("Acme Markets");
        unmount();
    });

    it("queries the endpoint with the default search param and the page", async () => {
        const calls: Array<{ url: string; params: Record<string, any> }> = [];
        const Harness = dc(
            () => {
                providePgUiConfig({
                    api: {
                        get: async (url: string, options: any) => {
                            calls.push({ url, params: options?.params ?? {} });
                            return {
                                data: {
                                    items: [{ title: "Acme Markets", value: "m_1" }],
                                    hasMore: false,
                                },
                            };
                        },
                    },
                });
                return () => (
                    <PgApiAutocomplete
                        endpoint="/internal/merchants"
                        debounceMs={5}
                        preloadOnOpen={false}
                        itemTitle="title"
                        itemValue="value"
                    />
                );
            },
            { props: {} },
        );
        const { el, unmount } = mount(Harness, {});
        await openAutocomplete(el);
        const input = el.querySelector("input") as HTMLInputElement;
        input.focus();
        typeInto(input, "ac");
        await wait(40);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe("/internal/merchants");
        expect(calls[0]!.params).toEqual({ page: 1, search: "ac" });
        expect(optionLabels(el)).toEqual(["Acme Markets"]);
        unmount();
    });
});

describe("PgDateInput", () => {
    it("renders seven LTR weekday headers Sunday..Saturday", async () => {
        const { el, unmount } = mount(DateHarness, { initial: "2026-11-10" });
        (el.querySelector("[data-pg-date]") as HTMLElement).click();
        await nextFrame();
        const headers = [...el.querySelectorAll(".pg-cal-weekday")];
        expect(headers.map((node) => node.getAttribute("aria-label"))).toEqual([
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
        ]);
        expect(headers.map((node) => node.textContent)).toEqual([
            "Su",
            "Mo",
            "Tu",
            "We",
            "Th",
            "Fr",
            "Sa",
        ]);
        expect(document.documentElement.dir).toBe("ltr");
        unmount();
    });

    it("emits the ISO date when a calendar day is clicked", async () => {
        const { el, unmount } = mount(DateHarness, { initial: "2026-11-10" });
        (el.querySelector("[data-pg-date]") as HTMLElement).click();
        await nextFrame();
        (el.querySelector('[data-iso="2026-11-20"]') as HTMLElement).click();
        await nextFrame();
        expect(readOut(el)).toBe("2026-11-20");
        expect(el.querySelector("[data-pg-date-panel]")).toBeNull();
        unmount();
    });

    it("commits a typed YYYY-MM-DD on Enter and reverts an impossible date", async () => {
        const { el, unmount } = mount(DateHarness, {});
        const input = el.querySelector(".pg-date-input") as HTMLInputElement;
        input.focus();
        await nextFrame();
        typeInto(input, "2026-11-27");
        press(input, "Enter");
        await nextFrame();
        expect(readOut(el)).toBe("2026-11-27");

        typeInto(input, "2026-99-99");
        press(input, "Enter");
        await nextFrame();
        expect(readOut(el)).toBe("2026-11-27");
        expect(input.value).toBe("2026-11-27");
        expect(el.querySelector(".pg-field__error")?.textContent).toContain(
            "valid date",
        );
        unmount();
    });

    it("keeps the legacy Date[] range contract and closes on the second click", async () => {
        const { el, unmount } = mount(LegacyRangeHarness, {
            initial: [new Date(2026, 10, 1, 12), new Date(2026, 10, 5, 12)],
        });
        (el.querySelector("[data-pg-date]") as HTMLElement).click();
        await nextFrame();
        (el.querySelector('[data-iso="2026-11-20"]') as HTMLElement).click();
        await nextFrame();
        expect(el.querySelector("[data-pg-date-panel]")).not.toBeNull();
        (el.querySelector('[data-iso="2026-11-10"]') as HTMLElement).click();
        await nextFrame();
        expect(readOut(el)).toEqual(["2026-11-10", "2026-11-20"]);
        expect(el.querySelector("[data-pg-date-panel]")).toBeNull();
        unmount();
    });
});

describe("PgDateRangeInput", () => {
    it("swaps the endpoints when the second click is earlier", async () => {
        const { el, unmount } = mount(RangeHarness, {
            initial: { start: "2026-11-01", end: "2026-11-05" },
        });
        (el.querySelector("[data-pg-date-range]") as HTMLElement).click();
        await nextFrame();
        (el.querySelector('[data-iso="2026-11-20"]') as HTMLElement).click();
        await nextFrame();
        (el.querySelector('[data-iso="2026-11-10"]') as HTMLElement).click();
        await nextFrame();
        expect(readOut(el)).toEqual({ start: "2026-11-10", end: "2026-11-20" });
        unmount();
    });

    it("emits the exact 30-day range from the Last 30 Days preset", async () => {
        const { el, unmount } = mount(RangeHarness, {
            initial: { start: "2026-11-01", end: "2026-11-05" },
        });
        (el.querySelector("[data-pg-date-range]") as HTMLElement).click();
        await nextFrame();
        const preset = [...el.querySelectorAll(".pg-date-preset")].find((node) =>
            node.textContent?.includes("Last 30 Days"),
        ) as HTMLElement;
        expect(preset).toBeTruthy();
        preset.click();
        await nextFrame();
        const emitted = readOut(el);
        expect(emitted).toEqual(last30Days());
        const day = 24 * 60 * 60 * 1000;
        expect(
            (new Date(emitted.end).getTime() - new Date(emitted.start).getTime()) / day,
        ).toBe(29);
        unmount();
    });

    it("previews the range band while hovering the second endpoint", async () => {
        const { el, unmount } = mount(RangeHarness, {
            initial: { start: "2026-11-01", end: "2026-11-05" },
        });
        (el.querySelector("[data-pg-date-range]") as HTMLElement).click();
        await nextFrame();
        (el.querySelector('[data-iso="2026-11-10"]') as HTMLElement).click();
        await nextFrame();
        const hovered = el.querySelector('[data-iso="2026-11-15"]') as HTMLElement;
        hovered.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
        await nextFrame();
        expect(
            el.querySelector('[data-iso="2026-11-12"]')?.classList.contains("pg-cal-day--in-range"),
        ).toBe(true);
        expect(
            el.querySelector('[data-iso="2026-11-15"]')?.classList.contains("pg-cal-day--hover-end"),
        ).toBe(true);
        unmount();
    });

    it("renders the dual calendar and the 152px preset sidebar", async () => {
        const { el, unmount } = mount(RangeHarness, {
            initial: { start: "2026-11-01", end: "2026-11-05" },
        });
        (el.querySelector("[data-pg-date-range]") as HTMLElement).click();
        await nextFrame();
        expect(el.querySelectorAll("[data-pg-calendar]").length).toBe(2);
        expect(el.querySelector(".pg-date-range__presets")).not.toBeNull();
        expect(last30Days().end >= last30Days().start).toBe(true);
        expect(advancedCss).toMatch(/\.pg-date-range__presets \{[\s\S]*?flex: 0 0 152px/);
        expect(advancedCss).toMatch(
            /@media \(max-width: 767px\) \{[\s\S]*?data-pg-date-month="1"/,
        );
        unmount();
    });

    it("renders the start → end value in the trigger", async () => {
        const { el, unmount } = mount(RangeHarness, {
            initial: { start: "2026-11-01", end: "2026-11-05" },
        });
        const input = el.querySelector(".pg-date-range-input") as HTMLInputElement;
        expect(input.value).toBe("2026-11-01 → 2026-11-05");
        unmount();
    });
});

describe("TableFilters", () => {
    const filters: any[] = [
        { key: "created", label: "Created", type: "daterange", queryFrom: "from", queryTo: "to" },
        { key: "posted", label: "Posted", type: "date", single: true },
        {
            key: "status",
            label: "Status",
            type: "multiselect",
            options: [
                { title: "Active", value: "ACTIVE" },
                { title: "Pending", value: "PENDING" },
            ],
        },
        { key: "amount", label: "Amount", type: "numberRange" },
    ];

    const FiltersHarness = dc(
        (props: any) => {
            const values = ref<any>({});
            return () => (
                <div>
                    <span class="out">{JSON.stringify(values.value)}</span>
                    <TableFilters
                        filters={props.filters}
                        values={values.value}
                        total={12}
                        onChange={(key: string, value: unknown) => {
                            const next = { ...values.value };
                            if (value === undefined) delete next[key];
                            else next[key] = value;
                            values.value = next;
                        }}
                        onClear={() => (values.value = {})}
                    />
                </div>
            );
        },
        { props: { filters: { type: Array, default: () => [] } } },
    );

    it("renders no filter surface at all when there are no filter definitions", async () => {
        const { el, unmount } = mount(FiltersHarness, { filters: [] });
        expect(el.querySelector(".pg-table-filters")).toBeNull();
        expect(el.querySelector("[class*='filter']")).toBeNull();
        unmount();
    });

    it("renders exactly one label per filter (date controls never duplicate it)", async () => {
        const { el, unmount } = mount(FiltersHarness, { filters });
        const created = el.querySelector('[data-pg-filter="created"]') as HTMLElement;
        const posted = el.querySelector('[data-pg-filter="posted"]') as HTMLElement;
        expect(created.querySelectorAll(".pg-filter-label").length).toBe(1);
        expect(posted.querySelectorAll(".pg-filter-label").length).toBe(1);
        expect(posted.querySelectorAll(".pg-field__label").length).toBe(0);
        // The date filter is the Vapor calendar control, never a native input.
        expect(created.querySelector("[data-pg-date-range]")).not.toBeNull();
        expect(posted.querySelector("[data-pg-date]")).not.toBeNull();
        expect(el.querySelectorAll("select").length).toBe(0);
        unmount();
    });

    it("keeps the status multi-select open and renders Label: A, B chips", async () => {
        const { el, unmount } = mount(FiltersHarness, { filters });
        const status = el.querySelector('[data-pg-filter="status"]') as HTMLElement;
        (status.querySelector("[data-pg-autocomplete]") as HTMLElement).click();
        await nextFrame();
        clickOption(status.querySelectorAll(".pg-ac-option")[0]!);
        await nextFrame();
        expect(status.querySelector("[data-pg-ac-panel]")).not.toBeNull();
        clickOption(status.querySelectorAll(".pg-ac-option")[1]!);
        await nextFrame();
        expect(status.querySelector("[data-pg-ac-panel]")).not.toBeNull();
        expect(readOut(el)).toEqual({ status: ["ACTIVE", "PENDING"] });
        const chip = el.querySelector(".pg-filter-chip");
        expect(chip?.textContent).toContain("Status:");
        expect(chip?.textContent).toContain("Active, Pending");

        (el.querySelector(".pg-table-filters__clear button") as HTMLElement).click();
        await nextFrame();
        expect(readOut(el)).toEqual({});
        expect(el.querySelector(".pg-filter-chip")).toBeNull();
        unmount();
    });

    it("never injects a bordered refresh box into an api autocomplete filter", async () => {
        const apiFilters: any[] = [
            {
                key: "merchantId",
                label: "Merchant",
                type: "apiAutocomplete",
                load: async () => [{ title: "Acme Markets", value: "m_1" }],
            },
        ];
        const { el, unmount } = mount(FiltersHarness, { filters: apiFilters });
        const field = el.querySelector('[data-pg-filter="merchantId"]') as HTMLElement;
        expect(field.querySelector('[aria-label="Refresh options"]')).toBeNull();
        expect(field.querySelector(".pg-btn")).toBeNull();
        expect(field.querySelector(".pg-ac-refresh")).toBeNull();
        (field.querySelector("[data-pg-autocomplete]") as HTMLElement).click();
        await nextFrame();
        expect(field.querySelectorAll(".pg-ac-option").length).toBe(1);
        unmount();
    });
});

describe("Date pickers — mobile bottom sheet", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.style.overflow = "";
    });

    it("keeps the desktop popover when the viewport is wide", async () => {
        const { el, unmount } = mount(DateHarness, { initial: "2026-11-10" });
        (el.querySelector("[data-pg-date]") as HTMLElement).click();
        await nextFrame();
        const panel = el.querySelector("[data-pg-date-panel]") as HTMLElement;
        expect(panel.classList.contains("pg-date-sheet")).toBe(false);
        expect(el.querySelector("[data-pg-date-scrim]")).toBeNull();
        expect(panel.getAttribute("aria-modal")).toBe("false");
        unmount();
    });

    it("switches to a sheet automatically on a phone-sized viewport", async () => {
        vi.stubGlobal(
            "matchMedia",
            (query: string) =>
                ({
                    matches: query.includes("max-width: 640px"),
                    media: query,
                    addEventListener: () => undefined,
                    removeEventListener: () => undefined,
                }) as unknown as MediaQueryList,
        );
        const { el, unmount } = mount(DateHarness, { initial: "2026-11-10" });
        (el.querySelector("[data-pg-date]") as HTMLElement).click();
        await nextFrame();
        expect(
            el.querySelector("[data-pg-date-panel]")?.classList.contains("pg-date-sheet"),
        ).toBe(true);
        unmount();
    });

    it("PgDateInput sheet: no virtual keyboard, scroll lock, header, commit closes", async () => {
        const { el, unmount } = mount(DateHarness, { initial: "2026-11-10", sheet: "always" });
        const input = el.querySelector(".pg-date-input") as HTMLInputElement;
        expect(input.readOnly).toBe(true);
        expect(input.getAttribute("inputmode")).toBe("none");

        (el.querySelector("[data-pg-date]") as HTMLElement).click();
        await nextFrame();
        const panel = el.querySelector("[data-pg-date-panel]") as HTMLElement;
        expect(panel.classList.contains("pg-date-sheet")).toBe(true);
        expect(panel.getAttribute("aria-modal")).toBe("true");
        expect(el.querySelector("[data-pg-date-scrim]")).not.toBeNull();
        expect(panel.querySelector(".pg-date-sheet__value")?.textContent).toBe("2026-11-10");
        expect(document.body.style.overflow).toBe("hidden");

        (el.querySelector('[data-iso="2026-11-20"]') as HTMLElement).click();
        await nextFrame();
        expect(readOut(el)).toBe("2026-11-20");
        expect(el.querySelector("[data-pg-date-panel]")).toBeNull();
        expect(el.querySelector("[data-pg-date-scrim]")).toBeNull();
        expect(document.body.style.overflow).toBe("");
        unmount();
    });

    it("PgDateInput sheet closes from the close button and the scrim without committing", async () => {
        const { el, unmount } = mount(DateHarness, { initial: "2026-11-10", sheet: "always" });
        (el.querySelector("[data-pg-date]") as HTMLElement).click();
        await nextFrame();
        (el.querySelector(".pg-date-sheet__close") as HTMLElement).click();
        await nextFrame();
        expect(el.querySelector("[data-pg-date-panel]")).toBeNull();

        (el.querySelector("[data-pg-date]") as HTMLElement).click();
        await nextFrame();
        const scrim = el.querySelector("[data-pg-date-scrim]") as HTMLElement;
        scrim.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        await nextFrame();
        // The scrim swallows the pointerdown so the tap never reaches the page below.
        expect(el.querySelector("[data-pg-date-panel]")).not.toBeNull();
        scrim.click();
        await nextFrame();
        expect(el.querySelector("[data-pg-date-panel]")).toBeNull();
        expect(readOut(el)).toBe("2026-11-10");
        unmount();
    });

    it("PgDateRangeInput sheet: start/end endpoints drive picking and Apply commits", async () => {
        const { el, unmount } = mount(RangeHarness, {
            initial: { start: "2026-11-01", end: "2026-11-05" },
            sheet: "always",
        });
        (el.querySelector("[data-pg-date-range]") as HTMLElement).click();
        await nextFrame();
        const panel = el.querySelector("[data-pg-date-range-panel]") as HTMLElement;
        expect(panel.classList.contains("pg-date-sheet")).toBe(true);
        const startBtn = () => el.querySelector('[data-pg-date-endpoint="start"]') as HTMLElement;
        const endBtn = () => el.querySelector('[data-pg-date-endpoint="end"]') as HTMLButtonElement;
        expect(startBtn().getAttribute("aria-pressed")).toBe("true");
        expect(startBtn().textContent).toContain("2026-11-01");
        expect(endBtn().textContent).toContain("2026-11-05");

        // Re-target only the end date: the start is kept.
        endBtn().click();
        await nextFrame();
        expect(endBtn().getAttribute("aria-pressed")).toBe("true");
        (el.querySelector('[data-pg-date-month="0"] [data-iso="2026-11-12"]') as HTMLElement).click();
        await nextFrame();
        expect(readOut(el)).toEqual({ start: "2026-11-01", end: "2026-11-12" });
        expect(el.querySelector("[data-pg-date-range-panel]")).not.toBeNull();

        const apply = [...el.querySelectorAll(".pg-date-range__actions .pg-btn")].find((node) =>
            node.textContent?.includes("Apply"),
        ) as HTMLElement;
        apply.click();
        await nextFrame();
        expect(el.querySelector("[data-pg-date-range-panel]")).toBeNull();
        unmount();
    });

    it("scopes every sheet rule to .pg-date-sheet and keeps 44px day targets", () => {
        expect(advancedCss).toMatch(/\.pg-date-sheet \.pg-cal-day \{[\s\S]*?height: 44px/);
        expect(advancedCss).toMatch(/env\(safe-area-inset-bottom/);
        expect(advancedCss).toMatch(/\.pg-date-sheet \.pg-date-range__presets \{[\s\S]*?flex-direction: row/);
    });
});

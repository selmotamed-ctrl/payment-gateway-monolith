import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ref } from "vue";

import { dc } from "../src/lib/dc";
import { PgTable } from "../src/data/table/Table";
import { PgTableRowActions } from "../src/data/table/TableRowActions";
import { PgTableFooter, useTableXlsx } from "../src/data/table/HeaderFooter";
import { PgProvider } from "../src/provider/PgProvider";
import { PgApiTable } from "../src/data/table/PgApiTable";
import { activeFilterCount, buildFilterQuery, filterToQuery, isFilterActive, type TableFilter } from "../src/data/table/filters";
import { readCell, sortRowsByHeader, type TableHeader } from "../src/data/table/types";
import { mount, wait } from "./helpers/render";

const tableCss = readFileSync("src/tokens/parts/table.css", "utf8");
const rowActionsSource = readFileSync("src/data/table/TableRowActions.tsx", "utf8");
const componentsCss = readFileSync("src/tokens/components.css", "utf8");

type Payment = {
    id: string;
    reference: string;
    amount: string;
    status: string;
    createdAt?: string;
};

const headers: TableHeader<Payment>[] = [
    { key: "reference", label: "Reference", value: "reference" },
    { key: "amount", label: "Amount", value: "amount", format: "money" },
    { key: "status", label: "Status", value: "status" },
];

const payments: Payment[] = Array.from({ length: 10 }, (_, index) => ({
    id: `id-${index}`,
    reference: `P-${index}`,
    amount: String(100 - index * 5),
    status: index % 2 === 0 ? "SUCCEEDED" : "FAILED",
    createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
}));

const firstRowText = (root: ParentNode): string =>
    Array.from(root.querySelectorAll("tbody tr")[0]?.querySelectorAll("td") ?? [])
        .map((cell) => cell.textContent?.trim())
        .join("|");

describe("PgTable", () => {
    it("renders ten rows inside the shell, scroll wrapper and unified table", () => {
        const { el, unmount } = mount(PgTable, { headers, items: payments });

        expect(el.querySelector(".pg-table-shell")).toBeTruthy();
        expect(el.querySelector(".table-wrapper.pg-table-scroll")).toBeTruthy();
        expect(el.querySelector(".pg-table-shell > .table-wrapper.pg-table-scroll > table.pg-unified-table")).toBeTruthy();
        expect(el.querySelectorAll("tbody tr").length).toBe(10);
        expect(el.querySelector("tbody tr")?.classList.contains("table-data-row")).toBe(true);

        unmount();
    });

    it("declares the 48px row and opaque sticky action contracts in the table CSS", () => {
        expect(tableCss).toMatch(
            /\.pg-table-shell \.pg-unified-table > tbody > tr > td\s*\{[\s\S]*?height:\s*48px/,
        );
        expect(tableCss).toMatch(
            /\.pg-table-shell \.pg-col-actions\s*\{[\s\S]*?position:\s*sticky[\s\S]*?inset-inline-end:\s*0[\s\S]*?background:/,
        );
        expect(tableCss).toMatch(/font-size:\s*11\.5px[\s\S]*?text-transform:\s*uppercase/);
        expect(tableCss).toMatch(/overflow-x:\s*auto/);
    });

    it("cycles sortable headers asc -> desc -> none and updates aria-sort", async () => {
        const { el, unmount } = mount(PgTable, { headers, items: payments });
        const amountHeader = el.querySelectorAll("th")[1] as HTMLTableCellElement;
        const sortButton = amountHeader.querySelector(".pg-table__sort") as HTMLButtonElement;

        expect(sortButton).toBeTruthy();
        expect(amountHeader.getAttribute("aria-sort")).toBe("none");

        sortButton.click();
        await wait(10);
        expect(amountHeader.getAttribute("aria-sort")).toBe("ascending");
        expect(firstRowText(el)).toContain("55");

        sortButton.click();
        await wait(10);
        expect(amountHeader.getAttribute("aria-sort")).toBe("descending");
        expect(firstRowText(el)).toContain("100");

        sortButton.click();
        await wait(10);
        expect(amountHeader.getAttribute("aria-sort")).toBe("none");
        expect(firstRowText(el)).toContain("P-0");

        unmount();
    });

    it("filters rows through the built-in PgSearchInput", async () => {
        const { el, unmount } = mount(PgTable, { headers, items: payments, searchable: true });
        const input = el.querySelector(".pg-table-toolbar input[type='search']") as HTMLInputElement;

        expect(input).toBeTruthy();
        input.value = "P-3";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await wait(20);

        const rows = el.querySelectorAll("tbody tr");
        expect(rows.length).toBe(1);
        expect(rows[0]?.textContent).toContain("P-3");

        unmount();
    });

    it("does not fire rowClick when the click starts inside a control", () => {
        const onRowClick = vi.fn();
        const headersWithButton: TableHeader<Payment>[] = [
            { key: "reference", label: "Reference", Value: () => <button class="cell-btn">Inspect</button> },
            { key: "amount", label: "Amount", value: "amount" },
        ];
        const RowClickRoot = dc(
            () => () => <PgTable headers={headersWithButton} items={[payments[0]]} onRowClick={onRowClick} />,
            {},
        );
        const { el, unmount } = mount(RowClickRoot);

        (el.querySelector(".cell-btn") as HTMLButtonElement).click();
        expect(onRowClick).not.toHaveBeenCalled();

        (el.querySelectorAll("tbody tr td")[1] as HTMLElement).click();
        expect(onRowClick).toHaveBeenCalledTimes(1);

        unmount();
    });
});

/* ------------------------------------------------------------------ row actions */

const ActionsHarness = dc(
    (props: { firstPrimary: any; firstItems: any[]; secondItems: any[] }, _expose, _ctx) => () => (
        <table>
            <tbody>
                <tr>
                    <td>row one</td>
                    <td>
                        <PgTableRowActions primaryAction={props.firstPrimary} items={props.firstItems} />
                    </td>
                </tr>
                <tr>
                    <td>row two</td>
                    <td>
                        <PgTableRowActions items={props.secondItems} />
                    </td>
                </tr>
            </tbody>
        </table>
    ),
    { props: ["firstPrimary", "firstItems", "secondItems"] },
);

describe("PgTableRowActions", () => {
    it("runs the primary action once and never bubbles to the row", () => {
        const primary = { label: "Inspect", icon: "mdi-eye-outline", onClick: vi.fn() };
        const { el, unmount } = mount(ActionsHarness, {
            firstPrimary: primary,
            firstItems: [],
            secondItems: [],
        });
        const row = el.querySelector("tbody tr") as HTMLTableRowElement;
        const rowClick = vi.fn();
        row.addEventListener("click", rowClick);

        (el.querySelector(".pg-row-actions__primary") as HTMLButtonElement).click();

        expect(primary.onClick).toHaveBeenCalledTimes(1);
        expect(rowClick).not.toHaveBeenCalled();
        unmount();
    });

    it("mounts the overflow panel in the root floating layer and closes after an item click", async () => {
        const item = { key: "open", label: "Open", onClick: vi.fn() };
        const danger = { key: "delete", label: "Delete", danger: true, dividerBefore: true, onClick: vi.fn() };
        const hidden = { key: "hidden", label: "Hidden action", hidden: true, onClick: vi.fn() };
        const { el, unmount } = mount(ActionsHarness, {
            firstPrimary: null,
            firstItems: [item, danger, hidden],
            secondItems: [danger],
        });

        (el.querySelector(".pg-row-actions__more") as HTMLButtonElement).click();
        await wait(20);

        const panel = document.querySelector(".pg-row-actions__panel") as HTMLElement | null;
        expect(panel).toBeTruthy();
        expect(panel?.getAttribute("role")).toBe("menu");
        expect(panel?.parentElement?.hasAttribute("data-pg-floating-layer")).toBe(true);
        expect(panel?.closest("table")).toBeNull();
        expect(panel?.closest("body")).toBe(document.body);
        expect(panel?.textContent).not.toContain("Hidden action");
        expect(panel?.querySelector(".pg-menu-divider")).toBeTruthy();
        expect(componentsCss).toMatch(
            /\.pg-row-actions__panel\s*\{[\s\S]*?position:\s*fixed[\s\S]*?z-index:\s*var\(--pg-z-popover\)/,
        );
        expect(componentsCss).toMatch(/\.pg-row-actions__more\s*\{[\s\S]*?width:\s*30px[\s\S]*?height:\s*30px/);

        const menuItems = panel!.querySelectorAll("[role='menuitem']");
        expect(menuItems.length).toBe(2);
        expect((menuItems[1] as HTMLElement).classList.contains("pg-menu-item--danger")).toBe(true);
        (menuItems[0] as HTMLButtonElement).click();
        await wait(20);

        expect(item.onClick).toHaveBeenCalledTimes(1);
        expect(document.querySelector(".pg-row-actions__panel")).toBeNull();
        expect(rowActionsSource).not.toMatch(/import\s*\{[^}]*\bTeleport\b/);
        unmount();
    });

    it("opens the same menu on a row contextmenu at the pointer coordinates", async () => {
        const { el, unmount } = mount(ActionsHarness, {
            firstPrimary: null,
            firstItems: [{ key: "open", label: "Open", onClick: vi.fn() }],
            secondItems: [{ key: "close", label: "Close", onClick: vi.fn() }],
        });
        const row = el.querySelector("tbody tr") as HTMLTableRowElement;
        const event = new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 120,
            clientY: 240,
        });

        row.dispatchEvent(event);
        await wait(20);

        expect(event.defaultPrevented).toBe(true);
        const panel = document.querySelector(".pg-row-actions__panel") as HTMLElement | null;
        expect(panel).toBeTruthy();
        expect(Math.round(parseFloat(panel!.style.left))).toBe(120);
        expect(Math.round(parseFloat(panel!.style.top))).toBe(240);

        // A menu near the bottom edge flips above the pointer and clamps at 8px.
        row.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5000, clientY: 760 }),
        );
        await wait(20);
        const flipped = document.querySelector(".pg-row-actions__panel") as HTMLElement | null;
        expect(flipped).toBeTruthy();
        expect(parseFloat(flipped!.style.top)).toBeLessThan(760);
        expect(parseFloat(flipped!.style.left)).toBeLessThanOrEqual(1280 - 210 - 8);
        unmount();
    });

    it("closes on Escape and returns focus to the overflow button", async () => {
        const { el, unmount } = mount(ActionsHarness, {
            firstPrimary: null,
            firstItems: [{ key: "open", label: "Open", onClick: vi.fn() }],
            secondItems: [{ key: "close", label: "Close", onClick: vi.fn() }],
        });
        const more = el.querySelector(".pg-row-actions__more") as HTMLButtonElement;
        more.click();
        await wait(20);
        expect(document.querySelector(".pg-row-actions__panel")).toBeTruthy();

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await wait(20);

        expect(document.querySelector(".pg-row-actions__panel")).toBeNull();
        expect(document.activeElement).toBe(more);
        unmount();
    });

    it("keeps only one row menu open at a time", async () => {
        const { el, unmount } = mount(ActionsHarness, {
            firstPrimary: null,
            firstItems: [{ key: "first", label: "First row action", onClick: vi.fn() }],
            secondItems: [{ key: "second", label: "Second row action", onClick: vi.fn() }],
        });
        const buttons = el.querySelectorAll(".pg-row-actions__more");

        (buttons[0] as HTMLButtonElement).click();
        await wait(20);
        (buttons[1] as HTMLButtonElement).click();
        await wait(20);

        const panels = document.querySelectorAll(".pg-row-actions__panel");
        expect(panels.length).toBe(1);
        expect(panels[0]?.textContent).toContain("Second row action");
        unmount();
    });
});

/* -------------------------------------------------------------------- ApiTable */

type FetchCall = {
    params: Record<string, any>;
    signal: AbortSignal;
    resolve: (value: unknown) => void;
};

const deferredFetcher = () => {
    const calls: FetchCall[] = [];
    const fetcher = (params: Record<string, any>, signal: AbortSignal) =>
        new Promise((resolve) => {
            calls.push({ params, signal, resolve });
        });
    return { calls, fetcher };
};

describe("PgApiTable", () => {
    it("aborts the previous request and renders only the latest filter response", async () => {
        const { calls, fetcher } = deferredFetcher();
        const RaceRoot = dc(
            () => () => (
                <PgApiTable
                    title="Payments"
                    headers={headers}
                    fetcher={fetcher}
                    syncUrl={false}
                    defaultPageSize={25}
                />
            ),
            {},
        );
        const { el, unmount } = mount(RaceRoot);
        await wait(30);
        expect(calls.length).toBe(1);

        const input = el.querySelector(".pg-table-toolbar input[type='search']") as HTMLInputElement;
        input.value = "B";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await wait(500);

        expect(calls.length).toBe(2);
        expect(calls[0]!.signal.aborted).toBe(true);
        expect(calls[1]!.params.search).toBe("B");
        expect(calls[1]!.params.page).toBe(1);

        calls[1]!.resolve({ items: [{ id: "B-1", reference: "B-1", amount: "1", status: "SUCCEEDED" }], total: 1 });
        await wait(30);
        expect(el.textContent).toContain("B-1");

        // A late response from the aborted request must never flash over the new rows.
        calls[0]!.resolve({ items: [{ id: "A-1", reference: "A-1", amount: "9", status: "FAILED" }], total: 1 });
        await wait(30);
        expect(el.textContent).toContain("B-1");
        expect(el.textContent).not.toContain("A-1");

        unmount();
    });

    it("resets to page 1 when the page size changes", async () => {
        const { calls, fetcher } = deferredFetcher();
        const Pager = dc(
            () => {
                const size = ref(10);
                return () => (
                    <div>
                        <button class="set-size" type="button" onClick={() => (size.value = 50)}>
                            50
                        </button>
                        <PgApiTable
                            headers={headers}
                            fetcher={fetcher}
                            numberOfItemsPerPage={size.value}
                            syncUrl={false}
                        />
                    </div>
                );
            },
            {},
        );

        const { el, unmount } = mount(Pager);
        await wait(30);
        expect(calls.length).toBe(1);
        calls[0]!.resolve({ items: payments.slice(0, 10), total: 30 });
        await wait(30);

        (el.querySelector("button[aria-label='Next page']") as HTMLButtonElement).click();
        await wait(30);
        expect(calls.length).toBe(2);
        expect(calls[1]!.params.page).toBe(2);
        calls[1]!.resolve({ items: payments.slice(0, 10), total: 30 });
        await wait(30);

        const activePage = el.querySelector("button[aria-current='page']") as HTMLButtonElement;
        expect(activePage?.textContent?.trim()).toBe("2");

        (el.querySelector(".set-size") as HTMLButtonElement).click();
        await wait(30);

        expect(calls.length).toBe(3);
        expect(calls[2]!.params.page).toBe(1);
        expect(calls[2]!.params.pageSize).toBe(50);

        unmount();
    });

    it("accepts a { data, meta: { total } } envelope and keeps rows during a background refetch", async () => {
        const { calls, fetcher } = deferredFetcher();
        const Root = dc(
            () => () => (
                <PgApiTable
                    title="Payments"
                    headers={headers}
                    fetcher={fetcher}
                    syncUrl={false}
                    defaultPageSize={10}
                />
            ),
            {},
        );
        const { el, unmount } = mount(Root);
        await wait(30);

        calls[0]!.resolve({
            data: [{ id: "one", reference: "ONE-1", amount: "10", status: "SUCCEEDED" }],
            meta: { total: 42 },
        });
        await wait(30);

        expect(el.textContent).toContain("ONE-1");
        expect(el.textContent).toContain("Showing 1–10 of 42");

        const exportButton = el.querySelector(
            "button[aria-label='Download Current Data as Excel Sheet']",
        ) as HTMLButtonElement;
        expect(exportButton.disabled).toBe(false);

        (el.querySelector(".pg-table-toolbar button[aria-label='Refresh']") as HTMLButtonElement).click();
        await wait(30);

        expect(calls.length).toBe(2);
        expect(el.querySelector(".pg-table-refetch")).toBeTruthy();
        expect(el.textContent).toContain("ONE-1");

        calls[1]!.resolve({
            data: [{ id: "two", reference: "TWO-2", amount: "20", status: "SUCCEEDED" }],
            meta: { total: 42 },
        });
        await wait(30);

        expect(el.querySelector(".pg-table-refetch")).toBeNull();
        expect(el.textContent).toContain("TWO-2");
        unmount();
    });

    it("renders the PgStateView error state and recovers on Retry", async () => {
        let attempt = 0;
        const fetcher = () => {
            attempt += 1;
            if (attempt === 1) return Promise.reject(new Error("boom"));
            return Promise.resolve({
                items: [{ id: "recovered", reference: "REC-1", amount: "5", status: "SUCCEEDED" }],
                total: 1,
            });
        };
        const Root = dc(
            () => () => <PgApiTable title="Payments" headers={headers} fetcher={fetcher} syncUrl={false} />,
            {},
        );
        const { el, unmount } = mount(Root);
        await wait(30);

        expect(el.querySelector(".pg-state-view")).toBeTruthy();
        expect(el.textContent).toContain("Could not load data");

        const retry = Array.from(el.querySelectorAll(".pg-state-view button")).find((button) =>
            button.textContent?.includes("Retry"),
        ) as HTMLButtonElement | undefined;
        expect(retry).toBeTruthy();
        retry!.click();
        await wait(40);

        expect(el.querySelector(".pg-state-view")).toBeNull();
        expect(el.textContent).toContain("REC-1");
        unmount();
    });

    it("shows a Reset all filters action when a filtered search returns nothing", async () => {
        const { calls, fetcher } = deferredFetcher();
        const EmptyRoot = dc(
            () => () => (
                <PgApiTable
                    title="Payments"
                    headers={headers}
                    fetcher={fetcher}
                    syncUrl={false}
                    defaultPageSize={10}
                />
            ),
            {},
        );
        const { el, unmount } = mount(EmptyRoot);
        await wait(30);
        calls[0]!.resolve({ items: payments.slice(0, 5), total: 5 });
        await wait(30);

        const input = el.querySelector(".pg-table-toolbar input[type='search']") as HTMLInputElement;
        input.value = "ZZZ";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await wait(500);
        calls[1]!.resolve({ items: [], total: 0 });
        await wait(40);

        const reset = Array.from(el.querySelectorAll("button")).find((button) =>
            button.textContent?.includes("Reset all filters"),
        ) as HTMLButtonElement | undefined;
        expect(reset).toBeTruthy();
        expect(el.textContent).toContain("No matching records");
        unmount();
    });

    it("renders 0 results in the footer and disables both pagination ends", () => {
        const { el, unmount } = mount(PgTableFooter, { page: 1, pageSize: 25, total: 0 });
        expect(el.textContent).toContain("0 results");

        const prev = el.querySelector("button[aria-label='Previous page']") as HTMLButtonElement;
        const next = el.querySelector("button[aria-label='Next page']") as HTMLButtonElement;
        expect(prev.disabled).toBe(true);
        expect(next.disabled).toBe(true);
        expect(el.querySelector("button[aria-label='Page 1']")).toBeTruthy();
        unmount();
    });

    it("renders an accessible 1–25 of 1,420 range and marks the active page", () => {
        const { el, unmount } = mount(PgTableFooter, { page: 2, pageSize: 25, total: 1420 });
        const text = el.textContent ?? "";
        expect(text).toContain("Showing 26–50 of 1,420");
        expect(text).not.toContain("Showing 1–25");

        const active = el.querySelector("button[aria-current='page']") as HTMLButtonElement;
        expect(active).toBeTruthy();
        expect(active.textContent?.trim()).toBe("2");
        expect(active.getAttribute("aria-label")).toBe("Page 2");
        unmount();
    });
});

describe("useTableXlsx", () => {
    it("exports visible columns as formatted money/date strings and never raw objects", async () => {
        const captured: any[] = [];
        const exportHeaders: TableHeader<any>[] = [
            { key: "amount", label: "Amount", value: "amount" },
            { key: "createdAt", label: "Created", value: "createdAt" },
            { key: "meta", label: "Meta", value: "meta" },
        ];
        const exportRows = [
            { amount: "100", createdAt: "2026-01-02T10:20:30.000Z", meta: { nested: true } },
        ];
        const Exporter = dc(
            () => {
                const { downloadXlsx } = useTableXlsx({
                    headers: () => exportHeaders,
                    data: () => exportRows,
                    title: () => "Payments",
                });
                return () => (
                    <button class="do-export" type="button" onClick={() => void downloadXlsx()}>
                        Export
                    </button>
                );
            },
            {},
        );
        const ExportRoot = dc(
            () => () => (
                <PgProvider
                    config={{
                        exportXlsx: async (payload: any) => {
                            captured.push(payload);
                        },
                    }}
                >
                    <Exporter />
                </PgProvider>
            ),
            {},
        );

        const { el, unmount } = mount(ExportRoot);
        (el.querySelector(".do-export") as HTMLButtonElement).click();
        await wait(30);

        expect(captured).toHaveLength(1);
        const outHeaders = captured[0].headers as TableHeader<any>[];
        const amount = outHeaders.find((header) => header.key === "amount");
        const created = outHeaders.find((header) => header.key === "createdAt");
        const meta = outHeaders.find((header) => header.key === "meta");
        const cellOf = (header: TableHeader<any> | undefined): string =>
            typeof header?.value === "function" ? (header.value as any)(exportRows[0], 0) : "";
        expect(cellOf(amount)).toBe("100.000 LYD");
        expect(cellOf(created)).toBe("2026-01-02 10:20:30 UTC");
        expect(cellOf(meta)).toBe('{"nested":true}');
        expect(cellOf(meta)).not.toContain("[object Object]");
        unmount();
    });
});

/* ---------------------------------------------------------------------- utils */

describe("table filter utilities", () => {
    const textFilter: TableFilter = { key: "search", label: "Search", type: "text" };
    const multiFilter: TableFilter = { key: "status", label: "Status", type: "data-autocomplete", options: [], multiple: true };
    const dateFilter: TableFilter = { key: "created", label: "Created", type: "date" };
    const booleanFilter: TableFilter = { key: "flagged", label: "Flagged", type: "boolean" };

    it("treats empty arrays, blank strings and empty ranges as inactive", () => {
        expect(isFilterActive(multiFilter, [])).toBe(false);
        expect(isFilterActive(textFilter, "   ")).toBe(false);
        expect(isFilterActive(dateFilter, { from: null, to: null })).toBe(false);
        expect(isFilterActive(dateFilter, { from: "", to: "" })).toBe(false);
        expect(isFilterActive(textFilter, null)).toBe(false);
        expect(isFilterActive(booleanFilter, false)).toBe(true);
        expect(isFilterActive(textFilter, "SADAD")).toBe(true);
    });

    it("never emits empty query parameters", () => {
        expect(filterToQuery(multiFilter, [])).toEqual({});
        expect(filterToQuery(multiFilter, ["", "  "])).toEqual({});
        expect(filterToQuery(multiFilter, ["ACTIVE", "", "PENDING"])).toEqual({ status: "ACTIVE,PENDING" });
        expect(filterToQuery(dateFilter, { from: "", to: "" })).toEqual({});
        expect(buildFilterQuery([textFilter, multiFilter, dateFilter], { search: " ", status: [] })).toEqual({});
    });

    it("counts only active filters", () => {
        expect(activeFilterCount([textFilter, multiFilter, dateFilter], {})).toBe(0);
        expect(
            activeFilterCount([textFilter, multiFilter, dateFilter], {
                search: "SADAD",
                status: [],
                created: { from: "2026-01-01" },
            }),
        ).toBe(2);
    });
});

describe("table sorting and cell reading", () => {
    it("sorts money columns numerically, not lexicographically", () => {
        const rows = [{ amount: "100.000" }, { amount: "90.000" }, { amount: "9.000" }];
        const moneyHeaders: TableHeader<any>[] = [{ key: "amount", label: "Amount", value: "amount" }];
        expect(sortRowsByHeader(rows, moneyHeaders, "amount", "asc").map((row) => row.amount)).toEqual([
            "9.000",
            "90.000",
            "100.000",
        ]);
        expect(sortRowsByHeader(rows, moneyHeaders, "amount", "desc").map((row) => row.amount)).toEqual([
            "100.000",
            "90.000",
            "9.000",
        ]);
    });

    it("sorts date columns chronologically", () => {
        const rows = [{ createdAt: "2026-03-01" }, { createdAt: "2026-01-01" }, { createdAt: "2026-02-01" }];
        const dateHeaders: TableHeader<any>[] = [{ key: "createdAt", label: "Created", value: "createdAt" }];
        expect(sortRowsByHeader(rows, dateHeaders, "createdAt", "asc").map((row) => row.createdAt)).toEqual([
            "2026-01-01",
            "2026-02-01",
            "2026-03-01",
        ]);
    });

    it("reads dot paths safely and never throws on a missing object", () => {
        expect(readCell("merchant.legalName", { merchant: { legalName: "Acme LLC" } }, 0)).toBe("Acme LLC");
        expect(readCell("merchant.legalName", { merchant: null }, 0)).toBe("");
        expect(readCell("merchant.legalName", {}, 0)).toBe("");
        expect(readCell(["merchant", "legalName"], { merchant: { legalName: "Acme LLC" } }, 0)).toBe("Acme LLC");
        expect(readCell(() => 42 as any, {}, 0)).toBe("42");
        expect(readCell("meta", { meta: { nested: true } }, 0)).toBe('{"nested":true}');
    });
});

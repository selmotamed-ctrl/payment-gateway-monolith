import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextTick } from "vue";
import { describe, expect, it } from "vitest";
import {
    classifyDiff,
    deepEqual,
    diffKindOf,
    formatJsonValue,
    humanizeKey,
    humanizePath,
    parsePath,
    toPointer,
} from "../src/data/json/jsonDiffModel";
import { JsonDiffViewer } from "../src/data/json/JsonDiffViewer";
import { JsonValueCell } from "../src/data/json/JsonValueCell";
import { JsonValueList } from "../src/data/json/JsonValueList";
import { mount } from "./helpers/render";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.resolve(here, "../src/tokens/parts/json.css"), "utf8");

const mountViewer = (props: Record<string, unknown>) => mount(JsonDiffViewer as any, props);
const mountCell = (props: Record<string, unknown>) => mount(JsonValueCell as any, props);
const mountList = (props: Record<string, unknown>) => mount(JsonValueList as any, props);

describe("jsonDiffModel labels and paths", () => {
    it("humanises snake_case, camelCase and acronyms", () => {
        expect(humanizeKey("settlement_iban_number")).toBe("Settlement IBAN Number");
        expect(humanizeKey("commissionReceivableCeiling")).toBe("Commission Receivable Ceiling");
        expect(humanizeKey("kybStatus")).toBe("KYB Status");
        expect(humanizePath("/payoutBankDetailsJson/iban")).toBe("Payout Bank Details · IBAN");
    });

    it("parses JSON pointers and dotted paths and converts back", () => {
        expect(parsePath("/a~1b/0/c~0d")).toEqual(["a/b", "0", "c~d"]);
        expect(parsePath("tiers[2].flat")).toEqual(["tiers", "2", "flat"]);
        expect(parsePath("$")).toEqual([]);
        expect(toPointer(["a/b", "c~d"])).toBe("/a~1b/c~0d");
        expect(toPointer([])).toBe("");
    });
});

describe("deepEqual", () => {
    it("compares nested objects and arrays structurally", () => {
        expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
        expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
        expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    });

    it("compares Dates by timestamp and BigInt by value", () => {
        expect(deepEqual(new Date("2026-11-27T10:00:00Z"), new Date("2026-11-27T10:00:00Z"))).toBe(true);
        expect(deepEqual(new Date("2026-11-27T10:00:00Z"), new Date("2026-11-27T10:00:01Z"))).toBe(false);
        expect(deepEqual({ amount: 10n }, { amount: 10n })).toBe(true);
    });

    it("survives circular references", () => {
        const a: any = { value: 1 };
        const b: any = { value: 1 };
        a.self = a;
        b.self = b;
        expect(deepEqual(a, b)).toBe(true);
    });
});

describe("diff classifier", () => {
    it("returns status/kind rows for { before, after } and keeps unchanged leaves", () => {
        const rows = classifyDiff({ before: { status: "PENDING", fee: 10 }, after: { status: "ACTIVE", fee: 10 } });
        const statusRow = rows.find((row) => row.key === "status")!;
        const feeRow = rows.find((row) => row.key === "fee")!;
        expect(statusRow).toMatchObject({ path: "/status", status: "modified", kind: "status", before: "PENDING", after: "ACTIVE" });
        expect(feeRow).toMatchObject({ path: "/fee", status: "unchanged", kind: "money", before: 10, after: 10 });
    });

    it("supports RFC-6902 arrays, { operations } and plain payloads", () => {
        const patch = classifyDiff([
            { op: "add", path: "/added", value: 1 },
            { op: "remove", path: "/removed", value: 2 },
            { op: "replace", path: "/changed", value: 4, oldValue: 3 },
        ]);
        expect(patch.map((row) => row.status)).toEqual(["added", "removed", "modified"]);

        const wrapped = classifyDiff({ operations: [{ op: "replace", path: "/tier", value: "HIGH", oldValue: "LOW" }] });
        expect(wrapped[0]).toMatchObject({ path: "/tier", status: "modified", kind: "status" });

        const payload = classifyDiff({ merchant_id: "m_1", monthly_volume: "1250.00" });
        expect(payload.map((row) => row.key)).toEqual(["merchant_id", "monthly_volume"]);
        expect(payload.every((row) => row.status === "unchanged")).toBe(true);
        expect(payload[1]).toMatchObject({ kind: "money" });
    });

    it("classifies money, status, date, list and object kinds", () => {
        expect(diffKindOf("totalAmount", "12.500")).toBe("money");
        expect(diffKindOf("total", "12.500")).toBe("money");
        expect(diffKindOf("unit_price", 3)).toBe("money");
        expect(diffKindOf("status", "ACTIVE")).toBe("status");
        expect(diffKindOf("createdAt", "2026-11-27T10:00:00Z")).toBe("date");
        expect(diffKindOf("rails", ["A"])).toBe("list");
        expect(diffKindOf("metadata", { a: 1 })).toBe("object");
        expect(diffKindOf("note", "plain text")).toBe("value");
    });

    it("never throws on BigInt or circular payloads", () => {
        const before: any = { a: 1, amount: 10n };
        const after: any = { a: 2, amount: 11n };
        before.self = before;
        after.self = after;
        expect(() => classifyDiff({ before, after })).not.toThrow();
        expect(formatJsonValue(before)).toContain("[Circular]");
        expect(formatJsonValue(10n)).toBe('"10"');
    });
});

describe("JsonDiffViewer", () => {
    it("shows only the changed row by default (mandatory contract)", () => {
        const { el, unmount } = mountViewer({
            diff: { before: { status: "PENDING", fee: 10 }, after: { status: "ACTIVE", fee: 10 } },
        });
        const rows = el.querySelectorAll(".pg-json-diff__row");
        expect(el.querySelector(".pg-json-diff")).toBeTruthy();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.classList.contains("pg-json-diff__row--modified")).toBe(true);
        expect(rows[0]!.querySelector(".pg-json-diff__path")?.textContent).toBe("/status");
        expect(el.textContent).not.toContain("/fee");
        expect(rows[0]!.getAttribute("data-status")).toBe("modified");
        expect(el.querySelector(".pg-json-diff__copy")).toBeTruthy();
        unmount();
    });

    it("reveals unchanged rows with showUnchanged or the keyboard-accessible toggle", async () => {
        const diff = { before: { status: "PENDING", fee: 10 }, after: { status: "ACTIVE", fee: 10 } };
        const expanded = mountViewer({ diff, showUnchanged: true });
        expect(expanded.el.querySelectorAll(".pg-json-diff__row")).toHaveLength(2);
        expect(expanded.el.querySelectorAll(".pg-json-diff__row--unchanged")).toHaveLength(1);
        expanded.unmount();

        const { el, unmount } = mountViewer({ diff });
        const toggle = el.querySelector(".pg-json-diff__toggle") as HTMLButtonElement;
        expect(toggle.tagName).toBe("BUTTON");
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
        toggle.click();
        await nextTick();
        expect(el.querySelectorAll(".pg-json-diff__row")).toHaveLength(2);
        expect((el.querySelector(".pg-json-diff__toggle") as HTMLButtonElement).getAttribute("aria-expanded")).toBe("true");
        (el.querySelector(".pg-json-diff__toggle") as HTMLButtonElement).click();
        await nextTick();
        expect(el.querySelectorAll(".pg-json-diff__row")).toHaveLength(1);
        unmount();
    });

    it("marks added and removed rows with their semantic classes", () => {
        const { el, unmount } = mountViewer({
            diff: { before: { keep: 1, gone: "old" }, after: { keep: 1, fresh: "new" } },
        });
        expect(el.querySelector(".pg-json-diff__row--added")).toBeTruthy();
        expect(el.querySelector(".pg-json-diff__row--removed")).toBeTruthy();
        expect(el.querySelector(".pg-json-diff__row--added .pg-json-diff__mark")?.textContent).toBe("+");
        expect(el.querySelector(".pg-json-diff__row--removed .pg-json-diff__mark")?.textContent).toBe("-");
        unmount();
    });

    it("keeps raw keys and values LTR-isolated for Arabic pages", () => {
        const { el, unmount } = mountViewer({ diff: { before: { settlement_iban_number: "OLD" }, after: { settlement_iban_number: "NEW" } } });
        expect(el.querySelector(".pg-json-diff__path")?.getAttribute("dir")).toBe("ltr");
        expect(el.querySelector(".pg-json-diff__value")?.getAttribute("dir")).toBe("ltr");
        expect(el.querySelector(".pg-json-diff__label")?.textContent).toBe("Settlement IBAN Number");
        unmount();
    });

    it("never throws on null, BigInt, arrays and masked secrets", () => {
        expect(() => {
            const { unmount } = mountViewer({
                diff: {
                    before: { note: null, balance: 10n, rails: ["A", "B"], secret: "sk_live_123" },
                    after: { note: null, balance: 11n, rails: ["A", "C"], secret: "•••• 4242" },
                },
            });
            unmount();
        }).not.toThrow();
    });

    it("renders plain payloads with copyable values", () => {
        const { el, unmount } = mountViewer({ diff: { action: "FREEZE", reason: "fraud" } });
        expect(el.querySelector(".pg-json-diff")?.getAttribute("data-mode")).toBe("payload");
        expect(el.querySelectorAll(".pg-json-diff__row")).toHaveLength(2);
        expect(el.querySelector(".pg-json-diff__copy")).toBeTruthy();
        unmount();
    });

    it("keeps the legacy diff shapes working", () => {
        const operations = mountViewer({ operations: [{ op: "replace", path: "/a", value: 2, oldValue: 1 }] });
        expect(operations.el.textContent).toContain("/a");
        operations.unmount();
        const legacy = mountViewer({ before: { a: 1 }, after: { a: 2 } });
        expect(legacy.el.querySelector(".pg-json-diff__row--modified")).toBeTruthy();
        legacy.unmount();
    });
});

describe("JsonValueCell", () => {
    it("renders booleans as subtle true/false pills", () => {
        const truthy = mountCell({ value: true });
        expect(truthy.el.querySelector(".pg-json-value__bool--true")?.textContent).toBe("true");
        truthy.unmount();
        const falsy = mountCell({ value: false });
        expect(falsy.el.querySelector(".pg-json-value__bool--false")?.textContent).toBe("false");
        falsy.unmount();
    });

    it("renders null as italic muted text and numbers as tabular", () => {
        const nullCell = mountCell({ value: null });
        expect(nullCell.el.querySelector(".pg-json-value__null")?.textContent).toBe("null");
        nullCell.unmount();
        const numberCell = mountCell({ value: 1234.5 });
        expect(numberCell.el.querySelector(".pg-json-value__number")?.classList.contains("pg-tabular")).toBe(true);
        expect(numberCell.el.textContent).toContain("1234.5");
        numberCell.unmount();
    });

    it("truncates strings at 120 characters and expands on click", async () => {
        const long = "x".repeat(160);
        const { el, unmount } = mountCell({ value: long });
        expect(el.querySelector(".pg-json-value__text")?.textContent).toBe(`${"x".repeat(120)}…`);
        expect(el.textContent).not.toContain(long);
        const expand = el.querySelector(".pg-json-value__expand") as HTMLButtonElement;
        expect(expand.tagName).toBe("BUTTON");
        expand.click();
        await nextTick();
        expect(el.querySelector(".pg-json-value__text")?.textContent).toBe(long);
        expect((el.querySelector(".pg-json-value__expand") as HTMLButtonElement).getAttribute("aria-expanded")).toBe("true");
        unmount();
    });

    it("formats ISO timestamps and copies raw leaf values", () => {
        const { el, unmount } = mountCell({ value: "2026-11-27T10:00:00.000Z" });
        expect(el.querySelector(".pg-json-value__date")?.getAttribute("dir")).toBe("ltr");
        expect(el.querySelector(".pg-json-value__copy")).toBeTruthy();
        unmount();
    });

    it("renders nested objects through JsonValueList", () => {
        const { el, unmount } = mountCell({ value: { merchant_id: "m_1" } });
        expect(el.querySelector(".pg-json-value-list")).toBeTruthy();
        expect(el.textContent).toContain("Merchant ID");
        unmount();
    });

    it("guards nested objects beyond maxDepth", () => {
        const { el, unmount } = mountCell({ value: { a: { b: 1 } }, maxDepth: 1 });
        expect(el.textContent).toContain("[Nested Object]");
        unmount();
    });
});

describe("JsonValueList", () => {
    it("humanises keys by default with LTR JSON keys and a nested tree", () => {
        const { el, unmount } = mountList({ data: { settlement_iban_number: "LY83", nested: { inward: true } } });
        const keys = [...el.querySelectorAll(".pg-json-value-list__key")] as HTMLElement[];
        expect(keys[0]?.textContent).toBe("Settlement IBAN Number");
        expect(keys[0]?.getAttribute("dir")).toBe("ltr");
        expect(el.querySelector(".pg-json-value-list__nested")).toBeTruthy();
        expect(el.textContent).toContain("Inward");
        unmount();
    });

    it("guards nesting beyond maxDepth", () => {
        const { el, unmount } = mountList({ data: { a: { b: { c: 1 } } }, maxDepth: 2 });
        expect(el.textContent).toContain("[Nested Object]");
        expect(el.textContent).not.toContain("C");
        unmount();
    });

    it("survives circular payloads", () => {
        const data: any = { name: "merchant" };
        data.self = data;
        const { el, unmount } = mountList({ data });
        expect(el.textContent).toContain("[Circular]");
        unmount();
    });

    it("keeps the legacy value/labels/order props", () => {
        const { el, unmount } = mountList({
            value: { b: 2, a: 1 },
            labels: { a: "Alpha" },
            order: ["a"],
            ariaLabel: "Payload",
        });
        const keys = [...el.querySelectorAll(".pg-json-value-list__key")] as HTMLElement[];
        expect(keys[0]?.textContent).toBe("Alpha");
        expect(el.querySelector(".pg-json-value-list")?.getAttribute("aria-label")).toBe("Payload");
        unmount();
    });
});

describe("json.css contract", () => {
    it("owns the diff rows, bars and typed value classes", () => {
        expect(css).toContain(".pg-json-diff {");
        expect(css).toContain(".pg-json-diff__row--added {");
        expect(css).toContain(".pg-json-diff__row--removed {");
        expect(css).toContain(".pg-json-diff__row--modified {");
        expect(css).toMatch(/\.pg-json-diff__row--added\s*\{[^}]*var\(--pg-status-success-bg\)/);
        expect(css).toMatch(/\.pg-json-diff__row--removed\s*\{[^}]*var\(--pg-status-danger-bg\)/);
        expect(css).toMatch(/\.pg-json-diff__row--modified\s*\{[^}]*var\(--pg-status-warning-bg\)/);
        expect(css).toContain(".pg-json-value__bool {");
        expect(css).toContain(".pg-json-value-list__nested {");
        expect(css).toMatch(/border-inline-start:\s*3px solid/);
    });

    it("uses only design tokens (no raw hex colours)", () => {
        expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
});

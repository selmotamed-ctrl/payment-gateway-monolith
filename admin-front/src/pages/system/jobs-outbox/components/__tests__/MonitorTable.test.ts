import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../MonitorTable.tsx", import.meta.url)), "utf8");

describe("Jobs & Outbox MonitorTable component contract", () => {
    it("declares every prop it reads in the dc() call", () => {
        expect(source).toMatch(/props:\s*\[/);
        for (const prop of [
            "title",
            "url",
            "listKey",
            "headers",
            "filters",
            "initialFilters",
            "refreshSignal",
            "rowColor",
            "searchable",
        ]) {
            expect(source).toContain(`"${prop}"`);
        }
    });

    it("never builds a filter query from an undefined filter list", () => {
        expect(source).toContain("const filters = computed(() => props.filters ?? [])");
        expect(source).toContain("buildFilterQuery(filters.value, values.value)");
        expect(source).toContain("filters={filters.value}");
    });
});

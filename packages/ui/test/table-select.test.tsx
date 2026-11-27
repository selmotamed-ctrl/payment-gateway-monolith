import { describe, expect, it } from "vitest";
import { PgTable } from "../src/data/table/Table";
import { mount, nextFrame } from "./helpers/render";

describe("table selection", () => {
    it("checks a row after clicking its native checkbox", async () => {
        const rows = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
        const { el, unmount } = mount(PgTable as any, {
            items: rows,
            selectable: true,
            headers: [{ key: "name", label: "Name" }],
        });
        await nextFrame();
        const inputs = el.querySelectorAll("tbody input[type=checkbox]");
        expect(inputs.length).toBe(2);
        (inputs[0] as HTMLInputElement).click();
        await nextFrame();
        expect((el.querySelectorAll("tbody input[type=checkbox]")[0] as HTMLInputElement).checked).toBe(true);
        unmount();
    });
});

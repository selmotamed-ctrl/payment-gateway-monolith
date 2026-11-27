import { describe, expect, it } from "vitest";
import { dc } from "../src/lib/dc";
import { PgExpansionPanel, PgExpansionPanels } from "../src/layout/PgShellPrimitives";
import { mount, nextFrame } from "./helpers/render";

const Host = dc(() => () => (
    <PgExpansionPanels>
        <PgExpansionPanel value="ids" title="Technical identifiers">
            <span class="inside">Operator case ID</span>
        </PgExpansionPanel>
    </PgExpansionPanels>
), {});

describe("expansion", () => {
    it("opens on header click and renders the body once", async () => {
        const { el, unmount } = mount(Host, {});
        await nextFrame();
        const header = el.querySelector(".pg-expansion__header") as HTMLButtonElement;
        expect(header?.getAttribute("aria-expanded")).toBe("false");
        header.click();
        await nextFrame();
        expect(header?.getAttribute("aria-expanded")).toBe("true");
        expect(el.querySelector(".inside")?.textContent).toBe("Operator case ID");
        expect(el.querySelectorAll(".pg-expansion__body")).toHaveLength(1);
        unmount();
    });
});

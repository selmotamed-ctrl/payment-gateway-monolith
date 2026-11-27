import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { dc } from "../src/lib/dc";
import { PgCheckbox } from "../src/inputs/PgCheckbox";
import { mount, nextFrame } from "./helpers/render";

const Host = dc(() => {
    const value = ref(false);
    return () => (
        <div>
            <PgCheckbox modelValue={value.value} onUpdate:modelValue={(v: any) => (value.value = Boolean(v))} label="Approve" />
            <span class="state">{String(value.value)}</span>
        </div>
    );
}, { inheritAttrs: false });

describe("controlled checkbox", () => {
    it("toggles and keeps the native checked state", async () => {
        const { el, unmount } = mount(Host, {});
        const input = el.querySelector("input[type=checkbox]") as HTMLInputElement;
        input.click();
        await nextFrame();
        expect(el.querySelector(".state")?.textContent).toBe("true");
        expect(input.checked).toBe(true);
        unmount();
    });
});

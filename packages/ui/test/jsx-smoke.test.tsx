import { describe, expect, it } from "vitest";
import { defineVaporComponent } from "vue-jsx";
import { createVaporApp } from "vue";

const Plain = defineVaporComponent(() => {
    const el = document.createElement("div");
    el.className = "plain";
    el.textContent = "hello";
    return el;
});

describe("vapor smoke", () => {
    it("mounts a plain component", () => {
        const el = document.createElement("div");
        document.body.appendChild(el);
        const app = createVaporApp(Plain as any);
        app.mount(el);
        expect(el.querySelector(".plain")?.textContent).toBe("hello");
    });
});

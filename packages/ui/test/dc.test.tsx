import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { defineComponent } from "../src/lib/dc";
import { dc } from "../src/lib/dc";
import { usePgUiConfig } from "../src/lib/config";
import { PgProvider } from "../src/provider/PgProvider";
import { mount, nextFrame } from "./helpers/render";

const Defaulted = dc(
    (props: any, _expose, { attrs, slots }) => () => (
        <div class={["probe", attrs.class].filter(Boolean).join(" ")} data-mode={attrs["data-mode"]}>
            <span class="value">{String(props.copyable)}</span>
            <span class="object">{typeof props.primaryAction}</span>
            {slots.default?.()}
        </div>
    ),
    {
        props: {
            copyable: { type: Boolean, default: true },
            primaryAction: { type: Object, default: null },
            clearable: { type: Boolean, default: true },
        },
        inheritAttrs: true,
    },
);

describe("dc prop resolution", () => {
    it("resolves a boolean default when the caller omits the prop", () => {
        const { el, unmount } = mount(Defaulted, {});
        expect(el.querySelector(".value")?.textContent).toBe("true");
        unmount();
    });

    it("keeps object props on props and never on the DOM element", () => {
        const action = { label: "Inspect", onClick: () => undefined };
        const { el, unmount } = mount(Defaulted, { primaryAction: action, "data-mode": "row" });
        expect(el.querySelector(".object")?.textContent).toBe("object");
        expect(el.querySelector(".probe")?.getAttribute("primaryaction")).toBeNull();
        expect(el.querySelector(".probe")?.getAttribute("primary-action")).toBeNull();
        expect(el.innerHTML).not.toContain("[object Object]");
        expect(el.querySelector(".probe")?.getAttribute("data-mode")).toBe("row");
        unmount();
    });

    it("forwards undeclared class/style/handlers to the root", () => {
        const { el, unmount } = mount(Defaulted, { class: "extra", style: "color: red" });
        const probe = el.querySelector(".probe") as HTMLElement;
        expect(probe.classList.contains("extra")).toBe(true);
        expect(probe.style.color).toBe("red");
        unmount();
    });

    it("keeps defineComponent props too", () => {
        const Comp = defineComponent(
            (props: any) => () => <div class="defined">{String(props.copyable)}</div>,
            { props: { copyable: { type: Boolean, default: true } } },
        );
        const { el, unmount } = mount(Comp as any, {});
        expect(el.querySelector(".defined")?.textContent).toBe("true");
        unmount();
    });
});

describe("dc rerender branch", () => {
    it("keeps provide/inject alive for children created after a re-render", async () => {
        const ready = ref(false);

        const Child = dc(
            () => {
                const config = usePgUiConfig();
                return () => <span class="rerender-page-size">{String(config.defaultPageSize)}</span>;
            },
            { inheritAttrs: false },
        );

        // A top-level reactive early return is the reason `rerender` exists: the
        // first pass renders the loading branch and the effect builds the real
        // branch later. Children built in that second pass must stay inside the
        // component tree so they inherit `provide`.
        const Branching = dc(
            () => () =>
                ready.value ? (
                    <div class="rerender-loaded">
                        <Child />
                    </div>
                ) : (
                    <div class="rerender-loading">loading</div>
                ),
            { rerender: true, inheritAttrs: false },
        );

        const Root = dc(
            () => () => (
                <PgProvider config={{ defaultPageSize: 77 }}>
                    <Branching />
                </PgProvider>
            ),
            { inheritAttrs: false },
        );

        const { el, unmount } = mount(Root, {});
        expect(el.querySelector(".rerender-loading")).not.toBeNull();
        expect(el.querySelector(".rerender-page-size")).toBeNull();

        ready.value = true;
        await nextFrame();
        await nextFrame();

        expect(el.querySelector(".rerender-loaded")).not.toBeNull();
        // The provider default is 25; 77 can only come from the injected config.
        expect(el.querySelector(".rerender-page-size")?.textContent).toBe("77");
        unmount();
    });
});

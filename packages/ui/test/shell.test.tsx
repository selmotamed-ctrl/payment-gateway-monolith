import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { dc } from "../src/lib/dc";
import {
    PgApp,
    PgAppBar,
    PgAppBarTitle,
    PgAvatar,
    PgBtnToggle,
    PgChip,
    PgExpansionPanel,
    PgExpansionPanelText,
    PgExpansionPanelTitle,
    PgExpansionPanels,
    PgList,
    PgListItem,
    PgMain,
    PgNavigationDrawer,
    PgSlider,
    PgTimeline,
    PgTimelineItem,
    PgTransition,
    PgTag,
} from "../src/layout/PgShellPrimitives";
import { PgButton } from "../src/actions/PgButton";
import { mount, nextFrame } from "./helpers/render";

const shellCss = () =>
    readFileSync(`${process.cwd()}/src/tokens/parts/layout.css`, "utf8").replace(/\s+/g, " ");

/* === Harnesses ============================================================ */

const ShellHarness = dc(
    () => () => (
        <PgApp>
            <PgAppBar
                height={64}
                density="compact"
                v-slots={{
                    prepend: () => <span class="bar-prepend">Menu</span>,
                    default: () => <PgAppBarTitle class="bar-title">Admin</PgAppBarTitle>,
                    append: () => <span class="bar-append">User</span>,
                }}
            />
            <PgMain>
                <span class="main-content">Content</span>
            </PgMain>
        </PgApp>
    ),
    {},
);

const DrawerZoned = dc(
    () => () => (
        <PgNavigationDrawer
            modelValue
            permanent
            width={260}
            ariaLabel="Primary nav"
            v-slots={{
                prepend: () => <div class="drawer-brand">Brand</div>,
                append: () => <div class="drawer-user">Operator</div>,
            }}
        >
            <ul class="pg-nav">
                <li class="nav-row">Overview</li>
                <li class="nav-row">Merchants</li>
            </ul>
        </PgNavigationDrawer>
    ),
    {},
);

const DrawerLegacy = dc(
    () => () => (
        <PgNavigationDrawer modelValue permanent>
            <div class="pg-drawer__brand">Brand</div>
            <ul class="pg-nav">
                {Array.from({ length: 30 }, (_, index) => (
                    <li class="nav-row" key={index}>
                        Row {index + 1}
                    </li>
                ))}
            </ul>
            <div class="pg-drawer__footer">Operator card</div>
        </PgNavigationDrawer>
    ),
    {},
);

let drawerUpdates: boolean[] = [];

const DrawerTemporary = dc(
    (props: any) => () => (
        <PgNavigationDrawer
            modelValue={props.open}
            temporary
            onUpdate:modelValue={(value: boolean) => {
                drawerUpdates.push(value);
            }}
        >
            <ul class="pg-nav">
                <li class="nav-row">Overview</li>
            </ul>
        </PgNavigationDrawer>
    ),
    { props: { open: { type: Boolean, default: true } }, inheritAttrs: true },
);

const ExpansionHarness = dc(
    (props: any) => () => (
        <PgExpansionPanels multiple={props.multiple} modelValue={props.modelValue}>
            {["one", "two", "three", "four", "five"].map((value) => (
                <PgExpansionPanel value={value} title={`Panel ${value}`} key={value}>
                    <span class={`panel-body-${value}`}>Body {value}</span>
                </PgExpansionPanel>
            ))}
        </PgExpansionPanels>
    ),
    {
        props: {
            multiple: { type: Boolean, default: false },
            modelValue: { type: [String, Number, Array], default: undefined },
        },
        inheritAttrs: true,
    },
);

const LegacyExpansionHarness = dc(
    () => () => (
        <PgExpansionPanels>
            <PgExpansionPanel value={0} title="Legacy title">
                <span class="legacy-text">Legacy body</span>
            </PgExpansionPanel>
        </PgExpansionPanels>
    ),
    {},
);

const TimelineHarness = dc(
    () => () => (
        <PgTimeline>
            <PgTimelineItem title="Created" dotColor="success" timestamp="10:00" />
            <PgTimelineItem title="Captured" tone="danger" timestamp="10:01" />
            <PgTimelineItem title="Settled" tone="info" timestamp="10:02" />
        </PgTimeline>
    ),
    {},
);

let chipClosed = 0;
let parentClicks = 0;

const ChipHarness = dc(
    () => () => (
        <div
            class="chip-parent"
            onClick={() => {
                parentClicks += 1;
            }}
        >
            <PgChip
                closable
                label="LYD"
                onClose={() => {
                    chipClosed += 1;
                }}
            />
        </div>
    ),
    {},
);

let toggleEmits: Array<unknown> = [];

const ToggleHarness = dc(
    (props: any) => () => (
        <PgBtnToggle
            modelValue={props.multiple ? ["7d"] : "7d"}
            multiple={props.multiple}
            onUpdate:modelValue={(value: unknown) => {
                toggleEmits.push(value);
            }}
        >
            <PgButton value="7d" size="small">
                7D
            </PgButton>
            <PgButton value="30d" size="small">
                30D
            </PgButton>
            <PgButton value="90d" size="small">
                90D
            </PgButton>
        </PgBtnToggle>
    ),
    { props: { multiple: { type: Boolean, default: false } }, inheritAttrs: true },
);

let sliderUpdates: number[] = [];
let sliderChanges: number[] = [];

const SliderHarness = dc(
    (props: any) => () => (
        <PgSlider
            modelValue={props.value}
            min={0}
            max={100}
            step={5}
            label="Fee variance"
            unit="%"
            onUpdate:modelValue={(value: number) => {
                sliderUpdates.push(value);
            }}
            onChange={(value: number) => {
                sliderChanges.push(value);
            }}
        />
    ),
    { props: { value: { type: Number, default: 20 } }, inheritAttrs: true },
);

const ListHarness = dc(
    () => () => (
        <PgList>
            <PgListItem title="Static row" />
            <PgListItem title="Clickable row" onClick={() => undefined} />
            <PgListItem title="Linked row" to="/merchants" active />
            <PgListItem title="External row" href="https://example.test" />
        </PgList>
    ),
    {},
);

/* === Tests ================================================================ */

describe("PgApp, PgAppBar & PgMain", () => {
    it("renders the app bar clusters in order with the height token", () => {
        const { el, unmount } = mount(ShellHarness, {});
        const app = el.querySelector(".pg-app") as HTMLElement;
        expect(app).toBeTruthy();
        const bar = el.querySelector("header.pg-app-bar") as HTMLElement;
        expect(bar.classList.contains("pg-app-bar--compact")).toBe(true);
        expect(bar.style.getPropertyValue("--pg-app-bar-height")).toBe("64px");
        expect(bar.querySelector(".bar-prepend")).toBeTruthy();
        expect(bar.querySelector(".bar-title")?.textContent).toBe("Admin");
        expect(bar.querySelector(".bar-append")).toBeTruthy();
        const children = Array.from(bar.children).map((child) => child.className);
        expect(children[0]).toContain("pg-app-bar__prepend");
        expect(children[1]).toContain("pg-app-bar__main");
        expect(children[children.length - 1]).toContain("pg-app-bar__append");
        expect(shellCss()).toMatch(/\.pg-app-bar \{[^}]*height: var\(--pg-app-bar-height, var\(--pg-app-bar-h\)\)/);
        unmount();
    });

    it("renders main as #pg-main-content with min-width: 0", () => {
        const { el, unmount } = mount(ShellHarness, {});
        const main = el.querySelector("main#pg-main-content") as HTMLElement;
        expect(main).toBeTruthy();
        expect(main.classList.contains("pg-main")).toBe(true);
        expect(main.querySelector(".main-content")?.textContent).toBe("Content");
        expect(shellCss()).toMatch(/\.pg-main \{[^}]*min-width: 0/);
        unmount();
    });

    it("can turn the sticky app bar off", () => {
        const StaticBar = dc(() => () => <PgAppBar sticky={false} />, {});
        const { el, unmount } = mount(StaticBar, {});
        expect(el.querySelector(".pg-app-bar")?.classList.contains("pg-app-bar--static")).toBe(true);
        unmount();
    });
});

describe("PgNavigationDrawer", () => {
    it("renders the three-zone flex column structure", () => {
        const { el, unmount } = mount(DrawerZoned, {});
        const drawer = el.querySelector("aside.pg-nav-drawer") as HTMLElement;
        expect(drawer.getAttribute("role")).toBe("navigation");
        expect(drawer.getAttribute("aria-label")).toBe("Primary nav");
        expect(drawer.style.width).toBe("260px");
        const content = drawer.querySelector(".v-navigation-drawer__content") as HTMLElement;
        expect(content).toBeTruthy();
        expect(content.querySelector(".pg-nav-drawer__prepend .drawer-brand")).toBeTruthy();
        expect(content.querySelector(".pg-nav-drawer__body .pg-nav")).toBeTruthy();
        expect(content.querySelector(".pg-nav-drawer__append .drawer-user")).toBeTruthy();
        const children = Array.from(content.children).map((child) => child.className);
        expect(children[0]).toContain("pg-nav-drawer__prepend");
        expect(children[1]).toContain("pg-nav-drawer__body");
        expect(children[2]).toContain("pg-nav-drawer__append");
        const css = shellCss();
        expect(css).toMatch(/\.pg-nav-drawer \.v-navigation-drawer__content \{[^}]*display: flex/);
        expect(css).toMatch(/\.pg-nav-drawer \.v-navigation-drawer__content \{[^}]*height: 100%/);
        expect(css).toMatch(/\.pg-nav-drawer \.v-navigation-drawer__content \{[^}]*min-height: 0/);
        expect(css).toMatch(/\.pg-nav-drawer__body \{[^}]*flex: 1 1 auto/);
        unmount();
    });

    it("keeps legacy default-slot content scrollable with a pinned footer", () => {
        const { el, unmount } = mount(DrawerLegacy, {});
        const body = el.querySelector(".pg-nav-drawer__body") as HTMLElement;
        const brand = body.querySelector(".pg-drawer__brand") as HTMLElement;
        const nav = body.querySelector(".pg-nav") as HTMLElement;
        const footer = body.querySelector(".pg-drawer__footer") as HTMLElement;
        expect(Array.from(body.children)).toEqual([brand, nav, footer]);
        expect(footer.previousElementSibling).toBe(nav);
        expect(nav.contains(footer)).toBe(false);
        expect(nav.querySelectorAll(".nav-row")).toHaveLength(30);
        expect(nav.lastElementChild?.textContent).toBe("Row 30");
        const css = shellCss();
        expect(css).toMatch(/\.pg-nav-drawer__body > \.pg-nav \{[^}]*flex: 1 1 auto/);
        expect(css).toMatch(/\.pg-nav-drawer__body > \.pg-nav \{[^}]*min-height: 0/);
        expect(css).toMatch(/\.pg-nav-drawer__body > \.pg-nav \{[^}]*overflow-y: auto/);
        expect(css).toMatch(/\.pg-nav-drawer__body > \.pg-drawer__footer \{[^}]*flex-shrink: 0/);
        expect(css).toMatch(/\.pg-nav-drawer__body > \.pg-drawer__footer \{[^}]*margin-top: auto/);
        unmount();
    });

    it("closes a temporary drawer on Escape and backdrop click", async () => {
        drawerUpdates = [];
        const { el, unmount } = mount(DrawerTemporary, { open: true });
        expect(el.querySelector(".pg-nav-drawer__backdrop")).toBeTruthy();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await nextFrame();
        expect(drawerUpdates).toEqual([false]);
        (el.querySelector(".pg-nav-drawer__backdrop") as HTMLElement).click();
        await nextFrame();
        expect(drawerUpdates).toEqual([false, false]);
        expect(document.body.style.overflow).toBe("hidden");
        unmount();
        expect(document.body.style.overflow).toBe("");
    });

    it("hides a permanent drawer state only when the caller closes it", () => {
        const Closed = dc(() => () => <PgNavigationDrawer modelValue={false}>…</PgNavigationDrawer>, {});
        const { el, unmount } = mount(Closed, {});
        expect((el.querySelector(".pg-nav-drawer") as HTMLElement).hidden).toBe(true);
        unmount();
    });
});

describe("PgExpansionPanels", () => {
    it("defaults every panel to collapsed", () => {
        const { el, unmount } = mount(ExpansionHarness, {});
        const headers = el.querySelectorAll<HTMLButtonElement>(".pg-expansion__header");
        expect(headers).toHaveLength(5);
        for (const header of Array.from(headers)) {
            expect(header.getAttribute("aria-expanded")).toBe("false");
            expect(header.getAttribute("aria-controls")).toBeNull();
        }
        expect(el.querySelector(".pg-expansion__body")).toBeNull();
        const css = shellCss();
        expect(css).toContain(".pg-expansion--open .pg-expansion__chevron");
        expect(css).toContain("transform: rotate(180deg)");
        unmount();
    });

    it("opens one panel at a time in single mode", async () => {
        const { el, unmount } = mount(ExpansionHarness, {});
        const headers = () => el.querySelectorAll<HTMLButtonElement>(".pg-expansion__header");
        headers()[0]!.click();
        await nextFrame();
        expect(headers()[0]!.getAttribute("aria-expanded")).toBe("true");
        expect(el.querySelector(".panel-body-one")).toBeTruthy();
        const controls = headers()[0]!.getAttribute("aria-controls")!;
        expect(document.getElementById(controls)?.className).toContain("pg-expansion__body");
        headers()[1]!.click();
        await nextFrame();
        expect(headers()[0]!.getAttribute("aria-expanded")).toBe("false");
        expect(headers()[1]!.getAttribute("aria-expanded")).toBe("true");
        expect(el.querySelector(".panel-body-one")).toBeNull();
        expect(el.querySelector(".panel-body-two")).toBeTruthy();
        unmount();
    });

    it("keeps multiple panels open when multiple is set", async () => {
        const { el, unmount } = mount(ExpansionHarness, { multiple: true });
        const headers = el.querySelectorAll<HTMLButtonElement>(".pg-expansion__header");
        headers[0]!.click();
        headers[2]!.click();
        await nextFrame();
        expect(headers[0]!.getAttribute("aria-expanded")).toBe("true");
        expect(headers[2]!.getAttribute("aria-expanded")).toBe("true");
        expect(el.querySelector(".panel-body-one")).toBeTruthy();
        expect(el.querySelector(".panel-body-three")).toBeTruthy();
        unmount();
    });

    it("renders one header/body without mounting the body twice", async () => {
        const { el, unmount } = mount(LegacyExpansionHarness, {});
        const header = el.querySelector(".pg-expansion__header") as HTMLButtonElement;
        expect(header.textContent).toContain("Legacy title");
        expect(header.querySelector(".pg-expansion__body")).toBeNull();
        expect(header.getAttribute("aria-expanded")).toBe("false");
        header.click();
        await nextFrame();
        const text = el.querySelector(".legacy-text") as HTMLElement;
        expect(text.textContent).toBe("Legacy body");
        expect(text.closest(".pg-expansion__body")).toBeTruthy();
        expect(el.querySelectorAll(".pg-expansion__body")).toHaveLength(1);
        unmount();
    });
});

describe("PgTimeline", () => {
    it("renders semantic ordered-list items with tone dots and no trailing connector", () => {
        const { el, unmount } = mount(TimelineHarness, {});
        const timeline = el.querySelector("ol.pg-timeline") as HTMLElement;
        expect(timeline).toBeTruthy();
        const items = timeline.querySelectorAll("li.pg-timeline__item");
        expect(items).toHaveLength(3);
        expect(items[0]!.querySelector(".pg-timeline__dot")?.classList.contains("pg-timeline__dot--success")).toBe(true);
        expect(items[1]!.querySelector(".pg-timeline__dot")?.classList.contains("pg-timeline__dot--danger")).toBe(true);
        expect(items[2]!.querySelector(".pg-timeline__dot")?.classList.contains("pg-timeline__dot--info")).toBe(true);
        expect(items[2]!.classList.contains("pg-timeline__item")).toBe(true);
        expect(items[2]!.nextElementSibling).toBeNull();
        expect(shellCss()).toContain(".pg-timeline__item:last-child .pg-timeline__track::before { display: none; }");
        unmount();
    });
});

describe("PgAvatar (identity atom)", () => {
    it("derives two-letter initials", () => {
        const { el, unmount } = mount(PgAvatar, { name: "Salem Elmotamed" });
        expect(el.querySelector(".pg-avatar")?.getAttribute("role")).toBe("img");
        expect(el.querySelector(".pg-avatar")?.getAttribute("aria-label")).toBe("Salem Elmotamed");
        expect(el.querySelector(".pg-avatar__initials")?.textContent).toBe("SE");
        unmount();
    });

    it("falls back to initials after an image error", async () => {
        const { el, unmount } = mount(PgAvatar, { src: "https://example.test/missing.png", name: "Salem Elmotamed" });
        const image = el.querySelector("img") as HTMLImageElement;
        expect(image).toBeTruthy();
        image.dispatchEvent(new Event("error"));
        await nextFrame();
        expect(el.querySelector("img")).toBeNull();
        expect(el.querySelector(".pg-avatar__initials")?.textContent).toBe("SE");
        unmount();
    });

    it("maps sizes to classes", () => {
        const { el, unmount } = mount(PgAvatar, { name: "Acme", size: "xs" });
        expect(el.querySelector(".pg-avatar")?.classList.contains("pg-avatar--xs")).toBe(true);
        unmount();
    });
});

describe("PgChip & PgTag", () => {
    it("stops propagation when the close button emits close", () => {
        chipClosed = 0;
        parentClicks = 0;
        const { el, unmount } = mount(ChipHarness, {});
        const close = el.querySelector(".pg-chip__close") as HTMLButtonElement;
        expect(close.getAttribute("aria-label")).toBe("Remove");
        close.click();
        expect(chipClosed).toBe(1);
        expect(parentClicks).toBe(0);
        unmount();
    });

    it("closes on Backspace/Delete while the chip itself is focused", () => {
        chipClosed = 0;
        parentClicks = 0;
        const { el, unmount } = mount(ChipHarness, {});
        const chip = el.querySelector(".pg-chip") as HTMLElement;
        chip.focus();
        chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
        expect(chipClosed).toBe(1);
        expect(parentClicks).toBe(0);
        unmount();
    });

    it("renders a compact tag", () => {
        const { el, unmount } = mount(PgTag, { label: "LYD", tone: "brand" });
        expect(el.querySelector(".pg-tag")?.classList.contains("pg-tag--brand")).toBe(true);
        expect(el.textContent).toBe("LYD");
        unmount();
    });
});

describe("PgBtnToggle", () => {
    it("selects a segment and keeps a mandatory selection", async () => {
        toggleEmits = [];
        const { el, unmount } = mount(ToggleHarness, {});
        await nextFrame();
        const buttons = el.querySelectorAll<HTMLButtonElement>(".pg-btn");
        expect(buttons).toHaveLength(3);
        expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true");
        expect(buttons[1]!.getAttribute("aria-pressed")).toBe("false");
        buttons[1]!.click();
        await nextFrame();
        expect(toggleEmits).toEqual(["30d"]);
        buttons[0]!.click();
        await nextFrame();
        expect(toggleEmits).toEqual(["30d"]);
        unmount();
    });

    it("supports multiple selection", async () => {
        toggleEmits = [];
        const { el, unmount } = mount(ToggleHarness, { multiple: true });
        await nextFrame();
        const buttons = el.querySelectorAll<HTMLButtonElement>(".pg-btn");
        expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true");
        buttons[1]!.click();
        await nextFrame();
        expect(toggleEmits).toEqual([["7d", "30d"]]);
        unmount();
    });

    it("moves focus with arrow keys", async () => {
        toggleEmits = [];
        const { el, unmount } = mount(ToggleHarness, {});
        await nextFrame();
        const buttons = el.querySelectorAll<HTMLButtonElement>(".pg-btn");
        buttons[0]!.focus();
        buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        await nextFrame();
        expect(document.activeElement).toBe(buttons[1]);
        unmount();
    });
});

describe("PgSlider", () => {
    it("emits numeric updates and changes", async () => {
        sliderUpdates = [];
        sliderChanges = [];
        const { el, unmount } = mount(SliderHarness, { value: 20 });
        const input = el.querySelector("input.pg-slider__native") as HTMLInputElement;
        expect(input.value).toBe("20");
        expect(el.querySelector(".pg-slider__value")?.textContent).toBe("20%");
        expect((el.querySelector(".pg-slider__fill") as HTMLElement).style.width).toBe("20%");
        input.value = "35";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        expect(sliderUpdates).toEqual([35]);
        input.dispatchEvent(new Event("change", { bubbles: true }));
        expect(sliderChanges).toEqual([35]);
        unmount();
    });

    it("uses the keyboard contract for step, page and end jumps", async () => {
        sliderUpdates = [];
        sliderChanges = [];
        const { el, unmount } = mount(SliderHarness, { value: 20 });
        const input = el.querySelector("input.pg-slider__native") as HTMLInputElement;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        await nextFrame();
        expect(sliderUpdates).toEqual([25]);
        expect(sliderChanges).toEqual([25]);
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
        await nextFrame();
        expect(sliderUpdates[1]).toBe(70);
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
        await nextFrame();
        expect(sliderUpdates[2]).toBe(100);
        unmount();
    });

    it("clamps an out-of-range model value", () => {
        sliderUpdates = [];
        const { el, unmount } = mount(SliderHarness, { value: 150 });
        const input = el.querySelector("input.pg-slider__native") as HTMLInputElement;
        expect(input.value).toBe("100");
        expect(el.querySelector(".pg-slider__value")?.textContent).toBe("100%");
        expect((el.querySelector(".pg-slider__fill") as HTMLElement).style.width).toBe("100%");
        unmount();
    });
});

const ReactiveActiveHarness = dc(
    () => {
        const active = ref(false);
        return () => (
            <ul class="pg-list">
                <li>
                    <button class="active-toggle" onClick={() => (active.value = !active.value)}>
                        Toggle
                    </button>
                </li>
                <PgListItem title="Linked row" to="/merchants" active={active.value} />
            </ul>
        );
    },
    {},
);

describe("PgListItem reactivity", () => {
    it("updates the active class and aria-current when the prop changes", async () => {
        const { el, unmount } = mount(ReactiveActiveHarness);
        const link = el.querySelector(".pg-list-item") as HTMLAnchorElement;
        expect(link.classList.contains("pg-list-item--active")).toBe(false);
        expect(link.getAttribute("aria-current")).toBeNull();

        (el.querySelector(".active-toggle") as HTMLButtonElement).click();
        await nextFrame();

        expect(link.classList.contains("pg-list-item--active")).toBe(true);
        expect(link.getAttribute("aria-current")).toBe("page");
        unmount();
    });
});

describe("PgListItem semantics", () => {
    it("renders a/button/div according to interactivity", () => {
        const { el, unmount } = mount(ListHarness, {});
        const items = el.querySelectorAll(".pg-list-item");
        expect(items).toHaveLength(4);
        expect(items[0]!.tagName).toBe("DIV");
        expect(items[1]!.tagName).toBe("BUTTON");
        expect((items[1] as HTMLButtonElement).type).toBe("button");
        expect(items[2]!.tagName).toBe("A");
        expect(items[2]!.getAttribute("href")).toBe("/merchants");
        expect(items[2]!.getAttribute("aria-current")).toBe("page");
        expect(items[3]!.tagName).toBe("A");
        expect(items[3]!.getAttribute("href")).toBe("https://example.test");
        expect(el.querySelector("ul.pg-list")).toBeTruthy();
        unmount();
    });
});

describe("PgTransition", () => {
    it("renders CSS-driven children without a VDOM transition wrapper", () => {
        const TransitionHarness = dc(
            () => () => (
                <PgTransition name="slide-y" duration={200}>
                    <span class="transition-child">Child</span>
                </PgTransition>
            ),
            {},
        );
        const { el, unmount } = mount(TransitionHarness, {});
        const wrapper = el.querySelector(".pg-transition") as HTMLElement;
        expect(wrapper.classList.contains("pg-transition--slide-y")).toBe(true);
        expect(wrapper.style.getPropertyValue("--pg-transition-duration")).toBe("200ms");
        expect(wrapper.querySelector(".transition-child")?.textContent).toBe("Child");
        const css = shellCss();
        expect(css).toContain("@media (prefers-reduced-motion: reduce)");
        expect(css).toMatch(/\.pg-transition \{[^}]*animation: none !important/);
        unmount();
    });
});

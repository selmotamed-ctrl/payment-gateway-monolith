import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dc } from "../src/lib/dc";
import { usePgFormControl } from "../src/lib/formRegistry";
import {
    CenterView,
    PgCard,
    PgCenter,
    PgFormCol,
    PgFormGrid,
    PgPage,
    PgSection,
    PgStack,
    ScreenContainer,
    SurfaceCard,
} from "../src/layout/PgLayout";
import {
    PgPageHeader,
    PgSubHeader,
    PgText,
    PgView,
    PageHeader,
    SubHeader,
    ThemedText,
    ThemedView,
} from "../src/layout/PgPageHeader";
import {
    PgCardActions,
    PgCardSubtitle,
    PgCardText,
    PgCardTitle,
    PgForm,
    SurfaceCardText,
    PgTag,
} from "../src/layout/PgShellPrimitives";
import { mount, nextFrame, wait } from "./helpers/render";

const layoutCss = () =>
    readFileSync(`${process.cwd()}/src/tokens/parts/layout.css`, "utf8").replace(/\s+/g, " ");

/* === Harnesses ============================================================ */

const PageAlone = dc(() => () => <PgPage size="narrow" gap="lg"><span class="page-content">Page</span></PgPage>, {});

const PageNested = dc(
    () => () => (
        <PgPage>
            <PgPage>
                <span class="page-content">Nested</span>
            </PgPage>
        </PgPage>
    ),
    {},
);

const SectionHarness = dc(
    () => () => (
        <PgSection
            title="Settlement"
            subtitle="Today’s batches"
            gap="lg"
            v-slots={{
                actions: () => <button class="section-action">Run</button>,
            }}
        >
            <span class="section-body">Body</span>
        </PgSection>
    ),
    {},
);

const CardHarness = dc(
    () => () => (
        <PgCard
            title="Wallet"
            subtitle="LYD · live"
            padding="lg"
            divided
            tone="warning"
            v-slots={{
                actions: () => <button class="card-action">Inspect</button>,
                footer: () => <div class="card-footer">Footer</div>,
            }}
        >
            <span class="card-body">Balance</span>
        </PgCard>
    ),
    {},
);

const GridHarness = dc(
    () => () => (
        <PgFormGrid columns={12} gap="lg">
            <PgFormCol span={6} md={4}>
                <span class="grid-a">A</span>
            </PgFormCol>
            <PgFormCol span={12}>
                <span class="grid-b">B</span>
            </PgFormCol>
        </PgFormGrid>
    ),
    {},
);

const StackHarness = dc(
    () => () => (
        <PgStack direction="row" gap="lg" align="center" justify="space-between" wrap>
            <span class="stack-a">A</span>
            <span class="stack-b">B</span>
        </PgStack>
    ),
    {},
);

const HeaderHarness = dc(
    () => () => (
        <PgPageHeader
            title="Acme Payments"
            subtitle="Merchant overview"
            badge="ACTIVE"
            badgeLabel="Active"
            breadcrumbs={[
                { label: "Home", to: "/" },
                { label: "Merchants", to: "/merchants" },
                { label: "Acme" },
            ]}
            v-slots={{
                actions: () => <button class="header-action">Refresh</button>,
            }}
        />
    ),
    {},
);

const TextHarness = dc(
    () => () => (
        <div>
            <PgText as="code" variant="mono" tone="muted" truncate>
                TXN-0001
            </PgText>
            <PgText as="p" variant="caption" clamp={2}>
                Long copy
            </PgText>
            <PgText type="defaultSemiBold">Legacy</PgText>
            <PgSubHeader
                title="Recent events"
                subtitle="Last 24 hours"
                v-slots={{ actions: () => <button class="sub-action">All</button> }}
            />
        </div>
    ),
    {},
);

/* A real registry control: registers, validates and focuses through PgForm. */
let formSubmitted = 0;
let formFocused = 0;
let formValidity: boolean[] = [];

const FormControl = dc(
    (props: any) => {
        const { id } = usePgFormControl({
            id: "layout-form-control",
            validate: () => (props.valid ? { valid: true, message: "" } : { valid: false, message: "Required" }),
            focus: () => {
                formFocused += 1;
            },
        });
        return () => <input id={id} class="form-control" value={props.value ?? ""} readonly />;
    },
    {
        props: {
            valid: { type: Boolean, default: false },
            value: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);

const FormHarness = dc(
    (props: any) => () => (
        <PgForm
            fastFail={props.fastFail}
            onSubmit={() => {
                formSubmitted += 1;
            }}
            onUpdate:modelValue={(valid: boolean) => {
                formValidity.push(valid);
            }}
        >
            <FormControl valid={props.valid} />
        </PgForm>
    ),
    {
        props: {
            valid: { type: Boolean, default: false },
            fastFail: { type: Boolean, default: false },
        },
        inheritAttrs: true,
    },
);

let cardClicks = 0;

const InteractiveCard = dc(
    () => () => (
        <PgCard
            interactive
            onClick={() => {
                cardClicks += 1;
            }}
        >
            <span class="card-body">Open</span>
        </PgCard>
    ),
    {},
);

/* === Tests ================================================================ */

describe("PgPage & PgSection", () => {
    it("renders one page container with size and gap classes", () => {
        const { el, unmount } = mount(PageAlone, {});
        const page = el.querySelector(".pg-page") as HTMLElement;
        expect(page).toBeTruthy();
        expect(page.classList.contains("pg-page--narrow")).toBe(true);
        expect(page.classList.contains("pg-page--gap-lg")).toBe(true);
        expect(el.querySelectorAll(".pg-page")).toHaveLength(1);
        expect(page.querySelector(".page-content")?.textContent).toBe("Page");
        unmount();
    });

    it("resets padding on a nested page and delegates default padding to layout tokens", () => {
        const { el, unmount } = mount(PageNested, {});
        expect(el.querySelectorAll(".pg-page")).toHaveLength(2);
        const css = layoutCss();
        expect(css).toContain(".pg-page .pg-page");
        expect(css).toMatch(/\.pg-page \.pg-page \{[^}]*padding: 0/);
        expect(css).toContain("--pg-layout-page-pad-desktop: 24px 28px 48px");
        unmount();
    });

    it("exposes the ScreenContainer alias", () => {
        expect(ScreenContainer).toBe(PgPage);
    });

    it("renders a semantic section with aria-labelledby, actions and gap", () => {
        const { el, unmount } = mount(SectionHarness, {});
        const section = el.querySelector("section.pg-section") as HTMLElement;
        expect(section).toBeTruthy();
        expect(section.classList.contains("pg-section--gap-lg")).toBe(true);
        const labelledBy = section.getAttribute("aria-labelledby");
        expect(labelledBy).toBeTruthy();
        const heading = document.getElementById(labelledBy!) as HTMLElement;
        expect(heading.tagName).toBe("H2");
        expect(heading.textContent).toBe("Settlement");
        expect(section.querySelector(".pg-section-description")?.textContent).toBe("Today’s batches");
        expect(section.querySelector(".section-action")?.textContent).toBe("Run");
        expect(section.querySelector(".pg-section__body .section-body")?.textContent).toBe("Body");
        unmount();
    });

    it("supports the legacy collapsible section contract", async () => {
        const Collapsible = dc(
            (props: any) => () => (
                <PgSection title="Advanced" collapsible modelValue={props.open}>
                    <span class="section-body">Body</span>
                </PgSection>
            ),
            { inheritAttrs: true },
        );
        const { el, unmount } = mount(Collapsible, { open: false });
        expect(el.querySelector(".pg-section__body")).toBeNull();
        expect(el.querySelector(".pg-section__toggle")?.getAttribute("aria-expanded")).toBe("false");
        unmount();
        const open = mount(Collapsible, { open: true });
        expect(open.el.querySelector(".pg-section__body .section-body")?.textContent).toBe("Body");
        open.unmount();
    });
});

describe("PgCard", () => {
    it("renders header, body, footer, actions, tone and padding classes", () => {
        const { el, unmount } = mount(CardHarness, {});
        const card = el.querySelector(".pg-card") as HTMLElement;
        expect(card.classList.contains("pg-card--pad-lg")).toBe(true);
        expect(card.classList.contains("pg-card--divided")).toBe(true);
        expect(card.classList.contains("pg-card--tone-warning")).toBe(true);
        expect(card.querySelector(".pg-card__title")?.textContent).toBe("Wallet");
        expect(card.querySelector(".pg-card__subtitle")?.textContent).toBe("LYD · live");
        expect(card.querySelector(".card-action")?.textContent).toBe("Inspect");
        expect(card.querySelector(".pg-card__body .card-body")?.textContent).toBe("Balance");
        expect(card.querySelector(".pg-card__footer .card-footer")?.textContent).toBe("Footer");
        expect(layoutCss()).toMatch(/\.pg-card--pad-lg > \.pg-card__body \{ padding: 24px/);
        unmount();
    });

    it("activates an interactive card from pointer and keyboard", async () => {
        cardClicks = 0;
        const { el, unmount } = mount(InteractiveCard, {});
        const card = el.querySelector(".pg-card") as HTMLElement;
        expect(card.getAttribute("role")).toBe("button");
        expect(card.getAttribute("tabindex")).toBe("0");
        card.click();
        await nextFrame();
        expect(cardClicks).toBe(1);
        card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        card.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        await nextFrame();
        expect(cardClicks).toBe(3);
        expect(layoutCss()).toContain(".pg-card--interactive");
        unmount();
    });

    it("keeps every card primitive and SurfaceCard alias", () => {
        expect(SurfaceCard).toBe(PgCard);
        expect(SurfaceCardText).toBe(PgCardText);
        expect(PgCardTitle).toBeTruthy();
        expect(PgCardSubtitle).toBeTruthy();
        expect(PgCardActions).toBeTruthy();
        expect(PgTag).toBeTruthy();
    });
});

describe("PgFormGrid, PgStack & PgCenter", () => {
    it("renders 12-column spans and responsive classes", () => {
        const { el, unmount } = mount(GridHarness, {});
        const grid = el.querySelector(".pg-form-grid") as HTMLElement;
        expect(grid.classList.contains("pg-form-grid--gap-lg")).toBe(true);
        expect(grid.style.getPropertyValue("--pg-form-columns")).toBe("12");
        const a = el.querySelector(".grid-a")!.parentElement as HTMLElement;
        expect(a.classList.contains("pg-form-col--span-6")).toBe(true);
        expect(a.classList.contains("pg-form-col--md-4")).toBe(true);
        const b = el.querySelector(".grid-b")!.parentElement as HTMLElement;
        expect(b.classList.contains("pg-form-col--span-12")).toBe(true);
        const css = layoutCss();
        expect(css).toContain("@media (min-width: 768px)");
        expect(css).toMatch(/\.pg-form-col--span-6 \{ grid-column: span 6 \/ span 6/);
        expect(css).toMatch(/\.pg-form-col--md-4 \{ grid-column: span 4 \/ span 4/);
        unmount();
    });

    it("maps PgStack direction, gap and alignment", () => {
        const { el, unmount } = mount(StackHarness, {});
        const stack = el.querySelector(".pg-stack") as HTMLElement;
        expect(stack.classList.contains("pg-stack--row")).toBe(true);
        expect(stack.classList.contains("pg-stack--gap-lg")).toBe(true);
        expect(stack.classList.contains("pg-stack--wrap")).toBe(true);
        expect(stack.style.alignItems).toBe("center");
        expect(stack.style.justifyContent).toBe("space-between");
        unmount();
    });

    it("keeps PgCenter and CenterView aliases", () => {
        expect(CenterView).toBe(PgCenter);
    });
});

describe("PgPageHeader, PgSubHeader & PgText", () => {
    it("renders h1, subtitle, badge, breadcrumbs and a shrink-proof action cluster", () => {
        const { el, unmount } = mount(HeaderHarness, {});
        expect(el.querySelector("h1.pg-page-title")?.textContent).toBe("Acme Payments");
        expect(el.querySelector(".pg-page-subtitle")?.textContent).toBe("Merchant overview");
        const nav = el.querySelector("nav.pg-breadcrumbs") as HTMLElement;
        expect(nav.getAttribute("aria-label")).toBe("Breadcrumb");
        expect(nav.querySelectorAll("li")).toHaveLength(3);
        expect(nav.querySelectorAll("a")).toHaveLength(2);
        expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Acme");
        expect(el.querySelector(".pg-badge")?.textContent).toContain("Active");
        expect(el.querySelector(".header-action")?.textContent).toBe("Refresh");
        const css = layoutCss();
        expect(css).toMatch(/\.pg-page-header__actions \{[^}]*gap: 10px/);
        expect(css).toMatch(/\.pg-page-header__actions \{[^}]*flex-shrink: 0/);
        unmount();
    });

    it("maps PgText variants, tones, truncation and semantic tags", () => {
        const { el, unmount } = mount(TextHarness, {});
        const mono = el.querySelector("code.pg-text") as HTMLElement;
        expect(mono).toBeTruthy();
        expect(mono.classList.contains("pg-text--mono")).toBe(true);
        expect(mono.classList.contains("pg-text--tone-muted")).toBe(true);
        expect(mono.classList.contains("pg-text--truncate")).toBe(true);
        const clamped = el.querySelector("p.pg-text") as HTMLElement;
        expect(clamped.classList.contains("pg-text--caption")).toBe(true);
        expect(clamped.classList.contains("pg-text--clamp")).toBe(true);
        expect(clamped.style.getPropertyValue("--pg-text-clamp")).toBe("2");
        const legacy = el.querySelectorAll(".pg-text")[2] as HTMLElement;
        expect(legacy.classList.contains("pg-text--weight-semibold")).toBe(true);
        const sub = el.querySelector(".pg-subheader") as HTMLElement;
        expect(sub.querySelector(".pg-subheader__title")?.textContent).toBe("Recent events");
        expect(sub.querySelector(".pg-subheader__actions .sub-action")?.textContent).toBe("All");
        expect(layoutCss()).toMatch(/\.pg-subheader__actions \{[^}]*gap: 10px/);
        unmount();
    });

    it("keeps the legacy page-header aliases", () => {
        expect(PageHeader).toBe(PgPageHeader);
        expect(SubHeader).toBe(PgSubHeader);
        expect(ThemedText).toBe(PgText);
        expect(ThemedView).toBe(PgView);
    });
});

describe("PgForm validation", () => {
    it("blocks submit, focuses the first invalid control and emits validity", async () => {
        formSubmitted = 0;
        formFocused = 0;
        formValidity = [];
        const { el, unmount } = mount(FormHarness, { valid: false });
        const form = el.querySelector("form.pg-form") as HTMLFormElement;
        expect(form.hasAttribute("novalidate")).toBe(true);
        const event = new Event("submit", { bubbles: true, cancelable: true });
        form.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        await wait(0);
        expect(formSubmitted).toBe(0);
        expect(formFocused).toBe(1);
        expect(formValidity).toEqual([false]);
        unmount();
    });

    it("submits once when every registered control is valid", async () => {
        formSubmitted = 0;
        formValidity = [];
        const { el, unmount } = mount(FormHarness, { valid: true });
        (el.querySelector("form.pg-form") as HTMLFormElement).dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
        );
        await wait(0);
        expect(formSubmitted).toBe(1);
        expect(formValidity).toEqual([true]);
        unmount();
    });
});

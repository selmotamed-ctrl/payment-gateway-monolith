import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { nextTick, ref } from "vue";
import { PgButton, resolveButtonVariant } from "../src/actions/PgButton";
import { PgIcon } from "../src/actions/PgIcon";
import { PgDivider, PgProgressBar, PgSpinner } from "../src/actions/PgFeedbackAtoms";
import { PgSegmentedTabs } from "../src/actions/PgSegmentedTabs";
import { PgThemeLanguageControls, PgThemeMenu } from "../src/patterns/PgThemeControls";
import { icons } from "../src/actions/icons.generated";
import { dc } from "../src/lib/dc";
import { providePgUiConfig } from "../src/lib/config";
import { setLocale } from "../src/lib/locale";
import { setThemeMode } from "../src/lib/theme";
import { mount, nextFrame, wait } from "./helpers/render";

const actionsCss = readFileSync("src/tokens/parts/actions.css", "utf8");

/** Wraps a component so listeners are real child-component bindings. */
const hostOf = (render: () => any) => dc(() => render, { props: {} });

const waitFor = async <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): Promise<T> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const found = root.querySelector<T>(selector);
        if (found) return found;
        await nextFrame();
        await wait(5);
    }
    throw new Error(`Timed out waiting for ${selector}`);
};

afterEach(() => {
    setLocale("en");
    setThemeMode("light");
    vi.restoreAllMocks();
});

describe("PgButton variant hierarchy", () => {
    it("maps quiet danger utilities to outlined-danger, never a filled red block", () => {
        expect(resolveButtonVariant({ variant: "tonal", color: "error" })).toBe("outlined-danger");
        expect(resolveButtonVariant({ variant: "soft", color: "error" })).toBe("outlined-danger");
        expect(resolveButtonVariant({ variant: "outlined", color: "error" })).toBe("outlined-danger");
        expect(resolveButtonVariant({ variant: "text", color: "error" })).toBe("text-danger");
        expect(resolveButtonVariant({ variant: "flat", color: "error" })).toBe("danger");
        expect(resolveButtonVariant({ variant: "", color: "error" })).toBe("danger");
        expect(resolveButtonVariant({ variant: "outlined-danger" })).toBe("outlined-danger");
        expect(resolveButtonVariant({ variant: "text-danger" })).toBe("text-danger");
        expect(resolveButtonVariant({ variant: "tonal", color: "warning" })).toBe("outlined-warning");
        expect(resolveButtonVariant({ variant: "outlined", color: "success" })).toBe("outlined-success");
    });
});

describe("PgButton", () => {
    it("replaces prependIcon with a spinner while loading (never both)", () => {
        const { el, unmount } = mount(PgButton, {
            loading: true,
            prependIcon: "mdi-refresh",
            label: "Refresh",
        });
        const button = el.querySelector("button") as HTMLButtonElement;
        expect(button.querySelector(".pg-btn__spinner")).not.toBeNull();
        expect(button.querySelectorAll(".pg-icon").length).toBe(0);
        expect(button.querySelector(".pg-btn__label")?.textContent).toBe("Refresh");
        expect(button.getAttribute("aria-busy")).toBe("true");
        expect(button.getAttribute("aria-disabled")).toBe("true");
        expect(button.disabled).toBe(true);
        expect(button.classList.contains("pg-btn--loading")).toBe(true);
        unmount();
    });

    it("renders the prepend and append icons when not loading", () => {
        const { el, unmount } = mount(PgButton, {
            prependIcon: "mdi-refresh",
            appendIcon: "mdi-chevron-right",
            label: "Refresh",
        });
        const button = el.querySelector("button") as HTMLButtonElement;
        expect(button.querySelector(".pg-btn__spinner")).toBeNull();
        expect(button.querySelectorAll("svg.pg-icon").length).toBe(2);
        unmount();
    });

    it("blocks disabled and loading clicks and never fires onClick", () => {
        const disabledClick = vi.fn();
        const DisabledHost = hostOf(() => <PgButton disabled onClick={disabledClick} label="Disabled" />);
        const disabled = mount(DisabledHost, {});
        const disabledButton = disabled.el.querySelector("button") as HTMLButtonElement;
        expect(disabledButton.disabled).toBe(true);
        expect(disabledButton.getAttribute("aria-disabled")).toBe("true");
        disabledButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(disabledClick).not.toHaveBeenCalled();
        disabled.unmount();

        const loadingClick = vi.fn();
        const LoadingHost = hostOf(() => <PgButton loading onClick={loadingClick} label="Loading" />);
        const loading = mount(LoadingHost, {});
        const loadingButton = loading.el.querySelector("button") as HTMLButtonElement;
        loadingButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(loadingClick).not.toHaveBeenCalled();
        loading.unmount();

        const enabledClick = vi.fn();
        const EnabledHost = hostOf(() => <PgButton onClick={enabledClick} label="Save" />);
        const enabled = mount(EnabledHost, {});
        (enabled.el.querySelector("button") as HTMLButtonElement).click();
        expect(enabledClick).toHaveBeenCalledTimes(1);
        expect(enabledClick.mock.calls[0][0]).toBeInstanceOf(MouseEvent);
        enabled.unmount();
    });

    it("emits click and applies every canonical variant class", () => {
        const variants = ["primary", "secondary", "outlined", "tonal", "ghost", "text", "danger"];
        for (const variant of variants) {
            const clicks: MouseEvent[] = [];
            const Host = hostOf(() => <PgButton variant={variant} onClick={(event: MouseEvent) => clicks.push(event)} label="Save" />);
            const { el, unmount } = mount(Host, {});
            const button = el.querySelector("button") as HTMLButtonElement;
            expect(button.classList.contains(`pg-btn--${variant}`)).toBe(true);
            expect(actionsCss).toMatch(new RegExp(`\\.pg-btn--${variant}\\s*\\{`));
            button.click();
            expect(clicks.length).toBe(1);
            unmount();
        }
    });

    it("maps the legacy flat/soft/plain spellings onto the 2026 hierarchy", () => {
        const legacy: Array<[string, string]> = [
            ["flat", "primary"],
            ["soft", "tonal"],
            ["plain", "ghost"],
        ];
        for (const [input, expected] of legacy) {
            const { el, unmount } = mount(PgButton, { variant: input });
            expect((el.querySelector("button") as HTMLElement).classList.contains(`pg-btn--${expected}`)).toBe(true);
            unmount();
        }
    });

    it("sizes sm/md/lg and icon-only buttons per the 36/40/44 control contract", () => {
        for (const [size, height] of [
            ["sm", "pg-btn--sm"],
            ["md", "pg-btn--md"],
            ["lg", "pg-btn--lg"],
        ] as const) {
            const { el, unmount } = mount(PgButton, { size, label: "Save" });
            expect((el.querySelector("button") as HTMLElement).classList.contains(height)).toBe(true);
            unmount();
        }
        const icon = mount(PgButton, { icon: true, ariaLabel: "Search" });
        const iconButton = icon.el.querySelector("button") as HTMLButtonElement;
        expect(iconButton.classList.contains("pg-btn--icon")).toBe(true);
        expect(iconButton.getAttribute("aria-label")).toBe("Search");
        icon.unmount();

        expect(actionsCss).toMatch(/\.pg-btn\s*\{[^}]*flex-shrink:\s*0;/);
        expect(actionsCss).toMatch(/\.pg-btn--sm\s*\{[^}]*height:\s*var\(--pg-control-h-sm\);/);
        expect(actionsCss).toMatch(/\.pg-btn--lg\s*\{[^}]*height:\s*44px;/);
        expect(actionsCss).toMatch(/\.pg-btn--icon\s*\{[^}]*width:\s*var\(--pg-control-h-md\);/);
    });

    it("reacts to a loading/disabled toggle without keeping the prepend icon", async () => {
        const Host = dc(
            () => {
                const loading = ref(false);
                const disabled = ref(false);
                return () => (
                    <div>
                        <PgButton
                            loading={loading.value}
                            disabled={disabled.value}
                            prependIcon="mdi-refresh"
                            label="Refresh"
                        />
                        <button class="toggle-loading" type="button" onClick={() => (loading.value = !loading.value)}>
                            toggle
                        </button>
                    </div>
                );
            },
            { props: {} },
        );
        const { el, unmount } = mount(Host, {});
        const button = () => el.querySelector(".pg-btn") as HTMLButtonElement;
        expect(button().querySelector(".pg-btn__spinner")).toBeNull();
        expect(button().querySelectorAll(".pg-icon").length).toBe(1);

        (el.querySelector(".toggle-loading") as HTMLButtonElement).click();
        await nextTick();
        expect(button().querySelector(".pg-btn__spinner")).not.toBeNull();
        expect(button().querySelectorAll(".pg-icon").length).toBe(0);
        expect(button().getAttribute("aria-busy")).toBe("true");
        expect(button().disabled).toBe(true);
        unmount();
    });

    it("resolves and intercepts route links while preserving Ctrl/Cmd-click for a new tab", () => {
        const navigate = vi.fn();
        const Host = dc(
            (_props: any, _expose, { slots }) => {
                providePgUiConfig({
                    resolveHref: (to: any) => `/app${String(to)}`,
                    navigate,
                });
                return () => <PgButton to="/merchants" label="Merchants" />;
            },
            { inheritAttrs: false },
        );
        const { el, unmount } = mount(Host as any, {});
        const link = el.querySelector("a") as HTMLAnchorElement;
        expect(link.getAttribute("href")).toBe("/app/merchants");

        const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
        link.dispatchEvent(plain);
        expect(plain.defaultPrevented).toBe(true);
        expect(navigate).toHaveBeenCalledWith("/merchants");

        const ctrl = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
        link.dispatchEvent(ctrl);
        expect(ctrl.defaultPrevented).toBe(false);
        expect(navigate).toHaveBeenCalledTimes(1);
        unmount();
    });
});

describe("PgIcon", () => {
    it("renders the registry path for names with and without the mdi- prefix", () => {
        const plain = mount(PgIcon, { icon: "check" });
        const plainSvg = plain.el.querySelector("svg") as SVGElement;
        expect(plainSvg.querySelector("path")?.getAttribute("d")).toBe(icons["mdi-check"]);
        expect(plainSvg.getAttribute("aria-hidden")).toBe("true");
        expect(plainSvg.getAttribute("width")).toBe("18px");
        expect(plainSvg.style.width).toBe("18px");
        plain.unmount();

        const prefixed = mount(PgIcon, { icon: "mdi-magnify" });
        expect(prefixed.el.querySelector("path")?.getAttribute("d")).toBe(icons["mdi-magnify"]);
        prefixed.unmount();
    });

    it("maps semantic colour names to tokens and clears aria-hidden when labelled", () => {
        const success = mount(PgIcon, { icon: "mdi-check", color: "success" });
        const svg = success.el.querySelector("svg") as SVGElement;
        expect(svg.style.color).toBe("var(--pg-status-success-dot)");
        success.unmount();

        const muted = mount(PgIcon, { icon: "mdi-check", color: "muted", label: "Complete" });
        const labelled = muted.el.querySelector("svg") as SVGElement;
        expect(labelled.style.color).toBe("var(--pg-ink-muted)");
        expect(labelled.getAttribute("aria-hidden")).toBeNull();
        expect(labelled.getAttribute("aria-label")).toBe("Complete");
        expect(labelled.getAttribute("role")).toBe("img");
        muted.unmount();
    });

    it("mirrors directional icons in RTL", async () => {
        setLocale("ar");
        const { el, unmount } = mount(PgIcon, { icon: "mdi-chevron-right", directional: true });
        const svg = el.querySelector("svg") as SVGElement;
        expect(svg.style.transform).toBe("scaleX(-1)");
        unmount();
        setLocale("en");
    });

    it("renders an empty-safe svg and warns only once for an unknown icon", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const first = mount(PgIcon, { icon: "mdi-pg-ui-does-not-exist" });
        const second = mount(PgIcon, { icon: "mdi-pg-ui-does-not-exist" });
        expect(first.el.querySelector("svg")).not.toBeNull();
        expect(first.el.querySelector("path")?.getAttribute("d") ?? "").toBe("");
        expect(second.el.querySelector("svg")).not.toBeNull();
        const warnings = warn.mock.calls.filter((call) => String(call[0]).includes("mdi-pg-ui-does-not-exist"));
        expect(warnings.length).toBe(1);
        first.unmount();
        second.unmount();
    });
});

describe("PgFeedbackAtoms", () => {
    it("renders the spinner as a role=progressbar with exact pixel sizes", () => {
        const sizes: Array<[string, string]> = [
            ["xs", "14px"],
            ["sm", "16px"],
            ["md", "24px"],
            ["lg", "36px"],
        ];
        for (const [size, pixels] of sizes) {
            const { el, unmount } = mount(PgSpinner, { size });
            const svg = el.querySelector("svg") as SVGElement;
            expect(svg.getAttribute("role")).toBe("progressbar");
            expect(svg.style.width).toBe(pixels);
            expect(svg.style.height).toBe(pixels);
            expect(svg.getAttribute("aria-valuenow")).toBeNull();
            unmount();
        }

        const danger = mount(PgSpinner, { size: 20, color: "danger" });
        expect((danger.el.querySelector("svg") as SVGElement).style.color).toBe("var(--pg-status-danger-dot)");
        danger.unmount();
    });

    it("clamps determinate spinner values and reports aria-valuenow", () => {
        const high = mount(PgSpinner, { modelValue: 140 });
        expect((high.el.querySelector("svg") as SVGElement).getAttribute("aria-valuenow")).toBe("100");
        high.unmount();

        const low = mount(PgSpinner, { modelValue: -20 });
        expect((low.el.querySelector("svg") as SVGElement).getAttribute("aria-valuenow")).toBe("0");
        low.unmount();
    });

    it("renders the progress bar with clamped ARIA values, tones and labels", () => {
        const { el, unmount } = mount(PgProgressBar, { modelValue: 65, label: "Upload", showValue: true });
        const bar = el.querySelector("[role='progressbar']") as HTMLElement;
        expect(bar.getAttribute("aria-valuemin")).toBe("0");
        expect(bar.getAttribute("aria-valuemax")).toBe("100");
        expect(bar.getAttribute("aria-valuenow")).toBe("65");
        expect((bar.querySelector(".pg-progress__fill") as HTMLElement).style.width).toBe("65%");
        expect(el.textContent).toContain("Upload");
        expect(el.textContent).toContain("65%");
        unmount();

        const high = mount(PgProgressBar, { modelValue: 140 });
        expect((high.el.querySelector("[role='progressbar']") as HTMLElement).getAttribute("aria-valuenow")).toBe("100");
        expect((high.el.querySelector(".pg-progress__fill") as HTMLElement).style.width).toBe("100%");
        high.unmount();

        const low = mount(PgProgressBar, { modelValue: -10 });
        expect((low.el.querySelector("[role='progressbar']") as HTMLElement).getAttribute("aria-valuenow")).toBe("0");
        low.unmount();

        for (const tone of ["brand", "success", "warning", "danger", "info"]) {
            const toneBar = mount(PgProgressBar, { modelValue: 50, tone });
            expect((toneBar.el.querySelector("[role='progressbar']") as HTMLElement).classList.contains(`pg-progress--${tone}`)).toBe(true);
            toneBar.unmount();
            expect(actionsCss).toContain(`.pg-progress--${tone} .pg-progress__fill`);
        }

        const indeterminate = mount(PgProgressBar, { indeterminate: true });
        const indeterminateBar = indeterminate.el.querySelector("[role='progressbar']") as HTMLElement;
        expect(indeterminateBar.classList.contains("pg-progress--indeterminate")).toBe(true);
        expect(indeterminateBar.getAttribute("aria-valuenow")).toBeNull();
        indeterminate.unmount();
    });

    it("renders horizontal, vertical and labelled dividers with separator roles", () => {
        const horizontal = mount(PgDivider);
        const divider = horizontal.el.querySelector("[role='separator']") as HTMLElement;
        expect(divider.getAttribute("aria-orientation")).toBe("horizontal");
        horizontal.unmount();

        const vertical = mount(PgDivider, { vertical: true });
        const verticalDivider = vertical.el.querySelector("[role='separator']") as HTMLElement;
        expect(verticalDivider.getAttribute("aria-orientation")).toBe("vertical");
        expect(verticalDivider.classList.contains("pg-divider--vertical")).toBe(true);
        vertical.unmount();

        const labelled = mount(PgDivider, { label: "OR" });
        const labelledDivider = labelled.el.querySelector("[role='separator']") as HTMLElement;
        expect(labelledDivider.classList.contains("pg-divider--label")).toBe(true);
        expect(labelledDivider.textContent).toContain("OR");
        labelled.unmount();
    });
});

describe("PgSegmentedTabs", () => {
    const tabs = [
        { value: "24h", label: "24 hours" },
        { value: "7d", label: "7 days", count: 12 },
        { value: "30d", label: "30 days", disabled: true },
        { value: "90d", label: "90 days" },
    ];

    it("renders tabs, selects on click and shows the count pill", async () => {
        const updates: string[] = [];
        const Host = dc(
            () => {
                const value = ref("24h");
                return () => (
                    <PgSegmentedTabs
                        modelValue={value.value}
                        tabs={tabs}
                        onUpdate:modelValue={(next: string) => {
                            updates.push(next);
                            value.value = next;
                        }}
                    />
                );
            },
            { props: {} },
        );
        const { el, unmount } = mount(Host, {});
        const buttons = el.querySelectorAll<HTMLButtonElement>("[role='tab']");
        expect(el.querySelector("[role='tablist']")).not.toBeNull();
        expect(buttons.length).toBe(4);
        expect(buttons[0].getAttribute("aria-selected")).toBe("true");
        expect(buttons[0].getAttribute("tabindex")).toBe("0");
        expect(buttons[1].getAttribute("aria-selected")).toBe("false");
        expect(buttons[1].getAttribute("tabindex")).toBe("-1");
        expect(buttons[1].querySelector(".pg-segmented__count")?.textContent).toBe("12");

        buttons[1].click();
        await nextTick();
        expect(updates).toEqual(["7d"]);
        const active = el.querySelectorAll<HTMLButtonElement>("[role='tab']")[1];
        expect(active.getAttribute("aria-selected")).toBe("true");
        expect(active.getAttribute("tabindex")).toBe("0");

        (el.querySelectorAll<HTMLButtonElement>("[role='tab']")[2] as HTMLButtonElement).click();
        expect(updates).toEqual(["7d"]);
        unmount();
    });

    it("moves roving focus with arrow keys (LTR and RTL) and skips disabled tabs", async () => {
        const updates: string[] = [];
        const Host = dc(
            () => {
                const value = ref("24h");
                return () => (
                    <PgSegmentedTabs
                        modelValue={value.value}
                        tabs={tabs}
                        onUpdate:modelValue={(next: string) => {
                            updates.push(next);
                            value.value = next;
                        }}
                    />
                );
            },
            { props: {} },
        );
        const { el, unmount } = mount(Host, {});

        let buttons = el.querySelectorAll<HTMLButtonElement>("[role='tab']");
        buttons[0].focus();
        buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
        await nextTick();
        expect(updates).toEqual(["7d"]);
        expect(document.activeElement).toBe(buttons[1]);

        buttons[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
        await nextTick();
        expect(updates).toEqual(["7d", "90d"]);
        expect(document.activeElement).toBe(buttons[3]);

        setLocale("ar");
        updates.length = 0;
        buttons = el.querySelectorAll<HTMLButtonElement>("[role='tab']");
        buttons[0].focus();
        buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
        await nextTick();
        expect(updates).toEqual(["90d"]);
        expect(document.activeElement).toBe(buttons[3]);
        setLocale("en");
        unmount();
    });
});

describe("PgThemeControls", () => {
    it("opens the language menu, switches to Arabic (RTL) and back to English (LTR)", async () => {
        setThemeMode("light");
        const changes: string[] = [];
        const Host = hostOf(() => (
            <PgThemeLanguageControls onLocaleChange={(locale: string) => changes.push(locale)} />
        ));
        const { el, unmount } = mount(Host, {});
        const trigger = () => el.querySelector('[aria-label="Language"]') as HTMLElement;
        expect(trigger()).not.toBeNull();

        trigger().click();
        const arabic = await waitFor('[data-locale-option="ar"]');
        expect(arabic.textContent).toContain("العربية");
        expect((el.querySelector('[data-locale-option="en"]') as HTMLElement).getAttribute("aria-checked")).toBe("true");
        (arabic as HTMLButtonElement).click();
        expect(document.documentElement.getAttribute("dir")).toBe("rtl");
        expect(document.documentElement.getAttribute("lang")).toBe("ar");
        expect(localStorage.getItem("locale-name")).toBe("ar");
        expect(changes).toEqual(["ar"]);

        trigger().click();
        const english = await waitFor('[data-locale-option="en"]');
        expect(english.textContent).toContain("English");
        (english as HTMLButtonElement).click();
        expect(document.documentElement.getAttribute("dir")).toBe("ltr");
        expect(document.documentElement.getAttribute("lang")).toBe("en");
        expect(localStorage.getItem("locale-name")).toBe("en");
        expect(changes).toEqual(["ar", "en"]);
        unmount();
    });

    it("switches theme through the theme menu and marks the active option", async () => {
        setThemeMode("light");
        const changes: string[] = [];
        const Host = hostOf(() => (
            <PgThemeLanguageControls onThemeChange={(mode: string) => changes.push(mode)} />
        ));
        const { el, unmount } = mount(Host, {});
        const trigger = () => el.querySelector('[aria-label="Theme"]') as HTMLElement;
        trigger().click();
        const dark = await waitFor('[data-theme-option="dark"]');
        expect(dark.getAttribute("role")).toBe("menuitemradio");
        expect((el.querySelector('[data-theme-option="light"]') as HTMLElement).getAttribute("aria-checked")).toBe("true");
        (dark as HTMLButtonElement).click();
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
        expect(localStorage.getItem("pg-theme")).toBe("dark");
        expect(changes).toEqual(["dark"]);

        trigger().click();
        const light = await waitFor('[data-theme-option="light"]');
        expect(light.getAttribute("role")).toBe("menuitemradio");
        (light as HTMLButtonElement).click();
        expect(document.documentElement.getAttribute("data-theme")).toBe("light");
        expect(localStorage.getItem("pg-theme")).toBe("light");
        expect(changes).toEqual(["dark", "light"]);
        unmount();
    });

    it("works as a standalone PgThemeMenu and marks the active option", async () => {
        setThemeMode("light");
        const changes: string[] = [];
        const Host = hostOf(() => <PgThemeMenu onThemeChange={(mode: string) => changes.push(mode)} />);
        const { el, unmount } = mount(Host, {});
        (el.querySelector('[aria-label="Theme"]') as HTMLElement).click();
        const system = await waitFor('[data-theme-option="system"]');
        expect(el.querySelectorAll('[data-theme-option]').length).toBe(3);
        expect(system.textContent).toContain("System");
        (system as HTMLButtonElement).click();
        expect(changes).toEqual(["system"]);
        expect(localStorage.getItem("pg-theme")).toBe("system");
        unmount();
    });
});

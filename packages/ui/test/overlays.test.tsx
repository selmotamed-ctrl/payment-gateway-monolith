import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { dc } from "../src/lib/dc";
import { mount, nextFrame, wait } from "./helpers/render";
import { PgDialog } from "../src/overlays/PgDialog";
import { PgDrawer } from "../src/overlays/PgDrawer";
import { PgFormModal, PgConfirmDialog } from "../src/overlays/PgFormModal";
import { PgDetailsDialog } from "../src/overlays/PgDetailsDialog";
import { PgCommandPalette } from "../src/overlays/PgCommandPalette";
import { PgMenu } from "../src/overlays/PgMenu";
import { PgTooltip } from "../src/overlays/PgTooltip";
import { PgTextField } from "../src/inputs/PgTextField";
import { resetOverlayStack } from "../src/lib/overlayStack";

const pointerDown = (target: EventTarget) => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
};
const pressEscape = () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
};
const press = (target: EventTarget, key: string) => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
};
const setInput = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
};

const overlayCssPath = [
    `${process.cwd()}/src/tokens/parts/overlays.css`,
    `${process.cwd()}/packages/ui/src/tokens/parts/overlays.css`,
].find((path) => existsSync(path));

if (!overlayCssPath) throw new Error("Cannot locate overlays.css");

const overlayCss = readFileSync(overlayCssPath, "utf8");

const cssBlock = (selector: string): string => {
    const start = overlayCss.indexOf(`${selector} {`);
    if (start < 0) return "";
    const end = overlayCss.indexOf("}", start);
    return overlayCss.slice(start, end + 1);
};

const dialogHost = (options: { persistent?: boolean; size?: string } = {}) => {
    const open = ref(true);
    const updates: boolean[] = [];
    const Host = dc(() => () => (
        <PgDialog
            modelValue={open.value}
            onUpdate:modelValue={(value: boolean) => {
                updates.push(value);
                open.value = value;
            }}
            title="Inspect payment"
            subtitle="Reference PG-2026-00001"
            persistent={options.persistent}
            size={options.size ?? "md"}
            v-slots={{
                default: () => <p class="dialog-body">Body content</p>,
                footer: () => <button class="dialog-footer">Done</button>,
            }}
        />
    ));
    return { ...mount(Host as any, {}), open, updates };
};

const confirmHost = () => {
    let api: { show: (options: any) => Promise<boolean> } | null = null;
    const Host = dc(() => {
        const dialog = ref<any>(null);
        api = {
            show: (options: any) => dialog.value.show(options),
        };
        return () => <PgConfirmDialog ref={dialog} />;
    });
    return { ...mount(Host as any, {}), get api() { return api!; } };
};

const drawerHost = (scrim = true) => {
    const open = ref(true);
    const updates: boolean[] = [];
    const Host = dc(() => () => (
        <PgDrawer
            modelValue={open.value}
            onUpdate:modelValue={(value: boolean) => {
                updates.push(value);
                open.value = value;
            }}
            title="Journal entry"
            eyebrow="Inspector"
            subtitle="Double-entry ledger"
            scrim={scrim}
            v-slots={{
                default: () => <p class="drawer-body">Entry lines</p>,
                headerActions: () => <button class="drawer-action">Export</button>,
                footer: () => <button class="drawer-footer">Close</button>,
            }}
        />
    ));
    return { ...mount(Host as any, {}), open, updates };
};

const commandHost = () => {
    const open = ref(true);
    const queries: string[] = [];
    const submits: any[][] = [];
    const clicks: string[] = [];
    const Host = dc(() => () => (
        <PgCommandPalette
            modelValue={open.value}
            onUpdate:modelValue={(value: boolean) => (open.value = value)}
            onUpdate:query={(value: string) => queries.push(value)}
            onSubmit={(...args: any[]) => submits.push(args)}
            ariaLabel="Global search"
            v-slots={{
                default: ({ query }: any) => (
                    <div class="command-results">
                        <button
                            class="command-one"
                            role="option"
                            data-pg-command-item
                            onClick={() => clicks.push("one")}
                        >
                            Merchant A — {query}
                        </button>
                        <button
                            class="command-two"
                            role="option"
                            data-pg-command-item
                            onClick={() => clicks.push("two")}
                        >
                            Merchant B
                        </button>
                    </div>
                ),
            }}
        />
    ));
    return { ...mount(Host as any, {}), open, queries, submits, clicks };
};

const menuHost = (location = "bottom start") => {
    const updates: boolean[] = [];
    const picks: string[] = [];
    const Host = dc(() => () => (
        <PgMenu
            location={location}
            onUpdate:modelValue={(value: boolean) => updates.push(value)}
            v-slots={{
                activator: ({ props }: any) => (
                    <button class="menu-trigger" {...props}>
                        Actions
                    </button>
                ),
                default: () => (
                    <div class="menu-items">
                        <button class="menu-one" role="menuitem" onClick={() => picks.push("one")}>
                            One
                        </button>
                        <button class="menu-two" role="menuitem" onClick={() => picks.push("two")}>
                            Two
                        </button>
                    </div>
                ),
            }}
        />
    ));
    return { ...mount(Host as any, {}), updates, picks };
};

const tooltipHost = () => {
    const Host = dc(() => () => (
        <PgTooltip
            text="Refund the captured amount"
            v-slots={{ default: () => <button class="tip-trigger">Refund</button> }}
        />
    ));
    return mount(Host as any, {});
};

afterEach(() => {
    vi.useRealTimers();
    resetOverlayStack();
});

describe("PgDialog", () => {
    it("mounts through createIf, is a modal dialog and keeps the close button inside the header row", async () => {
        const { el, unmount, open } = dialogHost();
        await nextFrame();
        const dialog = el.querySelector(".pg-dialog");
        expect(dialog).toBeTruthy();
        expect(dialog?.getAttribute("role")).toBe("dialog");
        expect(dialog?.getAttribute("aria-modal")).toBe("true");
        expect(el.querySelector(".dialog-body")?.textContent).toBe("Body content");
        expect(el.querySelector(".dialog-footer")?.textContent).toBe("Done");

        const close = el.querySelector(".pg-dialog__close") as HTMLElement;
        expect(close).toBeTruthy();
        expect(close.closest(".pg-dialog__header")).toBeTruthy();
        expect(getComputedStyle(close).position).not.toBe("absolute");
        expect(close.closest(".pg-dialog__heading")).toBeNull();

        open.value = false;
        await nextTick();
        expect(el.querySelector(".pg-dialog")).toBeNull();
        open.value = true;
        await nextTick();
        expect(el.querySelector(".pg-dialog")).toBeTruthy();
        unmount();
    });

    it("closes on backdrop pointerdown and Escape, and emits update:modelValue", async () => {
        const { el, updates, unmount } = dialogHost();
        await nextFrame();
        pointerDown(el.querySelector(".pg-dialog-backdrop")!);
        await nextTick();
        expect(el.querySelector(".pg-dialog")).toBeNull();
        expect(updates).toContain(false);

        const second = dialogHost();
        await nextFrame();
        pressEscape();
        await nextTick();
        expect(second.el.querySelector(".pg-dialog")).toBeNull();
        expect(second.updates).toContain(false);
        unmount();
        second.unmount();
    });

    it("persistent blocks both Escape and the backdrop", async () => {
        const { el, updates, unmount } = dialogHost({ persistent: true });
        await nextFrame();
        pressEscape();
        pointerDown(el.querySelector(".pg-dialog-backdrop")!);
        await nextTick();
        expect(el.querySelector(".pg-dialog")).toBeTruthy();
        expect(updates).toHaveLength(0);
        expect((el.querySelector(".pg-dialog__close") as HTMLButtonElement).disabled).toBe(true);
        unmount();
    });

    it("declares a 32px close button that is never absolutely positioned in the overlay CSS", () => {
        expect(cssBlock(".pg-dialog__close")).toContain("width: 32px");
        expect(cssBlock(".pg-dialog__close")).toContain("height: 32px");
        expect(cssBlock(".pg-dialog__close")).not.toContain("position: absolute");
        expect(cssBlock(".pg-dialog__header-actions")).toContain("flex: 0 0 auto");
    });

    it("exposes show/hide for imperative callers", async () => {
        let dialog: any = null;
        const Host = dc(() => {
            const instance = ref<any>(null);
            dialog = {
                show: () => instance.value.show(),
                hide: () => instance.value.hide(),
            };
            return () => <PgDialog ref={instance} modelValue={false} title="Imperative" />;
        });
        const { el, unmount } = mount(Host as any, {});
        await nextTick();
        dialog.show();
        await nextTick();
        expect(el.querySelector(".pg-dialog")).toBeTruthy();
        dialog.hide();
        await nextTick();
        expect(el.querySelector(".pg-dialog")).toBeNull();
        unmount();
    });

    it("emits afterLeave after the close transition", async () => {
        const afterLeave = vi.fn();
        const { unmount } = mount(PgDialog, {
            modelValue: true,
            title: "Close me",
            "onAfterLeave": afterLeave,
        });
        await nextFrame();
        (document.querySelector(".pg-dialog__close") as HTMLButtonElement).click();
        await nextTick();
        await nextTick();
        expect(afterLeave).toHaveBeenCalledTimes(1);
        unmount();
    });

    it("locks body scroll and restores focus to the trigger", async () => {
        const trigger = document.createElement("button");
        trigger.className = "outside-trigger";
        document.body.appendChild(trigger);
        trigger.focus();

        const { el, unmount } = mount(PgDialog, { modelValue: true, title: "Focus me" });
        await nextFrame();
        expect(document.body.style.overflow).toBe("hidden");

        pointerDown(el.querySelector(".pg-dialog-backdrop")!);
        await nextTick();
        await nextFrame();
        expect(document.body.style.overflow).toBe("");
        expect(document.activeElement).toBe(trigger);

        unmount();
        trigger.remove();
    });
});

describe("PgConfirmDialog", () => {
    it("focuses Cancel for a danger confirmation and resolves true on confirm", async () => {
        const { api, unmount } = confirmHost();
        await nextTick();
        const result = api.show({ title: "Suspend merchant", message: "This blocks new payments.", type: "error" });
        await nextFrame();

        const cancel = document.querySelector(".pg-confirm__cancel") as HTMLElement;
        expect(cancel).toBeTruthy();
        expect(document.activeElement).toBe(cancel);

        (document.querySelector(".pg-confirm__confirm") as HTMLButtonElement).click();
        await nextFrame();
        await expect(result).resolves.toBe(true);
        unmount();
    });

    it("resolves false on cancel", async () => {
        const { api, unmount } = confirmHost();
        await nextTick();
        const result = api.show({ title: "Revoke key", message: "Revoke the API key?", type: "warning" });
        await nextFrame();
        (document.querySelector(".pg-confirm__cancel") as HTMLButtonElement).click();
        await nextFrame();
        await expect(result).resolves.toBe(false);
        unmount();
    });

    it("locks Confirm until requireText matches exactly", async () => {
        const { api, unmount } = confirmHost();
        await nextTick();
        const result = api.show({
            title: "Refund payment",
            message: "This cannot be undone.",
            tone: "danger",
            requireText: "REFUND",
        });
        await nextFrame();

        const confirm = document.querySelector(".pg-confirm__confirm") as HTMLButtonElement;
        const input = document.querySelector(".pg-confirm__lock input") as HTMLInputElement;
        expect(confirm.disabled).toBe(true);

        setInput(input, "refund");
        await nextTick();
        expect(confirm.disabled).toBe(true);

        setInput(input, "REFUND");
        await nextTick();
        expect(confirm.disabled).toBe(false);

        confirm.click();
        await nextFrame();
        await expect(result).resolves.toBe(true);
        unmount();
    });

    it("disables Cancel and Escape while the confirmation handler is in flight", async () => {
        const { api, unmount } = confirmHost();
        await nextTick();
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => (finish = resolve));
        const result = api.show({
            title: "Delete report",
            message: "Delete the published report?",
            onConfirm: () => gate,
        });
        await nextFrame();

        (document.querySelector(".pg-confirm__confirm") as HTMLButtonElement).click();
        await nextTick();

        const cancel = document.querySelector(".pg-confirm__cancel") as HTMLButtonElement;
        expect(cancel.disabled).toBe(true);
        expect((document.querySelector(".pg-dialog__close") as HTMLButtonElement).disabled).toBe(true);
        pressEscape();
        await nextTick();
        expect(document.querySelector(".pg-dialog")).toBeTruthy();

        finish();
        await nextFrame();
        await expect(result).resolves.toBe(true);
        expect(document.querySelector(".pg-dialog")).toBeNull();
        unmount();
    });
});

describe("PgFormModal", () => {
    it("validates the internal form before emitting submit", async () => {
        const onSubmit = vi.fn();
        const Host = dc(() => () => (
            <PgFormModal
                modelValue={true}
                title="Create merchant"
                submitLabel="Create"
                onSubmit={onSubmit}
                v-slots={{ default: () => <input class="required-field" required /> }}
            />
        ));
        const { el, unmount } = mount(Host as any, {});
        await nextTick();

        const form = el.querySelector("form.pg-form") as HTMLFormElement;
        expect(form).toBeTruthy();
        const submit = el.querySelector(".pg-dialog__footer .pg-btn--primary") as HTMLButtonElement;
        expect(submit).toBeTruthy();

        submit.click();
        await nextTick();
        expect(onSubmit).not.toHaveBeenCalled();

        (el.querySelector(".required-field") as HTMLInputElement).value = "Acme";
        submit.click();
        await wait(20);
        expect(onSubmit).toHaveBeenCalledTimes(1);
        unmount();
    });

    it("runs the internal PgForm rules before emitting submit", async () => {
        const onSubmit = vi.fn();
        const Host = dc(() => () => (
            <PgFormModal modelValue={true} title="Create merchant" onSubmit={onSubmit}>
                <PgTextField
                    modelValue=""
                    label="Legal name"
                    rules={[(value: string) => (value ? true : "Legal name is required")]}
                />
            </PgFormModal>
        ));
        const { el, unmount } = mount(Host as any, {});
        await nextTick();

        (el.querySelector(".pg-dialog__footer .pg-btn--primary") as HTMLButtonElement).click();
        await wait(20);
        expect(onSubmit).not.toHaveBeenCalled();

        const input = el.querySelector(".pg-control-native") as HTMLInputElement;
        input.value = "Acme";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        (el.querySelector(".pg-dialog__footer .pg-btn--primary") as HTMLButtonElement).click();
        await wait(20);
        expect(onSubmit).toHaveBeenCalledTimes(1);
        unmount();
    });

    it("renders the danger error alert inside the scrollable body", async () => {
        const Host = dc(() => () => (
            <PgFormModal modelValue={true} title="Edit" errorMessage="Server rejected the change">
                <p class="form-body">Fields</p>
            </PgFormModal>
        ));
        const { el, unmount } = mount(Host as any, {});
        await nextTick();
        const alert = el.querySelector(".pg-dialog__body .pg-alert--danger");
        expect(alert?.textContent).toContain("Server rejected the change");
        unmount();
    });
});

describe("PgDrawer", () => {
    it("renders the end-side inspector header/body/footer and closes on Escape", async () => {
        const { el, updates, unmount } = drawerHost();
        await nextFrame();
        const drawer = el.querySelector(".pg-slideover");
        expect(drawer).toBeTruthy();
        expect(drawer?.getAttribute("role")).toBe("complementary");
        expect(el.querySelector(".pg-slideover__eyebrow")?.textContent).toBe("Inspector");
        expect(el.querySelector(".pg-slideover__title")?.textContent).toBe("Journal entry");
        expect(el.querySelector(".pg-slideover__body .drawer-body")).toBeTruthy();
        expect(el.querySelector(".pg-slideover__footer .drawer-footer")).toBeTruthy();
        expect(el.querySelector(".pg-drawer-backdrop")?.classList.contains("pg-drawer-backdrop--scrim")).toBe(true);

        pressEscape();
        await nextTick();
        expect(el.querySelector(".pg-slideover")).toBeNull();
        expect(updates).toContain(false);
        unmount();
    });

    it("supports a disabled scrim for the non-blocking help drawer", async () => {
        const { el, unmount } = drawerHost(false);
        await nextFrame();
        const backdrop = el.querySelector(".pg-drawer-backdrop");
        expect(backdrop?.classList.contains("pg-drawer-backdrop--no-scrim")).toBe(true);
        unmount();
    });

    it("pads header/body/footer and keeps the body as the only scroller", () => {
        expect(cssBlock(".pg-slideover__header")).toContain("padding: var(--pg-space-dialog-header)");
        expect(cssBlock(".pg-slideover__body")).toContain("padding: var(--pg-space-dialog-body)");
        expect(cssBlock(".pg-slideover__body")).toContain("min-height: 0");
        expect(cssBlock(".pg-slideover__footer")).toContain("padding: var(--pg-space-dialog-footer)");
    });
});

describe("PgCommandPalette", () => {
    it("typing only updates the query and never emits submit/navigates", async () => {
        const { el, queries, submits, clicks, unmount } = commandHost();
        await nextFrame();
        const input = el.querySelector(".pg-command-palette__input") as HTMLInputElement;
        expect(input).toBeTruthy();
        setInput(input, "merchant");
        await nextTick();

        expect(queries).toContain("merchant");
        expect(submits).toHaveLength(0);
        expect(clicks).toHaveLength(0);
        expect(el.querySelector(".command-one")?.textContent).toContain("merchant");
        expect(el.querySelector(".pg-command-palette")).toBeTruthy();
        unmount();
    });

    it("ArrowDown moves the active row and Enter emits submit for the active item", async () => {
        const { el, submits, clicks, unmount } = commandHost();
        await nextFrame();
        const input = el.querySelector(".pg-command-palette__input") as HTMLInputElement;
        setInput(input, "merchant");
        await nextTick();
        press(input, "ArrowDown");
        await nextTick();

        expect(el.querySelector(".command-one")?.classList.contains("pg-command-palette__item--active")).toBe(false);
        expect(el.querySelector(".command-two")?.classList.contains("pg-command-palette__item--active")).toBe(true);

        press(input, "Enter");
        await nextTick();
        expect(submits).toHaveLength(1);
        expect(submits[0]?.[0]).toBe("merchant");
        expect(clicks).toHaveLength(0);
        unmount();
    });

    it("has no close X button in the 56px search header", async () => {
        const { el, unmount } = commandHost();
        await nextFrame();
        const search = el.querySelector(".pg-command-palette__search");
        expect(search?.querySelectorAll("button")).toHaveLength(0);
        expect(search?.querySelector(".pg-dialog__close")).toBeNull();
        expect(search?.querySelector("kbd")?.textContent).toBe("ESC");
        expect(cssBlock(".pg-command-palette__search")).toContain("height: 56px");
        expect(cssBlock(".pg-command-palette")).toContain("width: min(680px, calc(100vw - 32px))");
        unmount();
    });

    it("opening the palette closes an open drawer through the shared overlay stack", async () => {
        const drawerOpen = ref(true);
        const paletteOpen = ref(false);
        const Host = dc(() => () => (
            <div>
                <PgDrawer
                    modelValue={drawerOpen.value}
                    onUpdate:modelValue={(value: boolean) => (drawerOpen.value = value)}
                    title="Help"
                    v-slots={{ default: () => <p class="help-body">Help</p> }}
                />
                <PgCommandPalette
                    modelValue={paletteOpen.value}
                    onUpdate:modelValue={(value: boolean) => (paletteOpen.value = value)}
                    v-slots={{ default: () => <p class="result-body">Result</p> }}
                />
            </div>
        ));
        const { el, unmount } = mount(Host as any, {});
        await nextFrame();
        expect(el.querySelector(".pg-slideover")).toBeTruthy();

        paletteOpen.value = true;
        await nextTick();
        await nextFrame();
        expect(el.querySelector(".pg-slideover")).toBeNull();
        expect(el.querySelector(".pg-command-palette")).toBeTruthy();
        expect(drawerOpen.value).toBe(false);
        unmount();
    });
});

describe("PgMenu", () => {
    it("opens from the activator, focuses the first item from the keyboard, and closes on item click", async () => {
        const { el, updates, picks, unmount } = menuHost();
        await nextTick();
        const trigger = el.querySelector(".menu-trigger") as HTMLButtonElement;
        expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
        expect(trigger.getAttribute("aria-expanded")).toBe("false");

        trigger.click();
        await nextFrame();
        const panel = el.querySelector(".pg-menu-panel") as HTMLElement;
        const expandedTrigger = el.querySelector(".menu-trigger") as HTMLButtonElement;
        expect(panel).toBeTruthy();
        expect(panel.style.position).toBe("fixed");
        expect(panel.style.zIndex).toBe("var(--pg-z-popover)");
        expect(expandedTrigger.getAttribute("aria-expanded")).toBe("true");
        expect(document.activeElement).toBe(el.querySelector(".menu-one"));

        press(panel, "ArrowDown");
        expect(document.activeElement).toBe(el.querySelector(".menu-two"));

        (el.querySelector(".menu-one") as HTMLButtonElement).click();
        await nextTick();
        expect(picks).toContain("one");
        expect(el.querySelector(".pg-menu-panel")).toBeNull();
        expect(updates).toEqual([true, false]);
        unmount();
    });

    it("clamps a bottom-end panel inside window.innerWidth - 8", async () => {
        const { el, unmount } = menuHost("bottom end");
        const anchor = el.querySelector(".pg-menu-anchor") as HTMLElement;
        anchor.getBoundingClientRect = () =>
            ({
                left: window.innerWidth - 20,
                right: window.innerWidth - 4,
                top: 60,
                bottom: 92,
                width: 16,
                height: 32,
                x: window.innerWidth - 20,
                y: 60,
                toJSON: () => ({}),
            }) as DOMRect;
        (el.querySelector(".menu-trigger") as HTMLButtonElement).click();
        await nextFrame();
        const panel = el.querySelector(".pg-menu-panel") as HTMLElement;
        const left = parseFloat(panel.style.left);
        expect(Number.isFinite(left)).toBe(true);
        expect(left).toBeGreaterThanOrEqual(8);
        expect(left + 190).toBeLessThanOrEqual(window.innerWidth - 8);
        unmount();
    });
});

describe("PgTooltip", () => {
    it("waits 220ms before mounting, shows immediately on focus and hides on Escape", async () => {
        vi.useFakeTimers();
        const { el, unmount } = tooltipHost();
        const anchor = el.querySelector(".pg-tooltip-anchor") as HTMLElement;
        const trigger = el.querySelector(".tip-trigger") as HTMLButtonElement;

        anchor.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(219);
        await nextTick();
        expect(el.querySelector(".pg-tooltip")).toBeNull();

        await vi.advanceTimersByTimeAsync(1);
        await nextTick();
        const tooltip = el.querySelector(".pg-tooltip");
        expect(tooltip).toBeTruthy();
        expect(tooltip?.getAttribute("role")).toBe("tooltip");
        expect(tooltip?.textContent).toContain("Refund the captured amount");
        expect(trigger.getAttribute("aria-describedby")).toContain(tooltip?.id);

        anchor.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
        await nextTick();
        expect(el.querySelector(".pg-tooltip")).toBeNull();

        trigger.focus();
        await nextTick();
        expect(el.querySelector(".pg-tooltip")).toBeTruthy();

        trigger.click();
        await nextTick();
        expect(el.querySelector(".pg-tooltip")).toBeNull();

        trigger.blur();
        trigger.focus();
        await nextTick();
        expect(el.querySelector(".pg-tooltip")).toBeTruthy();

        pressEscape();
        await nextTick();
        expect(el.querySelector(".pg-tooltip")).toBeNull();
        unmount();
    });
});

describe("PgDetailsDialog", () => {
    it("renders fields with PgFieldsSection, skips empty sections and marks references copyable", async () => {
        const Host = dc(() => () => (
            <PgDetailsDialog
                modelValue={true}
                title="Payment details"
                sections={[
                    {
                        title: "Identity",
                        fields: [
                            { text: "Payment ID", value: "pay_01JABCDEF" },
                            { text: "Status", value: "SUCCEEDED" },
                        ],
                    },
                    { title: "Empty section", fields: [] },
                ]}
            />
        ));
        const { el, unmount } = mount(Host as any, {});
        await nextFrame();
        expect(el.querySelector(".pg-dialog")).toBeTruthy();
        expect(el.querySelector(".pg-fields-sections")).toBeTruthy();
        expect(el.textContent).toContain("pay_01JABCDEF");
        expect(el.textContent).toContain("SUCCEEDED");
        expect(el.textContent).not.toContain("Empty section");
        expect(el.querySelector(".pg-field-item__value--interactive")).toBeTruthy();
        unmount();
    });

    it("supports the imperative show() service used by showDetails()", async () => {
        let api: any = null;
        const Host = dc(() => {
            const instance = ref<any>(null);
            api = { show: (options: any) => instance.value.show(options) };
            return () => <PgDetailsDialog ref={instance} />;
        });
        const { el, unmount } = mount(Host as any, {});
        await nextTick();
        const result = api.show({
            title: "Payment details",
            sections: [{ title: "Identity", fields: [{ text: "Payment ID", value: "pay_imperative" }] }],
        });
        await nextFrame();
        expect(el.querySelector(".pg-details-dialog")).toBeTruthy();
        expect(el.textContent).toContain("pay_imperative");
        (el.querySelector(".pg-dialog__footer .pg-btn--outlined") as HTMLButtonElement).click();
        await nextTick();
        expect(el.querySelector(".pg-dialog")).toBeNull();
        await expect(result).resolves.toBe(false);
        unmount();
    });

    it("shows the loading state instead of the field grid", async () => {
        const { el, unmount } = mount(PgDetailsDialog, {
            modelValue: true,
            title: "Payment details",
            loading: true,
            sections: [{ title: "Identity", fields: [{ text: "Payment ID", value: "pay_1" }] }],
        });
        await nextFrame();
        expect(el.querySelector(".pg-details__loading")).toBeTruthy();
        expect(el.querySelector(".pg-fields-sections")).toBeNull();
        unmount();
    });
});

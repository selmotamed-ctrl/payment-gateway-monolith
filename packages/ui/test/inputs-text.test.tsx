import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createComponent, nextTick, ref } from "vue";
import { dc } from "../src/lib/dc";
import { mount } from "./helpers/render";
import { PgForm } from "../src/layout/PgShellPrimitives";
import { PgFieldShell } from "../src/inputs/PgFieldShell";
import { PgFormField } from "../src/inputs/PgFormField";
import { PgTextField } from "../src/inputs/PgTextField";
import { PgTextarea } from "../src/inputs/PgTextarea";
import { PgSearchInput } from "../src/inputs/PgSearchInput";
import { PgOtpInput } from "../src/inputs/PgOtpInput";
import { PgCodeEditor } from "../src/inputs/PgCodeEditor";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.resolve(here, "../src/tokens/parts/inputs-text.css"), "utf-8");

/**
 * `mount()` mounts its component as the app root. Vapor does not deliver emit
 * listeners on the root component, so every component under test is mounted as
 * a child of a tiny host - the same position it has in a real page.
 */
const mountChild = (Child: any, childProps: Record<string, any> = {}) => {
    const Host = dc(
        (_props: any, _expose: any, _ctx: any) => () => (
            <div class="test-host">{createComponent(Child, { $: [() => childProps] })}</div>
        ),
        { props: {}, inheritAttrs: true },
    );
    return mount(Host, {});
};

const typeInto = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
};

const keydown = (element: Element, key: string, init: KeyboardEventInit = {}) =>
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

const paste = (element: Element, text: string) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    element.dispatchEvent(event);
};

describe("PgFieldShell", () => {
    it("renders label, required mark, hint and swaps the hint for a live error", () => {
        const withHint = mountChild(PgFieldShell, { forId: "amount", label: "Amount", hint: "In LYD", required: true });
        expect(withHint.el.querySelector(".pg-field__label")?.textContent).toContain("Amount");
        expect(withHint.el.querySelector(".pg-field__required")?.textContent).toBe("*");
        expect(withHint.el.querySelector(".pg-field__hint")?.getAttribute("id")).toBe("amount-hint");
        expect(withHint.el.querySelector(".pg-field__error")).toBeNull();
        withHint.unmount();

        const withError = mountChild(PgFieldShell, {
            forId: "amount",
            label: "Amount",
            hint: "In LYD",
            error: "Amount is required",
        });
        expect(withError.el.querySelector(".pg-field__hint")).toBeNull();
        const error = withError.el.querySelector(".pg-field__error");
        expect(error?.getAttribute("role")).toBe("alert");
        expect(error?.getAttribute("id")).toBe("amount-error");
        expect(error?.textContent).toBe("Amount is required");
        withError.unmount();
    });

    it("omits the label and footer DOM entirely when they are empty", () => {
        const { el, unmount } = mountChild(PgFieldShell, {});
        expect(el.querySelector(".pg-field__label")).toBeNull();
        expect(el.querySelector(".pg-field__head")).toBeNull();
        expect(el.querySelector(".pg-field__hint")).toBeNull();
        expect(el.querySelector(".pg-field__error")).toBeNull();
        expect(el.querySelector(".pg-field__footer")).toBeNull();
        unmount();
    });

    it("links the hint/error ids to the slotted control with aria-describedby", async () => {
        const Host = dc(
            (_props: any, _expose: any, _ctx: any) => () => (
                <PgFieldShell forId="name" label="Name" hint="Legal name" error="Required">
                    <input id="name" />
                </PgFieldShell>
            ),
            { props: {}, inheritAttrs: true },
        );
        const { el, unmount } = mount(Host, {});
        await nextTick();
        const input = el.querySelector("input")!;
        expect(input.getAttribute("aria-describedby")).toBe("name-error");
        expect(input.getAttribute("aria-invalid")).toBe("true");
        expect(input.getAttribute("aria-required")).toBeNull();
        unmount();
    });

    it("keeps details hidden while still surfacing an error", () => {
        const { el, unmount } = mountChild(PgFieldShell, {
            label: "Search",
            hint: "Hidden hint",
            error: "Bad value",
            hideDetails: true,
        });
        expect(el.querySelector(".pg-field__hint")).toBeNull();
        expect(el.querySelector(".pg-field__error")?.textContent).toBe("Bad value");
        unmount();
    });

    it("marks disabled shells for styling", () => {
        const { el, unmount } = mountChild(PgFieldShell, { label: "Locked", disabled: true });
        expect(el.querySelector(".pg-field--disabled")).toBeTruthy();
        unmount();
    });
});

describe("PgFormField", () => {
    it("gives a slotted control one stable id and points the label at it", async () => {
        const Host = dc(
            (_props: any, _expose: any, _ctx: any) => () => (
                <PgFormField label="Code">
                    <input />
                </PgFormField>
            ),
            { props: {}, inheritAttrs: true },
        );
        const { el, unmount } = mount(Host, {});
        await nextTick();
        const input = el.querySelector("input") as HTMLInputElement;
        expect(input.id).toBeTruthy();
        expect(el.querySelector("label")?.getAttribute("for")).toBe(input.id);
        unmount();
    });

    it("associates its label, required mark, tooltip and error with a custom control", async () => {
        const Host = dc(
            (_props: any, _expose: any, _ctx: any) => () => (
                <PgFormField
                    label="Amount"
                    forId="amount-input"
                    required
                    hint="In LYD"
                    error="Must be positive"
                    tooltip="Enter the gross amount"
                >
                    <input id="amount-input" />
                </PgFormField>
            ),
            { props: {}, inheritAttrs: true },
        );
        const { el, unmount } = mount(Host, {});
        await nextTick();
        const label = el.querySelector("label")!;
        expect(label.getAttribute("for")).toBe("amount-input");
        expect(label.textContent).toContain("Amount");
        expect(label.textContent).toContain("*");
        expect(el.querySelector(".pg-form-field__tooltip")?.getAttribute("title")).toBe("Enter the gross amount");
        expect(el.querySelector(".pg-form-field__hint")).toBeNull();
        expect(el.querySelector(".pg-form-field__error")?.getAttribute("role")).toBe("alert");
        expect(el.querySelector("input")?.getAttribute("aria-describedby")).toBe("amount-input-error");
        expect(el.querySelector("input")?.getAttribute("aria-invalid")).toBe("true");
        unmount();
    });
});

describe("PgTextField", () => {
    it("owns the focus ring on the outer box while the inner input has zero chrome", async () => {
        const { el, unmount } = mountChild(PgTextField, { label: "Name", modelValue: "Salem" });
        const input = el.querySelector("input")!;
        const box = el.querySelector(".pg-control-box") as HTMLElement;
        input.focus();
        await nextTick();
        expect(box.classList.contains("pg-control-box--focused")).toBe(true);
        expect(input.className).not.toMatch(/outline/);
        expect(input.hasAttribute("style")).toBe(false);
        input.blur();
        await nextTick();
        expect(box.classList.contains("pg-control-box--focused")).toBe(false);
        unmount();

        expect(css).toMatch(/\.pg-control-box:focus-within,[\s\S]*?box-shadow: var\(--pg-focus-ring\)/);
        expect(css).toMatch(/\.pg-control-box \.pg-control-native[\s\S]*?outline: none !important/);
    });

    it("forwards class and data attributes to the field root, not the native input", () => {
        const { el, unmount } = mountChild(PgTextField, {
            modelValue: "x",
            class: "custom-field",
            "data-testid": "amount-field",
        });
        const root = el.querySelector(".pg-field")!;
        expect(root.classList.contains("custom-field")).toBe(true);
        expect(root.getAttribute("data-testid")).toBe("amount-field");
        expect(el.querySelector("input")?.getAttribute("data-testid")).toBeNull();
        unmount();
    });

    it("sizes the box with the shared control-height tokens", () => {
        const small = mountChild(PgTextField, { size: "sm" });
        expect(small.el.querySelector(".pg-control-box--sm")).toBeTruthy();
        small.unmount();
        const large = mountChild(PgTextField, { size: "lg" });
        expect(large.el.querySelector(".pg-control-box--lg")).toBeTruthy();
        large.unmount();
        expect(css).toContain("height: var(--pg-control-h-sm)");
        expect(css).toContain("height: var(--pg-control-h-md)");
        expect(css).toContain("height: var(--pg-control-h-lg)");
    });

    it("shows a 22px clear button only when non-empty and emits update + clear", async () => {
        const updates: any[] = [];
        const clears: any[] = [];
        const { el, unmount } = mountChild(PgTextField, {
            modelValue: "draft",
            clearable: true,
            "onUpdate:modelValue": (value: any) => updates.push(value),
            onClear: () => clears.push(true),
        });
        const button = el.querySelector(".pg-control-clear-btn") as HTMLButtonElement;
        expect(button).toBeTruthy();
        expect(button.getAttribute("aria-label")).toBe("Clear input");
        button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        button.click();
        await nextTick();
        expect(updates).toEqual([""]);
        expect(clears).toHaveLength(1);
        expect((el.querySelector("input") as HTMLInputElement).value).toBe("");
        expect(el.querySelector(".pg-control-clear-btn")).toBeNull();
        unmount();

        const empty = mountChild(PgTextField, { modelValue: "", clearable: true });
        expect(empty.el.querySelector(".pg-control-clear-btn")).toBeNull();
        empty.unmount();
    });

    it("toggles password visibility without moving focus", async () => {
        const { el, unmount } = mountChild(PgTextField, { type: "password", modelValue: "secret" });
        const input = el.querySelector("input") as HTMLInputElement;
        expect(input.type).toBe("password");
        const toggle = el.querySelector('[aria-label="Show password"]') as HTMLButtonElement;
        toggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        toggle.click();
        await nextTick();
        expect(input.type).toBe("text");
        expect(el.querySelector('[aria-label="Hide password"]')).toBeTruthy();
        unmount();
    });

    it("displays numeric zero instead of an empty value", () => {
        const { el, unmount } = mountChild(PgTextField, { modelValue: 0 });
        expect((el.querySelector("input") as HTMLInputElement).value).toBe("0");
        unmount();
    });

    it("renders prefix/suffix, a maxlength counter and the enter event", async () => {
        const enters: any[] = [];
        const { el, unmount } = mountChild(PgTextField, {
            modelValue: "12",
            prefix: "LYD",
            suffix: "amount",
            maxlength: 5,
            onEnter: (value: any) => enters.push(value),
        });
        expect(el.querySelector(".pg-control-affix")?.textContent).toBe("LYD");
        expect(el.querySelector(".pg-field__counter")?.textContent).toBe("2/5");
        keydown(el.querySelector("input")!, "Enter");
        expect(enters).toEqual(["12"]);
        unmount();
    });

    it("shows explicit and rule errors and applies the error ring", async () => {
        const { el, unmount } = mountChild(PgTextField, {
            modelValue: "",
            label: "Email",
            hint: "Work email",
            error: "Email is required",
        });
        expect(el.querySelector(".pg-control-box--error")).toBeTruthy();
        expect(el.querySelector(".pg-field__hint")).toBeNull();
        expect(el.querySelector(".pg-field__error")?.textContent).toBe("Email is required");
        unmount();

        const rules = [(value: any) => (value ? true : "Required")];
        const ruled = mountChild(PgTextField, { modelValue: "", label: "Code", rules });
        const input = ruled.el.querySelector("input")!;
        typeInto(input, "x");
        input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        await nextTick();
        expect(ruled.el.querySelector(".pg-field__error")).toBeNull();
        typeInto(input, "");
        input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        await nextTick();
        expect(ruled.el.querySelector(".pg-field__error")?.textContent).toBe("Required");
        ruled.unmount();
    });

    it("registers with PgForm and validates false then true on submit", async () => {
        const validity: any[] = [];
        const submissions: any[] = [];
        const Host = dc(
            (_props: any, _expose: any, _ctx: any) => {
                const value = ref("");
                return () => (
                    <PgForm
                        onSubmit={() => submissions.push(true)}
                        onUpdate:modelValue={(next: boolean) => validity.push(next)}
                    >
                        <PgTextField
                            label="Name"
                            modelValue={value.value}
                            rules={[(next: any) => (next ? true : "Required")]}
                            onUpdate:modelValue={(next: string) => {
                                value.value = next;
                            }}
                        />
                    </PgForm>
                );
            },
            { props: {}, inheritAttrs: true },
        );
        const { el, unmount } = mount(Host, {});
        const form = el.querySelector("form") as HTMLFormElement;
        form.requestSubmit();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(validity).toEqual([false]);
        expect(submissions).toEqual([]);
        expect(el.querySelector(".pg-field__error")?.textContent).toBe("Required");

        typeInto(el.querySelector("input")!, "Salem");
        await nextTick();
        form.requestSubmit();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(validity).toEqual([false, true]);
        expect(submissions).toHaveLength(1);
        unmount();
    });
});

describe("PgTextarea", () => {
    it("updates its value, counter and focus ring, and advertises auto-grow", async () => {
        const updates: any[] = [];
        const { el, unmount } = mountChild(PgTextarea, {
            modelValue: "",
            label: "Notes",
            maxlength: 20,
            counter: true,
            "onUpdate:modelValue": (value: any) => updates.push(value),
        });
        const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
        expect(textarea.getAttribute("data-autogrow")).toBe("true");
        expect(textarea.getAttribute("rows")).toBe("3");
        textarea.focus();
        await nextTick();
        expect(el.querySelector(".pg-control-box--focused")).toBeTruthy();
        typeInto(textarea, "hello");
        await nextTick();
        expect(updates).toEqual(["hello"]);
        expect(el.querySelector(".pg-field__counter")?.textContent).toBe("5/20");
        expect(textarea.getAttribute("maxlength")).toBe("20");
        unmount();
    });

    it("emits submit on Ctrl/Cmd+Enter but not on a plain Enter", () => {
        const submissions: any[] = [];
        const { el, unmount } = mountChild(PgTextarea, {
            modelValue: "line",
            onSubmit: (value: any) => submissions.push(value),
        });
        const textarea = el.querySelector("textarea")!;
        keydown(textarea, "Enter");
        expect(submissions).toEqual([]);
        keydown(textarea, "Enter", { ctrlKey: true });
        expect(submissions).toEqual(["line"]);
        unmount();
    });

    it("honours noResize", () => {
        const { el, unmount } = mountChild(PgTextarea, { noResize: true });
        expect(el.querySelector(".pg-control-textarea--no-resize")).toBeTruthy();
        unmount();
    });
});

describe("PgSearchInput", () => {
    it("uses the sm preset, leading magnifier and emits enter/search on Enter", async () => {
        const searches: any[] = [];
        const enters: any[] = [];
        const { el, unmount } = mountChild(PgSearchInput, {
            modelValue: "merchant",
            onSearch: (value: any) => searches.push(value),
            onEnter: (value: any) => enters.push(value),
        });
        expect(el.querySelector(".pg-control-box--sm")).toBeTruthy();
        expect(el.querySelector('[aria-label="Search"]')).toBeTruthy();
        keydown(el.querySelector("input")!, "Enter");
        await nextTick();
        expect(searches).toEqual(["merchant"]);
        expect(enters).toEqual(["merchant"]);
        unmount();
    });

    it("clears on Escape and emits clear", async () => {
        const updates: any[] = [];
        const clears: any[] = [];
        const { el, unmount } = mountChild(PgSearchInput, {
            modelValue: "abc",
            "onUpdate:modelValue": (value: any) => updates.push(value),
            onClear: () => clears.push(true),
        });
        keydown(el.querySelector("input")!, "Escape");
        await nextTick();
        expect(updates).toContain("");
        expect(clears).toHaveLength(1);
        unmount();
    });

    it("debounces search when a debounce is supplied", async () => {
        vi.useFakeTimers();
        try {
            const searches: any[] = [];
            const { el, unmount } = mountChild(PgSearchInput, {
                modelValue: "",
                debounce: 150,
                onSearch: (value: any) => searches.push(value),
            });
            typeInto(el.querySelector("input")!, "qa");
            expect(searches).toEqual([]);
            vi.advanceTimersByTime(150);
            expect(searches).toEqual(["qa"]);
            unmount();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("PgOtpInput", () => {
    it("stays LTR in an RTL document and distributes a formatted paste exactly once", async () => {
        document.documentElement.setAttribute("dir", "rtl");
        const updates: any[] = [];
        const completions: any[] = [];
        const { el, unmount } = mountChild(PgOtpInput, {
            modelValue: "",
            "onUpdate:modelValue": (value: any) => updates.push(value),
            onComplete: (value: any) => completions.push(value),
        });
        const otp = el.querySelector(".pg-otp") as HTMLElement;
        expect(otp.getAttribute("dir")).toBe("ltr");
        const boxes = Array.from(el.querySelectorAll<HTMLInputElement>(".pg-otp__box"));
        expect(boxes).toHaveLength(6);
        expect(boxes[0]!.getAttribute("autocomplete")).toBe("one-time-code");
        expect(boxes[0]!.getAttribute("inputmode")).toBe("numeric");
        expect(boxes[1]!.getAttribute("autocomplete")).toBe("off");

        paste(boxes[0]!, "482-910");
        await nextTick();
        expect(updates).toEqual(["482910"]);
        expect(completions).toEqual(["482910"]);

        paste(boxes[0]!, "482910");
        await nextTick();
        expect(completions).toEqual(["482910"]);
        unmount();
        document.documentElement.setAttribute("dir", "ltr");
    });

    it("auto-advances on typing and steps back on Backspace", async () => {
        const updates: any[] = [];
        const { el, unmount } = mountChild(PgOtpInput, {
            modelValue: "",
            "onUpdate:modelValue": (value: any) => updates.push(value),
        });
        const boxes = Array.from(el.querySelectorAll<HTMLInputElement>(".pg-otp__box"));
        boxes[0]!.focus();
        typeInto(boxes[0]!, "4");
        await nextTick();
        expect(updates).toEqual(["4"]);
        expect(document.activeElement).toBe(boxes[1]);

        keydown(boxes[1]!, "Backspace");
        await nextTick();
        keydown(boxes[1]!, "Backspace");
        await nextTick();
        expect(document.activeElement).toBe(boxes[0]);
        unmount();
    });

    it("masks digits and shows the optional separator", () => {
        const { el, unmount } = mountChild(PgOtpInput, { modelValue: "123456", mask: true, separator: true });
        const boxes = Array.from(el.querySelectorAll<HTMLInputElement>(".pg-otp__box"));
        expect(boxes[0]!.type).toBe("password");
        expect(el.querySelector(".pg-otp__separator")?.textContent).toBe("–");
        unmount();
    });
});

describe("PgCodeEditor", () => {
    it("accepts valid JSON, reports validChange and formats through the toolbar", async () => {
        const updates: any[] = [];
        const validity: any[] = [];
        const { el, unmount } = mountChild(PgCodeEditor, {
            modelValue: '{"a":1}',
            "onUpdate:modelValue": (value: any) => updates.push(value),
            onValidChange: (value: any) => validity.push(value),
        });
        const frame = el.querySelector(".pg-json-editor__frame")!;
        expect(frame.classList.contains("pg-json-editor__frame--invalid")).toBe(false);
        expect(frame.getAttribute("dir")).toBe("ltr");
        expect(el.querySelector(".pg-json-editor__status")?.textContent).toBe("Valid JSON");
        expect(validity).toEqual([true]);

        const format = Array.from(el.querySelectorAll("button")).find((button) => button.textContent === "Format")!;
        format.click();
        await nextTick();
        expect(updates).toEqual(['{\n  "a": 1\n}']);
        unmount();
    });

    it("marks invalid JSON with the frame class, status and error gutter line", async () => {
        const validity: any[] = [];
        const { el, unmount } = mountChild(PgCodeEditor, {
            modelValue: '{\n  "a": 1,\n}',
            "onValidChange": (value: any) => validity.push(value),
        });
        expect(el.querySelector(".pg-json-editor__frame--invalid")).toBeTruthy();
        expect(el.querySelector(".pg-json-editor__status")?.textContent).toMatch(/^Line \d+ error$/);
        expect(el.querySelector(".pg-json-editor__gutter-line--error")).toBeTruthy();
        expect(el.querySelector(".pg-json-editor__error")?.textContent).toMatch(/^Line \d+:/);
        expect(validity).toEqual([false]);
        unmount();
    });

    it("treats an empty optional value as valid", () => {
        const { el, unmount } = mountChild(PgCodeEditor, { modelValue: "" });
        expect(el.querySelector(".pg-json-editor__frame--invalid")).toBeNull();
        expect(el.querySelector(".pg-json-editor__status")?.textContent).toBe("Valid JSON");
        expect(el.querySelector(".pg-json-editor__gutter-line")?.textContent).toBe("1");
        unmount();
    });

    it("inserts two spaces on Tab and formats with Cmd/Ctrl+Shift+F", async () => {
        const updates: any[] = [];
        const { el, unmount } = mountChild(PgCodeEditor, {
            modelValue: '{\n"a":1\n}',
            "onUpdate:modelValue": (value: any) => updates.push(value),
        });
        const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
        textarea.selectionStart = 1;
        textarea.selectionEnd = 1;
        keydown(textarea, "Tab");
        expect(updates.at(-1)).toBe('{  \n"a":1\n}');
        keydown(textarea, "f", { ctrlKey: true, shiftKey: true });
        expect(updates.at(-1)).toBe('{\n  "a": 1\n}');
        unmount();
    });

    it("keeps the gutter synced to the textarea scroll position", () => {
        const { el, unmount } = mountChild(PgCodeEditor, {
            modelValue: "{\n  \"a\": 1,\n  \"b\": 2\n}",
        });
        const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
        const gutter = el.querySelector(".pg-json-editor__gutter") as HTMLElement;
        Object.defineProperty(textarea, "scrollTop", { value: 40, writable: true, configurable: true });
        textarea.dispatchEvent(new Event("scroll"));
        expect(gutter.scrollTop).toBe(40);
        unmount();

        expect(css).toMatch(/\.pg-json-editor__gutter-line[\s\S]*?height: 20px/);
        expect(css).toMatch(/\.pg-json-editor__input[\s\S]*?line-height: 20px/);
    });
});

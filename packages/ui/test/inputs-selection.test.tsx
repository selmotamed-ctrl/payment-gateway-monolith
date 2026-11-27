import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ref } from "vue";
import { dc } from "../src/lib/dc";
import { PgCheckbox } from "../src/inputs/PgCheckbox";
import { PgChoice } from "../src/inputs/PgChoice";
import { PgRadio, PgRadioGroup, PgSwitch } from "../src/inputs/PgToggle";
import { PgFileUpload } from "../src/inputs/PgFileUpload";
import { mount, nextFrame } from "./helpers/render";

const click = (element: Element | null) => {
    if (!element) throw new Error("element not found");
    (element as HTMLElement).click();
};

const fileOf = (name: string, type = "application/pdf", size?: number): File => {
    const file = new File(["content"], name, { type });
    if (size !== undefined) {
        Object.defineProperty(file, "size", { value: size, configurable: true });
    }
    return file;
};

describe("PgCheckbox (2026 tactile squircle)", () => {
    it("renders a genuinely unchecked native input and emits true on any click", async () => {
        let next: any;
        const Host = dc(() => {
            const value = ref(false);
            return () => (
                <PgCheckbox
                    modelValue={value.value}
                    label="Active"
                    onUpdate:modelValue={(nextValue: boolean) => {
                        next = nextValue;
                        value.value = nextValue;
                    }}
                />
            );
        });
        const { el, unmount } = mount(Host, {});
        const input = el.querySelector("input[type='checkbox']") as HTMLInputElement;
        expect(input).toBeTruthy();
        expect(input.checked).toBe(false);
        expect(el.querySelector(".pg-chk__check")).toBeNull();
        expect(el.querySelector(".pg-chk")?.classList.contains("pg-chk--checked")).toBe(false);

        click(el.querySelector(".pg-chk__box"));
        expect(next).toBe(true);
        await nextFrame();
        expect(input.checked).toBe(true);
        expect(el.querySelector(".pg-chk__check")).not.toBeNull();
        expect(el.querySelector(".pg-chk")?.classList.contains("pg-chk--checked")).toBe(true);
        unmount();
    });

    it("toggles array membership with value and sameValue()", () => {
        let next: any;
        const Host = dc(() => {
            const value = ref<any[]>(["PENDING"]);
            return () => (
                <PgCheckbox
                    modelValue={value.value}
                    value="ACTIVE"
                    label="Active"
                    onUpdate:modelValue={(nextValue: any[]) => {
                        next = nextValue;
                        value.value = nextValue;
                    }}
                />
            );
        });
        const { el, unmount } = mount(Host, {});
        expect((el.querySelector("input[type='checkbox']") as HTMLInputElement).checked).toBe(false);
        click(el.querySelector(".pg-chk__box"));
        expect(next).toEqual(["PENDING", "ACTIVE"]);

        const SecondHost = dc(() => {
            const value = ref<any[]>(["ACTIVE", 7]);
            return () => (
                <PgCheckbox
                    modelValue={value.value}
                    value="ACTIVE"
                    onUpdate:modelValue={(nextValue: any[]) => {
                        next = nextValue;
                        value.value = nextValue;
                    }}
                />
            );
        });
        const second = mount(SecondHost, {});
        expect((second.el.querySelector("input[type='checkbox']") as HTMLInputElement).checked).toBe(true);
        click(second.el.querySelector(".pg-chk__box"));
        expect(next).toEqual([7]);
        second.unmount();
        unmount();
    });

    it("renders the indeterminate dash and exposes the native indeterminate property", async () => {
        const { el, unmount } = mount(PgCheckbox, { modelValue: false, indeterminate: true, label: "Some rows" });
        await nextFrame();
        const input = el.querySelector("input[type='checkbox']") as HTMLInputElement;
        expect(input.indeterminate).toBe(true);
        expect(input.getAttribute("aria-checked")).toBe("mixed");
        expect(el.querySelector(".pg-chk__dash")).not.toBeNull();
        expect(el.querySelector(".pg-chk__check")).toBeNull();
        expect(el.querySelector(".pg-chk")?.classList.contains("pg-chk--indeterminate")).toBe(true);
        unmount();
    });

    it("never toggles while disabled", () => {
        const { el, unmount } = mount(PgCheckbox, { modelValue: false, disabled: true, label: "Blocked" });
        const input = el.querySelector("input[type='checkbox']") as HTMLInputElement;
        expect(input.disabled).toBe(true);
        expect(el.querySelector(".pg-checkbox-field")?.classList.contains("pg-checkbox-field--disabled")).toBe(true);
        click(el.querySelector(".pg-chk__box"));
        expect(input.checked).toBe(false);
        expect(el.querySelector(".pg-chk")?.classList.contains("pg-chk--checked")).toBe(false);
        unmount();
    });

    it("supports true-value / false-value and the compliance card variant", () => {
        let next: any;
        const Host = dc(() => {
            const value = ref<any>(false);
            return () => (
                <PgCheckbox
                    modelValue={value.value}
                    trueValue="yes"
                    falseValue="no"
                    variant="card"
                    label="Export summary"
                    description="All four checks are complete."
                    onUpdate:modelValue={(nextValue: any) => {
                        next = nextValue;
                        value.value = nextValue;
                    }}
                />
            );
        });
        const { el, unmount } = mount(Host, {});
        expect(el.querySelector(".pg-check-card")).not.toBeNull();
        expect(el.querySelector(".pg-check-card__title")?.textContent).toContain("Export summary");
        click(el.querySelector(".pg-chk__box"));
        expect(next).toBe("yes");
        unmount();
    });
});

describe("PgChoice selection card", () => {
    it("exposes role/aria-checked and toggles from a card click", async () => {
        const Host = dc(() => {
            const value = ref(false);
            return () => (
                <PgChoice
                    modelValue={value.value}
                    title="Bank transfer"
                    description="Settles in one business day."
                    icon="mdi-bank-outline"
                    onUpdate:modelValue={(next: boolean) => {
                        value.value = next;
                    }}
                />
            );
        });
        const { el, unmount } = mount(Host, {});
        const choice = el.querySelector(".pg-choice") as HTMLElement;
        expect(choice.getAttribute("role")).toBe("checkbox");
        expect(choice.getAttribute("aria-checked")).toBe("false");
        expect(choice.getAttribute("tabindex")).toBe("0");

        choice.click();
        await nextFrame();
        expect(choice.getAttribute("aria-checked")).toBe("true");
        expect(choice.classList.contains("pg-choice--checked")).toBe(true);
        expect(el.querySelector(".pg-choice__icon")).not.toBeNull();
        expect(el.querySelector(".pg-choice__title")?.textContent).toContain("Bank transfer");
        unmount();
    });

    it("renders radio mode and ignores clicks on links inside the description", async () => {
        let toggles = 0;
        const Host = dc(() => (
            <PgChoice
                modelValue={false}
                mode="radio"
                title="Fast"
                onUpdate:modelValue={() => {
                    toggles += 1;
                }}
            >
                <a
                    href="#learn"
                    class="learn-more"
                    onClick={(event: MouseEvent) => event.preventDefault()}
                >
                    Learn more
                </a>
            </PgChoice>
        ));
        const { el, unmount } = mount(Host, {});
        const choice = el.querySelector(".pg-choice") as HTMLElement;
        expect(choice.getAttribute("role")).toBe("radio");
        expect(choice.getAttribute("aria-checked")).toBe("false");

        click(el.querySelector(".learn-more"));
        expect(toggles).toBe(0);

        choice.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(toggles).toBe(1);
        choice.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        expect(toggles).toBe(2);
        unmount();
    });

    it("keeps the legacy checked/onChange contract used by the Academy", () => {
        let next: any;
        const Host = dc(() => (
            <PgChoice
                type="radio"
                checked
                state="selected"
                name="question"
                onChange={(value: boolean) => {
                    next = value;
                }}
            >
                Answer A
            </PgChoice>
        ));
        const { el, unmount } = mount(Host, {});
        const choice = el.querySelector(".pg-choice") as HTMLElement;
        expect(choice.getAttribute("role")).toBe("radio");
        expect(choice.getAttribute("aria-checked")).toBe("true");
        expect(choice.classList.contains("pg-choice--selected")).toBe(true);
        click(choice);
        expect(next).toBe(true);
        unmount();
    });
});

describe("PgSwitch tactile toggle", () => {
    it("toggles aria-checked, emits and stops table-cell click propagation", async () => {
        const outerClick = vi.fn();
        const updates: boolean[] = [];
        const Host = dc(() => {
            const value = ref(false);
            return () => (
                <div onClick={outerClick}>
                    <PgSwitch
                        modelValue={value.value}
                        label="Webhook active"
                        onUpdate:modelValue={(next: boolean) => {
                            updates.push(next);
                            value.value = next;
                        }}
                    />
                </div>
            );
        });
        const { el, unmount } = mount(Host, {});
        const input = el.querySelector("input[role='switch']") as HTMLInputElement;
        expect(input).toBeTruthy();
        expect(input.getAttribute("aria-checked")).toBe("false");
        expect(el.querySelector(".pg-switch__track")).not.toBeNull();

        click(el.querySelector(".pg-switch__track"));
        await nextFrame();
        expect(updates).toEqual([true]);
        expect(input.getAttribute("aria-checked")).toBe("true");
        expect(outerClick).not.toHaveBeenCalled();
        unmount();
    });

    it("blocks activation while loading and renders a spinner in the thumb", async () => {
        const updates: boolean[] = [];
        const Host = dc(() => {
            const value = ref(false);
            return () => (
                <PgSwitch
                    modelValue={value.value}
                    loading
                    label="Saving"
                    onUpdate:modelValue={(next: boolean) => {
                        updates.push(next);
                        value.value = next;
                    }}
                />
            );
        });
        const { el, unmount } = mount(Host, {});
        expect(el.querySelector(".pg-switch")?.classList.contains("pg-switch--loading")).toBe(true);
        expect(el.querySelector(".pg-switch__thumb .pg-spinner")).not.toBeNull();
        const input = el.querySelector("input[role='switch']") as HTMLInputElement;
        expect(input.disabled).toBe(true);
        click(el.querySelector(".pg-switch__track"));
        await nextFrame();
        expect(updates).toEqual([]);
        unmount();
    });
});

describe("PgRadioGroup and PgRadio", () => {
    it("selects on click and keeps a single radio checked", async () => {
        const updates: string[] = [];
        const Host = dc(() => {
            const value = ref("a");
            return () => (
                <PgRadioGroup
                    modelValue={value.value}
                    label="Settlement frequency"
                    onUpdate:modelValue={(next: string) => {
                        updates.push(next);
                        value.value = next;
                    }}
                >
                    <PgRadio value="a" label="Daily" />
                    <PgRadio value="b" label="Weekly" />
                    <PgRadio value="c" label="Monthly" />
                </PgRadioGroup>
            );
        });
        const { el, unmount } = mount(Host, {});
        expect(el.querySelector("[role='radiogroup']")).not.toBeNull();
        const radios = Array.from(el.querySelectorAll("input[type='radio']")) as HTMLInputElement[];
        expect(radios).toHaveLength(3);
        expect(radios[0]!.checked).toBe(true);
        expect(radios[0]!.getAttribute("aria-checked")).toBe("true");

        click(el.querySelectorAll(".pg-radio")[1]);
        await nextFrame();
        expect(updates).toEqual(["b"]);
        expect(radios[0]!.checked).toBe(false);
        expect(radios[1]!.checked).toBe(true);
        expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
        unmount();
    });

    it("moves focus and selection with ArrowDown", async () => {
        const Host = dc(() => {
            const value = ref("a");
            return () => (
                <PgRadioGroup modelValue={value.value} onUpdate:modelValue={(next: string) => (value.value = next)}>
                    <PgRadio value="a" label="Daily" />
                    <PgRadio value="b" label="Weekly" disabled />
                    <PgRadio value="c" label="Monthly" />
                </PgRadioGroup>
            );
        });
        const { el, unmount } = mount(Host, {});
        const radios = Array.from(el.querySelectorAll("input[type='radio']")) as HTMLInputElement[];
        radios[0]!.focus();
        radios[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        await nextFrame();
        expect(document.activeElement).toBe(radios[2]);
        expect(radios[2]!.checked).toBe(true);
        unmount();
    });

    it("renders options through the options array", () => {
        const { el, unmount } = mount(PgRadioGroup, {
            modelValue: "x",
            options: [
                { value: "x", label: "Option X" },
                { value: "y", label: "Option Y", description: "Second" },
            ],
        });
        expect(el.querySelectorAll(".pg-radio")).toHaveLength(2);
        expect(el.textContent).toContain("Option X");
        expect(el.textContent).toContain("Second");
        unmount();
    });
});

describe("PgFileUpload dropzone", () => {
    it("rejects an oversized drop with a size reason and visible message", async () => {
        const reject = vi.fn();
        const Host = dc(() => {
            const value = ref<any>(null);
            return () => (
                <PgFileUpload
                    modelValue={value.value}
                    maxSizeMb={10}
                    onReject={reject}
                    onUpdate:modelValue={(next: any) => {
                        value.value = next;
                    }}
                />
            );
        });
        const { el, unmount } = mount(Host, {});
        const dropzone = el.querySelector(".pg-dropzone") as HTMLElement;
        const oversized = fileOf("statement.pdf", "application/pdf", 25 * 1024 * 1024);
        const event = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: { files: [oversized] } });
        dropzone.dispatchEvent(event);

        expect(reject).toHaveBeenCalledTimes(1);
        const reasons = reject.mock.calls[0]![0] as Array<{ file: File; reason: string; message: string }>;
        expect(reasons).toHaveLength(1);
        expect(reasons[0]!.file.name).toBe("statement.pdf");
        expect(reasons[0]!.reason).toBe("maxSize");
        expect(reasons[0]!.message).toContain("10 MB");
        expect(el.textContent).toContain("10 MB");
        await nextFrame();
        expect(dropzone.classList.contains("pg-dropzone--error")).toBe(true);
        unmount();
    });

    it("keeps already-valid files while rejecting an oversized one", () => {
        const updates: any[] = [];
        const reject = vi.fn();
        const existing = fileOf("existing.pdf");
        const Host = dc(() => {
            const value = ref<any>([existing]);
            return () => (
                <PgFileUpload
                    modelValue={value.value}
                    maxSizeMb={10}
                    onReject={reject}
                    onUpdate:modelValue={(next: any) => {
                        updates.push(next);
                        value.value = next;
                    }}
                />
            );
        });
        const { el, unmount } = mount(Host, {});
        const valid = fileOf("licence.pdf");
        const oversized = fileOf("huge.pdf", "application/pdf", 25 * 1024 * 1024);
        const event = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: { files: [valid, oversized] } });
        (el.querySelector(".pg-dropzone") as HTMLElement).dispatchEvent(event);

        expect(updates.at(-1)).toHaveLength(2);
        expect(updates.at(-1).map((file: File) => file.name)).toEqual(["existing.pdf", "licence.pdf"]);
        expect(reject.mock.calls[0]![0][0].file.name).toBe("huge.pdf");
        expect(reject.mock.calls[0]![0][0].reason).toBe("maxSize");
        unmount();
    });

    it("lists existing files and removes a single row", () => {
        const updates: any[] = [];
        const existing = fileOf("existing.pdf");
        const Host = dc(() => {
            const value = ref<any>([existing]);
            return () => (
                <PgFileUpload
                    modelValue={value.value}
                    onUpdate:modelValue={(next: any) => {
                        updates.push(next);
                        value.value = next;
                    }}
                />
            );
        });
        const { el, unmount } = mount(Host, {});
        expect(el.querySelectorAll(".pg-file-row")).toHaveLength(1);
        expect(el.textContent).toContain("existing.pdf");

        click(el.querySelector(".pg-file-row__remove"));
        expect(updates.at(-1)).toEqual([]);
        unmount();
    });

    it("accepts a valid file, resets input.value and allows the same filename again", () => {
        const updates: any[] = [];
        const Host = dc(() => {
            const value = ref<any>(null);
            return () => (
                <PgFileUpload
                    modelValue={value.value}
                    multiple
                    onUpdate:modelValue={(next: any) => {
                        updates.push(next);
                        value.value = next;
                    }}
                />
            );
        });
        const { el, unmount } = mount(Host, {});
        const input = el.querySelector("input[type='file']") as HTMLInputElement;
        const file = fileOf("licence.pdf");
        Object.defineProperty(input, "files", { value: [file], configurable: true });
        input.dispatchEvent(new Event("change", { bubbles: true }));

        expect(updates).toHaveLength(1);
        expect(updates[0]).toHaveLength(1);
        expect(updates[0][0].name).toBe("licence.pdf");
        expect(input.value).toBe("");

        Object.defineProperty(input, "files", { value: [file], configurable: true });
        input.dispatchEvent(new Event("change", { bubbles: true }));
        expect(updates).toHaveLength(2);
        unmount();
    });

    it("enforces the accepted file types", () => {
        const reject = vi.fn();
        const Host = dc(() => {
            const value = ref<any>(null);
            return () => (
                <PgFileUpload
                    modelValue={value.value}
                    accept=".pdf"
                    onReject={reject}
                    onUpdate:modelValue={(next: any) => {
                        value.value = next;
                    }}
                />
            );
        });
        const { el, unmount } = mount(Host, {});
        const input = el.querySelector("input[type='file']") as HTMLInputElement;
        Object.defineProperty(input, "files", { value: [fileOf("note.txt", "text/plain")], configurable: true });
        input.dispatchEvent(new Event("change", { bubbles: true }));
        expect(reject).toHaveBeenCalledTimes(1);
        expect(reject.mock.calls[0]![0][0].reason).toBe("fileType");
        unmount();
    });
});

describe("selection CSS contract", () => {
    it("owns the squircle, toggle, choice and dropzone geometry with tokens only", () => {
        const file = path.resolve(process.cwd(), "src/tokens/parts/inputs-selection.css");
        const css = fs.readFileSync(file, "utf-8");
        expect(css).toContain(".pg-chk__box");
        expect(css).toContain("inline-size: 18px");
        expect(css).toContain("border-radius: 5px");
        expect(css).toContain(".pg-chk--checked");
        expect(css).toContain(".pg-switch__track");
        expect(css).toContain(".pg-radio__circle");
        expect(css).toContain(".pg-choice__mark");
        expect(css).toContain(".pg-dropzone");
        expect(css).toContain(".pg-file-row__remove");
        expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    });
});

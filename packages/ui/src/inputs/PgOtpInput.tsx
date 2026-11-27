import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { PgFieldShell } from "./PgFieldShell";

const digitsOnly = (value: unknown): string => String(value ?? "").replace(/\D/g, "");

/**
 * Segmented one-time-code input. The row is always LTR (a numeric code reads
 * left-to-right even in Arabic), typing auto-advances, Backspace steps back,
 * arrows move between boxes and pasting `482-910` distributes `482910`.
 */
export const PgOtpInput = dc(
    (props: Record<string, any>, _expose, { emit, expose }) => {
        const autoId = useId();
        const groupId = props.id || `pg-otp-${autoId}`;
        const boxes = ref<Array<HTMLInputElement | null>>([]);
        const focusedIndex = ref(-1);
        const lastComplete = ref("");

        const length = computed(() => {
            const parsed = Number(props.length);
            return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 12) : 6;
        });
        const model = computed(() => digitsOnly(props.modelValue).slice(0, length.value));
        const chars = computed(() =>
            Array.from({ length: length.value }, (_, index) => model.value[index] ?? ""),
        );
        const complete = computed(() => model.value.length === length.value);

        const focusBox = (index: number) => {
            const bounded = Math.max(0, Math.min(index, length.value - 1));
            void nextTick(() => boxes.value[bounded]?.focus());
        };

        const emitComplete = (code: string) => {
            if (code.length !== length.value) {
                lastComplete.value = "";
                return;
            }
            if (lastComplete.value === code) return;
            lastComplete.value = code;
            emit?.("complete", code);
        };

        const commit = (next: string, caret?: number) => {
            const code = digitsOnly(next).slice(0, length.value);
            emit?.("update:modelValue", code);
            emitComplete(code);
            if (caret !== undefined) focusBox(caret);
            else if (code.length >= length.value) focusBox(length.value - 1);
        };

        watch(model, (next) => {
            // Keep the one-shot guard in sync when the parent clears the value.
            if (next.length !== length.value) lastComplete.value = "";
        });

        const write = (index: number, raw: string) => {
            const digits = digitsOnly(raw);
            if (!digits) {
                const next = [...chars.value];
                next[index] = "";
                commit(next.join(""), index);
                return;
            }
            if (digits.length > 1) {
                distribute(digits, index);
                return;
            }
            const next = [...chars.value];
            next[index] = digits;
            const code = next.join("");
            commit(code, Math.min(index + 1, length.value - 1));
        };

        const distribute = (digits: string, start = 0) => {
            const next = [...chars.value];
            const begin = digits.length >= length.value ? 0 : start;
            let cursor = begin;
            for (const digit of digits) {
                if (cursor >= length.value) break;
                next[cursor] = digit;
                cursor += 1;
            }
            const code = next.join("");
            emit?.("update:modelValue", code);
            emitComplete(code);
            focusBox(Math.min(cursor, length.value - 1));
        };

        const onPaste = (index: number, event: ClipboardEvent) => {
            const text = digitsOnly(event.clipboardData?.getData("text") ?? "");
            if (!text) return;
            event.preventDefault();
            distribute(text, index);
        };

        const onKeydown = (index: number, event: KeyboardEvent) => {
            if (event.key === "Backspace") {
                event.preventDefault();
                if (chars.value[index]) {
                    const next = [...chars.value];
                    next[index] = "";
                    commit(next.join(""), index);
                } else if (index > 0) {
                    const next = [...chars.value];
                    next[index - 1] = "";
                    commit(next.join(""), index - 1);
                }
                return;
            }
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                focusBox(index - 1);
                return;
            }
            if (event.key === "ArrowRight") {
                event.preventDefault();
                focusBox(index + 1);
                return;
            }
            if (event.key === "Home") {
                event.preventDefault();
                focusBox(0);
                return;
            }
            if (event.key === "End") {
                event.preventDefault();
                focusBox(length.value - 1);
            }
        };

        const focus = () => {
            const firstEmpty = chars.value.findIndex((char) => !char);
            focusBox(firstEmpty === -1 ? 0 : firstEmpty);
        };

        const reset = () => {
            lastComplete.value = "";
            emit?.("update:modelValue", "");
        };

        let blurTimer: ReturnType<typeof setTimeout> | undefined;
        onBeforeUnmount(() => {
            if (blurTimer) clearTimeout(blurTimer);
            boxes.value = [];
        });
        onMounted(() => {
            if (props.autofocus) focusBox(0);
        });

        expose?.({ focus, reset });

        return () => {
            const boxIds = Array.from({ length: length.value }, (_, index) =>
                index === 0 ? groupId : `${groupId}-${index + 1}`,
            );
            const separatorAfter = Math.floor(length.value / 2) - 1;

            const renderBox = (index: number, boxId: string) => (
                <input
                    key={`box-${index}`}
                    ref={(element: any) => {
                        boxes.value[index] = element as HTMLInputElement | null;
                    }}
                    id={boxId}
                    class={[
                        "pg-otp__box",
                        "pg-tabular",
                        chars.value[index] ? "pg-otp__box--filled" : "",
                        focusedIndex.value === index ? "pg-otp__box--focused" : "",
                        props.error ? "pg-otp__box--error" : "",
                    ]}
                    dir="ltr"
                    type={props.mask ? "password" : "text"}
                    inputmode="numeric"
                    pattern="[0-9]*"
                    maxlength={1}
                    autocomplete={index === 0 ? "one-time-code" : "off"}
                    autocapitalize="off"
                    spellcheck={false}
                    value={digitsOnly(chars.value[index])}
                    disabled={props.disabled}
                    readonly={props.readonly}
                    aria-label={`Digit ${index + 1}`}
                    aria-invalid={props.error ? "true" : undefined}
                    onInput={(event: Event) => {
                        write(index, (event.target as HTMLInputElement).value);
                    }}
                    onPaste={(event: ClipboardEvent) => onPaste(index, event)}
                    onKeydown={(event: KeyboardEvent) => onKeydown(index, event)}
                    onFocus={() => {
                        focusedIndex.value = index;
                        boxes.value[index]?.select();
                    }}
                    onBlur={() => {
                        if (blurTimer) clearTimeout(blurTimer);
                        blurTimer = setTimeout(() => {
                            focusedIndex.value = -1;
                        }, 0);
                    }}
                />
            );

            return (
                <PgFieldShell
                    forId={groupId}
                    label={props.label}
                    hint={props.hint}
                    error={props.error}
                    required={props.required}
                    disabled={props.disabled}
                    hideDetails={props.hideDetails}
                >
                    <div
                        class={[
                            "pg-otp",
                            props.error ? "pg-otp--error" : "",
                            complete.value ? "pg-otp--complete" : "",
                            props.disabled ? "pg-otp--disabled" : "",
                            props.mask ? "pg-otp--masked" : "",
                        ]}
                        dir="ltr"
                        role="group"
                        aria-label={props.label || "One-time code"}
                        aria-invalid={props.error ? "true" : undefined}
                    >
                        {Array.from({ length: separatorAfter + 1 }, (_, index) => renderBox(index, boxIds[index]))}
                        {props.separator ? (
                            <span class="pg-otp__separator" aria-hidden="true">
                                {props.separatorCharacter || "–"}
                            </span>
                        ) : null}
                        {Array.from(
                            { length: Math.max(0, length.value - separatorAfter - 1) },
                            (_, offset) => {
                                const index = separatorAfter + 1 + offset;
                                return renderBox(index, boxIds[index]);
                            },
                        )}
                    </div>
                </PgFieldShell>
            );
        };
    },
    {
        props: {
            modelValue: { type: String, default: "" },
            length: { type: Number, default: 6 },
            label: { type: String, default: "" },
            hint: { type: String, default: "" },
            error: { type: String, default: "" },
            required: { type: Boolean, default: false },
            hideDetails: { type: Boolean, default: false },
            mask: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            readonly: { type: Boolean, default: false },
            autofocus: { type: Boolean, default: false },
            separator: { type: Boolean, default: false },
            separatorCharacter: { type: String, default: "" },
            id: { type: String, default: "" },
        },
        emits: ["update:modelValue", "complete"],
        inheritAttrs: true,
    },
);

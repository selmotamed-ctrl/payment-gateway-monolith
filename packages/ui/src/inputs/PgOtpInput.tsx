import { computed, nextTick, ref } from "vue";
import { dc } from "../lib/dc";

/**
 * Segmented one-time-code input. Each box accepts one character; typing moves
 * forward, Backspace moves back, and pasting a full code fills every box.
 */
export const PgOtpInput = dc(
    (props: Record<string, any>, _expose, { emit }) => {
        const inputs = ref<HTMLInputElement[]>([]);
        const chars = computed(() => {
            const value = String(props.modelValue ?? "");
            return Array.from({ length: props.length ?? 6 }, (_, index) => value[index] ?? "");
        });
        const write = (index: number, char: string) => {
            const next = [...chars.value];
            next[index] = char.slice(-1);
            emit?.("update:modelValue", next.join(""));
            if (char && index < (props.length ?? 6) - 1) {
                void nextTick(() => inputs.value[index + 1]?.focus());
            }
        };
        const onPaste = (event: ClipboardEvent) => {
            const text = (event.clipboardData?.getData("text") ?? "").replace(/\D/g, "");
            if (!text) return;
            event.preventDefault();
            emit?.("update:modelValue", text.slice(0, props.length ?? 6));
        };
        return () => (
            <div class="pg-otp" role="group" aria-label={props.label ?? "One-time code"}>
                {Array.from({ length: props.length ?? 6 }, (_, index) => (
                    <input
                        key={index}
                        ref={(element: any) => {
                            if (element) inputs.value[index] = element as HTMLInputElement;
                        }}
                        class="pg-otp__box pg-tabular"
                        inputmode="numeric"
                        autocomplete="one-time-code"
                        maxlength={1}
                        value={chars.value[index]}
                        disabled={props.disabled}
                        aria-label={`Digit ${index + 1}`}
                        onInput={(event: Event) => write(index, (event.target as HTMLInputElement).value)}
                        onPaste={onPaste}
                        onKeydown={(event: KeyboardEvent) => {
                            if (event.key === "Backspace" && !chars.value[index] && index > 0) {
                                inputs.value[index - 1]?.focus();
                            }
                            if (event.key === "ArrowLeft" && index > 0) inputs.value[index - 1]?.focus();
                            if (event.key === "ArrowRight" && index < (props.length ?? 6) - 1) inputs.value[index + 1]?.focus();
                        }}
                    />
                ))}
            </div>
        );
    },
    {
        props: {
            modelValue: { type: String, default: "" },
            length: { type: Number, default: 6 },
            disabled: { type: Boolean, default: false },
            label: { type: String, default: "" },
        },
        emits: ["update:modelValue"],
    },
);

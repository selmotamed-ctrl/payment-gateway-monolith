import { computed, ref } from "vue";
import { dc } from "../lib/dc";

/**
 * Bare code editor (line gutter + native textarea + parse-error line).
 * This is the one sanctioned raw `<textarea>` in the product: the report/chrome
 * JSON spec *is* text that an author pastes from the AI transcript. It lives in
 * `@pg/ui`, so application pages never contain a raw control.
 */
export const PgCodeEditor = dc(
    (props: Record<string, any>, _expose, { attrs, emit }) => {
        const scroll = ref(0);
        const gutter = ref<HTMLElement | null>(null);
        const lines = computed(() => String(props.modelValue ?? "").split("\n").length);
        const syncScroll = (event: Event) => {
            scroll.value = (event.target as HTMLTextAreaElement).scrollTop;
            if (gutter.value) gutter.value.scrollTop = scroll.value;
        };
        return () => (
            <div
                {...attrs}
                class={["pg-json-editor__frame", props.errorLine ? "pg-json-editor__frame--invalid" : "", attrs.class]
                    .filter(Boolean)
                    .join(" ")}
            >
                <div ref={gutter} class="pg-json-editor__gutter pg-mono" aria-hidden="true">
                    {Array.from({ length: lines.value }, (_, index) => (
                        <div
                            key={index}
                            class={["pg-json-editor__gutter-line", props.errorLine === index + 1 ? "pg-json-editor__gutter-line--error" : ""]}
                        >
                            {index + 1}
                        </div>
                    ))}
                </div>
                <textarea
                    id={props.id}
                    class="pg-json-editor__input pg-mono"
                    dir="ltr"
                    spellcheck={false}
                    autocomplete="off"
                    autocapitalize="off"
                    wrap="off"
                    disabled={props.disabled}
                    readonly={props.readonly}
                    aria-label={props.label || undefined}
                    aria-invalid={props.errorLine ? "true" : undefined}
                    aria-describedby={props.describedBy || undefined}
                    value={props.modelValue}
                    onInput={(event: Event) => emit?.("update:modelValue", (event.target as HTMLTextAreaElement).value)}
                    onScroll={syncScroll}
                    onKeydown={(event: KeyboardEvent) => emit?.("keydown", event)}
                />
            </div>
        );
    },
    {
        props: {
            modelValue: { type: String, default: "" },
            id: { type: String, default: "" },
            label: { type: String, default: "" },
            describedBy: { type: String, default: "" },
            errorLine: { type: Number, default: 0 },
            disabled: { type: Boolean, default: false },
            readonly: { type: Boolean, default: false },
        },
        emits: ["update:modelValue", "keydown"],
        inheritAttrs: true,
    },
);

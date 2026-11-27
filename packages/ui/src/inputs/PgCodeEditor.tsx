import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { PgFieldShell } from "./PgFieldShell";

type ParseState = {
    valid: boolean;
    line: number;
    message: string;
};

const errorLineFrom = (message: string, source: string): number => {
    const explicit = /line\s+(\d+)/i.exec(message);
    if (explicit) return Number(explicit[1]);
    const position = /position\s+(\d+)/i.exec(message);
    if (position) {
        const offset = Math.max(0, Math.min(Number(position[1]), source.length));
        return source.slice(0, offset).split("\n").length;
    }
    return 1;
};

const parseJson = (source: string): ParseState => {
    if (!source.trim()) return { valid: true, line: 0, message: "" };
    try {
        JSON.parse(source);
        return { valid: true, line: 0, message: "" };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { valid: false, line: errorLineFrom(message, source), message };
    }
};

/**
 * Monospace JSON/config editor with a synchronized line-number gutter, live
 * syntax validation and line-level highlighting, Format and Copy actions.
 *
 * This is the one sanctioned raw `<textarea>` in `@pg/ui`: the report/chrome
 * JSON spec *is* text pasted from the AI transcript. Application pages never
 * render a raw JSON textarea outside this component.
 */
export const PgCodeEditor = dc(
    (props: Record<string, any>, _expose, { attrs, emit, slots }) => {
        const autoId = useId();
        const editorId = props.id || `pg-code-${autoId}`;
        const source = computed(() => (props.modelValue === null || props.modelValue === undefined ? "" : String(props.modelValue)));
        const parsed = computed<ParseState>(() =>
            props.language === "json" || props.language === undefined
                ? parseJson(source.value)
                : { valid: true, line: 0, message: "" },
        );
        const lineCount = computed(() => Math.max(1, source.value.split("\n").length));
        const errorLine = computed(() => props.errorLine || parsed.value.line || 0);
        const invalid = computed(() => !parsed.value.valid || Boolean(props.errorLine));
        const statusText = computed(() => {
            if (invalid.value) return `Line ${errorLine.value} error`;
            if (props.language === "text") return `${lineCount.value} ${lineCount.value === 1 ? "line" : "lines"}`;
            return "Valid JSON";
        });
        const languageBadge = computed(() => String(props.language || "json").toUpperCase());
        const copied = ref(false);
        let copyTimer: ReturnType<typeof setTimeout> | undefined;
        let textareaEl: HTMLTextAreaElement | null = null;
        let gutterEl: HTMLElement | null = null;

        watch(
            () => parsed.value.valid,
            (valid) => emit?.("validChange", valid),
            { immediate: true },
        );

        const syncScroll = (event: Event) => {
            const top = (event.target as HTMLTextAreaElement).scrollTop;
            if (gutterEl) gutterEl.scrollTop = top;
        };

        const setSource = (next: string) => {
            emit?.("update:modelValue", next);
            if (textareaEl) textareaEl.value = next;
        };

        const format = () => {
            if (props.readonly || props.disabled) return;
            if ((props.language || "json") !== "json" || !parsed.value.valid) return;
            try {
                const next = JSON.stringify(JSON.parse(source.value), null, 2);
                setSource(next);
            } catch {
                /* validity already guards this path */
            }
        };

        const fallbackCopy = () => {
            if (!textareaEl) return;
            try {
                textareaEl.focus();
                textareaEl.select();
                document.execCommand?.("copy");
            } catch {
                /* clipboard is best effort */
            }
        };

        const copy = async () => {
            try {
                if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(source.value);
                else fallbackCopy();
            } catch {
                fallbackCopy();
            }
            copied.value = true;
            if (copyTimer) clearTimeout(copyTimer);
            copyTimer = setTimeout(() => {
                copied.value = false;
            }, 1500);
        };

        const insertTab = (event: KeyboardEvent) => {
            const element = event.target as HTMLTextAreaElement;
            const start = element.selectionStart ?? element.value.length;
            const end = element.selectionEnd ?? start;
            const next = `${element.value.slice(0, start)}  ${element.value.slice(end)}`;
            element.value = next;
            const caret = start + 2;
            try {
                element.selectionStart = caret;
                element.selectionEnd = caret;
            } catch {
                /* selection is best effort */
            }
            emit?.("update:modelValue", next);
        };

        const onKeydown = (event: KeyboardEvent) => {
            const mod = event.metaKey || event.ctrlKey;
            if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                insertTab(event);
                return;
            }
            if (mod && event.shiftKey && (event.key === "f" || event.key === "F")) {
                event.preventDefault();
                format();
                return;
            }
            (attrs.onKeydown as ((event: KeyboardEvent) => void) | undefined)?.(event);
            emit?.("keydown", event);
        };

        onBeforeUnmount(() => {
            if (copyTimer) clearTimeout(copyTimer);
            textareaEl = null;
            gutterEl = null;
        });

        return () => {
            const frameAttrs = { ...attrs };
            delete frameAttrs.onKeydown;
            delete frameAttrs.class;
            const gutterLines = Array.from({ length: lineCount.value }, (_, index) => (
                <div
                    key={`line-${index}`}
                    class={[
                        "pg-json-editor__gutter-line",
                        errorLine.value === index + 1 ? "pg-json-editor__gutter-line--error" : "",
                    ]}
                >
                    {index + 1}
                </div>
            ));

            const editor = (
                <div class="pg-json-editor">
                    <div class="pg-json-editor__toolbar">
                        <span class="pg-json-editor__badge">{languageBadge.value}</span>
                        <span
                            class={[
                                "pg-json-editor__status",
                                invalid.value ? "pg-json-editor__status--invalid" : "pg-json-editor__status--valid",
                            ]}
                            role="status"
                            aria-live="polite"
                        >
                            {statusText.value}
                        </span>
                        <span class="pg-json-editor__toolbar-spacer" />
                        {slots.toolbar ? slots.toolbar() : null}
                        {props.showFormat !== false && (props.language || "json") === "json" && (
                            <button
                                type="button"
                                class="pg-json-editor__btn"
                                disabled={!parsed.value.valid || Boolean(props.readonly) || Boolean(props.disabled)}
                                onClick={format}
                            >
                                Format
                            </button>
                        )}
                        <button type="button" class="pg-json-editor__btn" disabled={Boolean(props.disabled)} onClick={copy}>
                            {copied.value ? "Copied" : "Copy"}
                        </button>
                    </div>
                    <div
                        {...frameAttrs}
                        class={[
                            "pg-json-editor__frame",
                            invalid.value ? "pg-json-editor__frame--invalid" : "",
                            props.readonly ? "pg-json-editor__frame--readonly" : "",
                            props.disabled ? "pg-json-editor__frame--disabled" : "",
                            attrs.class,
                        ]}
                        dir="ltr"
                    >
                        <div
                            ref={(element: any) => {
                                gutterEl = element;
                            }}
                            class="pg-json-editor__gutter pg-mono"
                            aria-hidden="true"
                        >
                            {gutterLines}
                        </div>
                        <textarea
                            ref={(element: any) => {
                                textareaEl = element as HTMLTextAreaElement | null;
                            }}
                            id={editorId}
                            class="pg-json-editor__input pg-mono"
                            dir="ltr"
                            spellcheck={false}
                            autocomplete="off"
                            autocapitalize="off"
                            wrap="off"
                            style={{ minHeight: props.minHeight || "200px" }}
                            disabled={props.disabled}
                            readonly={props.readonly}
                            aria-label={props.label || "JSON editor"}
                            aria-invalid={invalid.value ? "true" : "false"}
                            aria-describedby={props.describedBy || undefined}
                            value={source.value}
                            onInput={(event: Event) => emit?.("update:modelValue", (event.target as HTMLTextAreaElement).value)}
                            onScroll={syncScroll}
                            onKeydown={onKeydown}
                        />
                    </div>
                    {!parsed.value.valid && (
                        <span class="pg-json-editor__error" role="alert">
                            Line {errorLine.value}: {parsed.value.message}
                        </span>
                    )}
                </div>
            );

            if (!props.label && !props.hint) return editor;

            return (
                <PgFieldShell
                    forId={editorId}
                    label={props.label}
                    hint={props.hint}
                    disabled={props.disabled}
                >
                    {editor}
                </PgFieldShell>
            );
        };
    },
    {
        props: {
            modelValue: { type: String, default: "" },
            id: { type: String, default: "" },
            label: { type: String, default: "" },
            hint: { type: String, default: "" },
            describedBy: { type: String, default: "" },
            language: { type: String, default: "json" },
            minHeight: { type: String, default: "200px" },
            showFormat: { type: Boolean, default: true },
            errorLine: { type: Number, default: 0 },
            disabled: { type: Boolean, default: false },
            readonly: { type: Boolean, default: false },
        },
        emits: ["update:modelValue", "validChange", "keydown"],
        inheritAttrs: true,
    },
);

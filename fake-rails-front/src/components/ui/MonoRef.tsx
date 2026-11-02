import { defineComponent, onBeforeUnmount, ref, type PropType, type VNodeChild } from "vue";
import { VIcon } from "vuetify/components";
import { useLocale } from "vuetify";

export const MonoRef = defineComponent({
    name: "MonoRef",
    props: {
        value: { type: String, default: "" },
        truncate: { type: Number, default: 0 },
        copyable: { type: Boolean, default: true },
        onCopied: { type: Function as PropType<(value: string) => void>, default: undefined },
    },
    setup(props) {
        const { t } = useLocale();
        const copied = ref(false);
        let timer: ReturnType<typeof setTimeout> | undefined;

        const fallbackCopy = (value: string): boolean => {
            const input = document.createElement("textarea");
            input.value = value;
            input.setAttribute("readonly", "");
            input.style.position = "fixed";
            input.style.opacity = "0";
            document.body.appendChild(input);
            input.select();
            let ok = false;
            try {
                ok = document.execCommand("copy");
            } finally {
                document.body.removeChild(input);
            }
            return ok;
        };

        const copy = async () => {
            if (!props.value || !props.copyable) return;
            let ok = false;
            try {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(props.value);
                    ok = true;
                } else {
                    ok = fallbackCopy(props.value);
                }
            } catch {
                ok = fallbackCopy(props.value);
            }
            if (!ok) return;
            copied.value = true;
            props.onCopied?.(props.value);
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                copied.value = false;
            }, 1400);
        };

        onBeforeUnmount(() => {
            if (timer) clearTimeout(timer);
        });

        return (): VNodeChild => {
            if (!props.value) {
                return <span style={{ color: "var(--pg-ink-faint)" }}>—</span>;
            }
            const shown =
                props.truncate > 0 && props.value.length > props.truncate
                    ? `${props.value.slice(0, props.truncate)}…`
                    : props.value;
            const label = copied.value ? t("Copied") : `${t("Copy")} ${props.value}`;
            return (
                <button
                    type="button"
                    class="pg-mono pg-mono-ref"
                    title={props.value}
                    aria-label={label}
                    aria-live="polite"
                    onClick={() => void copy()}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        padding: "2px 6px",
                        borderRadius: "var(--pg-radius-xs)",
                        backgroundColor: "var(--pg-bg-surface-subtle)",
                        border: "1px solid var(--pg-border-subtle)",
                        fontSize: "12px",
                        color: "var(--pg-ink-primary)",
                        cursor: props.copyable ? "pointer" : "default",
                        userSelect: "all",
                        fontFamily: "inherit",
                    }}
                >
                    <span>{shown}</span>
                    {props.copyable && (
                        <VIcon
                            size={12}
                            icon={copied.value ? "mdi-check" : "mdi-content-copy"}
                            style={{ color: copied.value ? "var(--pg-status-success-dot)" : "var(--pg-ink-muted)" }}
                        />
                    )}
                </button>
            );
        };
    },
});

export default MonoRef;

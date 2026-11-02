import { defineComponent, ref, type VNodeChild } from "vue";
import { VIcon } from "vuetify/components";

export const MonoRef = defineComponent({
    name: "MonoRef",
    props: {
        value: { type: String, default: "" },
        truncate: { type: Number, default: 0 },
        copyable: { type: Boolean, default: true },
    },
    setup(props) {
        const copied = ref(false);
        const copy = async (event: MouseEvent) => {
            event.stopPropagation();
            if (!props.value || !props.copyable) return;
            try {
                await navigator.clipboard?.writeText(props.value);
            } catch {
                const input = document.createElement("textarea");
                input.value = props.value;
                input.style.position = "fixed";
                input.style.opacity = "0";
                document.body.appendChild(input);
                input.select();
                document.execCommand("copy");
                document.body.removeChild(input);
            }
            copied.value = true;
            window.setTimeout(() => {
                copied.value = false;
            }, 1400);
        };
        return (): VNodeChild => {
            if (!props.value) {
                return <span style={{ color: "var(--pg-ink-faint)" }}>—</span>;
            }
            const shown =
                props.truncate > 0 && props.value.length > props.truncate
                    ? `${props.value.slice(0, props.truncate)}…`
                    : props.value;
            return (
                <span
                    class="pg-mono"
                    title={props.value}
                    onClick={copy}
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
                </span>
            );
        };
    },
});

export default MonoRef;

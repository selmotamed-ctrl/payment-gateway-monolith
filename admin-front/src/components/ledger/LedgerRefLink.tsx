import { defineComponent, type VNodeChild } from "vue";
import { VIcon } from "vuetify/components";
import { useLocale } from "vuetify";

/**
 * A reference that opens its record (journal entry, GL account...) instead of copying itself.
 * Renders a muted dash for an empty value, so callers can pass nullable ids directly.
 */
export const LedgerRefLink = defineComponent({
    name: "LedgerRefLink",
    props: {
        value: { type: String, default: "" },
        truncate: { type: Number, default: 14 },
        /** Accessible label of the action, e.g. "Open journal entry". */
        label: { type: String, default: "" },
    },
    emits: ["open"],
    setup(props, { emit }) {
        const { t } = useLocale();
        return (): VNodeChild => {
            if (!props.value) return <span style={{ color: "var(--pg-ink-faint)" }}>—</span>;
            const shown = props.truncate > 0 && props.value.length > props.truncate ? `${props.value.slice(0, props.truncate)}…` : props.value;
            return (
                <button
                    type="button"
                    class="pg-mono"
                    title={props.value}
                    aria-label={`${props.label || t("Open")} ${props.value}`}
                    onClick={(event: MouseEvent) => {
                        event.stopPropagation();
                        emit("open", props.value);
                    }}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        padding: "2px 6px",
                        borderRadius: "var(--pg-radius-xs)",
                        backgroundColor: "var(--pg-accent-interactive-soft)",
                        border: "1px solid var(--pg-border-subtle)",
                        fontSize: "12px",
                        color: "var(--pg-accent-interactive)",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        maxInlineSize: "100%",
                    }}
                >
                    <span>{shown}</span>
                    <VIcon icon="mdi-open-in-new" size={12} />
                </button>
            );
        };
    },
});

export default LedgerRefLink;

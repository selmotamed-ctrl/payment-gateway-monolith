import { defineComponent, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { summarizeValue, type SummaryRow } from "./model/jsonTree";

export type KeyValueItem = {
    label: string;
    text?: string;
    list?: string[];
    boolean?: boolean;
    mono?: boolean;
};

/** Converts `summarizeValue` rows into display items. */
export const summaryRowsToItems = (rows: SummaryRow[], translate: (text: string) => string = (text) => text): KeyValueItem[] =>
    rows.map((row) => ({
        label: translate(row.label),
        ...(row.kind === "list" ? { list: row.value as string[] } : row.kind === "boolean" ? { boolean: row.value === true } : { text: row.kind === "empty" ? "—" : String(row.value) }),
    }));

/** Structured read view of any JSON object: labelled rows, lists as chips, booleans as badges, never raw JSON. */
export const KeyValueSummary = defineComponent({
    name: "KeyValueSummary",
    props: {
        items: { type: Array as PropType<KeyValueItem[]> },
        /** Alternatively a raw JSON value that is flattened by `summarizeValue`. */
        value: { type: null as unknown as PropType<unknown> },
        compact: { type: Boolean, default: false },
        emptyLabel: { type: String, default: "" },
        maxRows: { type: Number, default: 0 },
        ariaLabel: { type: String, default: "" },
    },
    setup(props) {
        const { t } = useLocale();
        return (): VNodeChild => {
            let items = props.items ?? summaryRowsToItems(summarizeValue(props.value), t);
            const total = items.length;
            if (props.maxRows > 0) items = items.slice(0, props.maxRows);
            if (items.length === 0) {
                return props.emptyLabel ? <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>{props.emptyLabel}</span> : null;
            }
            return (
                <div style={{ minInlineSize: 0 }}>
                    <dl
                        aria-label={props.ariaLabel || undefined}
                        style={{ display: "grid", gap: props.compact ? "2px" : "6px", margin: 0, minInlineSize: 0 }}
                    >
                        {items.map((item, index) => (
                            <div
                                key={`${item.label}-${index}`}
                                style={{
                                    display: "flex",
                                    flexWrap: "wrap",
                                    alignItems: "baseline",
                                    columnGap: "8px",
                                    rowGap: "3px",
                                    fontSize: props.compact ? "11.5px" : "12.5px",
                                    minInlineSize: 0,
                                }}
                            >
                                <dt style={{ color: "var(--pg-ink-muted)", margin: 0 }}>{item.label}</dt>
                                <dd style={{ margin: 0, minInlineSize: 0, color: "var(--pg-ink-primary)" }}>
                                    {item.list ? (
                                        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px" }}>
                                            {item.list.map((entry, position) => (
                                                <span
                                                    key={`${entry}-${position}`}
                                                    dir="auto"
                                                    style={{
                                                        padding: "1px 6px",
                                                        borderRadius: "var(--pg-radius-xs)",
                                                        border: "1px solid var(--pg-border-subtle)",
                                                        backgroundColor: "var(--pg-bg-surface-subtle)",
                                                        fontSize: "11.5px",
                                                    }}
                                                >
                                                    {entry}
                                                </span>
                                            ))}
                                        </span>
                                    ) : item.boolean !== undefined ? (
                                        <StatusBadge
                                            status={item.boolean ? "YES" : "NO"}
                                            label={item.boolean ? t("Yes") : t("No")}
                                            toneOverride={item.boolean ? "success" : "neutral"}
                                            showDot={false}
                                        />
                                    ) : (
                                        <span dir="auto" style={{ fontFamily: item.mono ? "ui-monospace, monospace" : "inherit", overflowWrap: "anywhere" }}>
                                            {item.text ?? "—"}
                                        </span>
                                    )}
                                </dd>
                            </div>
                        ))}
                    </dl>
                    {props.maxRows > 0 && total > props.maxRows && (
                        <span style={{ fontSize: "11px", color: "var(--pg-ink-faint)" }}>+{total - props.maxRows} {t("more")}</span>
                    )}
                </div>
            );
        };
    },
});

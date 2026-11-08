import { defineComponent, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { parseTextPayload, type PayloadRow, type PayloadSection } from "../payloadRows";

/**
 * Structured key/value rendering of a redacted wire payload. Never prints raw JSON: objects are
 * flattened into labelled rows, plain text is shown wrapped in a normal text block.
 */
export const PayloadRows = defineComponent({
    name: "PayloadRows",
    props: {
        rows: { type: Array as PropType<PayloadRow[]>, default: () => [] },
        truncated: { type: Number, default: 0 },
        /** Plain text fallback (non-JSON response bodies). */
        text: { type: String, default: "" },
        emptyLabel: { type: String, default: "" },
    },
    setup(props) {
        const { t } = useLocale();
        return (): VNodeChild => {
            if (props.rows.length === 0 && !props.text) {
                return <span style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)" }}>{props.emptyLabel || t("No data")}</span>;
            }
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {props.rows.length > 0 && (
                        <dl
                            style={{
                                display: "grid",
                                gridTemplateColumns: "minmax(110px, 34%) 1fr",
                                margin: 0,
                                border: "1px solid var(--pg-border-subtle)",
                                borderRadius: "var(--pg-radius-sm)",
                                overflow: "hidden",
                            }}
                        >
                            {props.rows.map((row, index) => (
                                <div key={`${row.path}-${index}`} style={{ display: "contents" }}>
                                    <dt
                                        style={{
                                            margin: 0,
                                            padding: "6px 10px",
                                            fontSize: "12px",
                                            color: "var(--pg-ink-secondary)",
                                            backgroundColor: "var(--pg-bg-surface-subtle)",
                                            borderBottom: "1px solid var(--pg-border-subtle)",
                                            overflowWrap: "anywhere",
                                        }}
                                    >
                                        {row.parent && <span style={{ color: "var(--pg-ink-faint)" }}>{row.parent}.</span>}
                                        <span style={{ fontWeight: 500 }}>{row.label}</span>
                                    </dt>
                                    <dd
                                        class="pg-mono"
                                        dir="ltr"
                                        style={{
                                            margin: 0,
                                            padding: "6px 10px",
                                            fontSize: "12px",
                                            color: "var(--pg-ink-primary)",
                                            borderBottom: "1px solid var(--pg-border-subtle)",
                                            overflowWrap: "anywhere",
                                            textAlign: "start",
                                        }}
                                    >
                                        {row.redacted ? (
                                            <span
                                                style={{
                                                    padding: "1px 6px",
                                                    borderRadius: "var(--pg-radius-xs)",
                                                    backgroundColor: "var(--pg-status-neutral-bg)",
                                                    color: "var(--pg-status-neutral-text)",
                                                    border: "1px solid var(--pg-status-neutral-border)",
                                                    fontFamily: "inherit",
                                                }}
                                            >
                                                {t("Redacted")}
                                            </span>
                                        ) : (
                                            row.value
                                        )}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    )}
                    {props.truncated > 0 && (
                        <span style={{ fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>
                            +{props.truncated} {t("more fields not shown")}
                        </span>
                    )}
                    {props.text && (
                        <div
                            class="pg-mono"
                            dir="ltr"
                            style={{
                                padding: "8px 10px",
                                fontSize: "12px",
                                whiteSpace: "pre-wrap",
                                overflowWrap: "anywhere",
                                border: "1px solid var(--pg-border-subtle)",
                                borderRadius: "var(--pg-radius-sm)",
                                backgroundColor: "var(--pg-bg-surface-subtle)",
                                color: "var(--pg-ink-primary)",
                                maxBlockSize: "220px",
                                overflowY: "auto",
                            }}
                        >
                            {props.text}
                        </div>
                    )}
                </div>
            );
        };
    },
});

export const sectionTitleKey = (id: PayloadSection["id"]): string =>
    id === "headers" ? "Headers" : id === "query" ? "Query parameters" : id === "body" ? "Body" : "Request";

/** Rows or text of a response/body string, ready for `PayloadRows`. */
export const payloadPropsOfText = (text: string | null | undefined): { rows: PayloadRow[]; truncated: number; text: string } => {
    const parsed = parseTextPayload(text);
    return parsed.kind === "fields" ? { rows: parsed.rows, truncated: parsed.truncated, text: "" } : { rows: [], truncated: 0, text: parsed.text };
};

export default PayloadRows;

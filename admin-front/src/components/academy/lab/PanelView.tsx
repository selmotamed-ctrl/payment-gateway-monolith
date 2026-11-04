import { defineComponent, type CSSProperties, type PropType, type VNode } from "vue";
import { useLocale } from "vuetify";
import { VIcon } from "vuetify/components";
import type { Panel } from "@/content/academy";

/** Safe inline renderer: turns `**bold**` into <strong>; everything else stays plain text (no v-html). */
export const renderInline = (text: string): (VNode | string)[] => {
    const out: (VNode | string)[] = [];
    const re = /\*\*(.+?)\*\*/g;
    let last = 0;
    let match: RegExpExecArray | null;
    const source = String(text ?? "");
    while ((match = re.exec(source))) {
        if (match.index > last) out.push(source.slice(last, match.index));
        out.push(<strong>{match[1]}</strong>);
        last = match.index + match[0].length;
    }
    if (last < source.length) out.push(source.slice(last));
    return out;
};

export const labBorder = "1px solid rgba(var(--v-border-color), var(--v-border-opacity))";
export const labCard: CSSProperties = {
    border: labBorder,
    borderRadius: "10px",
    padding: "12px 16px",
    background: "rgb(var(--v-theme-surface))",
};
export const srOnly: CSSProperties = {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
};

const FLAGS = {
    ok: { icon: "mdi-check-circle", color: "success", label: "OK" },
    warn: { icon: "mdi-alert", color: "warning", label: "Warning" },
    bad: { icon: "mdi-close-circle", color: "error", label: "Problem" },
} as const;

export const PanelView = defineComponent({
    name: "AcademyLabPanelView",
    props: { panel: { type: Object as PropType<Panel>, required: true } },
    setup(props) {
        const { t } = useLocale();
        return () => {
            const panel = props.panel as Panel & Record<string, any>;
            let body: VNode | null = null;
            if (Array.isArray(panel.rows)) {
                body = (
                    <dl style={{ display: "grid", gridTemplateColumns: "minmax(110px, max-content) 1fr", gap: "4px 16px", margin: 0 }}>
                        {panel.rows.map((row: [string, string]) => (
                            <>
                                <dt style={{ opacity: 0.7 }}>{row[0]}</dt>
                                <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{row[1]}</dd>
                            </>
                        ))}
                    </dl>
                );
            } else if (panel.table) {
                body = (
                    <div style={{ overflowX: "auto" }}>
                        <table style={{ borderCollapse: "collapse", width: "100%" }}>
                            <thead>
                                <tr>
                                    {panel.table.columns.map((column: string) => (
                                        <th scope="col" style={{ textAlign: "start", padding: "4px 12px 4px 0", borderBottom: labBorder }}>
                                            {column}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {panel.table.rows.map((row: string[]) => (
                                    <tr>
                                        {row.map((cell) => (
                                            <td style={{ padding: "4px 12px 4px 0", borderBottom: labBorder }}>{cell}</td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                );
            } else if (Array.isArray(panel.timeline)) {
                body = (
                    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "6px" }}>
                        {panel.timeline.map((entry: { t: string; text: string; flag?: "ok" | "warn" | "bad" }) => {
                            const flag = entry.flag ? FLAGS[entry.flag] : null;
                            return (
                                <li style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                                    <span style={{ minWidth: "64px", opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>{entry.t}</span>
                                    {flag ? (
                                        <VIcon icon={flag.icon} color={flag.color} size={18} aria-hidden="true" />
                                    ) : null}
                                    <span>
                                        {flag ? <strong>{t(flag.label)}: </strong> : null}
                                        {entry.text}
                                    </span>
                                </li>
                            );
                        })}
                    </ol>
                );
            } else if (typeof panel.text === "string") {
                body = <p style={{ margin: 0 }}>{renderInline(panel.text)}</p>;
            }
            return (
                <section style={labCard} aria-label={panel.title}>
                    {body ? (
                        <>
                            <h3 style={{ margin: "0 0 8px", fontSize: "0.95rem", fontWeight: 600 }}>{panel.title}</h3>
                            {body}
                        </>
                    ) : (
                        <p style={{ margin: 0, fontWeight: 500 }}>{renderInline(panel.title)}</p>
                    )}
                </section>
            );
        };
    },
});

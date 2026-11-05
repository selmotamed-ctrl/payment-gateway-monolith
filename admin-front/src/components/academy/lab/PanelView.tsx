import { defineComponent, type PropType, type VNode } from "vue";
import { useLocale } from "vuetify";
import { VIcon } from "vuetify/components";
import type { Panel } from "@/content/academy";

/** Safe inline renderer: turns `**bold**` into <strong>; everything else stays plain text (no v-html). */
/** Points are fractions of a task (partial credit): show at most two decimals, never a raw float. */
export const pts = (value: number): string => String(Math.round(value * 100) / 100);

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

/** Plain text of an authored inline string (accessible names, step lists): the `**` markers removed. */
export const plainInline = (text: string): string => String(text ?? "").replace(/\*\*/g, "");

export type ChoiceTagTone = "good" | "bad" | "missed";

const TAG_ICON: Record<ChoiceTagTone, string> = {
    good: "mdi-check-circle",
    bad: "mdi-close-circle",
    missed: "mdi-alert-circle-outline",
};

/** Locked-state tag at the end of an answer row: MDI icon + the state in words (never colour alone). */
export const choiceTag = (tone: ChoiceTagTone, text: string): VNode => (
    <span class="ac-choice__tag">
        <VIcon icon={TAG_ICON[tone]} size={16} aria-hidden="true" />
        {text}
    </span>
);

const FLAGS = {
    ok: { icon: "mdi-check-circle", state: "done", label: "OK" },
    warn: { icon: "mdi-alert", state: "partial", label: "Warning" },
    bad: { icon: "mdi-close-circle", state: "failed", label: "Problem" },
} as const;

/** One evidence panel of a lab task (key/value rows, table, timeline or text). A flat hairline card. */
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
                    <dl class="ac-lab-kv">
                        {panel.rows.map((row: [string, string]) => (
                            <div class="ac-lab-kv__row">
                                <dt>{row[0]}</dt>
                                <dd dir="auto">{row[1]}</dd>
                            </div>
                        ))}
                    </dl>
                );
            } else if (panel.table) {
                body = (
                    <div class="ac-lab-tablewrap">
                        <table class="ac-lab-table">
                            <thead>
                                <tr>
                                    {panel.table.columns.map((column: string) => (
                                        <th scope="col">{column}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {panel.table.rows.map((row: string[]) => (
                                    <tr>
                                        {row.map((cell) => (
                                            <td dir="auto">{cell}</td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                );
            } else if (Array.isArray(panel.timeline)) {
                body = (
                    <ol class="ac-lab-timeline">
                        {panel.timeline.map((entry: { t: string; text: string; flag?: "ok" | "warn" | "bad" }) => {
                            const flag = entry.flag ? FLAGS[entry.flag] : null;
                            return (
                                <li class="ac-lab-timeline__item">
                                    <span class="ac-lab-timeline__time ac-ltr">{entry.t}</span>
                                    <span class={["ac-state", flag ? `ac-state--${flag.state}` : ""]} aria-hidden="true">
                                        <VIcon icon={flag ? flag.icon : "mdi-circle-small"} size={16} />
                                    </span>
                                    <span dir="auto">
                                        {flag ? <strong>{t(flag.label)}: </strong> : null}
                                        {entry.text}
                                    </span>
                                </li>
                            );
                        })}
                    </ol>
                );
            } else if (typeof panel.text === "string") {
                body = (
                    <p class="ac-lab-panel__text" dir="auto">
                        {renderInline(panel.text)}
                    </p>
                );
            }
            return (
                <section class="ac-card ac-lab-panel" aria-label={panel.title}>
                    {body ? (
                        <>
                            <h3 class="ac-lab-panel__title" dir="auto">
                                {panel.title}
                            </h3>
                            {body}
                        </>
                    ) : (
                        <p class="ac-lab-panel__lead" dir="auto">
                            {renderInline(panel.title)}
                        </p>
                    )}
                </section>
            );
        };
    },
});

export default PanelView;

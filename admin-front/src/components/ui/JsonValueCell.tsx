import { defineComponent, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { MoneyDisplay } from "./MoneyDisplay";
import { StatusBadge } from "./StatusBadge";
import { MetaPill } from "./MetaPill";
import type { ValueView } from "./jsonDiffModel";

const MAX_CHIPS = 12;

const formatDateTime = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
};

/** Draws one classified leaf value (`classifyValue`): money, status badge, chips, text... */
export const JsonValueCell = defineComponent({
    name: "JsonValueCell",
    props: {
        view: { type: Object as PropType<ValueView>, required: true },
    },
    setup(props) {
        const { t } = useLocale();
        return (): VNodeChild => {
            const view = props.view;
            switch (view.kind) {
                case "absent":
                    return <span style={{ color: "var(--pg-ink-faint)" }}>—</span>;
                case "empty":
                    return <span style={{ color: "var(--pg-ink-muted)", fontStyle: "italic" }}>{t("Empty")}</span>;
                case "money":
                    return <MoneyDisplay amount={view.amount} currency={view.currency} size="sm" />;
                case "status":
                    return <StatusBadge status={view.status} />;
                case "boolean":
                    return <span>{view.value ? t("Yes") : t("No")}</span>;
                case "datetime":
                    return <span dir="ltr" class="pg-tabular">{formatDateTime(view.iso)}</span>;
                case "list": {
                    const shown = view.items.slice(0, MAX_CHIPS);
                    const hidden = view.items.length - shown.length;
                    return (
                        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px", justifyContent: "inherit" }}>
                            {shown.map((item, index) => (
                                <MetaPill key={`${item}-${index}`} size="x-small" variant="outlined">
                                    <span dir="auto" style={{ unicodeBidi: "plaintext" }}>{item}</span>
                                </MetaPill>
                            ))}
                            {hidden > 0 && <MetaPill size="x-small" variant="text">{`+${hidden}`}</MetaPill>}
                        </span>
                    );
                }
                case "number":
                    return <span dir="ltr" class="pg-tabular">{view.text}</span>;
                case "text":
                    return (
                        <span dir="auto" style={{ unicodeBidi: "plaintext", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                            {view.text}
                        </span>
                    );
            }
        };
    },
});

export default JsonValueCell;

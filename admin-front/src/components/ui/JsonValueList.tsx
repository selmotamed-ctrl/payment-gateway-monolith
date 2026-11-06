import { computed, defineComponent, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { DescriptionList, type DescriptionItem } from "./DescriptionList";
import { JsonValueCell } from "./JsonValueCell";
import { entryView, humanizeSegment, payloadEntries } from "./jsonDiffModel";

/**
 * Read-only key / value view of a plain JSON object (evidence, severity inputs,
 * list versions...). Keys are humanised, nested objects become sub-rows, money /
 * status / list values use the shared cells. `labels` overrides a label by the
 * raw top-level key or the full dotted path.
 */
export const JsonValueList = defineComponent({
    name: "JsonValueList",
    props: {
        value: { type: null as unknown as PropType<unknown> },
        labels: { type: Object as PropType<Record<string, string>>, default: () => ({}) },
        /** Raw top-level keys to list first, in this order. */
        order: { type: Array as PropType<string[]>, default: () => [] },
        hidden: { type: Array as PropType<string[]>, default: () => [] },
        columns: { type: Number as PropType<1 | 2>, default: 1 },
        emptyText: { type: String, default: "" },
        ariaLabel: { type: String, default: "" },
    },
    setup(props) {
        const { t } = useLocale();
        const items = computed<DescriptionItem[]>(() => {
            const entries = payloadEntries(props.value).filter((entry) => !props.hidden.includes(entry.segments[0] ?? ""));
            const rank = (entry: { segments: string[] }) => {
                const index = props.order.indexOf(entry.segments[0] ?? "");
                return index === -1 ? props.order.length : index;
            };
            const sorted = entries
                .map((entry, index) => ({ entry, index }))
                .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
                .map(({ entry }) => entry);
            return sorted.map((entry) => {
                const segments = entry.segments;
                const parts = segments.map((segment, index) => {
                    const override = props.labels[segments.slice(0, index + 1).join(".")];
                    return t(override ?? humanizeSegment(segment));
                });
                const label = parts.join(" · ") || t("Entire record");
                return { label, value: <JsonValueCell view={entryView(entry, "after")} /> };
            });
        });
        return (): VNodeChild =>
            items.value.length === 0 ? (
                <span style={{ color: "var(--pg-ink-muted)", fontSize: "13px" }}>{props.emptyText || t("No data recorded.")}</span>
            ) : (
                <DescriptionList items={items.value} columns={props.columns} ariaLabel={props.ariaLabel} />
            );
    },
});

export default JsonValueList;

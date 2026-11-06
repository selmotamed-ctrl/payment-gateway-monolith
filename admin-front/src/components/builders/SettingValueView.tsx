import { defineComponent, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { KeyValueSummary, type KeyValueItem } from "./KeyValueSummary";
import { summarizeSetting, type SettingSummaryRow } from "./model/settingsSchemas";

/** Converts the summary rows of a setting into display items (maps become one row per category). */
export const settingRowsToItems = (rows: SettingSummaryRow[], translate: (text: string) => string = (text) => text): KeyValueItem[] => {
    const items: KeyValueItem[] = [];
    for (const row of rows) {
        const label = translate(row.label);
        if (row.kind === "listMap") {
            for (const entry of row.map ?? []) items.push({ label: `${label} · ${entry.name}`, list: entry.entries });
        } else if (row.kind === "list") items.push({ label, list: row.value as string[] });
        else if (row.kind === "boolean") items.push({ label, boolean: row.value === true });
        else items.push({ label, text: row.kind === "empty" || row.value === null ? "—" : String(row.value) });
    }
    return items;
};

/** Structured, labelled read view of a platform setting value (replaces the raw JSON preview). */
export const SettingValueView = defineComponent({
    name: "SettingValueView",
    props: {
        settingKey: { type: String, required: true },
        value: { type: null as unknown as PropType<unknown> },
        maxRows: { type: Number, default: 0 },
        compact: { type: Boolean, default: true },
    },
    setup(props) {
        const { t } = useLocale();
        return (): VNodeChild => (
            <KeyValueSummary
                items={settingRowsToItems(summarizeSetting(props.settingKey, props.value), t)}
                maxRows={props.maxRows}
                compact={props.compact}
                emptyLabel={t("No values set.")}
            />
        );
    },
});

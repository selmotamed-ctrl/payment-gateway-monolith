import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VBtn } from "vuetify/components";
import { useLocale } from "vuetify";
import { MetricStrip, type MetricItem } from "./MetricStrip";
import { SurfaceCard } from "./SurfaceCard";
import { FormChecklist, type ChecklistItem } from "./FormChecklist";

export const SummaryExportCard = defineComponent({
    name: "SummaryExportCard",
    props: {
        title: { type: String, required: true },
        metrics: { type: Array as PropType<MetricItem[]>, required: true },
        checks: { type: Array as PropType<ChecklistItem[]>, default: () => [] },
        checklist: { type: Object as PropType<Record<string, boolean>>, default: () => ({}) },
        showChecklists: { type: Boolean, default: false },
        checklistComplete: { type: Boolean, default: true },
        exportLoading: { type: Boolean, default: false },
        exportDisabled: { type: Boolean, default: false },
        exportLabel: { type: String, default: "" },
        onExport: { type: Function as PropType<() => void | Promise<void>>, default: undefined },
    },
    emits: ["update:checklist"],
    setup(props, { slots, emit }) {
        const { t } = useLocale();
        return (): VNodeChild => (
            <SurfaceCard>
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--pg-ink-primary)" }}>{props.title}</div>
                        <div style={{ flex: 1 }} />
                        {props.onExport && (
                            <VBtn
                                size="small"
                                variant="tonal"
                                prependIcon="mdi-download"
                                loading={props.exportLoading}
                                disabled={props.exportDisabled}
                                onClick={() => void props.onExport?.()}
                            >
                                {props.exportLabel || t("Export summary")}
                            </VBtn>
                        )}
                    </div>
                    <FormChecklist
                        checks={props.checks}
                        modelValue={props.checklist}
                        onUpdate:modelValue={(value: Record<string, boolean>) => emit("update:checklist", value)}
                        show={props.showChecklists}
                        title={t("Summary export checklist")}
                        complete={props.checklistComplete}
                        incompleteMessage={t("Complete all summary export checklist items before exporting")}
                    />
                    <MetricStrip items={props.metrics} />
                    {slots.default?.()}
                </div>
            </SurfaceCard>
        );
    },
});

export default SummaryExportCard;

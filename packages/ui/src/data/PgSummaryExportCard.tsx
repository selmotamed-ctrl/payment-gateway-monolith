import { createSlot } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { PgButton } from "../actions/PgButton";
import { PgCard } from "../layout/PgLayout";
import { PgMetricStrip, type PgMetricItem } from "./PgMetricStrip";
import { PgFormChecklist, type PgChecklistItem } from "./PgFormChecklist";

/** Summary card: title, optional export CTA, checklist and metric strip. */
export const PgSummaryExportCard = dc(
    (props: Record<string, any>, _expose, { emit, slots }) => {
        const { t } = useLocale();
        return () => (
            <PgCard>
                <div class="pg-stack">
                    <div class="pg-inline" style={{ justifyContent: "space-between" }}>
                        <div class="pg-card__title">{props.title}</div>
                        {props.onExport && (
                            <PgButton
                                size="sm"
                                variant="tonal"
                                prependIcon="mdi-download"
                                loading={props.exportLoading}
                                disabled={props.exportDisabled}
                                onClick={() => void props.onExport?.()}
                            >
                                {props.exportLabel || t("Export summary")}
                            </PgButton>
                        )}
                    </div>
                    <PgFormChecklist
                        checks={props.checks}
                        modelValue={props.checklist}
                        onUpdate:modelValue={(value: Record<string, boolean>) => emit?.("update:checklist", value)}
                        show={props.showChecklists}
                        title={t("Summary export checklist")}
                        complete={props.checklistComplete}
                        incompleteMessage={t("Complete all summary export checklist items before exporting")}
                    />
                    <PgMetricStrip items={props.metrics} />
                    {createSlot("default")}
                </div>
            </PgCard>
        );
    },
    {
        props: {
            title: { type: String, required: true },
            metrics: { type: Array as () => PgMetricItem[], default: () => [] },
            checks: { type: Array as () => PgChecklistItem[], default: () => [] },
            checklist: { type: Object as () => Record<string, boolean>, default: () => ({}) },
            showChecklists: { type: Boolean, default: false },
            checklistComplete: { type: Boolean, default: true },
            exportLoading: { type: Boolean, default: false },
            exportDisabled: { type: Boolean, default: false },
            exportLabel: { type: String, default: "" },
            onExport: { type: Function as unknown as () => (() => void | Promise<void>) | undefined, default: undefined },
        },
        emits: ["update:checklist"],
        slots: ["default"],
    },
);

export const SummaryExportCard = PgSummaryExportCard;

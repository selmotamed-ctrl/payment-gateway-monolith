import { computed, createSlot } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { PgButton } from "../actions/PgButton";
import { PgCard } from "../layout/PgLayout";
import { PgMetricStrip, type PgMetricItem } from "./PgMetricStrip";
import { PgFormChecklist, type PgChecklistItem } from "./PgFormChecklist";

type ChecklistValue = string[] | Record<string, boolean>;

const checkId = (check: PgChecklistItem, index: number): string => check.id ?? check.key ?? `check-${index}`;
const checkKey = (check: PgChecklistItem, index: number): string => check.key ?? check.id ?? `check-${index}`;
const idsFrom = (checks: PgChecklistItem[], value: ChecklistValue | undefined): string[] => {
    if (Array.isArray(value)) return [...value];
    return checks
        .map((check, index) => ({ check, index }))
        .filter(({ check, index }) => value?.[checkKey(check, index)] === true || value?.[checkId(check, index)] === true)
        .map(({ check, index }) => checkId(check, index));
};

/**
 * Portfolio-health summary card: one title, a never-clipped Export CTA, an
 * optional maker-checker checklist and the KPI bento. Export stays disabled
 * until every visible checklist item is checked.
 */
export const PgSummaryExportCard = dc(
    (
        props: {
            title: string;
            metrics?: PgMetricItem[];
            checks?: PgChecklistItem[];
            checklist?: ChecklistValue;
            showChecklists?: boolean;
            checklistComplete?: boolean;
            exportLoading?: boolean;
            exportDisabled?: boolean;
            exportLabel?: string;
            onChecklistChange?: (value: ChecklistValue) => void;
        },
        _expose,
        { emit },
    ) => {
        const { t } = useLocale();

        const checks = computed<PgChecklistItem[]>(() =>
            (props.checks ?? []).map((check, index) => ({
                ...check,
                id: checkId(check, index),
                key: checkKey(check, index),
            })),
        );
        const currentIds = computed(() => idsFrom(checks.value, props.checklist));
        const allChecked = computed(() => {
            if (!checks.value.length) return true;
            const ids = currentIds.value;
            return checks.value.every(
                (check, index) => ids.includes(checkId(check, index)) || ids.includes(checkKey(check, index)),
            );
        });
        const complete = computed(() => {
            if (props.checklistComplete === false) return false;
            if (!props.showChecklists) return true;
            return allChecked.value;
        });
        const disabled = computed(
            () => Boolean(props.exportDisabled) || Boolean(props.exportLoading) || !complete.value,
        );

        const applyChecklist = (next: ChecklistValue) => {
            const ids = Array.isArray(next) ? [...next] : idsFrom(checks.value, next);
            let output: ChecklistValue;
            if (Array.isArray(props.checklist)) {
                output = ids;
            } else {
                const record: Record<string, boolean> = { ...(props.checklist ?? {}) };
                for (const [index, check] of checks.value.entries()) {
                    const selected = ids.includes(checkId(check, index)) || ids.includes(checkKey(check, index));
                    record[checkKey(check, index)] = selected;
                    if (checkKey(check, index) !== checkId(check, index)) record[checkId(check, index)] = selected;
                }
                output = record;
            }
            props.onChecklistChange?.(output);
            emit?.("update:checklist", output);
        };

        return () => (
            <PgCard
                title={props.title}
                class="pg-summary-export"
                v-slots={{
                    headerActions: () => (
                        <PgButton
                            class="pg-summary-export__button"
                            size="sm"
                            variant="tonal"
                            prependIcon="mdi-download"
                            loading={props.exportLoading}
                            disabled={disabled.value}
                            onClick={() => emit?.("export")}
                        >
                            {props.exportLabel || t("Export summary")}
                        </PgButton>
                    ),
                }}
            >
                <div class="pg-summary-export__body">
                    {props.showChecklists && checks.value.length > 0 && (
                        <PgFormChecklist
                            items={checks.value}
                            modelValue={currentIds.value}
                            title={t("Summary export checklist")}
                            complete={complete.value}
                            incompleteMessage={t("Complete all summary export checklist items before exporting")}
                            onUpdate:modelValue={(value: ChecklistValue) => applyChecklist(value)}
                        />
                    )}
                    <PgMetricStrip items={props.metrics ?? []} />
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
            checklist: { type: [Array, Object] as unknown as () => ChecklistValue, default: () => ({}) },
            showChecklists: { type: Boolean, default: false },
            checklistComplete: { type: Boolean, default: true },
            exportLoading: { type: Boolean, default: false },
            exportDisabled: { type: Boolean, default: false },
            exportLabel: { type: String, default: "" },
            onChecklistChange: {
                type: Function as unknown as () => ((value: ChecklistValue) => void) | undefined,
                default: undefined,
            },
        },
        emits: ["update:checklist", "export"],
        slots: ["default"],
        inheritAttrs: true,
    },
);

export const SummaryExportCard = PgSummaryExportCard;

import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { RepeatableRows } from "./RepeatableRows";
import { WINDOW_ERROR_MESSAGES } from "./messages";
import {
    blankMaintenanceWindow,
    maintenanceWindowState,
    validateMaintenanceWindows,
    type MaintenanceWindowRow,
} from "./model/maintenanceWindows";

const STATE_TONE = { ACTIVE: "warning", UPCOMING: "info", PAST: "neutral" } as const;
const STATE_LABEL = { ACTIVE: "In maintenance now", UPCOMING: "Upcoming", PAST: "Finished" } as const;

/**
 * Maintenance windows of a route: `[{ start, end }]`. Times are edited in UTC (`datetime-local`
 * text) so the stored ISO instants do not depend on the operator's time zone. A route is excluded
 * from checkout while `start <= now < end`. `readonly` renders the same rows without editing.
 */
export const MaintenanceWindowsBuilder = defineComponent({
    name: "MaintenanceWindowsBuilder",
    props: {
        modelValue: { type: Array as PropType<MaintenanceWindowRow[]>, required: true },
        readonly: { type: Boolean, default: false },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const patchRow = (index: number, change: Partial<Pick<MaintenanceWindowRow, "start" | "end">>) =>
            emit("update:modelValue", props.modelValue.map((row, position) => (position === index ? { ...row, ...change } : row)));

        return (): VNodeChild => {
            const errors = validateMaintenanceWindows(props.modelValue);
            const errorFor = (index: number, field: "start" | "end"): string => {
                const found = errors.find((entry) => entry.index === index && entry.field === field);
                return found ? t(WINDOW_ERROR_MESSAGES[found.code]) : "";
            };
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", minInlineSize: 0 }}>
                    <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>{t("All times are UTC.")}</span>
                    <RepeatableRows
                        count={props.modelValue.length}
                        disabled={props.readonly}
                        addLabel={t("Add maintenance window")}
                        emptyLabel={t("No maintenance windows.")}
                        removeLabel={t("Remove window")}
                        rowLabel={(index: number) => `${t("Maintenance window")} ${index + 1}`}
                        onAdd={() => emit("update:modelValue", [...props.modelValue, blankMaintenanceWindow()])}
                        onRemove={(index: number) => emit("update:modelValue", props.modelValue.filter((_, position) => position !== index))}
                        v-slots={{
                            default: ({ index }: { index: number }) => {
                                const row = props.modelValue[index]!;
                                const state = maintenanceWindowState(row);
                                return (
                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "10px 12px", alignItems: "start" }}>
                                        <FormField label={t("Start (UTC)")} error={errorFor(index, "start")}>
                                            <VTextField type="datetime-local" modelValue={row.start} onUpdate:modelValue={(value: string) => patchRow(index, { start: value })} readonly={props.readonly} density="compact" hideDetails />
                                        </FormField>
                                        <FormField label={t("End (UTC)")} error={errorFor(index, "end")}>
                                            <VTextField type="datetime-local" modelValue={row.end} onUpdate:modelValue={(value: string) => patchRow(index, { end: value })} readonly={props.readonly} density="compact" hideDetails />
                                        </FormField>
                                        {state && (
                                            <div>
                                                <StatusBadge status={state} label={t(STATE_LABEL[state])} toneOverride={STATE_TONE[state]} />
                                            </div>
                                        )}
                                    </div>
                                );
                            },
                        }}
                    />
                </div>
            );
        };
    },
});

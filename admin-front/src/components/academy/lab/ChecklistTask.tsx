import { defineComponent, type PropType } from "vue";
import { useLocale } from "vuetify";
import { VIcon } from "vuetify/components";
import type { ChecklistTask as ChecklistTaskType } from "@/content/academy";
import type { ChecklistAnswer } from "../labScoring";
import { labBorder, renderInline } from "./PanelView";

export const ChecklistTask = defineComponent({
    name: "AcademyLabChecklistTask",
    props: {
        task: { type: Object as PropType<ChecklistTaskType>, required: true },
        answer: { type: Object as PropType<ChecklistAnswer | undefined>, default: undefined },
        locked: { type: Boolean, default: false },
        onChange: { type: Function as PropType<(answer: ChecklistAnswer) => void>, required: true },
    },
    setup(props) {
        const { t } = useLocale();
        const toggle = (id: string, on: boolean) => {
            const current = props.answer?.ticked ?? [];
            const next = on ? [...current.filter((x) => x !== id), id] : current.filter((x) => x !== id);
            props.onChange({ ...(props.answer ?? {}), ticked: next });
        };
        return () => {
            const ticked = new Set(props.answer?.ticked ?? []);
            return (
                <fieldset style={{ border: "none", padding: 0, margin: 0, display: "grid", gap: "8px" }}>
                    <legend style={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden" }}>
                        {t("Tick every item that applies")}
                    </legend>
                    <p style={{ margin: 0, opacity: 0.8 }}>{t("Tick every item that applies")}</p>
                    {props.task.items.map((item) => {
                        const isOn = ticked.has(item.id);
                        const right = isOn === item.shouldTick;
                        return (
                            <div style={{ border: labBorder, borderRadius: "8px", padding: "8px 12px" }}>
                                <label style={{ display: "flex", gap: "10px", alignItems: "flex-start", cursor: props.locked ? "default" : "pointer" }}>
                                    <input
                                        type="checkbox"
                                        value={item.id}
                                        checked={isOn}
                                        disabled={props.locked}
                                        style={{ marginTop: "4px" }}
                                        onChange={(event: Event) => toggle(item.id, (event.target as HTMLInputElement).checked)}
                                    />
                                    <span style={{ flex: 1 }}>{renderInline(item.label)}</span>
                                    {props.locked ? (
                                        <span style={{ whiteSpace: "nowrap" }}>
                                            <VIcon
                                                icon={right ? "mdi-check-circle" : "mdi-close-circle"}
                                                color={right ? "success" : "error"}
                                                size={18}
                                                aria-hidden="true"
                                            />{" "}
                                            {right ? t("Right") : item.shouldTick ? t("Should be ticked") : t("Should not be ticked")}
                                        </span>
                                    ) : null}
                                </label>
                                {props.locked ? <p style={{ margin: "6px 0 0", paddingInlineStart: "28px" }}>{item.why}</p> : null}
                            </div>
                        );
                    })}
                </fieldset>
            );
        };
    },
});
export default ChecklistTask;

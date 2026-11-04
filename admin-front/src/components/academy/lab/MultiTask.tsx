import { defineComponent, type PropType } from "vue";
import { useLocale } from "vuetify";
import { VIcon } from "vuetify/components";
import type { MultiTask as MultiTaskType } from "@/content/academy";
import type { MultiAnswer } from "../labScoring";
import { labBorder, renderInline } from "./PanelView";

export const MultiTask = defineComponent({
    name: "AcademyLabMultiTask",
    props: {
        task: { type: Object as PropType<MultiTaskType>, required: true },
        answer: { type: Object as PropType<MultiAnswer | undefined>, default: undefined },
        locked: { type: Boolean, default: false },
        onChange: { type: Function as PropType<(answer: MultiAnswer) => void>, required: true },
    },
    setup(props) {
        const { t } = useLocale();
        const toggle = (id: string, on: boolean) => {
            const current = props.answer?.selected ?? [];
            const next = on ? [...current.filter((x) => x !== id), id] : current.filter((x) => x !== id);
            props.onChange({ ...(props.answer ?? {}), selected: next });
        };
        return () => {
            const selected = new Set(props.answer?.selected ?? []);
            return (
                <fieldset style={{ border: "none", padding: 0, margin: 0, display: "grid", gap: "8px" }}>
                    <legend style={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden" }}>
                        {t("Select all that apply")}
                    </legend>
                    <p style={{ margin: 0, opacity: 0.8 }}>{t("Select all that apply")}</p>
                    {props.task.options.map((option) => {
                        const isOn = selected.has(option.id);
                        const showFeedback = props.locked && (isOn || option.correct);
                        return (
                            <div style={{ border: labBorder, borderRadius: "8px", padding: "8px 12px" }}>
                                <label style={{ display: "flex", gap: "10px", alignItems: "flex-start", cursor: props.locked ? "default" : "pointer" }}>
                                    <input
                                        type="checkbox"
                                        value={option.id}
                                        checked={isOn}
                                        disabled={props.locked}
                                        style={{ marginTop: "4px" }}
                                        onChange={(event: Event) => toggle(option.id, (event.target as HTMLInputElement).checked)}
                                    />
                                    <span style={{ flex: 1 }}>{renderInline(option.label)}</span>
                                    {props.locked ? (
                                        <span style={{ whiteSpace: "nowrap" }}>
                                            {option.correct ? (
                                                <>
                                                    <VIcon icon="mdi-check-circle" color="success" size={18} aria-hidden="true" />{" "}
                                                    {isOn ? t("Right, selected") : t("Should be selected")}
                                                </>
                                            ) : isOn ? (
                                                <>
                                                    <VIcon icon="mdi-close-circle" color="error" size={18} aria-hidden="true" /> {t("Wrongly selected")}
                                                </>
                                            ) : null}
                                        </span>
                                    ) : null}
                                </label>
                                {showFeedback ? <p style={{ margin: "6px 0 0", paddingInlineStart: "28px" }}>{option.feedback}</p> : null}
                            </div>
                        );
                    })}
                </fieldset>
            );
        };
    },
});
export default MultiTask;

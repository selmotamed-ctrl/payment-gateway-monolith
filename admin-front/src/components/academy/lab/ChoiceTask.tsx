import { defineComponent, type PropType } from "vue";
import { useLocale } from "vuetify";
import { VIcon } from "vuetify/components";
import type { ChoiceTask as ChoiceTaskType } from "@/content/academy";
import type { ChoiceAnswer } from "../labScoring";
import { labBorder, renderInline } from "./PanelView";

export const ChoiceTask = defineComponent({
    name: "AcademyLabChoiceTask",
    props: {
        task: { type: Object as PropType<ChoiceTaskType>, required: true },
        answer: { type: Object as PropType<ChoiceAnswer | undefined>, default: undefined },
        locked: { type: Boolean, default: false },
        onChange: { type: Function as PropType<(answer: ChoiceAnswer) => void>, required: true },
    },
    setup(props) {
        const { t } = useLocale();
        return () => (
            <fieldset style={{ border: "none", padding: 0, margin: 0, display: "grid", gap: "8px" }}>
                <legend style={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden" }}>{props.task.title}</legend>
                {props.task.options.map((option) => {
                    const chosen = props.answer?.selected === option.id;
                    const showFeedback = props.locked && (chosen || option.correct);
                    return (
                        <div style={{ border: labBorder, borderRadius: "8px", padding: "8px 12px" }}>
                            <label style={{ display: "flex", gap: "10px", alignItems: "flex-start", cursor: props.locked ? "default" : "pointer" }}>
                                <input
                                    type="radio"
                                    name={`choice-${props.task.id}`}
                                    value={option.id}
                                    checked={chosen}
                                    disabled={props.locked}
                                    style={{ marginTop: "4px" }}
                                    onChange={() => props.onChange({ ...(props.answer ?? { selected: null }), selected: option.id })}
                                />
                                <span style={{ flex: 1 }}>{renderInline(option.label)}</span>
                                {props.locked && option.correct ? (
                                    <span style={{ whiteSpace: "nowrap" }}>
                                        <VIcon icon="mdi-check-circle" color="success" size={18} aria-hidden="true" /> {t("Correct answer")}
                                    </span>
                                ) : null}
                                {props.locked && chosen && !option.correct ? (
                                    <span style={{ whiteSpace: "nowrap" }}>
                                        <VIcon icon="mdi-close-circle" color="error" size={18} aria-hidden="true" /> {t("Your choice")}
                                    </span>
                                ) : null}
                            </label>
                            {showFeedback ? <p style={{ margin: "6px 0 0", paddingInlineStart: "28px" }}>{option.feedback}</p> : null}
                        </div>
                    );
                })}
            </fieldset>
        );
    },
});
export default ChoiceTask;

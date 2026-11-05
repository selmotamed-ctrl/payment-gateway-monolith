import { defineComponent, type PropType } from "vue";
import { useLocale } from "vuetify";
import type { ChoiceTask as ChoiceTaskType } from "@/content/academy";
import type { ChoiceAnswer } from "../labScoring";
import { choiceTag, renderInline } from "./PanelView";

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
            <fieldset class="ac-lab-fieldset">
                <legend class="ac-sr-only">{props.task.title}</legend>
                <div class="ac-choices">
                    {props.task.options.map((option) => {
                        const chosen = props.answer?.selected === option.id;
                        const showFeedback = props.locked && (chosen || option.correct);
                        const noteId = `choice-${props.task.id}-${option.id}-note`;
                        // Locked: the right answer is green, a wrong pick red, the rest are inert.
                        const state = props.locked ? (option.correct ? "good" : chosen ? "bad" : "locked") : chosen ? "selected" : "";
                        return (
                            <div class="ac-lab-opt" key={option.id}>
                                <label class={["ac-choice", state ? `ac-choice--${state}` : "", props.locked ? "ac-choice--locked" : ""]}>
                                    <input
                                        type="radio"
                                        name={`choice-${props.task.id}`}
                                        value={option.id}
                                        checked={chosen}
                                        disabled={props.locked}
                                        aria-describedby={showFeedback ? noteId : undefined}
                                        onChange={() => props.onChange({ ...(props.answer ?? { selected: null }), selected: option.id })}
                                    />
                                    <span class="ac-choice__label" dir="auto">
                                        {renderInline(option.label)}
                                    </span>
                                    {props.locked && option.correct ? choiceTag("good", t("Correct answer")) : null}
                                    {props.locked && chosen && !option.correct ? choiceTag("bad", t("Your choice")) : null}
                                </label>
                                {showFeedback ? (
                                    <p id={noteId} class="ac-choice__note ac-lab-opt__note" dir="auto">
                                        {option.feedback}
                                    </p>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            </fieldset>
        );
    },
});
export default ChoiceTask;

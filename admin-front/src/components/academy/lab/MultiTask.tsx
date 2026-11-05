import { defineComponent, type PropType, type VNode } from "vue";
import { useLocale } from "vuetify";
import type { MultiTask as MultiTaskType } from "@/content/academy";
import type { MultiAnswer } from "../labScoring";
import { choiceTag, renderInline } from "./PanelView";

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
                <fieldset class="ac-lab-fieldset">
                    <legend class="ac-sr-only">{t("Select all that apply")}</legend>
                    <p class="ac-muted ac-lab-hintline">{t("Select all that apply")}</p>
                    <div class="ac-choices">
                        {props.task.options.map((option) => {
                            const isOn = selected.has(option.id);
                            const showFeedback = props.locked && (isOn || option.correct);
                            const noteId = `multi-${props.task.id}-${option.id}-note`;
                            let state = "";
                            let tag: VNode | null = null;
                            if (props.locked) {
                                if (option.correct) {
                                    state = isOn ? "good" : "missed";
                                    tag = choiceTag(isOn ? "good" : "missed", isOn ? t("Right, selected") : t("Should be selected"));
                                } else if (isOn) {
                                    state = "bad";
                                    tag = choiceTag("bad", t("Wrongly selected"));
                                } else {
                                    state = "locked";
                                }
                            } else if (isOn) {
                                state = "selected";
                            }
                            return (
                                <div class="ac-lab-opt" key={option.id}>
                                    <label class={["ac-choice", state ? `ac-choice--${state}` : "", props.locked ? "ac-choice--locked" : ""]}>
                                        <input
                                            type="checkbox"
                                            value={option.id}
                                            checked={isOn}
                                            disabled={props.locked}
                                            aria-describedby={showFeedback ? noteId : undefined}
                                            onChange={(event: Event) => toggle(option.id, (event.target as HTMLInputElement).checked)}
                                        />
                                        <span class="ac-choice__label" dir="auto">
                                            {renderInline(option.label)}
                                        </span>
                                        {tag}
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
        };
    },
});
export default MultiTask;

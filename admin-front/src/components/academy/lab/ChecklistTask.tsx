import { defineComponent, type PropType } from "vue";
import { useLocale } from "vuetify";
import type { ChecklistTask as ChecklistTaskType } from "@/content/academy";
import type { ChecklistAnswer } from "../labScoring";
import { choiceTag, renderInline } from "./PanelView";

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
                <fieldset class="ac-lab-fieldset">
                    <legend class="ac-sr-only">{t("Tick every item that applies")}</legend>
                    <p class="ac-muted ac-lab-hintline">{t("Tick every item that applies")}</p>
                    <div class="ac-choices">
                        {props.task.items.map((item) => {
                            const isOn = ticked.has(item.id);
                            const right = isOn === item.shouldTick;
                            const noteId = `check-${props.task.id}-${item.id}-note`;
                            // Locked: right = green; a missed tick = amber; a wrong tick = red.
                            const state = props.locked ? (right ? "good" : item.shouldTick ? "missed" : "bad") : isOn ? "selected" : "";
                            return (
                                <div class="ac-lab-opt" key={item.id}>
                                    <label class={["ac-choice", state ? `ac-choice--${state}` : "", props.locked ? "ac-choice--locked" : ""]}>
                                        <input
                                            type="checkbox"
                                            value={item.id}
                                            checked={isOn}
                                            disabled={props.locked}
                                            aria-describedby={props.locked ? noteId : undefined}
                                            onChange={(event: Event) => toggle(item.id, (event.target as HTMLInputElement).checked)}
                                        />
                                        <span class="ac-choice__label" dir="auto">
                                            {renderInline(item.label)}
                                        </span>
                                        {props.locked
                                            ? choiceTag(
                                                  right ? "good" : item.shouldTick ? "missed" : "bad",
                                                  right ? t("Right") : item.shouldTick ? t("Should be ticked") : t("Should not be ticked"),
                                              )
                                            : null}
                                    </label>
                                    {props.locked ? (
                                        <p id={noteId} class="ac-choice__note ac-lab-opt__note" dir="auto">
                                            {item.why}
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
export default ChecklistTask;

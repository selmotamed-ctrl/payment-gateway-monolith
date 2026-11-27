import { type PropType } from "vue";
import { defineComponent } from "@/utils/dc";
import { useLocale } from "@/utils/vael-compat";
import type { NumericTask as NumericTaskType } from "@/content/academy";
import { parseDecimal, type NumericAnswer } from "../labScoring";
import { PgTextField } from "@pg/ui";

export const NumericTask = defineComponent({
    name: "AcademyLabNumericTask",
    props: {
        task: { type: Object as PropType<NumericTaskType>, required: true },
        answer: { type: Object as PropType<NumericAnswer | undefined>, default: undefined },
        locked: { type: Boolean, default: false },
        onChange: { type: Function as PropType<(answer: NumericAnswer) => void>, required: true },
    },
    setup(props) {
        const { t } = useLocale();
        const id = () => `numeric-${props.task.id}`;
        return () => {
            const value = props.answer?.value ?? "";
            const invalid = value.trim() !== "" && parseDecimal(value) === null;
            return (
                <div class="ac-lab-numeric">
                    <label for={id()} class="ac-lab-label">
                        {t("Your answer")}
                        {props.task.unit ? ` (${props.task.unit})` : ""}
                    </label>
                    <PgTextField
                        id={id()}
                        class="ac-lab-input"
                        density="compact"
                        hideDetails
                        inputmode="decimal"
                        autocomplete="off"
                        dir="ltr"
                        modelValue={value}
                        disabled={props.locked}
                        aria-invalid={invalid ? "true" : undefined}
                        aria-describedby={`${id()}-help`}
                        onUpdate:modelValue={(next: string) => props.onChange({ ...(props.answer ?? {}), value: next })}
                    />
                    <span id={`${id()}-help`} role={invalid ? "alert" : undefined} class={["ac-lab-help", invalid ? "ac-lab-help--error" : ""]}>
                        {invalid ? t("Enter a plain number such as -57 or 12.50.") : t("Use digits, a minus sign and a decimal point only.")}
                    </span>
                    {props.locked ? (
                        <p class="ac-text ac-lab-expected-answer">
                            <strong>{t("Expected answer")}:</strong> <bdi>{props.task.answer}</bdi>
                            {props.task.unit ? ` ${props.task.unit}` : ""}
                        </p>
                    ) : null}
                </div>
            );
        };
    },
});
export default NumericTask;

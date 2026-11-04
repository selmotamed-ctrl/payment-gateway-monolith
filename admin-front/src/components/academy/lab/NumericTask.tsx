import { defineComponent, type PropType } from "vue";
import { useLocale } from "vuetify";
import type { NumericTask as NumericTaskType } from "@/content/academy";
import { parseDecimal, type NumericAnswer } from "../labScoring";
import { labBorder } from "./PanelView";

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
                <div style={{ display: "grid", gap: "6px", maxWidth: "360px" }}>
                    <label for={id()} style={{ fontWeight: 600 }}>
                        {t("Your answer")}
                        {props.task.unit ? ` (${props.task.unit})` : ""}
                    </label>
                    <input
                        id={id()}
                        type="text"
                        inputmode="decimal"
                        autocomplete="off"
                        dir="ltr"
                        value={value}
                        disabled={props.locked}
                        aria-invalid={invalid ? "true" : undefined}
                        aria-describedby={`${id()}-help`}
                        style={{ border: labBorder, borderRadius: "8px", padding: "8px 12px", font: "inherit", background: "transparent", color: "inherit" }}
                        onInput={(event: Event) => props.onChange({ ...(props.answer ?? {}), value: (event.target as HTMLInputElement).value })}
                    />
                    <span id={`${id()}-help`} role={invalid ? "alert" : undefined} style={{ opacity: 0.8 }}>
                        {invalid ? t("Enter a plain number such as -57 or 12.50.") : t("Use digits, a minus sign and a decimal point only.")}
                    </span>
                    {props.locked ? (
                        <p style={{ margin: 0 }}>
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

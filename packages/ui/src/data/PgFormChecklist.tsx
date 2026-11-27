import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { PgCheckbox } from "../inputs/PgCheckbox";

export interface PgChecklistItem {
    key: string;
    label: string;
}

/** Maker-checker / safeguard checklist with a single update event. */
export const PgFormChecklist = dc(
    (props: Record<string, any>, _expose, { emit }) => {
        const { t } = useLocale();
        const update = (key: string, value: unknown) => {
            emit?.("update:modelValue", { ...props.modelValue, [key]: Boolean(value) });
        };
        return () => {
            if (!props.show || !props.checks?.length) return null;
            return (
                <div class="pg-checklist">
                    {props.title && <div class="pg-checklist__title">{props.title}</div>}
                    {props.checks.map((check: PgChecklistItem) => (
                        <PgCheckbox
                            key={check.key}
                            modelValue={props.modelValue?.[check.key] === true}
                            onUpdate:modelValue={(value: unknown) => update(check.key, value)}
                            label={t(check.label)}
                            density="compact"
                            hideDetails
                        />
                    ))}
                    {!props.complete && props.incompleteMessage && (
                        <div class="pg-checklist__hint">{props.incompleteMessage}</div>
                    )}
                </div>
            );
        };
    },
    {
        props: {
            checks: { type: Array as () => PgChecklistItem[], default: () => [] },
            modelValue: { type: Object as () => Record<string, boolean>, default: () => ({}) },
            title: { type: String, default: "" },
            show: { type: Boolean, default: true },
            incompleteMessage: { type: String, default: "" },
            complete: { type: Boolean, default: true },
        },
        emits: ["update:modelValue"],
    },
);

export const FormChecklist = PgFormChecklist;

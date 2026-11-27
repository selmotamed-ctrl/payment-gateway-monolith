import { computed } from "vue";
import { dc } from "../lib/dc";
import { PgIcon } from "../actions/PgIcon";

export type PgChoiceState = "" | "selected" | "good" | "bad" | "missed" | "locked";

/**
 * Rich selection tile for onboarding, rail selection and exam/lab answers.
 *
 * It renders a single custom control (`role="checkbox"` or `role="radio"`) with
 * `aria-checked`, a leading icon box and a trailing 2026 indicator. `Enter` and
 * `Space` toggle it; links inside the description keep their own behaviour.
 *
 * The legacy Vuetify-era contract (`type`, `checked`, `onChange`, `state` and
 * default-slot content) is preserved so the Academy screens keep working.
 */
export const PgChoice = dc(
    (props: Record<string, any>, _expose, { attrs, emit, slots }) => {
        const mode = computed(() => (props.mode || props.type || "checkbox") === "radio" ? "radio" : "checkbox");
        const isChecked = computed(() => {
            if (props.modelValue !== undefined && props.modelValue !== null) return Boolean(props.modelValue);
            return Boolean(props.checked);
        });
        const isDisabled = computed(() => Boolean(props.disabled) || props.state === "locked");

        const toggle = () => {
            if (isDisabled.value) return;
            const next = mode.value === "radio" ? true : !isChecked.value;
            emit?.("update:modelValue", next);
            emit?.("change", next);
        };

        const handleClick = (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest?.("a,button,input,select,textarea,label")) {
                // "Learn more" and inline actions must never flip the card.
                event.stopPropagation();
                return;
            }
            event.preventDefault();
            toggle();
        };

        const handleKeydown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest?.("a,button,input,select,textarea,label")) return;
            if (event.key !== " " && event.key !== "Enter") return;
            event.preventDefault();
            toggle();
        };

        return () => {
            const stateClass = props.state ? `pg-choice--${props.state} ac-choice--${props.state}` : "";
            return (
                <div
                    {...attrs}
                    class={[
                        "pg-choice",
                        "ac-choice",
                        `pg-choice--${mode.value}`,
                        isChecked.value ? "pg-choice--checked" : "",
                        isDisabled.value ? "pg-choice--disabled ac-choice--locked" : "",
                        stateClass,
                        attrs.class,
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    role={mode.value === "radio" ? "radio" : "checkbox"}
                    aria-checked={isChecked.value ? "true" : "false"}
                    aria-disabled={isDisabled.value ? "true" : undefined}
                    aria-describedby={props.ariaDescribedBy || undefined}
                    tabindex={isDisabled.value ? -1 : 0}
                    data-pg-choice={mode.value}
                    onClick={handleClick}
                    onKeydown={handleKeydown}
                >
                    {(props.icon || slots.icon) && (
                        <span class="pg-choice__icon" aria-hidden="true">
                            {slots.icon ? slots.icon() : <PgIcon icon={props.icon} size={20} />}
                        </span>
                    )}
                    <span class="pg-choice__body">
                        {props.title && <span class="pg-choice__title">{props.title}</span>}
                        {(props.description || slots.description) && (
                            <span class="pg-choice__description">
                                {slots.description ? slots.description() : props.description}
                            </span>
                        )}
                        {slots.default?.()}
                    </span>
                    {(props.badge || slots.badge) && (
                        <span class="pg-choice__badge">{slots.badge ? slots.badge() : props.badge}</span>
                    )}
                    <span class="pg-choice__indicator" aria-hidden="true">
                        <span
                            class={[
                                "pg-choice__mark",
                                mode.value === "radio" ? "pg-choice__mark--radio" : "pg-choice__mark--checkbox",
                                isChecked.value ? "pg-choice__mark--on" : "",
                            ]
                                .filter(Boolean)
                                .join(" ")}
                        >
                            {isChecked.value ? (
                                mode.value === "radio" ? (
                                    <span class="pg-choice__dot" />
                                ) : (
                                    <svg class="pg-choice__check" viewBox="0 0 24 24" width={12} height={12} focusable="false">
                                        <path
                                            d="M20 6 9 17l-5-5"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2.4"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                        />
                                    </svg>
                                )
                            ) : null}
                        </span>
                    </span>
                </div>
            );
        };
    },
    {
        props: {
            modelValue: { type: Boolean, default: undefined },
            checked: { type: Boolean, default: false },
            mode: { type: String, default: "" },
            type: { type: String, default: "" },
            title: { type: String, default: "" },
            description: { type: String, default: "" },
            icon: { type: String, default: "" },
            badge: { type: [String, Number], default: "" },
            disabled: { type: Boolean, default: false },
            state: { type: String, default: "" },
            name: { type: String, default: "" },
            value: { type: [String, Number, Boolean, Object], default: undefined },
            ariaDescribedBy: { type: String, default: "" },
        },
        emits: ["update:modelValue", "change"],
        inheritAttrs: true,
    },
);

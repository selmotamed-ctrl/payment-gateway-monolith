import { dc } from "../lib/dc";

export type PgChoiceState = "" | "selected" | "good" | "bad" | "missed" | "locked";

/**
 * Accessible choice card used by exams, labs and any radio/checkbox list.
 * The native control lives inside `@pg/ui`, so pages never write a raw input.
 * The host's choice styles (`ac-choice`/`ac-choice--*`) are preserved.
 */
export const PgChoice = dc(
    (props: Record<string, any>, _expose, { emit, slots }) => () => (
        <label
            class={[
                "pg-choice",
                "ac-choice",
                props.state ? `ac-choice--${props.state}` : "",
                props.disabled ? "ac-choice--locked" : "",
                props.class,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            <input
                class="pg-choice__input"
                type={props.type ?? "checkbox"}
                name={props.name || undefined}
                value={props.value ?? undefined}
                checked={Boolean(props.checked)}
                disabled={Boolean(props.disabled)}
                aria-describedby={props.ariaDescribedBy || undefined}
                onChange={(event: Event) => emit?.("change", (event.target as HTMLInputElement).checked)}
            />
            <span class="ac-choice__label pg-choice__label">{slots.default?.() ?? props.label}</span>
            {slots.trailing?.()}
        </label>
    ),
    {
        props: {
            type: { type: String, default: "checkbox" },
            checked: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            name: { type: String, default: "" },
            value: { type: [String, Number], default: undefined },
            label: { type: String, default: "" },
            state: { type: String, default: "" },
            ariaDescribedBy: { type: String, default: "" },
        },
        emits: ["change"],
    },
);

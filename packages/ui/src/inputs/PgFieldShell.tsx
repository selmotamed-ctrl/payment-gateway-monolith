import { createSlot } from "vue";
import { dc } from "../lib/dc";

/**
 * Shared label / required mark / hint / error wrapper for every input.
 * Renders the exact 2026 spacing and the single error style used across the
 * design system.
 */
export const PgFieldShell = dc(
    (
        props: {
            forId?: string;
            label?: string;
            hint?: string;
            error?: string;
            required?: boolean;
            disabled?: boolean;
            hideDetails?: boolean;
            counter?: string;
        },
        _expose,
        { slots },
    ) => () => (
        <div class={["pg-field", props.disabled ? "pg-field--disabled" : ""]}>
            {props.label && (
                <label class="pg-field__label" for={props.forId}>
                    <span>{props.label}</span>
                    {props.required && (
                        <span class="pg-field__required" aria-hidden="true">
                            *
                        </span>
                    )}
                </label>
            )}
            {createSlot("default")}
            {!props.hideDetails && props.error ? (
                <span class="pg-field__error" role="alert" aria-live="polite">
                    {props.error}
                </span>
            ) : !props.hideDetails && (props.hint || props.counter) ? (
                <span class="pg-field__hint">
                    {props.hint}
                    {props.counter ? <span class="pg-field__counter pg-tabular">{props.counter}</span> : null}
                </span>
            ) : null}
            {slots.append ? slots.append() : null}
        </div>
    ),
    {
        props: {
            forId: { type: String, default: "" },
            label: { type: String, default: "" },
            hint: { type: String, default: "" },
            error: { type: String, default: "" },
            required: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            hideDetails: { type: Boolean, default: false },
            counter: { type: String, default: "" },
        },
    },
);

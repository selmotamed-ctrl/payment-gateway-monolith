import { defineComponent, type PropType } from "vue";
import { VIcon } from "vuetify/components";

export type StepState = "done" | "current" | "todo" | "locked" | "partial" | "failed";

const ICON: Record<StepState, string> = {
    done: "mdi-check-circle",
    current: "mdi-play-circle-outline",
    todo: "mdi-circle-outline",
    locked: "mdi-lock-outline",
    partial: "mdi-circle-half-full",
    failed: "mdi-close-circle-outline",
};

/**
 * Decorative state marker for step lists. It is aria-hidden: callers MUST put the state in
 * words next to it (colour and icon are never the only signal).
 */
export const StateIcon = defineComponent({
    name: "AcademyStateIcon",
    props: {
        state: { type: String as PropType<StepState>, required: true },
        /** Labs show a flask while still to do. */
        lab: { type: Boolean, default: false },
        size: { type: Number, default: 20 },
    },
    setup(props) {
        return () => (
            <span class={["ac-state", `ac-state--${props.state}`]} aria-hidden="true">
                <VIcon icon={props.lab && props.state === "todo" ? "mdi-flask-outline" : ICON[props.state]} size={props.size} />
            </span>
        );
    },
});

export default StateIcon;

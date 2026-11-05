import { computed, defineComponent, type PropType } from "vue";
import { VIcon } from "vuetify/components";

export type CalloutTone = "neutral" | "info" | "success" | "warning" | "danger";

const ICON: Record<CalloutTone, string> = {
    neutral: "mdi-information-outline",
    info: "mdi-information-outline",
    success: "mdi-check-circle-outline",
    warning: "mdi-alert-outline",
    danger: "mdi-alert-circle-outline",
};

/**
 * Inline message (never a toast). Uses the status tokens and always carries an icon AND text.
 * `role` defaults to "alert" for danger/warning and "status" otherwise; pass `role="none"` to omit it.
 */
export const Callout = defineComponent({
    name: "AcademyCallout",
    props: {
        tone: { type: String as PropType<CalloutTone>, default: "neutral" },
        title: { type: String, default: "" },
        icon: { type: String, default: "" },
        role: { type: String as PropType<"auto" | "alert" | "status" | "none">, default: "auto" },
    },
    setup(props, { slots }) {
        const role = computed(() => {
            if (props.role === "none") return undefined;
            if (props.role !== "auto") return props.role;
            return props.tone === "danger" || props.tone === "warning" ? "alert" : "status";
        });
        return () => (
            <div class={["ac-callout", props.tone !== "neutral" ? `ac-callout--${props.tone}` : ""]} role={role.value}>
                <VIcon class="ac-callout__icon" icon={props.icon || ICON[props.tone]} size={18} aria-hidden="true" />
                <div class="ac-callout__body">
                    {props.title ? <strong class="ac-callout__title">{props.title}</strong> : null}
                    {slots.default?.()}
                </div>
            </div>
        );
    },
});

export default Callout;

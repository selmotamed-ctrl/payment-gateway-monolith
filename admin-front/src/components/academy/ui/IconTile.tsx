import { defineComponent, type PropType } from "vue";
import { VIcon } from "vuetify/components";

/** Rounded square holding one MDI icon (track identity, empty states, certificate seal). */
export const IconTile = defineComponent({
    name: "AcademyIconTile",
    props: {
        icon: { type: String, required: true },
        tone: { type: String as PropType<"neutral" | "success" | "warning" | "danger" | "info">, default: "neutral" },
        large: { type: Boolean, default: false },
    },
    setup(props) {
        return () => (
            <span class={["ac-tile", props.large ? "ac-tile--lg" : "", props.tone !== "neutral" ? `ac-tile--${props.tone}` : ""]} aria-hidden="true">
                <VIcon icon={props.icon} size={props.large ? 22 : 18} />
            </span>
        );
    },
});

export default IconTile;

import { computed, defineComponent, type PropType } from "vue";

export type BarTone = "auto" | "info" | "success" | "warning" | "danger";

/** Thin linear progress. `label` is the accessible name (required: a bare progressbar is not announced usefully). */
export const ProgressBar = defineComponent({
    name: "AcademyProgressBar",
    props: {
        value: { type: Number, required: true },
        max: { type: Number, required: true },
        label: { type: String, required: true },
        tone: { type: String as PropType<BarTone>, default: "auto" },
        large: { type: Boolean, default: false },
    },
    setup(props) {
        const ratio = computed(() => (props.max > 0 ? Math.min(1, Math.max(0, props.value / props.max)) : 0));
        const tone = computed(() => (props.tone === "auto" ? (props.max > 0 && props.value >= props.max ? "success" : "info") : props.tone));
        return () => (
            <span
                class={["ac-bar", tone.value !== "info" ? `ac-bar--${tone.value}` : "", props.large ? "ac-bar--lg" : ""]}
                role="progressbar"
                aria-label={props.label}
                aria-valuemin={0}
                aria-valuemax={props.max}
                aria-valuenow={Math.min(props.value, props.max)}
            >
                <span style={{ inlineSize: `${Math.round(ratio.value * 100)}%` }} />
            </span>
        );
    },
});

export default ProgressBar;

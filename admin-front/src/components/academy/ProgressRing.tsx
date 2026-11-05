import { defineComponent } from "vue";

/**
 * Thin ring with the numbers in the centre (never colour alone). Flat: no gradient, tokens only.
 * A completed ring draws a check mark instead of "n/n".
 */
export const ProgressRing = defineComponent({
    name: "AcademyProgressRing",
    props: {
        value: { type: Number, required: true },
        max: { type: Number, required: true },
        label: { type: String, required: true },
        size: { type: Number, default: 76 },
    },
    setup(props) {
        return () => {
            const radius = 15.9155;
            const ratio = props.max > 0 ? Math.min(1, props.value / props.max) : 0;
            const done = props.max > 0 && props.value >= props.max;
            return (
                <figure class="ac-ring" style={{ inlineSize: `${props.size}px` }}>
                    <svg
                        viewBox="0 0 36 36"
                        role="img"
                        aria-label={`${props.label}: ${props.value} / ${props.max}`}
                        style={{ inlineSize: `${props.size}px`, blockSize: `${props.size}px`, display: "block" }}
                    >
                        <circle cx="18" cy="18" r={radius} fill="none" stroke="var(--pg-border-subtle)" stroke-width="2.6" />
                        <circle
                            cx="18"
                            cy="18"
                            r={radius}
                            fill="none"
                            stroke={done ? "var(--pg-status-success-dot)" : "var(--pg-accent-interactive)"}
                            stroke-width="2.6"
                            stroke-linecap="round"
                            stroke-dasharray={`${ratio * 100} 100`}
                            transform="rotate(-90 18 18)"
                        />
                        {done ? (
                            <path d="M12.5 18.4l3.9 3.9 7.3-7.8" fill="none" stroke="var(--pg-status-success-dot)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
                        ) : (
                            <text x="18" y="20.6" text-anchor="middle" font-size="7.6" font-weight="600" fill="var(--pg-ink-primary)">
                                {`${props.value}/${props.max}`}
                            </text>
                        )}
                    </svg>
                    <figcaption>{props.label}</figcaption>
                </figure>
            );
        };
    },
});

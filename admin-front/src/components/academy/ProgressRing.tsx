import { defineComponent } from "vue";

/** Ring with the numbers in the centre (never colour alone). */
export const ProgressRing = defineComponent({
    name: "AcademyProgressRing",
    props: {
        value: { type: Number, required: true },
        max: { type: Number, required: true },
        label: { type: String, required: true },
        size: { type: Number, default: 84 },
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
                        style={{ inlineSize: `${props.size}px`, blockSize: `${props.size}px` }}
                    >
                        <circle cx="18" cy="18" r={radius} fill="none" stroke="var(--pg-border-subtle)" stroke-width="3.2" />
                        <circle
                            cx="18"
                            cy="18"
                            r={radius}
                            fill="none"
                            stroke={done ? "var(--pg-status-success-dot)" : "var(--pg-accent-interactive)"}
                            stroke-width="3.2"
                            stroke-linecap="round"
                            stroke-dasharray={`${ratio * 100} 100`}
                            transform="rotate(-90 18 18)"
                        />
                        <text x="18" y="20.5" text-anchor="middle" font-size="8" font-weight="700" fill="var(--pg-ink-primary)">
                            {done ? "✓" : `${props.value}/${props.max}`}
                        </text>
                    </svg>
                    <figcaption>{props.label}</figcaption>
                </figure>
            );
        };
    },
});

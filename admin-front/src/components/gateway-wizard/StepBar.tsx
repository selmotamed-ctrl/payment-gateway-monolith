import { defineComponent, type PropType, type VNodeChild } from "vue";

export type StepBarItem = {
    key: string;
    label: string;
};

export const StepBar = defineComponent({
    name: "StepBar",
    props: {
        modelValue: { type: Number, required: true },
        steps: { type: Array as PropType<StepBarItem[]>, required: true },
        ariaLabel: { type: String, default: "" },
        onSelect: { type: Function as PropType<(value: number) => void>, default: undefined },
    },
    setup(props) {
        return (): VNodeChild => (
            <nav
                aria-label={props.ariaLabel || undefined}
                style={{
                    display: "flex",
                    alignItems: "stretch",
                    gap: "2px",
                    overflowX: "auto",
                    borderBottom: "1px solid var(--pg-border-subtle)",
                }}
            >
                {props.steps.map((item, index) => {
                    const value = index + 1;
                    const active = value === props.modelValue;
                    const complete = value < props.modelValue;
                    return (
                        <button
                            key={item.key}
                            type="button"
                            aria-current={active ? "step" : undefined}
                            onClick={() => props.onSelect?.(value)}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "8px",
                                minHeight: "46px",
                                padding: "10px 14px",
                                border: "none",
                                borderBottom: active
                                    ? "2px solid var(--pg-accent-interactive)"
                                    : "2px solid transparent",
                                marginBottom: "-1px",
                                background: "transparent",
                                color: active || complete ? "var(--pg-ink-primary)" : "var(--pg-ink-muted)",
                                cursor: "pointer",
                                whiteSpace: "nowrap",
                                fontFamily: "inherit",
                                fontSize: "12.5px",
                                fontWeight: active ? 600 : 500,
                            }}
                        >
                            <span
                                class="pg-tabular"
                                aria-hidden="true"
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: "22px",
                                    height: "22px",
                                    flex: "0 0 auto",
                                    borderRadius: "var(--pg-radius-xs)",
                                    border: `1px solid ${active ? "var(--pg-accent-interactive)" : "var(--pg-border-subtle)"}`,
                                    backgroundColor: active
                                        ? "var(--pg-accent-interactive-soft)"
                                        : complete
                                          ? "var(--pg-status-success-bg)"
                                          : "var(--pg-bg-surface-subtle)",
                                    color: active
                                        ? "var(--pg-accent-interactive)"
                                        : complete
                                          ? "var(--pg-status-success-text)"
                                          : "var(--pg-ink-muted)",
                                    fontSize: "11px",
                                    fontWeight: 600,
                                }}
                            >
                                {value}
                            </span>
                            <span>{item.label}</span>
                        </button>
                    );
                })}
            </nav>
        );
    },
});

export default StepBar;

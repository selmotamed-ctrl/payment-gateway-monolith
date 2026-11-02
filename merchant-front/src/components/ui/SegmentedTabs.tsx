import { defineComponent, type PropType, type VNodeChild } from "vue";

export interface SegmentedTab {
    value: string;
    label: string;
    count?: number;
}

export const SegmentedTabs = defineComponent({
    name: "SegmentedTabs",
    props: {
        modelValue: { type: String, required: true },
        tabs: { type: Array as PropType<SegmentedTab[]>, required: true },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        return (): VNodeChild => (
            <div
                role="tablist"
                aria-label="View"
                style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "2px",
                    height: "34px",
                    padding: "3px",
                    borderRadius: "var(--pg-radius-sm)",
                    backgroundColor: "var(--pg-bg-surface-subtle)",
                    border: "1px solid var(--pg-border-subtle)",
                    maxWidth: "100%",
                    overflowX: "auto",
                }}
            >
                {props.tabs.map((tab) => {
                    const active = tab.value === props.modelValue;
                    return (
                        <button
                            key={tab.value}
                            type="button"
                            role="tab"
                            aria-selected={active ? "true" : "false"}
                            onClick={() => emit("update:modelValue", tab.value)}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                height: "26px",
                                padding: "0 10px",
                                border: active ? "1px solid var(--pg-border-subtle)" : "1px solid transparent",
                                borderRadius: "var(--pg-radius-xs)",
                                backgroundColor: active ? "var(--pg-bg-surface)" : "transparent",
                                color: active ? "var(--pg-ink-primary)" : "var(--pg-ink-muted)",
                                boxShadow: active ? "var(--pg-shadow-xs)" : "none",
                                fontSize: "12.5px",
                                fontWeight: active ? 600 : 500,
                                cursor: "pointer",
                                whiteSpace: "nowrap",
                                fontFamily: "inherit",
                            }}
                        >
                            {tab.label}
                            {tab.count !== undefined && (
                                <span
                                    class="pg-tabular"
                                    style={{
                                        fontSize: "11px",
                                        color: active ? "var(--pg-ink-secondary)" : "var(--pg-ink-faint)",
                                    }}
                                >
                                    {tab.count}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        );
    },
});

export default SegmentedTabs;

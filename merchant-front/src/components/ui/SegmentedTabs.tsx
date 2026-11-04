import { defineComponent, useId, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";

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
        ariaLabel: { type: String, default: "" },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const baseId = useId();
        const select = (index: number) => {
            const tab = props.tabs[index];
            if (!tab) return;
            emit("update:modelValue", tab.value);
            requestAnimationFrame(() => document.getElementById(`${baseId}-${index}`)?.focus());
        };
        const onKeydown = (event: KeyboardEvent, index: number) => {
            // In RTL the visual "next" tab is to the left, so the horizontal arrows swap.
            // Read the rendered direction so an LTR island inside an RTL page still works.
            const target = event.currentTarget as HTMLElement | null;
            const rtl = !!target && getComputedStyle(target).direction === "rtl";
            const nextKey = rtl ? "ArrowLeft" : "ArrowRight";
            const prevKey = rtl ? "ArrowRight" : "ArrowLeft";
            if (event.key === nextKey || event.key === "ArrowDown") {
                event.preventDefault();
                select((index + 1) % props.tabs.length);
            } else if (event.key === prevKey || event.key === "ArrowUp") {
                event.preventDefault();
                select((index - 1 + props.tabs.length) % props.tabs.length);
            } else if (event.key === "Home") {
                event.preventDefault();
                select(0);
            } else if (event.key === "End") {
                event.preventDefault();
                select(props.tabs.length - 1);
            }
        };
        return (): VNodeChild => (
            <div
                role="tablist"
                aria-label={props.ariaLabel || t("View")}
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
                {props.tabs.map((tab, index) => {
                    const active = tab.value === props.modelValue;
                    return (
                        <button
                            key={tab.value}
                            id={`${baseId}-${index}`}
                            type="button"
                            role="tab"
                            class="pg-segmented-tab"
                            aria-selected={active ? "true" : "false"}
                            tabindex={active ? 0 : -1}
                            onClick={() => emit("update:modelValue", tab.value)}
                            onKeydown={(event: KeyboardEvent) => onKeydown(event, index)}
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

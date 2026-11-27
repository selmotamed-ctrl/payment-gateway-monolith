import { useId } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";

export interface SegmentedTab {
    value: string;
    label: string;
    count?: number;
    disabled?: boolean;
}

/** Pill-track sliding tab switcher (WAI-ARIA tablist, RTL arrow keys). */
export const PgSegmentedTabs = dc(
    (
        props: { modelValue: string; tabs: SegmentedTab[]; ariaLabel?: string },
        _expose,
        { emit, slots },
    ) => {
        const { t } = useLocale();
        const baseId = useId();
        const selectAt = (index: number) => {
            const tab = props.tabs?.[index];
            if (!tab || tab.disabled) return;
            emit?.("update:modelValue", tab.value);
            requestAnimationFrame(() => document.getElementById(`${baseId}-${index}`)?.focus());
        };
        const onKeydown = (event: KeyboardEvent, index: number) => {
            const length = props.tabs?.length ?? 0;
            if (!length) return;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                selectAt((index + 1) % length);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                selectAt((index - 1 + length) % length);
            } else if (event.key === "Home") {
                event.preventDefault();
                selectAt(0);
            } else if (event.key === "End") {
                event.preventDefault();
                selectAt(length - 1);
            }
        };

        return () => (
            <div
                role="tablist"
                aria-label={props.ariaLabel || t("View")}
                class="pg-segmented"
            >
                {props.tabs?.map((tab, index) => {
                    const active = tab.value === props.modelValue;
                    return (
                        <button
                            key={tab.value}
                            id={`${baseId}-${index}`}
                            type="button"
                            role="tab"
                            class={["pg-segmented__tab", active ? "pg-segmented__tab--active" : ""]}
                            aria-selected={active ? "true" : "false"}
                            disabled={tab.disabled}
                            tabindex={active ? 0 : -1}
                            onClick={() => selectAt(index)}
                            onKeydown={(event: KeyboardEvent) => onKeydown(event, index)}
                        >
                            {tab.label}
                            {tab.count !== undefined && <span class="pg-segmented__count pg-tabular">{tab.count}</span>}
                        </button>
                    );
                })}
                {slots.default?.()}
            </div>
        );
    },
    {
        props: {
            modelValue: { type: String, required: true },
            tabs: { type: Array as () => SegmentedTab[], default: () => [] },
            ariaLabel: { type: String, default: "" },
        },
        emits: ["update:modelValue"],
    },
);

export const SegmentedTabs = PgSegmentedTabs;

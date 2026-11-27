import { computed, ref, useId } from "vue";
import { dc } from "../lib/dc";
import { isRtlLocale, useLocale } from "../lib/locale";
import { PgIcon } from "./PgIcon";

export interface SegmentedTab {
    value: string;
    label: string;
    count?: number;
    icon?: string;
    disabled?: boolean;
}

/**
 * Pill-track segmented control (WAI-ARIA tablist with roving focus).
 *
 * Left/Right arrows move to the next/previous enabled tab and are mirrored in
 * RTL; Home/End jump to the edges. Disabled segments are skipped. A numeric
 * `count` renders as a tabular pill beside the label.
 */
export const PgSegmentedTabs = dc(
    (
        props: { modelValue: string; tabs: SegmentedTab[]; ariaLabel?: string; size?: string },
        _expose,
        { emit, slots },
    ) => {
        const { t } = useLocale();
        const baseId = useId();
        const list = ref<HTMLElement | null>(null);
        const tabs = computed(() => props.tabs ?? []);
        const activeIndex = computed(() => {
            const index = tabs.value.findIndex((tab) => tab.value === props.modelValue);
            if (index >= 0) return index;
            return tabs.value.findIndex((tab) => !tab.disabled);
        });

        const focusTab = (index: number) => {
            const element = list.value?.querySelectorAll<HTMLElement>("[role='tab']")[index];
            element?.focus();
        };

        const selectAt = (index: number, focus = true) => {
            const tab = tabs.value[index];
            if (!tab || tab.disabled) return;
            if (focus) focusTab(index);
            emit?.("update:modelValue", tab.value);
        };

        const step = (from: number, direction: number): number => {
            const length = tabs.value.length;
            if (!length) return -1;
            for (let offset = 1; offset <= length; offset += 1) {
                const index = ((from + direction * offset) % length + length) % length;
                if (!tabs.value[index]?.disabled) return index;
            }
            return from;
        };

        const onKeydown = (event: KeyboardEvent, index: number) => {
            const length = tabs.value.length;
            if (!length) return;
            // In RTL the visual right arrow points at the logically previous tab.
            const documentRtl =
                typeof document !== "undefined" && document.documentElement.getAttribute("dir") === "rtl";
            const forward = isRtlLocale.value || documentRtl ? -1 : 1;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                selectAt(step(index, forward));
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                selectAt(step(index, -forward));
            } else if (event.key === "Home") {
                event.preventDefault();
                const first = tabs.value.findIndex((tab) => !tab.disabled);
                selectAt(first < 0 ? index : first);
            } else if (event.key === "End") {
                event.preventDefault();
                const last = [...tabs.value].reverse().findIndex((tab) => !tab.disabled);
                selectAt(last < 0 ? index : length - 1 - last);
            }
        };

        return () => {
            return (
                <div
                    ref={list}
                    role="tablist"
                    aria-label={props.ariaLabel || t("View")}
                    aria-orientation="horizontal"
                    class={["pg-segmented", props.size === "sm" ? "pg-segmented--sm" : "", props.size === "lg" ? "pg-segmented--lg" : ""]
                        .filter(Boolean)
                        .join(" ")}
                    data-pg-segmented
                >
                    {tabs.value.map((tab, index) => {
                        return (
                            <button
                                key={tab.value}
                                id={`${baseId}-tab-${index}`}
                                type="button"
                                role="tab"
                                class={[
                                    "pg-segmented__tab",
                                    index === activeIndex.value ? "pg-segmented__tab--active" : "",
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                                aria-selected={index === activeIndex.value ? "true" : "false"}
                                aria-disabled={tab.disabled ? "true" : undefined}
                                disabled={tab.disabled}
                                tabindex={index === activeIndex.value ? 0 : -1}
                                data-pg-tab={tab.value}
                                onClick={() => selectAt(index)}
                                onKeydown={(event: KeyboardEvent) => onKeydown(event, index)}
                            >
                                {tab.icon ? <PgIcon icon={tab.icon} size={15} /> : null}
                                <span class="pg-segmented__label">{tab.label}</span>
                                {tab.count !== undefined ? (
                                    <span class="pg-segmented__count pg-tabular">{tab.count}</span>
                                ) : null}
                            </button>
                        );
                    })}
                    {slots.default?.()}
                </div>
            );
        };
    },
    {
        props: {
            modelValue: { type: String, default: "" },
            tabs: { type: Array as () => SegmentedTab[], default: () => [] },
            ariaLabel: { type: String, default: "" },
            size: { type: String, default: "" },
        },
        emits: ["update:modelValue"],
        inheritAttrs: true,
    },
);

export const SegmentedTabs = PgSegmentedTabs;
export const VBtnToggle = PgSegmentedTabs;

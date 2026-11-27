import { ref, useId, watch, createSlot, type PropType } from "vue";
import { defineComponent } from "@/utils/dc";
import { useLocale } from "@/utils/vael-compat";
import { PgIcon, StatusChip, type StatusTone } from "@pg/ui";

export type SectionCommand = { id: number; open: boolean };

const readOpenState = (key: string | undefined, fallback: boolean): boolean => {
    if (!key || typeof window === "undefined") return fallback;
    try {
        const stored = window.sessionStorage.getItem(key);
        if (stored === "1") return true;
        if (stored === "0") return false;
    } catch {
        return fallback;
    }
    return fallback;
};

/**
 * Merchant-detail section. It sits directly on the page canvas (no nested card),
 * owns one header row (label left, count then chevron right) and a controlled
 * body padding. `flush` removes body padding for sections that only contain a
 * table; `command` lets the page expand/collapse every section at once.
 */
const CollapsibleSection = defineComponent({
    name: "CollapsibleSection",
    props: {
        title: { type: String, required: true },
        subtitle: { type: String, default: "" },
        defaultOpen: { type: Boolean, default: false },
        storageKey: { type: String, default: "" },
        count: { type: [Number, String], default: null },
        tone: { type: String as () => StatusTone | null, default: null },
        command: { type: Object as PropType<SectionCommand | null>, default: null },
        alwaysOpen: { type: Boolean, default: false },
        /** Table-only sections: no body padding, the table card is the surface. */
        flush: { type: Boolean, default: false },
    },
    setup(props, { slots }) {
        const { t } = useLocale();
        const uid = useId();
        const headerId = `${uid}-header`;
        const bodyId = `${uid}-body`;
        const open = ref(readOpenState(props.storageKey, props.defaultOpen));

        const persist = () => {
            if (!props.storageKey || typeof window === "undefined") return;
            try {
                window.sessionStorage.setItem(props.storageKey, open.value ? "1" : "0");
            } catch {
                return;
            }
        };

        watch(
            () => props.storageKey,
            () => {
                open.value = readOpenState(props.storageKey, props.defaultOpen);
            },
        );
        watch(open, persist);
        watch(
            () => props.command?.id,
            () => {
                if (props.command) open.value = props.command.open;
            },
        );
        const isOpen = () => props.alwaysOpen || open.value;

        return () => {
            return (
                <section class={["merchant-section", isOpen() ? "merchant-section--open" : ""]}>
                    <button
                        id={headerId}
                        type="button"
                        class="merchant-section__header"
                        aria-expanded={isOpen() ? "true" : "false"}
                        aria-controls={bodyId}
                        disabled={props.alwaysOpen}
                        onClick={() => {
                            if (!props.alwaysOpen) open.value = !open.value;
                        }}
                    >
                        <span class="merchant-section__heading">
                            <span class="merchant-section__title">{t(props.title)}</span>
                            {props.subtitle && <span class="merchant-section__subtitle">{t(props.subtitle)}</span>}
                        </span>
                        <span class="merchant-section__meta">
                            {props.count !== null && props.count !== "" && (
                                <StatusChip label={String(props.count)} tone={props.tone ?? "neutral"} size="small" />
                            )}
                            {!props.alwaysOpen && (
                                <PgIcon
                                    icon={isOpen() ? "mdi-chevron-down" : "mdi-chevron-right"}
                                    size={18}
                                    class="merchant-section__chevron"
                                />
                            )}
                        </span>
                    </button>
                    {isOpen() && (
                        <div id={bodyId} role="region" aria-labelledby={headerId} class={["merchant-section__body", props.flush ? "merchant-section__body--flush" : ""]}>
                            {createSlot("default")}
                        </div>
                    )}
                </section>
            );
        };
    },
});

export default CollapsibleSection;

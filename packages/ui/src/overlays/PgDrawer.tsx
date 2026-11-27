import { createIf } from "@vue/runtime-vapor";
import { computed, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { lockBodyScroll, useEscape, useFocusTrap } from "../lib/dom";
import { useLocale } from "../lib/locale";
import { PgIcon } from "../actions/PgIcon";

const openStack: symbol[] = [];
const STACK_BASE = 1100;
const STACK_STEP = 4;

/**
 * Slide-over inspector. Open drawers stack: the last opened is always on top,
 * which fixes the old Vuetify z-index inversion when a drawer opens a second
 * drawer.
 */
export const PgDrawer = dc(
    (props: Record<string, any>, _expose, { emit, slots }) => {
        const { t } = useLocale();
        const root = ref<HTMLElement | null>(null);
        const titleId = useId();
        const stackId = Symbol("pg-drawer");
        const zIndex = ref<number | undefined>(undefined);
        const active = computed(() => Boolean(props.modelValue));
        let releaseScroll: (() => void) | null = null;

        const leaveStack = () => {
            const at = openStack.indexOf(stackId);
            if (at >= 0) openStack.splice(at, 1);
        };
        watch(
            active,
            (open) => {
                if (open) {
                    leaveStack();
                    openStack.push(stackId);
                    zIndex.value = STACK_BASE + (openStack.length - 1) * STACK_STEP;
                    releaseScroll = lockBodyScroll();
                } else {
                    leaveStack();
                    zIndex.value = undefined;
                    releaseScroll?.();
                    releaseScroll = null;
                }
            },
            { immediate: true },
        );
        useFocusTrap(root, active);
        useEscape(() => emit?.("update:modelValue", false), active);

        return () => {
            if (!active.value) return null;
            return (

                    <div
                        class="pg-drawer-backdrop"
                        style={{ zIndex: zIndex.value }}
                        onPointerdown={(event: PointerEvent) => {
                            if (event.target === event.currentTarget) emit?.("update:modelValue", false);
                        }}
                    >
                        <aside
                            ref={root}
                            class={["pg-drawer", `pg-drawer--${props.size ?? "md"}`, props.class]}
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby={titleId}
                            tabindex={-1}
                            style={[{ width: props.width ? `min(100vw, ${props.width}px)` : undefined }, props.style]}
                        >
                            <div class="pg-drawer__header">
                                <div>
                                    <h2 id={titleId} class="pg-dialog__title">
                                        {props.title}
                                    </h2>
                                    {props.subtitle && <p class="pg-dialog__subtitle">{props.subtitle}</p>}
                                </div>
                                <div class="pg-inline" style={{ gap: "8px" }}>
                                    {slots.headerActions?.()}
                                    <button
                                        type="button"
                                        class="pg-icon-btn"
                                        aria-label={t("Close")}
                                        onClick={() => emit?.("update:modelValue", false)}
                                    >
                                        <PgIcon icon="mdi-close" size={18} />
                                    </button>
                                </div>
                            </div>
                            <div class="pg-drawer__body">{slots.default?.()}</div>
                            {slots.footer && <div class="pg-drawer__footer">{slots.footer()}</div>}
                        </aside>
                    </div>

);
        };
    },
    {
        props: {
            modelValue: { type: Boolean, default: false },
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            size: { type: String, default: "md" },
            width: { type: Number, default: undefined },
        },
        emits: ["update:modelValue"],
        slots: ["default", "footer", "headerActions"],
    },
);

export const SlideOverDrawer = PgDrawer;

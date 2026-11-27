import { nextTick, ref } from "vue";
import { dc } from "../lib/dc";
import { useClickOutside, useEscape } from "../lib/dom";

/**
 * Keyboard-navigable action menu. `activator` renders the trigger; the panel is
 * teleported and closes on Escape, outside pointerdown or a row click.
 */
export const PgMenu = dc(
    (props: { modelValue?: boolean; open?: boolean; location?: string; offset?: number }, _expose, { emit, slots }) => {
        const anchor = ref<HTMLElement | null>(null);
        const panel = ref<HTMLElement | null>(null);
        const internal = ref(Boolean(props.modelValue ?? props.open));
        const style = ref<Record<string, string>>({});
        const isOpen = () => (props.modelValue !== undefined ? Boolean(props.modelValue) : internal.value);
        const setOpen = (value: boolean) => {
            internal.value = value;
            emit?.("update:modelValue", value);
            emit?.("update:open", value);
        };
        const update = () => {
            const element = anchor.value;
            if (!element || typeof window === "undefined") return;
            const rect = element.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            const flip = spaceBelow < 240 && rect.top > spaceBelow;
            style.value = {
                position: "fixed",
                left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 240))}px`,
                top: flip ? "auto" : `${rect.bottom + (props.offset ?? 6)}px`,
                bottom: flip ? `${window.innerHeight - rect.top + (props.offset ?? 6)}px` : "auto",
                zIndex: "var(--pg-z-popover)",
            };
        };
        const openPanel = async () => {
            setOpen(true);
            await nextTick();
            update();
            const first = panel.value?.querySelector<HTMLElement>("button,a,[role='menuitem']");
            first?.focus();
        };
        const close = () => setOpen(false);
        useEscape(close, () => isOpen());
        useClickOutside([anchor, panel], close, () => isOpen());

        return () => (
            <span
                ref={anchor}
                class="pg-menu-anchor"
                onClick={(event: MouseEvent) => {
                    const target = event.target as HTMLElement;
                    if (target.closest("button,a,input,select,textarea,[role='menuitem']")) {
                        if (!target.closest("[data-pg-menu-trigger]")) return;
                    }
                    event.stopPropagation();
                    if (isOpen()) close();
                    else void openPanel();
                }}
            >
                <span data-pg-menu-trigger>{slots.activator?.({ props: {} })}</span>

                    {isOpen() && (
                        <div
                            ref={panel}
                            class="pg-menu-panel"
                            role="menu"
                            style={style.value}
                            onClick={() => close()}
                        >
                            {slots.default?.()}
                        </div>
                    )}

</span>
        );
    },
    {
        props: {
            modelValue: { type: Boolean, default: undefined },
            open: { type: Boolean, default: undefined },
            location: { type: String, default: "bottom" },
            offset: { type: Number, default: 6 },
        },
        emits: ["update:modelValue", "update:open"],
    },
);

export const VMenu = PgMenu;

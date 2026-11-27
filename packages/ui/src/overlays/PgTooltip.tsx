import { computed, nextTick, ref } from "vue";
import { dc } from "../lib/dc";
import { useClickOutside, useEscape } from "../lib/dom";

/**
 * Delayed hover/focus tooltip. Teleported, viewport-aware and never clipped by
 * a card's `overflow`.
 */
export const PgTooltip = dc(
    (props: { text?: string; content?: string; location?: string; maxWidth?: number; openDelay?: number }, _expose, { attrs, slots }) => {
        const anchor = ref<HTMLElement | null>(null);
        const panel = ref<HTMLElement | null>(null);
        const open = ref(false);
        const style = ref<Record<string, string>>({});
        let timer: ReturnType<typeof setTimeout> | undefined;

        const update = () => {
            const element = anchor.value;
            if (!element || typeof window === "undefined") return;
            const rect = element.getBoundingClientRect();
            const spaceAbove = rect.top;
            const above = props.location !== "bottom" && spaceAbove > 60;
            style.value = {
                position: "fixed",
                left: `${Math.min(Math.max(8, rect.left + rect.width / 2), window.innerWidth - 8)}px`,
                transform: "translateX(-50%)",
                top: above ? "auto" : `${rect.bottom + 6}px`,
                bottom: above ? `${window.innerHeight - rect.top + 6}px` : "auto",
                maxWidth: `${props.maxWidth ?? 360}px`,
                zIndex: "var(--pg-z-tooltip)",
            };
        };
        const show = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(async () => {
                open.value = true;
                await nextTick();
                update();
            }, props.openDelay ?? 280);
        };
        const hide = () => {
            if (timer) clearTimeout(timer);
            open.value = false;
        };
        useEscape(hide, open);
        useClickOutside([anchor, panel], hide, open);

        return () => (
            <span
                ref={anchor}
                class={["pg-tooltip-anchor", attrs.class].filter(Boolean).join(" ")}
                onMouseenter={show}
                onMouseleave={hide}
                onFocusin={show}
                onFocusout={hide}
            >
                {slots.default?.()}

                    {open.value && (
                        <span ref={panel} class="pg-tooltip" role="tooltip" style={style.value} onMouseenter={hide}>
                            {props.text || props.content}
                        </span>
                    )}

</span>
        );
    },
    {
        props: {
            text: { type: String, default: "" },
            content: { type: String, default: "" },
            location: { type: String, default: "top" },
            maxWidth: { type: Number, default: 360 },
            openDelay: { type: Number, default: 280 },
        },
        inheritAttrs: true,
    },
);

export const VTooltip = PgTooltip;

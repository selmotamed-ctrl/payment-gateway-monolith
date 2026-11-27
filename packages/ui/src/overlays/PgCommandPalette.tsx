import { createIf } from "@vue/runtime-vapor";
import { computed, nextTick, ref, watch } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { lockBodyScroll, useEscape, useFocusTrap } from "../lib/dom";
import { PgIcon } from "../actions/PgIcon";

/**
 * Bare command/search palette: 56px search header (magnifier + borderless input
 * + ESC badge) and a padded scrollable results list. No duplicate close button,
 * so nothing can overlap the input.
 */
export const PgCommandPalette = dc(
    (props: Record<string, any>, _expose, { emit, slots }) => {
        const { t } = useLocale();
        const root = ref<HTMLElement | null>(null);
        const input = ref<HTMLInputElement | null>(null);
        const query = ref("");
        const active = computed(() => Boolean(props.modelValue));
        let releaseScroll: (() => void) | null = null;

        watch(
            active,
            (open) => {
                if (open) {
                    releaseScroll = lockBodyScroll();
                    void nextTick(() => input.value?.focus());
                } else {
                    releaseScroll?.();
                    releaseScroll = null;
                }
            },
            { immediate: true },
        );
        useFocusTrap(root, active);
        const close = () => emit?.("update:modelValue", false);
        useEscape(close, active);

        return () => {
            if (!active.value) return null;
            return (

                    <div
                        class="pg-dialog-backdrop pg-command-backdrop"
                        onPointerdown={(event: PointerEvent) => {
                            if (event.target === event.currentTarget) close();
                        }}
                    >
                        <div
                            ref={root}
                            class="pg-command-palette"
                            role="dialog"
                            aria-modal="true"
                            aria-label={props.ariaLabel || t("Search")}
                            tabindex={-1}
                        >
                            <div class="pg-command-palette__search">
                                <PgIcon icon="mdi-magnify" size={20} color="muted" />
                                <input
                                    ref={input}
                                    class="pg-command-palette__input"
                                    value={query.value}
                                    placeholder={props.placeholder ?? t("Search…")}
                                    aria-label={props.ariaLabel || t("Search")}
                                    onInput={(event: Event) => {
                                        query.value = (event.target as HTMLInputElement).value;
                                        emit?.("update:query", query.value);
                                        emit?.("search", query.value);
                                    }}
                                    onKeydown={(event: KeyboardEvent) => {
                                        if (event.key === "Enter") emit?.("submit", query.value);
                                    }}
                                />
                                <kbd class="pg-kbd-badge">ESC</kbd>
                                {slots.actions?.()}
                            </div>
                            <div class="pg-command-palette__results" role="listbox">
                                {slots.default?.({ query: query.value })}
                            </div>
                            {slots.footer && <div class="pg-command-palette__footer">{slots.footer()}</div>}
                        </div>
                    </div>
                
);
        };
    },
    {
        props: {
            modelValue: { type: Boolean, default: false },
            placeholder: { type: String, default: "" },
            ariaLabel: { type: String, default: "" },
        },
        emits: ["update:modelValue", "update:query", "search", "submit"],
    },
);

export default PgCommandPalette;

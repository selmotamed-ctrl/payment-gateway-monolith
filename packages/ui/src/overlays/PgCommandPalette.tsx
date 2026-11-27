import { createIf } from "@vue/runtime-vapor";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { lockBodyScroll, useClickOutside, useEscape, useFocusTrap } from "../lib/dom";
import { PgIcon } from "../actions/PgIcon";
import { closeOverlay, openOverlay, subscribeOverlayOpen } from "../lib/overlayStack";

const ITEM_SELECTOR = '[role="option"], [role="menuitem"], [data-pg-command-item]';

/**
 * Bare, keyboard-first command palette (`Ctrl+K` global search and
 * `Ctrl+Shift+K` guide search).
 *
 * The 56px search header contains a magnifier, one borderless input and the ESC
 * badge — deliberately no close `×` button that could overlap the text. The
 * default slot receives `{ query }`; typing only emits `update:query`/`search`
 * and can never navigate. `Enter` emits `submit(query, activeIndex, item)` so
 * the host decides what the active row means.
 */
export const PgCommandPalette = dc(
    (props: Record<string, any>, expose, { attrs, emit, slots }) => {
        const { t } = useLocale();
        const root = ref<HTMLElement | null>(null);
        const input = ref<HTMLInputElement | null>(null);
        const results = ref<HTMLElement | null>(null);
        const listId = useId();
        const query = ref(String(props.query ?? ""));
        const activeIndex = ref(0);
        const visible = ref(Boolean(props.modelValue));
        let releaseScroll: (() => void) | null = null;
        let overlayId: string | null = null;

        watch(
            () => props.modelValue,
            (value) => {
                if (value !== undefined) visible.value = Boolean(value);
            },
        );
        watch(
            () => props.query,
            (value) => {
                if (value !== undefined) query.value = String(value);
            },
        );
        watch(query, (value) => {
            const element = input.value;
            if (element && element.value !== value) element.value = value;
        });

        const items = (): HTMLElement[] => {
            const list = results.value;
            if (!list) return [];
            return [...list.querySelectorAll<HTMLElement>(ITEM_SELECTOR)].filter(
                (item) => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true",
            );
        };

        const highlight = (index: number) => {
            const list = items();
            if (!list.length) {
                activeIndex.value = 0;
                return;
            }
            const next = Math.min(Math.max(0, index), list.length - 1);
            activeIndex.value = next;
            list.forEach((item, itemIndex) => {
                const active = itemIndex === next;
                item.classList.toggle("pg-command-palette__item--active", active);
                if (active) item.setAttribute("data-active", "true");
                else item.removeAttribute("data-active");
                if (item.getAttribute("role") === "option") {
                    item.setAttribute("aria-selected", active ? "true" : "false");
                }
                if (!item.id) item.id = `${listId}-item-${itemIndex}`;
            });
            const activeItem = list[next];
            if (activeItem?.id) input.value?.setAttribute("aria-activedescendant", activeItem.id);
            else input.value?.removeAttribute("aria-activedescendant");
        };

        const setQuery = (value: string) => {
            query.value = value;
            emit?.("update:query", value);
            emit?.("search", value);
            activeIndex.value = 0;
            void nextTick(() => highlight(0));
        };

        const currentInput = () => {
            const list = items();
            return list[activeIndex.value] ?? list[0] ?? null;
        };

        const close = () => {
            if (!visible.value) return;
            visible.value = false;
            emit?.("update:modelValue", false);
        };

        const submit = (event?: KeyboardEvent) => {
            event?.preventDefault();
            if (event?.isComposing) return;
            const item = currentInput();
            emit?.("submit", query.value, activeIndex.value, item);
        };

        expose?.({
            close,
            focus: () => input.value?.focus(),
            get query() {
                return query.value;
            },
        });

        watch(
            visible,
            (open, previous) => {
                if (open) {
                    releaseScroll = lockBodyScroll();
                    const id = openOverlay("palette", () => {
                        visible.value = false;
                        emit?.("update:modelValue", false);
                    });
                    overlayId = id;
                    void nextTick(() => {
                        input.value?.focus();
                        highlight(0);
                    });
                } else {
                    releaseScroll?.();
                    releaseScroll = null;
                    if (overlayId) closeOverlay(overlayId);
                    overlayId = null;
                    if (previous) void nextTick(() => emit?.("afterLeave"));
                }
            },
            { immediate: true },
        );

        // Observe the shared event too: an externally triggered drawer/palette
        // must never leave two navigation surfaces open at once.
        const stopObserving = subscribeOverlayOpen((detail) => {
            if (!overlayId || detail.id === overlayId || !visible.value) return;
            if (detail.kind === "palette" || detail.kind === "drawer") close();
        });

        useFocusTrap(root, visible);
        useEscape(
            (event) => {
                event?.stopPropagation?.();
                close();
            },
            visible,
        );
        useClickOutside([root], close, visible);
        onBeforeUnmount(() => {
            stopObserving();
            releaseScroll?.();
            if (overlayId) closeOverlay(overlayId);
            overlayId = null;
        });

        const onKeydown = (event: KeyboardEvent) => {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                highlight(activeIndex.value + 1);
                return;
            }
            if (event.key === "ArrowUp") {
                event.preventDefault();
                highlight(activeIndex.value - 1);
                return;
            }
            if (event.key === "Enter") submit(event);
        };

        const onResultsClick = (event: MouseEvent) => {
            const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(ITEM_SELECTOR);
            if (!target || !results.value?.contains(target)) return;
            const index = items().indexOf(target);
            if (index < 0) return;
            activeIndex.value = index;
            emit?.("activate", target, index);
            close();
        };

        return () =>
            branch(
                () => visible.value,
                () => (
                    <div class="pg-dialog-backdrop pg-command-backdrop">
                        <div
                            ref={root}
                            class={["pg-command-palette", attrs.class].filter(Boolean).join(" ")}
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
                                    placeholder={props.placeholder || t("Search")}
                                    aria-label={props.ariaLabel || t("Search")}
                                    role="combobox"
                                    aria-expanded="true"
                                    aria-controls={listId}
                                    aria-autocomplete="list"
                                    aria-activedescendant={currentInput()?.id || undefined}
                                    autocomplete="off"
                                    spellcheck={false}
                                    autofocus
                                    onInput={(event: Event) => {
                                        setQuery((event.target as HTMLInputElement).value);
                                    }}
                                    onKeydown={onKeydown}
                                />
                                <kbd class="pg-kbd-badge" aria-hidden="true">
                                    ESC
                                </kbd>
                                {slots.actions?.()}
                            </div>
                            <div
                                ref={results}
                                id={listId}
                                class="pg-command-palette__results"
                                role="listbox"
                                aria-label={props.ariaLabel || t("Search")}
                                onClick={onResultsClick}
                                onMousemove={(event: MouseEvent) => {
                                    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(ITEM_SELECTOR);
                                    if (!target || !results.value?.contains(target)) return;
                                    const index = items().indexOf(target);
                                    if (index >= 0 && index !== activeIndex.value) highlight(index);
                                }}
                            >
                                {slots.default?.({
                                    query: query.value,
                                })}
                            </div>
                            {slots.footer && <div class="pg-command-palette__footer">{slots.footer()}</div>}
                        </div>
                    </div>
                ),
            );
    },
    {
        props: {
            modelValue: { type: Boolean, default: false },
            query: { type: String, default: undefined },
            placeholder: { type: String, default: "" },
            ariaLabel: { type: String, default: "" },
        },
        emits: ["update:modelValue", "update:query", "search", "submit", "activate", "afterLeave"],
        slots: ["default", "actions", "footer"],
        inheritAttrs: true,
    },
);

export default PgCommandPalette;

import { createIf } from "@vue/runtime-vapor";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { dc } from "../../lib/dc";
import { useLocale } from "../../lib/locale";
import { PgIcon } from "../../actions/PgIcon";
import { adoptFloatingElement } from "../../lib/floatingLayer";

export interface RowActionItem {
    key: string;
    label: string;
    icon?: string;
    danger?: boolean;
    disabled?: boolean;
    hidden?: boolean;
    dividerBefore?: boolean;
    onClick: () => void | Promise<void>;
}

export interface RowPrimaryAction {
    label: string;
    icon?: string;
    disabled?: boolean;
    loading?: boolean;
    onClick: () => void | Promise<void>;
}

type MenuOwner = {
    close: () => void;
};

/**
 * The single open row menu across every table on the page. Opening row B closes
 * row A without moving focus away from the user's current row.
 */
let activeMenu: MenuOwner | null = null;

const NATIVE_MENU_TARGETS = "a, input, textarea, select, [contenteditable], [data-no-row-context-menu]";
const KEYBOARD_BLOCKERS = "input, textarea, select, [contenteditable]";

const matches = (target: EventTarget | null, selector: string): boolean =>
    target instanceof Element && Boolean((target as Element).closest?.(selector));

const PANEL_WIDTH = 210;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;
const ITEM_HEIGHT = 34;
const DIVIDER_HEIGHT = 11;
const PANEL_PADDING = 12;

/**
 * Row action cell: one subtle outlined primary action, a ghost `[...]` trigger,
 * and the same action list on right-click / `Shift+F10` / the ContextMenu key.
 *
 * The floating panel is pure Vapor (`createIf` + `position: fixed`); there is no
 * VDOM `Teleport`, so it mounts inside the table row yet floats above the scroll
 * container with the shared popover z-index.
 */
export const PgTableRowActions = dc(
    (props: { primaryAction?: RowPrimaryAction | null; items?: RowActionItem[]; contextMenu?: boolean }, _expose, { attrs }) => {
        const { t } = useLocale();
        const root = ref<HTMLElement | null>(null);
        const button = ref<HTMLButtonElement | null>(null);
        const panel = ref<HTMLElement | null>(null);
        const open = ref(false);
        const point = ref({ x: 0, y: 0 });
        const anchor = ref<"button" | "pointer">("button");
        const measuredHeight = ref(0);
        let row: HTMLElement | null = null;

        const visibleItems = computed(() => (props.items ?? []).filter((item) => !item.hidden));
        const items = () => visibleItems.value;

        const estimateHeight = (): number => {
            const content = items().reduce(
                (total, item) => total + ITEM_HEIGHT + (item.dividerBefore ? DIVIDER_HEIGHT : 0),
                PANEL_PADDING,
            );
            return Math.min(420, content);
        };

        const viewport = () => ({
            width: typeof window === "undefined" ? 1280 : window.innerWidth || 1280,
            height: typeof window === "undefined" ? 800 : window.innerHeight || 800,
        });

        const position = (): Record<string, string> => {
            const screen = viewport();
            const width = Math.min(PANEL_WIDTH, screen.width - VIEWPORT_MARGIN * 2);
            const height = measuredHeight.value || estimateHeight();
            let x = VIEWPORT_MARGIN;
            let y = VIEWPORT_MARGIN;

            if (anchor.value === "pointer") {
                x = point.value.x;
                y = point.value.y;
            } else {
                const rect = button.value?.getBoundingClientRect();
                x = rect?.left ?? VIEWPORT_MARGIN;
                y = (rect?.bottom ?? 0) + ANCHOR_GAP;
            }

            const left = Math.max(VIEWPORT_MARGIN, Math.min(x, screen.width - width - VIEWPORT_MARGIN));
            const flipsAbove = y + height > screen.height - VIEWPORT_MARGIN;
            const top = flipsAbove
                ? Math.max(VIEWPORT_MARGIN, y - height - ANCHOR_GAP)
                : Math.max(VIEWPORT_MARGIN, y);

            return {
                left: `${Math.round(left)}px`,
                top: `${Math.round(top)}px`,
                width: `${Math.round(width)}px`,
                maxHeight: `${Math.max(120, screen.height - VIEWPORT_MARGIN * 2)}px`,
            };
        };

        const close = (options?: { restoreFocus?: boolean }) => {
            open.value = false;
            measuredHeight.value = 0;
            if (activeMenu && activeMenu.close === close) activeMenu = null;
            if (options?.restoreFocus) button.value?.focus();
        };

        const show = async (source: "button" | "pointer", x = 0, y = 0) => {
            if (!items().length) return;
            if (activeMenu && activeMenu.close !== close) activeMenu.close();
            anchor.value = source;
            point.value = { x, y };
            measuredHeight.value = 0;
            open.value = true;
            activeMenu = { close };
            await nextTick();
            // Escape the sticky action cell's stacking context before measuring.
            adoptFloatingElement(panel.value);
            const height = panel.value?.getBoundingClientRect?.().height ?? panel.value?.offsetHeight ?? 0;
            if (height) measuredHeight.value = height;
            const first = panel.value?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])");
            first?.focus?.();
        };

        const run = async (item: RowActionItem) => {
            if (item.disabled) return;
            close();
            try {
                await item.onClick();
            } catch (error) {
                console.error(error);
            }
        };

        const onRowContextMenu = (event: MouseEvent) => {
            if (props.contextMenu === false) return;
            if (matches(event.target, NATIVE_MENU_TARGETS)) return;
            if (!items().length) return;
            event.preventDefault();
            void show("pointer", event.clientX, event.clientY);
        };

        const onRowKeydown = (event: KeyboardEvent) => {
            if (props.contextMenu === false) return;
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            if (matches(event.target, KEYBOARD_BLOCKERS)) return;
            if (!items().length) return;
            event.preventDefault();
            const rect = button.value?.getBoundingClientRect();
            const x = rect ? rect.left : VIEWPORT_MARGIN;
            const y = rect ? rect.bottom + ANCHOR_GAP : VIEWPORT_MARGIN;
            void show("pointer", x, y);
        };

        const onDocumentPointer = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (root.value?.contains(target) || panel.value?.contains(target)) return;
            close();
        };

        const onDocumentKeydown = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || !open.value) return;
            event.stopPropagation();
            close({ restoreFocus: true });
        };

        const onDocumentScroll = (event: Event) => {
            if (!open.value) return;
            // Scrolling an ancestor of the panel (for example Playwright's
            // scroll-into-view or the table wrapper) must not dismiss the menu.
            const target = event.target as Node | null;
            const own = root.value;
            if (target && panel.value?.contains(target)) return;
            if (target && own && (own.contains(target) || (target instanceof Element && target.contains(own)))) return;
            close();
        };

        const listen = (add: boolean) => {
            if (typeof document === "undefined") return;
            const method = add ? "addEventListener" : "removeEventListener";
            document[method]("pointerdown", onDocumentPointer as EventListener, true);
            document[method]("keydown", onDocumentKeydown as EventListener);
            document[method]("scroll", onDocumentScroll as EventListener, true);
        };

        watch(open, (isOpen) => listen(isOpen));

        watch(
            () => items().length,
            (length) => {
                if (open.value && length === 0) close();
            },
        );

        onMounted(() => {
            row = root.value?.closest?.("tr") ?? null;
            row?.addEventListener("contextmenu", onRowContextMenu);
            row?.addEventListener("keydown", onRowKeydown);
        });

        onBeforeUnmount(() => {
            row?.removeEventListener("contextmenu", onRowContextMenu);
            row?.removeEventListener("keydown", onRowKeydown);
            if (open.value) listen(false);
            if (activeMenu?.close === close) activeMenu = null;
        });

        return () => (
            <div {...attrs} ref={root} class={["pg-row-actions", attrs.class].filter(Boolean).join(" ")}>
                {props.primaryAction && (
                    <button
                        type="button"
                        class="pg-row-actions__primary"
                        disabled={props.primaryAction.disabled || props.primaryAction.loading}
                        aria-busy={props.primaryAction.loading ? "true" : undefined}
                        onClick={(event: MouseEvent) => {
                            event.stopPropagation();
                            if (props.primaryAction?.disabled || props.primaryAction?.loading) return;
                            void props.primaryAction?.onClick();
                        }}
                    >
                        {props.primaryAction.loading ? (
                            <span class="pg-btn__spinner pg-row-actions__spinner" aria-hidden="true" />
                        ) : (
                            props.primaryAction.icon && <PgIcon icon={props.primaryAction.icon} size={15} />
                        )}
                        <span class="pg-row-actions__label">{t(props.primaryAction.label)}</span>
                    </button>
                )}
                {items().length > 0 && (
                    <button
                        ref={button}
                        type="button"
                        class="pg-row-actions__more"
                        aria-label={t("Row actions")}
                        aria-haspopup="menu"
                        aria-expanded={open.value ? "true" : "false"}
                        onClick={(event: MouseEvent) => {
                            event.stopPropagation();
                            if (open.value) close();
                            else void show("button");
                        }}
                    >
                        <PgIcon icon="mdi-dots-horizontal" size={18} />
                    </button>
                )}
                {branch(
                    () => open.value,
                    () => (
                        <div
                            ref={panel}
                            class="pg-menu-panel pg-row-actions__panel"
                            role="menu"
                            aria-label={t("Row actions")}
                            style={position()}
                            onClick={(event: MouseEvent) => event.stopPropagation()}
                            onPointerdown={(event: PointerEvent) => event.stopPropagation()}
                        >
                            {props.primaryAction && (
                                <div class="pg-row-actions__item">
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class="pg-menu-item"
                                        disabled={props.primaryAction.disabled || props.primaryAction.loading}
                                        onClick={(event: MouseEvent) => {
                                            event.stopPropagation();
                                            if (props.primaryAction?.disabled || props.primaryAction?.loading) return;
                                            close();
                                            void props.primaryAction?.onClick();
                                        }}
                                    >
                                        {props.primaryAction.icon && <PgIcon icon={props.primaryAction.icon} size={16} />}
                                        <span class="pg-row-actions__item-label">{t(props.primaryAction.label)}</span>
                                    </button>
                                </div>
                            )}
                            {items().map((item) => (
                                <div key={item.key} class="pg-row-actions__item">
                                    {item.dividerBefore && <div class="pg-menu-divider" role="separator" />}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class={["pg-menu-item", item.danger ? "pg-menu-item--danger" : ""]
                                            .filter(Boolean)
                                            .join(" ")}
                                        disabled={item.disabled}
                                        onClick={(event: MouseEvent) => {
                                            event.stopPropagation();
                                            void run(item);
                                        }}
                                    >
                                        {item.icon && <PgIcon icon={item.icon} size={16} />}
                                        <span class="pg-row-actions__item-label">{t(item.label)}</span>
                                    </button>
                                </div>
                            ))}
                        </div>
                    ),
                )}
            </div>
        );
    },
    {
        props: {
            primaryAction: { type: Object as () => RowPrimaryAction | null, default: null },
            items: { type: Array as () => RowActionItem[], default: () => [] },
            contextMenu: { type: Boolean, default: true },
        },
        inheritAttrs: true,
    },
);

export const TableRowActions = PgTableRowActions;

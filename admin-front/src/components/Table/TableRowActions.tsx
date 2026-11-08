import {
    computed,
    defineComponent,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    type PropType,
    type VNodeChild,
} from "vue";
import { VIcon, VMenu } from "vuetify/components";
import { useLocale } from "vuetify";

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

type MenuCloser = () => void;

/**
 * One row menu at a time. The small `…` menu and the right-click menu share
 * this coordinator, so opening either closes whatever menu was open before.
 */
let activeMenuCloser: MenuCloser | null = null;

const closeActiveMenu = (): void => {
    const closer = activeMenuCloser;
    activeMenuCloser = null;
    closer?.();
};

/** The first `TableRowActions` in a row owns the row context menu. */
const rowOwners = new WeakMap<HTMLElement, symbol>();

const EDITABLE_TARGETS =
    'input, textarea, select, [contenteditable="true"], .v-field, .v-checkbox, .v-switch, .v-radio, .v-slider';
const NATIVE_MENU_TARGETS = `${EDITABLE_TARGETS}, a, [data-no-row-context-menu]`;

const matchesTarget = (target: EventTarget | null, selector: string): boolean =>
    target instanceof Element && Boolean(target.closest(selector));

/**
 * Vuetify's `VMenu` finds its activator through `activatorProps.ref` (a function ref). A second `ref` on the same
 * element, written before or after the spread of `activatorProps`, REPLACES that one and the menu then has no anchor
 * (it opened at the top-left of the page). This sets both: the component's own ref and Vuetify's.
 */
const composeActivatorRef =
    (own: { value: HTMLElement | null }, vuetifyRef: unknown) =>
    (element: unknown): void => {
        own.value = element instanceof HTMLElement ? element : null;
        if (typeof vuetifyRef === "function") {
            (vuetifyRef as (target: unknown) => void)(element);
        }
    };

const MENU_PANEL_STYLE = {
    minWidth: "184px",
    maxHeight: "min(70vh, 420px)",
    overflowY: "auto",
    overscrollBehavior: "contain",
    padding: "4px",
    backgroundColor: "var(--pg-bg-surface)",
    border: "1px solid var(--pg-border-subtle)",
    borderRadius: "var(--pg-radius-md)",
    boxShadow: "var(--pg-shadow-menu)",
    display: "flex",
    flexDirection: "column",
    gap: "1px",
} as const;

const MENU_DIVIDER_STYLE = {
    height: "1px",
    backgroundColor: "var(--pg-border-subtle)",
    margin: "4px 2px",
} as const;

const itemButtonStyle = (danger: boolean | undefined, disabled: boolean | undefined) => ({
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    height: "32px",
    padding: "0 10px",
    borderRadius: "var(--pg-radius-xs)",
    backgroundColor: "transparent",
    border: "none",
    fontSize: "12.5px",
    fontWeight: 500,
    color: danger ? "var(--pg-status-danger-text)" : "var(--pg-ink-primary)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
    textAlign: "start" as const,
    fontFamily: "inherit",
});

export const TableRowActions = defineComponent({
    name: "TableRowActions",
    props: {
        primaryAction: { type: Object as PropType<RowPrimaryAction | null>, default: null },
        items: { type: Array as PropType<RowActionItem[]>, default: () => [] },
        /** Right-click and Shift+F10 on the row open the same actions. */
        contextMenu: { type: Boolean, default: true },
    },
    setup(props) {
        const { t } = useLocale();
        const root = ref<HTMLElement | null>(null);
        const actionsButton = ref<HTMLButtonElement | null>(null);
        const primaryButton = ref<HTMLButtonElement | null>(null);
        const contextActivator = ref<HTMLElement | null>(null);
        const buttonMenuOpen = ref(false);
        const contextOpen = ref(false);
        const contextPoint = ref({ x: 0, y: 0 });
        const owner = Symbol("pg-row-actions");
        let boundRow: HTMLElement | null = null;

        const visibleItems = computed(() => (props.items ?? []).filter((item) => !item.hidden));
        const primaryMenuItem = computed<RowActionItem | null>(() => {
            const primary = props.primaryAction;
            if (!primary) {
                return null;
            }
            return {
                key: "__primary",
                label: primary.label,
                icon: primary.icon,
                disabled: primary.disabled || primary.loading,
                onClick: primary.onClick,
            };
        });
        const hasContextItems = computed(() => Boolean(primaryMenuItem.value) || visibleItems.value.length > 0);

        const closeButtonMenu = (): void => {
            buttonMenuOpen.value = false;
            if (activeMenuCloser === closeButtonMenu) {
                activeMenuCloser = null;
            }
        };

        const onWindowEscape = (event: KeyboardEvent): void => {
            if (event.key !== "Escape" || !contextOpen.value) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            closeContextMenu();
            restoreFocus();
        };

        const removeEscapeListener = (): void => {
            window.removeEventListener("keydown", onWindowEscape, true);
        };

        const closeContextMenu = (): void => {
            contextOpen.value = false;
            removeEscapeListener();
            if (activeMenuCloser === closeContextMenu) {
                activeMenuCloser = null;
            }
        };

        const restoreFocus = (): void => {
            const active = document.activeElement as HTMLElement | null;
            const inOverlay = Boolean(active?.closest?.(".v-overlay-container"));
            if (!active || active === document.body || inOverlay || active === contextActivator.value) {
                (actionsButton.value ?? primaryButton.value)?.focus({ preventScroll: true });
            }
        };

        const focusFirstContextItem = (): void => {
            // Language-agnostic: the accessible name is translated in RTL.
            const panels = document.querySelectorAll<HTMLElement>('.v-menu.v-overlay--active [role="menu"]');
            const panel = panels[panels.length - 1];
            panel?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
        };

        const openContextAt = (x: number, y: number): void => {
            if (!hasContextItems.value) {
                return;
            }
            closeActiveMenu();
            buttonMenuOpen.value = false;
            contextPoint.value = { x, y };
            void nextTick(() => {
                contextOpen.value = true;
                activeMenuCloser = closeContextMenu;
                // Escape must close the menu even when focus stayed on the row
                // (or another overlay owns the Vuetify global-top flag).
                window.addEventListener("keydown", onWindowEscape, true);
                // Move keyboard focus into the menu so arrows work.
                window.requestAnimationFrame(focusFirstContextItem);
            });
        };

        const onRowContextMenu = (event: MouseEvent): void => {
            if (!props.contextMenu || !hasContextItems.value) {
                return;
            }
            if (event.defaultPrevented || matchesTarget(event.target, NATIVE_MENU_TARGETS)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            openContextAt(event.clientX, event.clientY);
        };

        const onRowKeydown = (event: KeyboardEvent): void => {
            if (event.key === "Escape" && contextOpen.value) {
                event.preventDefault();
                event.stopPropagation();
                closeContextMenu();
                restoreFocus();
                return;
            }
            if (!props.contextMenu || !hasContextItems.value) {
                return;
            }
            const isContextKey = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
            if (!isContextKey || matchesTarget(event.target, EDITABLE_TARGETS)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const row = boundRow;
            if (!row) {
                return;
            }
            const anchor = row.querySelector<HTMLElement>(".pg-col-actions") ?? row;
            const rect = anchor.getBoundingClientRect();
            const rtl = getComputedStyle(row).direction === "rtl";
            openContextAt(rtl ? rect.left + 8 : rect.right - 8, rect.top + Math.min(rect.height / 2, 20));
        };

        onMounted(() => {
            if (!props.contextMenu) {
                return;
            }
            const row = root.value?.closest("tr") as HTMLElement | null;
            if (!row || rowOwners.has(row)) {
                return;
            }
            rowOwners.set(row, owner);
            boundRow = row;
            row.addEventListener("contextmenu", onRowContextMenu);
            row.addEventListener("keydown", onRowKeydown);
        });

        onBeforeUnmount(() => {
            if (boundRow) {
                boundRow.removeEventListener("contextmenu", onRowContextMenu);
                boundRow.removeEventListener("keydown", onRowKeydown);
                if (rowOwners.get(boundRow) === owner) {
                    rowOwners.delete(boundRow);
                }
                boundRow = null;
            }
            removeEscapeListener();
            if (activeMenuCloser === closeButtonMenu || activeMenuCloser === closeContextMenu) {
                activeMenuCloser = null;
            }
        });

        const renderMenuItem = (item: RowActionItem, close: () => void): JSX.Element => (
            <div key={item.key}>
                {item.dividerBefore && <div role="separator" style={MENU_DIVIDER_STYLE} />}
                <button
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={(event: MouseEvent) => {
                        event.stopPropagation();
                        close();
                        void item.onClick();
                    }}
                    style={itemButtonStyle(item.danger, item.disabled)}
                >
                    {item.icon && (
                        <VIcon
                            icon={item.icon}
                            size={15}
                            style={{
                                color: item.danger ? "var(--pg-status-danger-text)" : "var(--pg-ink-muted)",
                            }}
                        />
                    )}
                    <span>{item.label}</span>
                </button>
            </div>
        );

        const renderMenuPanel = (
            primary: RowActionItem | null,
            items: RowActionItem[],
            close: () => void,
        ): JSX.Element => (
            <div
                role="menu"
                aria-label={t("Row actions")}
                style={MENU_PANEL_STYLE}
                onClick={(event: MouseEvent) => event.stopPropagation()}
            >
                {primary && renderMenuItem(primary, close)}
                {primary && items.length > 0 && <div role="separator" style={MENU_DIVIDER_STYLE} />}
                {items.map((item, index) =>
                    renderMenuItem(
                        primary && index === 0 && item.dividerBefore ? { ...item, dividerBefore: false } : item,
                        close,
                    ),
                )}
            </div>
        );

        return (): VNodeChild => {
            const visible = visibleItems.value;
            return (
                <div
                    ref={root}
                    onClick={(event: MouseEvent) => event.stopPropagation()}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "flex-end",
                        gap: "6px",
                        height: "28px",
                        whiteSpace: "nowrap",
                    }}
                >
                    {props.primaryAction && (
                        <button
                            ref={primaryButton}
                            type="button"
                            disabled={props.primaryAction.disabled || props.primaryAction.loading}
                            onClick={() => void props.primaryAction?.onClick()}
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "5px",
                                height: "26px",
                                padding: "0 10px",
                                borderRadius: "var(--pg-radius-sm)",
                                backgroundColor: "var(--pg-bg-surface)",
                                color: "var(--pg-ink-primary)",
                                border: "1px solid var(--pg-border-strong)",
                                fontSize: "12px",
                                fontWeight: 500,
                                lineHeight: 1,
                                cursor: props.primaryAction.disabled ? "not-allowed" : "pointer",
                                opacity: props.primaryAction.disabled ? 0.5 : 1,
                                boxShadow: "var(--pg-shadow-xs)",
                                fontFamily: "inherit",
                            }}
                        >
                            {props.primaryAction.icon && <VIcon icon={props.primaryAction.icon} size={13} />}
                            <span>{props.primaryAction.label}</span>
                        </button>
                    )}
                    {visible.length > 0 && (
                        <VMenu
                            modelValue={buttonMenuOpen.value}
                            onUpdate:modelValue={(value: boolean) => {
                                if (value) {
                                    closeActiveMenu();
                                    buttonMenuOpen.value = true;
                                    activeMenuCloser = closeButtonMenu;
                                } else {
                                    closeButtonMenu();
                                }
                            }}
                            location="bottom end"
                            offset={4}
                        >
                            {{
                                activator: ({ props: activatorProps }: { props: Record<string, unknown> }) => (
                                    <button
                                        type="button"
                                        {...activatorProps}
                                        ref={composeActivatorRef(actionsButton, activatorProps.ref)}
                                        aria-label={t("Row actions")}
                                        aria-keyshortcuts="Shift+F10"
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            width: "26px",
                                            height: "26px",
                                            borderRadius: "var(--pg-radius-sm)",
                                            backgroundColor: buttonMenuOpen.value
                                                ? "var(--pg-bg-surface-subtle)"
                                                : "transparent",
                                            color: "var(--pg-ink-secondary)",
                                            border: buttonMenuOpen.value
                                                ? "1px solid var(--pg-border-subtle)"
                                                : "1px solid transparent",
                                            cursor: "pointer",
                                        }}
                                    >
                                        <VIcon icon="mdi-dots-horizontal" size={16} />
                                    </button>
                                ),
                                default: () => renderMenuPanel(null, visible, closeButtonMenu),
                            }}
                        </VMenu>
                    )}
                    {props.contextMenu && hasContextItems.value && (
                        <VMenu
                            modelValue={contextOpen.value}
                            onUpdate:modelValue={(value: boolean) => {
                                contextOpen.value = value;
                                if (!value) {
                                    removeEscapeListener();
                                    if (activeMenuCloser === closeContextMenu) {
                                        activeMenuCloser = null;
                                    }
                                    restoreFocus();
                                }
                            }}
                            location="bottom start"
                            offset={4}
                        >
                            {{
                                activator: ({ props: activatorProps }: { props: Record<string, unknown> }) => (
                                    <span
                                        {...activatorProps}
                                        ref={composeActivatorRef(contextActivator, activatorProps.ref)}
                                        aria-hidden="true"
                                        tabindex={-1}
                                        style={{
                                            position: "fixed",
                                            left: `${contextPoint.value.x}px`,
                                            top: `${contextPoint.value.y}px`,
                                            width: "0px",
                                            height: "0px",
                                            pointerEvents: "none",
                                        }}
                                    />
                                ),
                                default: () => renderMenuPanel(primaryMenuItem.value, visible, closeContextMenu),
                            }}
                        </VMenu>
                    )}
                </div>
            );
        };
    },
});

export default TableRowActions;

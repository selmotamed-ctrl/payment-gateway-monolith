import { computed, nextTick, onBeforeUnmount, onMounted, ref, Teleport } from "vue";
import { dc } from "../../lib/dc";
import { useLocale } from "../../lib/locale";
import { PgIcon } from "../../actions/PgIcon";

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

type MenuState = {
    row: HTMLElement;
    close: () => void;
} | null;

let activeMenu: MenuState = null;

const EDITABLE_TARGETS =
    "input, textarea, select, [contenteditable='true'], .pg-control-box, .pg-checkbox-field, .pg-switch-field";
const NATIVE_MENU_TARGETS = `${EDITABLE_TARGETS}, a, [data-no-row-context-menu]`;

const matches = (target: EventTarget | null, selector: string): boolean =>
    target instanceof Element && Boolean(target.closest(selector));

/**
 * Shared row action cell. The primary action is visible; the overflow menu and a
 * right-click / Shift+F10 on the row open the same action list. Only one row menu
 * is open at a time and Escape closes it.
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
        let row: HTMLElement | null = null;

        const visibleItems = computed(() => (props.items ?? []).filter((item) => !item.hidden));

        const close = () => {
            open.value = false;
            if (activeMenu?.close === close) activeMenu = null;
        };

        const position = () => {
            const width = 210;
            const height = Math.min(420, visibleItems.value.length * 34 + 12);
            const x = anchor.value === "pointer" ? point.value.x : button.value?.getBoundingClientRect().left ?? 0;
            const y = anchor.value === "pointer" ? point.value.y : (button.value?.getBoundingClientRect().bottom ?? 0) + 6;
            const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
            const top = y + height > window.innerHeight - 8 ? Math.max(8, y - height - 6) : y;
            return { left: `${left}px`, top: `${top}px`, width: `${width}px` };
        };

        const show = async (source: "button" | "pointer", x = 0, y = 0) => {
            if (!visibleItems.value.length) return;
            if (activeMenu && activeMenu.close !== close) activeMenu.close();
            anchor.value = source;
            point.value = { x, y };
            open.value = true;
            activeMenu = { row: row ?? root.value ?? document.body, close };
            await nextTick();
            const first = panel.value?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)");
            first?.focus();
        };

        const run = async (item: RowActionItem) => {
            if (item.disabled) return;
            close();
            await item.onClick();
        };

        const onRowContextMenu = (event: MouseEvent) => {
            if (props.contextMenu === false) return;
            if (matches(event.target, NATIVE_MENU_TARGETS)) return;
            if (!visibleItems.value.length) return;
            event.preventDefault();
            void show("pointer", event.clientX, event.clientY);
        };
        const onRowKeydown = (event: KeyboardEvent) => {
            if (props.contextMenu === false) return;
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            if (matches(event.target, EDITABLE_TARGETS)) return;
            event.preventDefault();
            const rect = button.value?.getBoundingClientRect();
            void show("pointer", rect?.left ?? 0, (rect?.bottom ?? 0) + 6);
        };
        const onDocumentPointer = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (root.value?.contains(target) || panel.value?.contains(target)) return;
            close();
        };
        const onDocumentKeydown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && open.value) {
                close();
                button.value?.focus();
            }
        };

        onMounted(() => {
            row = root.value?.closest("tr") ?? null;
            row?.addEventListener("contextmenu", onRowContextMenu);
            row?.addEventListener("keydown", onRowKeydown);
            document.addEventListener("pointerdown", onDocumentPointer, true);
            document.addEventListener("keydown", onDocumentKeydown);
        });
        onBeforeUnmount(() => {
            row?.removeEventListener("contextmenu", onRowContextMenu);
            row?.removeEventListener("keydown", onRowKeydown);
            document.removeEventListener("pointerdown", onDocumentPointer, true);
            document.removeEventListener("keydown", onDocumentKeydown);
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
                        onClick={() => void props.primaryAction?.onClick()}
                    >
                        {props.primaryAction.loading && <span class="pg-btn__spinner" aria-hidden="true" />}
                        {props.primaryAction.icon && <PgIcon icon={props.primaryAction.icon} size={15} />}
                        <span>{t(props.primaryAction.label)}</span>
                    </button>
                )}
                {visibleItems.value.length > 0 && (
                    <button
                        ref={button}
                        type="button"
                        class="pg-row-actions__more"
                        aria-label={t("More actions")}
                        aria-haspopup="menu"
                        aria-expanded={open.value ? "true" : "false"}
                        onClick={() => (open.value ? close() : void show("button"))}
                    >
                        <PgIcon icon="mdi-dots-horizontal" size={18} />
                    </button>
                )}
                <Teleport to="body">
                    {open.value && (
                        <div ref={panel} class="pg-menu-panel pg-row-actions__panel" role="menu" style={position()}>
                            {visibleItems.value.map((item) => (
                                <div key={item.key}>
                                    {item.dividerBefore && <div class="pg-menu-divider" role="separator" />}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class={["pg-menu-item", item.danger ? "pg-menu-item--danger" : ""]}
                                        disabled={item.disabled}
                                        onClick={() => void run(item)}
                                    >
                                        {item.icon && <PgIcon icon={item.icon} size={16} />}
                                        <span>{t(item.label)}</span>
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </Teleport>
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

import { defineComponent, ref, type PropType, type VNodeChild } from "vue";
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

export const TableRowActions = defineComponent({
    name: "TableRowActions",
    props: {
        primaryAction: { type: Object as PropType<RowPrimaryAction | null>, default: null },
        items: { type: Array as PropType<RowActionItem[]>, default: () => [] },
    },
    setup(props) {
        const { t } = useLocale();
        const menuOpen = ref(false);
        return (): VNodeChild => {
            const visibleItems = (props.items ?? []).filter((item) => !item.hidden);
            return (
                <div
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
                    {visibleItems.length > 0 && (
                        <VMenu
                            modelValue={menuOpen.value}
                            onUpdate:modelValue={(value: boolean) => (menuOpen.value = value)}
                            location="bottom end"
                            offset={4}
                        >
                            {{
                                activator: ({ props: activatorProps }: { props: Record<string, unknown> }) => (
                                    <button
                                        type="button"
                                        {...activatorProps}
                                        aria-label={t("Row actions")}
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            width: "26px",
                                            height: "26px",
                                            borderRadius: "var(--pg-radius-sm)",
                                            backgroundColor: menuOpen.value ? "var(--pg-bg-surface-subtle)" : "transparent",
                                            color: "var(--pg-ink-secondary)",
                                            border: menuOpen.value
                                                ? "1px solid var(--pg-border-subtle)"
                                                : "1px solid transparent",
                                            cursor: "pointer",
                                        }}
                                    >
                                        <VIcon icon="mdi-dots-horizontal" size={16} />
                                    </button>
                                ),
                                default: () => (
                                    <div
                                        style={{
                                            minWidth: "184px",
                                            padding: "4px",
                                            backgroundColor: "var(--pg-bg-surface)",
                                            border: "1px solid var(--pg-border-subtle)",
                                            borderRadius: "var(--pg-radius-md)",
                                            boxShadow: "var(--pg-shadow-menu)",
                                            display: "flex",
                                            flexDirection: "column",
                                            gap: "1px",
                                        }}
                                    >
                                        {visibleItems.map((item) => (
                                            <div key={item.key}>
                                                {item.dividerBefore && (
                                                    <div
                                                        style={{
                                                            height: "1px",
                                                            backgroundColor: "var(--pg-border-subtle)",
                                                            margin: "4px 2px",
                                                        }}
                                                    />
                                                )}
                                                <button
                                                    type="button"
                                                    disabled={item.disabled}
                                                    onClick={() => {
                                                        menuOpen.value = false;
                                                        void item.onClick();
                                                    }}
                                                    style={{
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
                                                        color: item.danger
                                                            ? "var(--pg-status-danger-text)"
                                                            : "var(--pg-ink-primary)",
                                                        cursor: item.disabled ? "not-allowed" : "pointer",
                                                        opacity: item.disabled ? 0.45 : 1,
                                                        textAlign: "start",
                                                        fontFamily: "inherit",
                                                    }}
                                                >
                                                    {item.icon && (
                                                        <VIcon
                                                            icon={item.icon}
                                                            size={15}
                                                            style={{
                                                                color: item.danger
                                                                    ? "var(--pg-status-danger-text)"
                                                                    : "var(--pg-ink-muted)",
                                                            }}
                                                        />
                                                    )}
                                                    <span>{item.label}</span>
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                ),
                            }}
                        </VMenu>
                    )}
                </div>
            );
        };
    },
});

export default TableRowActions;

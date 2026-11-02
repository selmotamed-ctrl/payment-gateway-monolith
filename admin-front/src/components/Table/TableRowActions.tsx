import { type RefreshMethodWithNextSkip, type TableHeader, type TableHeaderAction } from "./types";
import { ThemedText } from "../ThemedText";
import { useLocale, useTheme } from "vuetify";
import Icon from "@/components/Icon/index.vue";
import { VDivider, VMenu, VProgressCircular, VTooltip } from "vuetify/components";
import { defineComponent, ref } from "vue";

export const TableRowActions = defineComponent<{
    header: TableHeader<any>;
    row: any;
    refresh: RefreshMethodWithNextSkip;
    reset: () => void | Promise<void>;
    refreshAsIs: () => void | Promise<void>;
}>(
    (props) => {
        const { t } = useLocale();
        const loading = ref(false);
        const open = ref(false);
        const theme = useTheme();
        const onClick = async (action: TableHeaderAction<any>) => {
            if (loading.value) {
                return;
            }
            loading.value = true;
            try {
                await action.action(props.row, {
                    refresh: props.refresh,
                    reset: props.reset,
                    refreshAsIs: props.refreshAsIs,
                });
            } catch (error) {
                console.error(error);
            } finally {
                loading.value = false;
            }
        };
        return () => {
            const currentColors = theme.current.value.colors;
            const header = props.header;
            const row = props.row;

            const actionsList = header.actions?.filter((action) => {
                if (typeof action.if === "function") {
                    return action.if(row);
                }
                return true;
            });

            if (header?.menu) {
                return (
                    <>
                        <VMenu
                            modelValue={open.value}
                            onUpdate:modelValue={(v) => {
                                open.value = v;
                            }}
                        >
                            {{
                                default: () => {
                                    return (
                                        <ThemedView
                                            style={{
                                                minWidth: "300px",
                                                gap: "12px",
                                                padding: "12px",
                                                borderRadius: "12px",
                                                border: "1px solid var(--pg-border-subtle)",
                                                backgroundColor: "var(--pg-bg-surface)",
                                            }}
                                        >
                                            {actionsList
                                                ?.map((action, index) => {
                                                    let backgroundColor = !action.backgroundColor
                                                        ? currentColors.primary
                                                        : typeof action.backgroundColor == "function"
                                                          ? action.backgroundColor(row)
                                                          : action.backgroundColor;

                                                    const disabled = loading.value || (typeof action.disabled == "function" ? action.disabled(row) : undefined);

                                                    if (disabled || loading.value) {
                                                        backgroundColor = currentColors["secondary"];
                                                    }

                                                    let content = (
                                                        <ThemedView
                                                            key={`${index}`}
                                                            noHoverable
                                                            role="button"
                                                            tabindex={disabled ? -1 : 0}
                                                            aria-disabled={disabled ? "true" : "false"}
                                                            aria-label={t(typeof action.label == "function" ? action.label(row) : action.label ?? "")}
                                                            onKeydown={(event: KeyboardEvent) => {
                                                                if (event.key === "Enter" || event.key === " ") {
                                                                    event.preventDefault();
                                                                    (event.currentTarget as HTMLElement).click();
                                                                }
                                                            }}
                                                            style={{
                                                                width: "100%",
                                                                borderRadius: "8px",
                                                                padding: "8px",
                                                                color: backgroundColor,
                                                                flexDirection: "row",
                                                                alignItems: "center",
                                                                gap: "12px",
                                                                justifyContent: "space-between",
                                                                cursor: disabled ? "not-allowed" : "pointer",
                                                                transition: "all 0.2s ease",
                                                                opacity: loading.value ? 0.6 : 1,
                                                            }}
                                                            disabled={disabled}
                                                            onClick={() => {
                                                                if (!disabled) {
                                                                    onClick(action);
                                                                    open.value = false;
                                                                }
                                                            }}
                                                        >
                                                            {action.label && (
                                                                <>
                                                                    <ThemedText
                                                                        style={{
                                                                            fontWeight: "600",
                                                                            fontSize: "12px",
                                                                            lineHeight: "12px",
                                                                        }}
                                                                    >
                                                                        {t(typeof action.label == "function" ? action.label(row) : action.label)}
                                                                    </ThemedText>
                                                                </>
                                                            )}

                                                            {action.iconName && (
                                                                <>
                                                                    <Icon
                                                                        icon={typeof action.iconName == "function" ? action.iconName(row) : action.iconName}
                                                                        color={backgroundColor}
                                                                        size={12}
                                                                    />
                                                                </>
                                                            )}
                                                        </ThemedView>
                                                    );

                                                    let toolTipWrappedContent: JSX.Element;
                                                    const ToolTipContent = action.Tooltip?.({ row });
                                                    const toolTipContent = action.tooltip?.({ row });
                                                    if (ToolTipContent) {
                                                        toolTipWrappedContent = (
                                                            <VTooltip>
                                                                {{
                                                                    activator: ({ props }: any) => {
                                                                        return <ThemedView {...props}>{content}</ThemedView>;
                                                                    },
                                                                    default: () => {
                                                                        return <>{ToolTipContent}</>;
                                                                    },
                                                                }}
                                                            </VTooltip>
                                                        );
                                                    } else if (toolTipContent) {
                                                        toolTipWrappedContent = (
                                                            <VTooltip>
                                                                {{
                                                                    activator: ({ props }: any) => {
                                                                        return <ThemedView {...props}>{content}</ThemedView>;
                                                                    },
                                                                    default: () => {
                                                                        return <>{t(toolTipContent)}</>;
                                                                    },
                                                                }}
                                                            </VTooltip>
                                                        );
                                                    } else {
                                                        toolTipWrappedContent = <>{content}</>;
                                                    }

                                                    let hrefWrappedContent: JSX.Element;
                                                    const href = action.href;
                                                    if (href) {
                                                        hrefWrappedContent = (
                                                            <a
                                                                style={{
                                                                    textDecoration: "none",
                                                                    width: "100%",
                                                                }}
                                                                onClick={(e) => {
                                                                    e.preventDefault();
                                                                }}
                                                                href={href(row)}
                                                            >
                                                                {toolTipWrappedContent}
                                                            </a>
                                                        );
                                                    } else {
                                                        hrefWrappedContent = <>{toolTipWrappedContent}</>;
                                                    }

                                                    return (
                                                        <>
                                                            {hrefWrappedContent}
                                                            {index < actionsList.length - 1 ? <VDivider /> : <></>}
                                                        </>
                                                    );
                                                })
                                                .filter((e) => !!e)}
                                        </ThemedView>
                                    );
                                },

                                activator: (slotProps: any) => {
                                    return (
                                        <ThemedView
                                            style={{
                                                paddingBottom: "1px",
                                            }}
                                            {...slotProps?.props}
                                            role="button"
                                            tabindex={loading.value ? -1 : 0}
                                            aria-haspopup="menu"
                                            aria-expanded={open.value ? "true" : "false"}
                                            aria-label={t("Row actions")}
                                            onKeydown={(event: KeyboardEvent) => {
                                                if (event.key === "Enter" || event.key === " ") {
                                                    event.preventDefault();
                                                    (event.currentTarget as HTMLElement).click();
                                                }
                                            }}
                                            noHoverable
                                            disabled={loading.value}
                                        >
                                            {!loading.value ? (
                                                <Icon icon="mdi-dots-vertical" size={32}></Icon>
                                            ) : (
                                                <VProgressCircular indeterminate></VProgressCircular>
                                            )}
                                        </ThemedView>
                                    );
                                },
                            }}
                        </VMenu>
                    </>
                );
            }

            return (
                <ThemedView
                    style={{
                        alignItems: "center",
                        flexDirection: "row",
                        gap: "8px",
                        padding: "8px",
                    }}
                >
                    {actionsList?.map((action, index) => {
                        let backgroundColor = !action.backgroundColor
                            ? currentColors.primary
                            : typeof action.backgroundColor == "function"
                              ? action.backgroundColor(row)
                              : action.backgroundColor;

                        const disabled = loading.value || (typeof action.disabled == "function" ? action.disabled(row) : undefined);

                        if (disabled || loading.value) {
                            backgroundColor = currentColors["secondary"];
                        }
                        let content = (
                            <>
                                <ThemedView
                                    class={disabled ? "" : "table-row-action-button"}
                                    key={`${index}`}
                                    noHoverable
                                    role="button"
                                    tabindex={disabled ? -1 : 0}
                                    aria-disabled={disabled ? "true" : "false"}
                                    aria-label={t(typeof action.label == "function" ? action.label(row) : action.label ?? "")}
                                    onKeydown={(event: KeyboardEvent) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            (event.currentTarget as HTMLElement).click();
                                        }
                                    }}
                                    style={{
                                        borderRadius: "8px",
                                        padding: "8px 12px",
                                        backgroundColor: "transparent",
                                        border: `1px solid ${backgroundColor}33`,
                                        flexDirection: "row",
                                        color: backgroundColor,
                                        alignItems: "center",
                                        gap: "8px",
                                        justifyContent: "center",
                                        cursor: disabled ? "not-allowed" : "pointer",
                                        transition: "all 0.2s ease",
                                        opacity: loading.value ? 0.6 : 1,
                                    }}
                                    disabled={disabled}
                                    onClick={() => {
                                        const disabled = loading.value || (typeof action.disabled == "function" ? action.disabled(row) : undefined);
                                        if (!disabled) {
                                            onClick(action);
                                        }
                                    }}
                                >
                                    {loading.value ? (
                                        <>
                                            <VProgressCircular size={14} indeterminate></VProgressCircular>
                                        </>
                                    ) : (
                                        action.iconName && (
                                            <>
                                                <Icon
                                                    icon={typeof action.iconName == "function" ? action.iconName(row) : action.iconName}
                                                    color={backgroundColor}
                                                    size={14}
                                                ></Icon>
                                            </>
                                        )
                                    )}

                                    {action.label && (
                                        <>
                                            <ThemedText
                                                style={{
                                                    fontWeight: "600",
                                                    fontSize: "12px",
                                                    lineHeight: "12px",
                                                    color: backgroundColor,
                                                }}
                                            >
                                                {t(typeof action.label == "function" ? action.label(row) : action.label)}
                                            </ThemedText>
                                        </>
                                    )}
                                </ThemedView>
                            </>
                        );
                        let toolTipWrappedContent: JSX.Element;
                        const ToolTipContent = action.Tooltip?.({ row });
                        const toolTipContent = action.tooltip?.({ row });
                        if (ToolTipContent) {
                            toolTipWrappedContent = (
                                <VTooltip>
                                    {{
                                        activator: ({ props }: any) => {
                                            return <ThemedView {...props}>{content}</ThemedView>;
                                        },
                                        default: () => {
                                            return <>{ToolTipContent}</>;
                                        },
                                    }}
                                </VTooltip>
                            );
                        } else if (toolTipContent) {
                            toolTipWrappedContent = (
                                <VTooltip>
                                    {{
                                        activator: ({ props }: any) => {
                                            return <ThemedView {...props}>{content}</ThemedView>;
                                        },
                                        default: () => {
                                            return <>{t(toolTipContent)}</>;
                                        },
                                    }}
                                </VTooltip>
                            );
                        } else {
                            toolTipWrappedContent = <>{content}</>;
                        }

                        let hrefWrappedContent: JSX.Element;
                        const href = action.href;
                        if (href) {
                            hrefWrappedContent = (
                                <a
                                    style={{
                                        textDecoration: "none",
                                    }}
                                    onClick={(e) => {
                                        e.preventDefault();
                                    }}
                                    href={href(row)}
                                >
                                    {toolTipWrappedContent}
                                </a>
                            );
                        } else {
                            hrefWrappedContent = <>{toolTipWrappedContent}</>;
                        }

                        return hrefWrappedContent;
                    })}
                </ThemedView>
            );
        };
    },
    {
        props: ["refreshAsIs", "header", "row", "reset", "refresh"],
    },
);

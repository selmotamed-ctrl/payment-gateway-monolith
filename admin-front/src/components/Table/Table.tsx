import "./styling.css";
import { readCell, type BaseTableProps, type IconProps, type RefreshMethodData, type RefreshMethodWithNextSkip, type TableHeader } from "./types";
import { ThemedView } from "../ThemedView";
import { ThemedText } from "../ThemedText";
import { useDisplay, useLocale, useTheme } from "vuetify";
import Icon from "@/components/Icon/index.vue";
import { TableRowActions } from "./TableRowActions";
import { defineComponent } from "vue";
import { VDivider, VForm, VIcon, VTooltip } from "vuetify/components";
import { extractApiError } from "@/utils/errors/extractor";
import { showConfirm } from "@/utils/confirm";
import { adaptedLocale } from "@/plugins/localization";
import { colors } from "@/plugins/vuetify";

const headerIconProps: Omit<IconProps, "icon"> = {
    // Todo
};

const HeaderCell = defineComponent(
    <T,>(props: {
        onSetSort: (sortBy: string, sortDirection: "asc" | "desc") => void;
        sortBy: null | string;
        sortDirection: "asc" | "desc";
        header: TableHeader<T>;
    }) => {
        const locale = useLocale();
        const theme = useTheme();
        const { t } = locale;
        return () => {
            const h = props.header;
            if (h.Header) {
                return <h.Header key={h.key}></h.Header>;
            }
            const sortKey = h.sortKey ?? h.key;
            const isSortSelected = !!props.sortBy && props.sortBy === sortKey;

            return (
                <ThemedView
                    onClick={h.onHeaderPress}
                    key={h.key}
                    style={[
                        {
                            flexDirection: "row",
                            alignItems: "center",
                            gap: "6px",
                            justifyContent: "flex-start",
                        },
                        h.headerCellStyle,
                    ]}
                >
                    {h.label && (
                        <>
                            <ThemedText
                                style={[
                                    {
                                        color: theme.current.value.colors["on-surface-variant"],
                                        fontSize: "13px",
                                        fontWeight: "600",
                                        letterSpacing: "0.01em",
                                        textTransform: "uppercase",
                                    },
                                    h.headerTextStyle,
                                ]}
                            >
                                {t(h.label)}
                            </ThemedText>
                        </>
                    )}

                    {h.headerIcon && (
                        <>
                            <Icon {...headerIconProps} icon={h.headerIcon} size="16px"></Icon>
                        </>
                    )}

                    {h.HeaderIcon && (
                        <>
                            <h.HeaderIcon {...headerIconProps}></h.HeaderIcon>
                        </>
                    )}
                    {!!(h.sortable !== false && !h.Header && !!h.label && h.key !== "actions" && sortKey) && (
                        <>
                            <Button
                                variant="text"
                                color={!isSortSelected ? colors.grey.darken1 : colors.blue.base}
                                onClick={() => {
                                    if (isSortSelected) {
                                        props.onSetSort(sortKey, props.sortDirection == "asc" ? "desc" : "asc");
                                        return;
                                    }
                                    props.onSetSort(sortKey, "asc");
                                }}
                                iconName={
                                    !isSortSelected
                                        ? "mdi-unfold-more-horizontal"
                                        : props.sortDirection == "asc"
                                          ? "mdi-chevron-up"
                                          : "mdi-chevron-down"
                                }
                            ></Button>
                        </>
                    )}
                </ThemedView>
            );
        };
    },
    {
        props: ["header", "onSetSort", "sortDirection", "sortBy"],
    },
);

export const Table = defineComponent(
    <T,>(
        props: BaseTableProps<T> & {
            data: T[];
            reset: () => void;
            refreshAsIs: () => void;
            refresh: RefreshMethodData | RefreshMethodWithNextSkip;
        } & {
            sortBy: string | null;
            sortDirection: "asc" | "desc";
            onSetSort: (sortBy: string, sortDirection: "asc" | "desc") => void;
            pageNumber: number;
            skip: number;
        },
    ) => {
        const display = useDisplay();
        const state = ref(
            {} as {
                [key: string]: any;
            },
        );
        const editingCells = ref(
            {} as {
                [cellKey: string]: any;
            },
        );
        const loadingCells = ref(
            {} as {
                [cellKey: string]: any;
            },
        );
        const validCells = ref(
            {} as {
                [cellKey: string]: any;
            },
        );

        const errorCells = ref(
            {} as {
                [cellKey: string]: any;
            },
        );

        const clearCellKeyFromEditing = (cellKey: string) => {
            editingCells.value[cellKey] = false;
            loadingCells.value[cellKey] = false;
            validCells.value[cellKey] = false;
            state.value[cellKey] = null;
            errorCells.value[cellKey] = null;
        };
        const submitCell = async (cellKey: string, rowIndex: number, row: T, header: TableHeader<T>) => {
            if (!header.cellEditEnabled || loadingCells.value[cellKey]) {
                return;
            }
            if (header.requireConfirmation) {
                const confirmed = await showConfirm({
                    message: header.confirmationMessage || "Confirm?",
                    title: "Submit",
                    type: "primary",
                });
                if (!confirmed) {
                    return;
                }
            }

            loadingCells.value[cellKey] = true;
            errorCells.value[cellKey] = null;
            try {
                await header.onSubmitEdit({
                    editedValue: state.value[cellKey],
                    index: rowIndex,
                    originalCellValue: (row as any)[header.cellEditKey],
                    refreshAsIs: props.refreshAsIs,
                    reset: props.reset,
                    row,
                });
                clearCellKeyFromEditing(cellKey);
            } catch (error) {
                console.error(error);
                const e = extractApiError(error);
                if (e) {
                    errorCells.value[cellKey] = e.error;
                }
            } finally {
                loadingCells.value[cellKey] = false;
            }
        };
        const theme = useTheme();

        return () => {
            const isMobile = display.mobile.value;
            const padding = !isMobile ? "20px 15px" : "6px 12px";
            const isDark = theme.current.value.dark;
            const colors = theme.current.value.colors;
            const separatorStyle = isDark ? `2px solid rgba(255, 255, 255, 0.1)` : "2px solid #e2e8f0";
            return (
                <ThemedView>
                    <ThemedView style={[props.tableContainerStyle]} class="table-wrapper">
                        <table
                            style={{
                                borderCollapse: "separate",
                                borderSpacing: "0",
                                width: "100%",
                                padding: "0px",
                            }}
                            class="modern-table"
                        >
                            <thead>
                                <tr class="table-header-row">
                                    {props.headers.map((header) => {
                                        return (
                                            <th
                                                key={header.key}
                                                style={{
                                                    borderInlineEnd: header.endSeparator ? separatorStyle : undefined,
                                                    borderInlineStart: header.startSeparator ? separatorStyle : undefined,
                                                    padding: padding,
                                                    width: header.minWidth ? "1px" : undefined,
                                                    backgroundColor: isDark ? colors.surface : "#f8fafc",
                                                    borderBottom: isDark ? `2px solid rgba(255, 255, 255, 0.1)` : "2px solid #e2e8f0",
                                                    position: "sticky",
                                                    top: 0,
                                                    zIndex: 10,
                                                }}
                                            >
                                                <HeaderCell
                                                    onSetSort={props.onSetSort}
                                                    sortBy={props.sortBy}
                                                    sortDirection={props.sortDirection}
                                                    header={header}
                                                ></HeaderCell>
                                            </th>
                                        );
                                    })}
                                </tr>
                            </thead>
                            <tbody>
                                {props.data.map((row, index) => {
                                    if (props.Row) {
                                        return <props.Row key={`${index}`} items={row}></props.Row>;
                                    }

                                    return (
                                        <>
                                            <tr
                                                key={`${index + props.skip}`}
                                                class="table-data-row"
                                                style={{
                                                    backgroundColor: props.rowColor?.(row)
                                                        ? props.rowColor(row) + "15"
                                                        : index % 2 === 0
                                                          ? isDark
                                                              ? colors.surface
                                                              : "#ffffff"
                                                          : isDark
                                                            ? colors["surface-variant"]
                                                            : "#f8fafc",
                                                    borderBottom:
                                                        index < props.data.length - 1 && props.placeDividers
                                                            ? isDark
                                                                ? "1px solid rgba(255, 255, 255, 0.1)"
                                                                : "1px solid #e2e8f0"
                                                            : undefined,
                                                    transition: "background-color 0.2s ease",
                                                }}
                                            >
                                                {props.headers.map((header, headerIndex) => {
                                                    const cellKey = `${index}${headerIndex}`;

                                                    if (header.Value) {
                                                        return (
                                                            <td
                                                                key={String(headerIndex)}
                                                                style={{
                                                                    borderInlineEnd: header.endSeparator ? separatorStyle : undefined,
                                                                    borderInlineStart: header.startSeparator ? separatorStyle : undefined,
                                                                    width: header.minWidth ? "1px" : undefined,
                                                                }}
                                                            >
                                                                <header.Value key={header.key} row={row}></header.Value>
                                                            </td>
                                                        );
                                                    }

                                                    if (header.actions) {
                                                        return (
                                                            <td
                                                                key={header.key}
                                                                style={{
                                                                    borderInlineEnd: header.endSeparator ? separatorStyle : undefined,
                                                                    borderInlineStart: header.startSeparator ? separatorStyle : undefined,
                                                                }}
                                                            >
                                                                <TableRowActions
                                                                    refreshAsIs={props.refreshAsIs}
                                                                    header={header}
                                                                    refresh={props.refresh}
                                                                    reset={props.reset}
                                                                    row={row}
                                                                ></TableRowActions>
                                                            </td>
                                                        );
                                                    }

                                                    if (header.value) {
                                                        if (header.cellEditEnabled && editingCells.value[cellKey]) {
                                                            return (
                                                                <td
                                                                    key={header.key}
                                                                    style={{
                                                                        padding: padding,
                                                                        borderInlineEnd: header.endSeparator ? separatorStyle : undefined,
                                                                        borderInlineStart: header.startSeparator ? separatorStyle : undefined,
                                                                        transition: "background-color 0.15s ease",
                                                                        minWidth: "250px",
                                                                        paddingTop: "22px",
                                                                    }}
                                                                >
                                                                    <VForm
                                                                        disabled={!!loadingCells.value[cellKey]}
                                                                        onUpdate:modelValue={(v) => {
                                                                            validCells.value[cellKey] = !!v;
                                                                        }}
                                                                        modelValue={validCells.value[cellKey]}
                                                                    >
                                                                        <ThemedView>
                                                                            <TextField
                                                                                maxWidth={"250px"}
                                                                                density={"compact"}
                                                                                loading={loadingCells.value[cellKey]}
                                                                                modelValue={state.value[cellKey]}
                                                                                onUpdate:modelValue={(v) => {
                                                                                    state.value[cellKey] = v;
                                                                                }}
                                                                                prependIcon={"mdi-close"}
                                                                                onClick:prepend={() => {
                                                                                    clearCellKeyFromEditing(cellKey);
                                                                                }}
                                                                                rules={header.rules}
                                                                                disabled={loadingCells.value[cellKey]}
                                                                                appendIcon={"mdi-check"}
                                                                                onClick:append={() => {
                                                                                    submitCell(cellKey, index, row, header);
                                                                                }}
                                                                                errorMessages={
                                                                                    errorCells.value[cellKey] ? [errorCells.value[cellKey]] : null
                                                                                }
                                                                            ></TextField>
                                                                        </ThemedView>
                                                                    </VForm>
                                                                </td>
                                                            );
                                                        }

                                                        return (
                                                            <td
                                                                class={header.onCellPress ? "table-cell-clickable" : "table-cell"}
                                                                style={{
                                                                    borderInlineEnd: header.endSeparator ? separatorStyle : undefined,
                                                                    borderInlineStart: header.startSeparator ? separatorStyle : undefined,
                                                                    padding: padding,
                                                                    cursor: header.onCellPress && "pointer",
                                                                    transition: "background-color 0.15s ease",
                                                                }}
                                                                onClick={
                                                                    header.onCellPress
                                                                        ? () => {
                                                                              header.onCellPress?.(row, {
                                                                                  refresh: props.refresh,
                                                                                  refreshAsIs: props.refreshAsIs,
                                                                                  reset: props.reset,
                                                                              });
                                                                          }
                                                                        : undefined
                                                                }
                                                                key={header.key}
                                                            >
                                                                <ThemedView
                                                                    style={{
                                                                        flexDirection: "row",
                                                                        alignItems: "center",
                                                                        gap: "12px",
                                                                        color: colors["on-surface"],
                                                                        fontWeight: "500",
                                                                        fontSize: "14px",
                                                                        lineHeight: "20px",
                                                                    }}
                                                                >
                                                                    {header.CellTooltip ? (
                                                                        <>
                                                                            <VTooltip activator={"parent"} interactive={true}>
                                                                                {header.CellTooltip()}
                                                                            </VTooltip>
                                                                        </>
                                                                    ) : header.cellToolTip && header.cellToolTip.text(row) ? (
                                                                        <>
                                                                            <VTooltip interactive={!!header.cellToolTip.onClick} activator={"parent"}>
                                                                                <ThemedView onClick={() => header.cellToolTip?.onClick?.(row)}>
                                                                                    {adaptedLocale.t(header.cellToolTip.text(row))}
                                                                                </ThemedView>
                                                                            </VTooltip>
                                                                        </>
                                                                    ) : (
                                                                        <></>
                                                                    )}

                                                                    {header.cellEditEnabled ? (
                                                                        <>
                                                                            <ThemedView
                                                                                class={"show-on-hover"}
                                                                                noHoverable
                                                                                onClick={
                                                                                    !header.cellIconOnClick
                                                                                        ? undefined
                                                                                        : () =>
                                                                                              header.cellIconOnClick?.({
                                                                                                  row: row,
                                                                                                  index,
                                                                                                  enableCellEditing() {
                                                                                                      editingCells.value[cellKey] = true;
                                                                                                      loadingCells.value[cellKey] = false;
                                                                                                      validCells.value[cellKey] = false;
                                                                                                      state.value[cellKey] = (row as any)?.[
                                                                                                          header.cellEditKey
                                                                                                      ];
                                                                                                      errorCells.value[cellKey] = null;
                                                                                                  },
                                                                                              })
                                                                                }
                                                                            >
                                                                                <VIcon size={18}>{header.cellIconName}</VIcon>
                                                                            </ThemedView>
                                                                        </>
                                                                    ) : (
                                                                        <></>
                                                                    )}

                                                                    <ThemedView>{readCell(header.value, row, index)}</ThemedView>
                                                                </ThemedView>
                                                            </td>
                                                        );
                                                    }

                                                    return <td key={header.key}> </td>;
                                                })}
                                            </tr>
                                        </>
                                    );
                                })}
                            </tbody>
                        </table>
                    </ThemedView>
                </ThemedView>
            );
        };
    },
    {
        props: [
            "Icon",
            "Row",
            "sortBy",
            "sortDirection",
            "placeDividers",
            "data",
            "headers",
            "onSetSort",
            "iconName",
            "numberOfItemsPerPage",
            "numberOfItemsPerPageChoices",
            "pageNumber",
            "refresh",
            "rowColor",
            "searchValue",
            "setNumberOfItemsPerPage",
            "setSearchValue",
            "showNumber",
            "refreshAsIs",
            "skip",
            "string",
            "tableContainerStyle",
            "title",
            "reset",
        ] as any[],
    },
);

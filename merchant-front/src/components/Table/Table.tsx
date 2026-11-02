import "./styling.css";
import { readCell, type BaseTableProps, type IconProps, type RefreshMethodData, type RefreshMethodWithNextSkip, type TableHeader } from "./types";
import { ThemedView } from "../ThemedView";
import { useLocale } from "vuetify";
import Icon from "@/components/Icon/index.vue";
import { defineComponent } from "vue";
import { VForm, VIcon, VTooltip } from "vuetify/components";
import { extractApiError } from "@/utils/errors/extractor";
import { showConfirm } from "@/utils/confirm";
import { adaptedLocale } from "@/plugins/localization";

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
        const { t } = locale;
        return () => {
            const h = props.header;
            if (h.Header) {
                return (
                    <span title={h.headerTooltip ? t(h.headerTooltip) : undefined}>
                        <h.Header key={h.key}></h.Header>
                    </span>
                );
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
                            <span style={h.headerTextStyle}>{t(h.label)}</span>
                        </>
                    )}

                    {h.headerTooltip && (
                        <VTooltip
                            text={t(h.headerTooltip)}
                            location="top"
                            maxWidth={420}
                        >
                            {{
                                activator: ({ props: activatorProps }: any) => (
                                    <VIcon
                                        {...activatorProps}
                                        {...{
                                            tabindex: 0,
                                            role: "button",
                                            "aria-label": `${t(h.label ?? h.key)} ${t("help")}`,
                                        }}
                                        icon="mdi-help-circle-outline"
                                        size={14}
                                        style={{ opacity: 0.55, cursor: "help", flex: "0 0 auto" }}
                                    />
                                ),
                            }}
                        </VTooltip>
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
                                color={isSortSelected ? "primary" : undefined}
                                {...{
                                    "aria-label": isSortSelected
                                        ? `${t("Sorted")} ${props.sortDirection === "asc" ? t("ascending") : t("descending")} ${t("by")} ${t(h.label ?? h.key)}`
                                        : `${t("Sort by")} ${t(h.label ?? h.key)}`,
                                }}
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
        const { t } = useLocale();

        return () => {
            const separatorStyle = "1px solid var(--pg-border-subtle)";
            return (
                <ThemedView>
                    <ThemedView style={[props.tableContainerStyle]} class="table-wrapper">
                        <table
                            aria-label={typeof (props as any).title === "string" ? t((props as any).title) : undefined}
                            style={{
                                borderCollapse: "separate",
                                borderSpacing: "0",
                                width: "100%",
                                padding: "0px",
                            }}
                            class="modern-table pg-unified-table"
                        >
                            <thead>
                                {typeof (props as any).title === "string" && (
                                    <caption class="pg-sr-only">{t((props as any).title)}</caption>
                                )}
                                <tr>
                                    {props.headers.map((header) => {
                                        return (
                                            <th
                                                key={header.key}
                                                scope="col"
                                                class={header.key === "actions" ? "pg-col-actions" : undefined}
                                                aria-sort={
                                                    header.sortable !== false && !header.Header && header.key !== "actions" && header.label
                                                        ? props.sortBy === (header.sortKey ?? header.key)
                                                            ? props.sortDirection === "asc"
                                                                ? "ascending"
                                                                : "descending"
                                                            : "none"
                                                        : undefined
                                                }
                                                style={{
                                                    borderInlineEnd: header.endSeparator ? separatorStyle : undefined,
                                                    borderInlineStart: header.startSeparator ? separatorStyle : undefined,
                                                    width: header.minWidth ? "1px" : undefined,
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
                                            >
                                                {props.headers.map((header, headerIndex) => {
                                                    const cellKey = `${index}${headerIndex}`;

                                                    if (header.Value) {
                                                        return (
                                                            <td
                                                                key={String(headerIndex)}
                                                                class={header.key === "actions" ? "pg-col-actions" : undefined}
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

                                                    if (header.value) {
                                                        if (header.cellEditEnabled && editingCells.value[cellKey]) {
                                                            return (
                                                                <td
                                                                    key={header.key}
                                                                    style={{
                                                                        padding: "6px 12px",
                                                                        borderInlineEnd: header.endSeparator ? separatorStyle : undefined,
                                                                        borderInlineStart: header.startSeparator ? separatorStyle : undefined,
                                                                        minWidth: "250px",
                                                                        paddingTop: "12px",
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
                                                                    cursor: header.onCellPress ? "pointer" : undefined,
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

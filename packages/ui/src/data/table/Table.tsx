import { PgTextField } from "../../inputs/PgTextField";
import { PgButton } from "../../actions/PgButton";
import { ref } from "vue";

import { readCell, type BaseTableProps, type IconProps, type RefreshMethodData, type RefreshMethodWithNextSkip, type TableHeader } from "./types";
import { criticalRowTone } from "./statusTone";
import { PgView } from "../../layout/PgPageHeader";
import { useLocale } from "../../lib/locale";
import { PgIcon } from "../../actions/PgIcon";
import { defineComponent } from "../../lib/dc";
import { PgForm } from "../../layout/PgShellPrimitives";
import { PgTooltip } from "../../overlays/PgTooltip";
import { usePgUiConfig } from "../../lib/config";



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
                <PgView
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
                        <PgTooltip text={t(h.headerTooltip)} location="top" maxWidth={420}>
                            <PgIcon
                                tabindex={0}
                                role="button"
                                aria-label={`${t(h.label ?? h.key)} ${t("help")}`}
                                icon="mdi-help-circle-outline"
                                size={14}
                                style={{ opacity: 0.55, cursor: "help", flex: "0 0 auto" }}
                            />
                        </PgTooltip>
                    )}

                    {h.headerIcon && (
                        <>
                            <PgIcon {...headerIconProps} icon={h.headerIcon} size="16px"></PgIcon>
                        </>
                    )}

                    {h.HeaderIcon && (
                        <>
                            <h.HeaderIcon {...headerIconProps}></h.HeaderIcon>
                        </>
                    )}
                    {!!(h.sortable !== false && !h.Header && !!h.label && h.key !== "actions" && sortKey) && (
                        <>
                            <PgButton
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
                                icon={
                                    !isSortSelected
                                        ? "mdi-unfold-more-horizontal"
                                        : props.sortDirection == "asc"
                                          ? "mdi-chevron-up"
                                          : "mdi-chevron-down"
                                }
                            ></PgButton>
                        </>
                    )}
                </PgView>
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
                const confirmed = await config.confirm?.({
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
                const e = config.extractApiError?.(error);
                if (e) {
                    errorCells.value[cellKey] = e.error ?? e.message;
                }
            } finally {
                loadingCells.value[cellKey] = false;
            }
        };
        const { t } = useLocale();
        const config = usePgUiConfig();

        return () => {
            const separatorStyle = "1px solid var(--pg-border-subtle)";
            return (
                <PgView>
                    <PgView style={[props.tableContainerStyle]} class="table-wrapper">
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

                                    let rowColor: string | undefined;
                                    try {
                                        rowColor = props.rowColor?.(row);
                                    } catch {
                                        rowColor = undefined;
                                    }
                                    const indicatorTone = criticalRowTone(row as Record<string, unknown>, rowColor);

                                    return (
                                        <>
                                            <tr
                                                key={`${index + props.skip}`}
                                                class={[
                                                    "table-data-row",
                                                    indicatorTone ? `pg-row-indicator pg-row-indicator--${indicatorTone}` : "",
                                                ]}
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
                                                                    <PgForm
                                                                        disabled={!!loadingCells.value[cellKey]}
                                                                        onUpdate:modelValue={(v) => {
                                                                            validCells.value[cellKey] = !!v;
                                                                        }}
                                                                        modelValue={validCells.value[cellKey]}
                                                                    >
                                                                        <PgView>
                                                                            <PgTextField

                                                                                density={"compact"}
                                                                                loading={loadingCells.value[cellKey]}
                                                                                modelValue={state.value[cellKey]}
                                                                                onUpdate:modelValue={(v) => {
                                                                                    state.value[cellKey] = v;
                                                                                }}
                                                                                prependInnerIcon={"mdi-close"}
                                                                                onClick:prependInner={() => {
                                                                                    clearCellKeyFromEditing(cellKey);
                                                                                }}
                                                                                rules={header.rules}
                                                                                disabled={loadingCells.value[cellKey]}
                                                                                appendInnerIcon={"mdi-check"}
                                                                                onClick:appendInner={() => {
                                                                                    submitCell(cellKey, index, row, header);
                                                                                }}
                                                                                errorMessages={
                                                                                    errorCells.value[cellKey] ? [errorCells.value[cellKey]] : null
                                                                                }
                                                                            ></PgTextField>
                                                                        </PgView>
                                                                    </PgForm>
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
                                                                <PgView
                                                                    style={{
                                                                        flexDirection: "row",
                                                                        alignItems: "center",
                                                                        gap: "12px",
                                                                    }}
                                                                >
                                                                    {header.CellTooltip ? (
                                                                        <PgTooltip text="" maxWidth={420}>
                                                                            {header.CellTooltip()}
                                                                        </PgTooltip>
                                                                    ) : header.cellToolTip && header.cellToolTip.text(row) ? (
                                                                        <PgTooltip text={t(header.cellToolTip.text(row))} maxWidth={420}>
                                                                            <PgView onClick={() => header.cellToolTip?.onClick?.(row)}>
                                                                                {t(header.cellToolTip.text(row))}
                                                                            </PgView>
                                                                        </PgTooltip>
                                                                    ) : null}

                                                                    {header.cellEditEnabled ? (
                                                                        <>
                                                                            <PgView
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
                                                                                <PgIcon size={18} icon={String(header.cellIconName ?? "")} />
                                                                            </PgView>
                                                                        </>
                                                                    ) : (
                                                                        <></>
                                                                    )}

                                                                    <PgView>{readCell(header.value, row, index)}</PgView>
                                                                </PgView>
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
                    </PgView>
                </PgView>
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

export const PgTable = Table;

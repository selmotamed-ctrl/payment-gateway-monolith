import { createFor, createIf } from "@vue/runtime-vapor";
import { computed, ref, watch } from "vue";

import { PgTextField } from "../../inputs/PgTextField";
import { PgSearchInput } from "../../inputs/PgSearchInput";
import { PgIcon } from "../../actions/PgIcon";
import { PgForm } from "../../layout/PgShellPrimitives";
import { PgView } from "../../layout/PgPageHeader";
import { PgTooltip } from "../../overlays/PgTooltip";
import { PgCheckbox } from "../../inputs/PgCheckbox";
import { PgEmptyState, PgSkeleton } from "../../feedback/PgEmptyState";
import { defineComponent } from "../../lib/dc";
import { useLocale } from "../../lib/locale";
import { usePgUiConfig } from "../../lib/config";
import {
    readCell,
    sortRowsByHeader,
    type BaseTableProps,
    type IconProps,
    type RefreshMethodData,
    type RefreshMethodWithNextSkip,
    type TableHeader,
} from "./types";
import { criticalRowTone } from "./statusTone";

/** Vapor JSX returns a Block at runtime; the public type is narrower. */
const branch = createIf as any;
const list = createFor as any;

const headerIconProps: Omit<IconProps, "icon"> = {};

const ROW_CLICK_BLOCKERS = [
    "button",
    "a",
    "input",
    "label",
    "textarea",
    "select",
    "summary",
    "[data-no-row-click]",
    "[data-no-row-context-menu]",
    ".pg-mono-ref",
    ".pg-row-actions",
    ".pg-row-actions__panel",
    ".pg-checkbox-field",
    ".pg-field",
    "[role='menu']",
    "[role='menuitem']",
].join(",");

const rowSearchText = (row: unknown): string => {
    try {
        if (row === null || row === undefined) return "";
        if (typeof row !== "object") return String(row).toLowerCase();
        return JSON.stringify(row).toLowerCase();
    } catch {
        return "";
    }
};

export type PgTableProps<T> = BaseTableProps<T> & {
    /** Alias for `data`; the 2026 API spells static rows `items`. */
    data?: T[];
    items?: T[];
    reset?: () => void;
    refreshAsIs?: () => void;
    refresh?: RefreshMethodData | RefreshMethodWithNextSkip;
    sortBy?: string | null;
    sortDirection?: "asc" | "desc";
    onSetSort?: (sortBy: string, sortDirection: "asc" | "desc") => void;
    /** Controlled-mode hook used to clear the sort after `desc`. */
    onClearSort?: () => void;
    pageNumber?: number;
    skip?: number;
    loading?: boolean;
    title?: string;
    onRowClick?: (row: T, index: number) => void;
    rowKey?: (row: T, index: number) => string | number;
    /** Local `PgSearchInput` toolbar for standalone tables. */
    searchable?: boolean;
    searchPlaceholder?: string;
    emptyTitle?: string;
    emptyDescription?: string;
    emptyActionLabel?: string;
    onEmptyAction?: () => void;
    selectable?: boolean;
    selectedKeys?: Array<string | number>;
    onSelectionChange?: (keys: Array<string | number>, rows: T[]) => void;
    density?: "comfortable" | "compact" | string;
    skeletonRows?: number;
};

/**
 * The 2026 operational data table.
 *
 * Owns the shell (`pg-table-shell`), the only horizontal scroll container
 * (`table-wrapper pg-table-scroll`), sortable 11.5px uppercase headers with an
 * `asc -> desc -> none` cycle, 48px rows, an opaque sticky action column,
 * loading skeletons, an in-table empty state and row-click routing that never
 * steals a click from an interactive control.
 */
export const Table = defineComponent(
    <T,>(props: PgTableProps<T>, { slots, attrs }: any) => {
        const { t } = useLocale();
        const config = usePgUiConfig();

        const editingCells = ref<Record<string, any>>({});
        const loadingCells = ref<Record<string, any>>({});
        const validCells = ref<Record<string, any>>({});
        const errorCells = ref<Record<string, any>>({});
        const state = ref<Record<string, any>>({});
        const localSortBy = ref<string | null>(null);
        const localSortDirection = ref<"asc" | "desc">("asc");
        const localSearch = ref("");
        const selected = ref<Array<string | number>>([...(props.selectedKeys ?? [])]);

        watch(
            () => props.selectedKeys,
            (keys) => {
                selected.value = [...(keys ?? [])];
            },
            { deep: true },
        );

        const headers = computed<TableHeader<T>[]>(() => props.headers ?? []);
        const searchable = () => props.searchable === true;
        const sortControlled = () => props.sortBy !== undefined || typeof props.onSetSort === "function";
        const activeSortKey = (): string | null => (props.sortBy !== undefined ? props.sortBy : localSortBy.value);
        const activeSortDirection = (): "asc" | "desc" => props.sortDirection ?? localSortDirection.value;
        const columns = computed(() => headers.value.length + (props.selectable ? 1 : 0));

        const sourceRows = (): T[] => ((props.items ?? props.data ?? []) as T[]);
        const searchedRows = (): T[] => {
            if (!searchable()) return sourceRows();
            const term = String(props.searchValue ?? localSearch.value ?? "").trim().toLowerCase();
            if (!term) return sourceRows();
            return sourceRows().filter((row) => rowSearchText(row).includes(term));
        };
        const displayRows = (): T[] => {
            const rows = searchedRows();
            if (sortControlled()) return rows;
            const key = activeSortKey();
            return key ? sortRowsByHeader(rows, headers.value, key, activeSortDirection()) : rows;
        };

        const rowKeyOf = (row: T, index: number): string | number => {
            if (typeof props.rowKey === "function") return props.rowKey(row, index);
            const candidate = row as Record<string, any> | null | undefined;
            const explicit = candidate?.id ?? candidate?.key ?? candidate?.uuid;
            return explicit === undefined || explicit === null ? index + (props.skip ?? 0) : (explicit as string | number);
        };

        const applySort = (key: string, direction: "asc" | "desc") => {
            localSortBy.value = key;
            localSortDirection.value = direction;
            props.onSetSort?.(key, direction);
        };
        const clearSort = () => {
            localSortBy.value = null;
            localSortDirection.value = "asc";
            props.onClearSort?.();
        };
        const cycleSort = (key: string) => {
            if (activeSortKey() !== key) {
                applySort(key, "asc");
                return;
            }
            if (activeSortDirection() === "asc") {
                applySort(key, "desc");
                return;
            }
            if (typeof props.onClearSort === "function" || !sortControlled()) {
                clearSort();
                return;
            }
            applySort(key, "asc");
        };

        const ariaSort = (header: TableHeader<T>): "ascending" | "descending" | "none" | undefined => {
            if (!isSortable(header)) return undefined;
            const key = header.sortKey ?? header.key;
            if (activeSortKey() !== key) return "none";
            return activeSortDirection() === "asc" ? "ascending" : "descending";
        };
        const isSortable = (header: TableHeader<T>): boolean =>
            header.sortable !== false && !header.Header && Boolean(header.label) && header.key !== "actions" && Boolean(header.sortKey ?? header.key);

        const sortIcon = (header: TableHeader<T>): string => {
            if (activeSortKey() !== (header.sortKey ?? header.key)) return "mdi-unfold-more-horizontal";
            return activeSortDirection() === "asc" ? "mdi-chevron-up" : "mdi-chevron-down";
        };
        const sortLabel = (header: TableHeader<T>): string => {
            const name = t(header.label ?? header.key);
            if (activeSortKey() !== (header.sortKey ?? header.key)) return `${t("Sort by")} ${name}`;
            return `${t("Sorted")} ${activeSortDirection() === "asc" ? t("ascending") : t("descending")} ${t("by")} ${name}`;
        };

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
                if (!confirmed) return;
            }

            loadingCells.value[cellKey] = true;
            errorCells.value[cellKey] = null;
            try {
                await header.onSubmitEdit({
                    editedValue: state.value[cellKey],
                    index: rowIndex,
                    originalCellValue: (row as any)?.[header.cellEditKey],
                    refreshAsIs: props.refreshAsIs as any,
                    reset: props.reset as any,
                    row,
                });
                clearCellKeyFromEditing(cellKey);
            } catch (error) {
                console.error(error);
                const extracted = config.extractApiError?.(error);
                if (extracted) {
                    errorCells.value[cellKey] = extracted.error ?? extracted.message;
                }
            } finally {
                loadingCells.value[cellKey] = false;
            }
        };

        const isSelected = (key: string | number): boolean => selected.value.includes(key);
        const allRowKeys = (): Array<string | number> => displayRows().map((row, index) => rowKeyOf(row, index));
        const allSelected = (): boolean => {
            const keys = allRowKeys();
            return keys.length > 0 && keys.every((key) => isSelected(key));
        };
        const someSelected = (): boolean => {
            const keys = allRowKeys();
            return keys.some((key) => isSelected(key)) && !allSelected();
        };
        const selectionRows = (keys: Array<string | number>): T[] =>
            displayRows().filter((row, index) => keys.includes(rowKeyOf(row, index)));
        const commitSelection = (keys: Array<string | number>) => {
            selected.value = keys;
            props.onSelectionChange?.(keys, selectionRows(keys));
        };
        const toggleRowSelection = (key: string | number, checked: unknown) => {
            const on = Array.isArray(checked) ? checked.length > 0 : Boolean(checked);
            const keys = on ? [...new Set([...selected.value, key])] : selected.value.filter((entry) => entry !== key);
            commitSelection(keys);
        };
        const toggleAll = (checked: unknown) => {
            const on = Array.isArray(checked) ? checked.length > 0 : Boolean(checked);
            const keys = allRowKeys();
            const next = on
                ? [...new Set([...selected.value, ...keys])]
                : selected.value.filter((entry) => !keys.includes(entry));
            commitSelection(next);
        };

        const onRowClick = (event: MouseEvent, row: T, index: number) => {
            if (typeof props.onRowClick !== "function") return;
            const target = event.target as Element | null;
            if (target?.closest?.(ROW_CLICK_BLOCKERS)) return;
            props.onRowClick(row, index);
        };

        const onScroll = (event: Event) => {
            const element = event.currentTarget as HTMLElement | null;
            if (!element) return;
            element.classList.toggle("pg-table-scroll--scrolled", Math.abs(element.scrollLeft) > 0);
        };

        /**
         * Rows, skeletons and the empty row live in a scoped DynamicFragment:
         * data, sorting, search and selection re-render only `<tbody>`, so the
         * toolbar keeps focus and the table width never jumps.
         */
        const renderSkeletonRow = (rowIndex: number) => {
            const headersList = headers.value;
            return (
                <tr key={`skeleton-${rowIndex}`} class="pg-table-skeleton-row" aria-hidden="true">
                    {props.selectable && (
                        <td class="pg-col-select">
                            <PgSkeleton width="16px" height="16px" />
                        </td>
                    )}
                    {headersList.map((header) => (
                        <td key={header.key} class={header.key === "actions" ? "pg-col-actions" : undefined}>
                            <PgSkeleton width={header.key === "actions" ? "64px" : "70%"} height="12px" />
                        </td>
                    ))}
                </tr>
            );
        };

        const renderRow = (row: T, index: number) => {
            const headersList = headers.value;
            const separatorStyle = "1px solid var(--pg-border-subtle)";
            if (props.Row) {
                return <props.Row key={`${index}`} items={row} />;
            }

            let rowColor: string | undefined;
                              try {
                                  rowColor = props.rowColor?.(row);
                              } catch {
                                  rowColor = undefined;
                              }
                              const tone =
                                  props.rowTone?.(row) ??
                                  (row && typeof row === "object"
                                      ? criticalRowTone(row as Record<string, unknown>, rowColor)
                                      : null);
                              const indicator =
                                  tone === "error" ? "danger" : tone === "neutral" || tone === "primary" ? null : tone;

                              return (
                                  <tr
                                      key={`${index + (props.skip ?? 0)}`}
                                      class={[
                                          "table-data-row",
                                          typeof props.onRowClick === "function" ? "pg-table-row--clickable" : "",
                                          indicator
                                              ? `pg-row-indicator pg-row-indicator--${indicator}`
                                              : props.rowTone
                                                ? "pg-row-indicator"
                                                : "",
                                      ]
                                          .filter(Boolean)
                                          .join(" ")}
                                      aria-selected={
                                          props.selectable ? (isSelected(rowKeyOf(row, index)) ? "true" : "false") : undefined
                                      }
                                      onClick={
                                          typeof props.onRowClick === "function"
                                              ? (event: MouseEvent) => onRowClick(event, row, index)
                                              : undefined
                                      }
                                  >
                                      {props.selectable && (
                                          <td class="pg-col-select">
                                              <label
                                                  class="pg-table-select"
                                                  aria-label={`${t("Select row")} ${index + 1 + (props.skip ?? 0)}`}
                                              >
                                                  <PgCheckbox
                                                      density="compact"
                                                      hideDetails
                                                      modelValue={isSelected(rowKeyOf(row, index))}
                                                      onUpdate:modelValue={(checked: unknown) =>
                                                          toggleRowSelection(rowKeyOf(row, index), checked)
                                                      }
                                                  />
                                              </label>
                                          </td>
                                      )}
                                      {headersList.map((header, headerIndex) => {
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
                                                      <header.Value key={header.key} row={row} />
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
                                                              onUpdate:modelValue={(value: unknown) => {
                                                                  validCells.value[cellKey] = !!value;
                                                              }}
                                                              modelValue={validCells.value[cellKey]}
                                                          >
                                                              <PgView>
                                                                  <PgTextField
                                                                      density={"compact"}
                                                                      loading={loadingCells.value[cellKey]}
                                                                      modelValue={state.value[cellKey]}
                                                                      onUpdate:modelValue={(value: unknown) => {
                                                                          state.value[cellKey] = value;
                                                                      }}
                                                                      prependInnerIcon={"mdi-close"}
                                                                      onClick:prependInner={() => {
                                                                          clearCellKeyFromEditing(cellKey);
                                                                      }}
                                                                      rules={header.rules}
                                                                      disabled={loadingCells.value[cellKey]}
                                                                      appendInnerIcon={"mdi-check"}
                                                                      onClick:appendInner={() => {
                                                                          void submitCell(cellKey, index, row, header);
                                                                      }}
                                                                      errorMessages={
                                                                          errorCells.value[cellKey] ? [errorCells.value[cellKey]] : null
                                                                      }
                                                                  />
                                                              </PgView>
                                                          </PgForm>
                                                      </td>
                                                  );
                                              }

                                              return (
                                                  <td
                                                      class={[
                                                          header.onCellPress ? "table-cell-clickable" : "table-cell",
                                                          header.key === "actions" ? "pg-col-actions" : "",
                                                      ]
                                                          .filter(Boolean)
                                                          .join(" ")}
                                                      style={{
                                                          borderInlineEnd: header.endSeparator ? separatorStyle : undefined,
                                                          borderInlineStart: header.startSeparator ? separatorStyle : undefined,
                                                          cursor: header.onCellPress ? "pointer" : undefined,
                                                      }}
                                                      onClick={
                                                          header.onCellPress
                                                              ? () => {
                                                                    header.onCellPress?.(row, {
                                                                        refresh: props.refresh as any,
                                                                        refreshAsIs: props.refreshAsIs ?? (() => undefined),
                                                                        reset: props.reset ?? (() => undefined),
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
                                                              <PgView
                                                                  class={"show-on-hover"}
                                                                  noHoverable
                                                                  onClick={
                                                                      !header.cellIconOnClick
                                                                          ? undefined
                                                                          : () =>
                                                                                header.cellIconOnClick?.({
                                                                                    row,
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
                                                          ) : null}

                                                          <PgView>{readCell(header.value, row, index)}</PgView>
                                                      </PgView>
                                                  </td>
                                              );
                                          }

                                          return <td key={header.key}> </td>;
                                      })}
                                  </tr>
            );
        };

        const renderEmptyRow = () => (
            <tr class="pg-table-empty-row">
                <td class="pg-table__empty-cell" colspan={columns.value}>
                    {slots?.empty?.() ?? (
                        <PgEmptyState
                            title={props.emptyTitle ?? t("No Data Found")}
                            description={props.emptyDescription ?? t("There are no items to display")}
                            icon="mdi-inbox-outline"
                            actionLabel={props.emptyActionLabel}
                            onAction={() => props.onEmptyAction?.()}
                        />
                    )}
                </td>
            </tr>
        );

        type BodyEntry = { skeleton: number } | { row: T; index: number };
        const isSkeletonEntry = (entry: BodyEntry): entry is { skeleton: number } => "skeleton" in entry;
        const bodyEntries = (): BodyEntry[] => {
            const rows = displayRows();
            if (props.loading && rows.length === 0) {
                return Array.from({ length: props.skeletonRows ?? 6 }, (_, index) => ({ skeleton: index }));
            }
            return rows.map((row, index) => ({ row, index }));
        };
        const headerSignature = computed(() => headers.value.map((header) => header.key).join("|"));
        const bodyKey = (entry: BodyEntry, index: number): string | number =>
            isSkeletonEntry(entry)
                ? `skeleton-${entry.skeleton}`
                : `${rowKeyOf(entry.row, entry.index)}::${headerSignature.value}`;
        const renderEntry = (entryRef: any) => {
            const entry = (entryRef && "value" in entryRef ? entryRef.value : entryRef) as BodyEntry;
            return isSkeletonEntry(entry) ? renderSkeletonRow(entry.skeleton) : renderRow(entry.row, entry.index);
        };

        const renderHeaderCell = (headerRef: any) => {
            const header = (headerRef && "value" in headerRef ? headerRef.value : headerRef) as TableHeader<T>;
            const separatorStyle = "1px solid var(--pg-border-subtle)";
            return (
                <th
                    scope="col"
                    class={header.key === "actions" ? "pg-col-actions" : undefined}
                    aria-sort={ariaSort(header)}
                    style={[
                        {
                            borderInlineEnd: header.endSeparator ? separatorStyle : undefined,
                            borderInlineStart: header.startSeparator ? separatorStyle : undefined,
                            width: header.minWidth ? "1px" : undefined,
                        },
                        header.headerCellStyle,
                    ]}
                >
                    {header.Header ? (
                        <span title={header.headerTooltip ? t(header.headerTooltip) : undefined}>
                            <header.Header key={header.key} />
                        </span>
                    ) : (
                        <PgView
                            class="pg-table__header-inner"
                            onClick={header.onHeaderPress}
                            style={[
                                {
                                    flexDirection: "row",
                                    alignItems: "center",
                                    gap: "6px",
                                    justifyContent: "flex-start",
                                },
                                header.headerCellStyle,
                            ]}
                        >
                            {isSortable(header) ? (
                                <button
                                    type="button"
                                    class="pg-table__sort"
                                    aria-label={sortLabel(header)}
                                    onClick={(event: MouseEvent) => {
                                        event.stopPropagation();
                                        cycleSort(header.sortKey ?? header.key);
                                    }}
                                >
                                    <span class="pg-table__sort-label" style={header.headerTextStyle}>
                                        {t(header.label ?? header.key)}
                                    </span>
                                    <PgIcon icon={sortIcon(header)} size={14} />
                                </button>
                            ) : (
                                header.label && (
                                    <span class="pg-table__header-label" style={header.headerTextStyle}>
                                        {t(header.label)}
                                    </span>
                                )
                            )}

                            {header.headerTooltip && (
                                <PgTooltip text={t(header.headerTooltip)} location="top" maxWidth={420}>
                                    <PgIcon
                                        tabindex={0}
                                        role="button"
                                        aria-label={`${t(header.label ?? header.key)} ${t("help")}`}
                                        icon="mdi-help-circle-outline"
                                        size={14}
                                        style={{ opacity: 0.55, cursor: "help", flex: "0 0 auto" }}
                                    />
                                </PgTooltip>
                            )}

                            {header.headerIcon && <PgIcon {...headerIconProps} icon={header.headerIcon} size={16} />}

                            {header.HeaderIcon && <header.HeaderIcon {...headerIconProps} />}
                        </PgView>
                    )}
                </th>
            );
        };
        const headerKey = (headerRef: any, index: number): string => {
            const header = (headerRef && "value" in headerRef ? headerRef.value : headerRef) as TableHeader<T>;
            return header?.key ?? `header-${index}`;
        };
        const headerBlock = list(() => headers.value, renderHeaderCell, headerKey);

        // `createFor` is the idiomatic Vapor list: rows update and reorder
        // without rebuilding the toolbar or the header.
        const rowsBlock = list(bodyEntries, renderEntry, bodyKey);
        const emptyBlock = branch(
            () => !props.loading && displayRows().length === 0,
            () => renderEmptyRow(),
        );

        return () => {
            const separatorStyle = "1px solid var(--pg-border-subtle)";

            return (
                <div
                    class={[
                        "pg-table-shell",
                        props.density === "compact" ? "pg-table-shell--compact" : "",
                        attrs.class,
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    aria-busy={props.loading ? "true" : undefined}
                >
                    {searchable() && (
                        <div class="pg-table-toolbar pg-table-toolbar--inline">
                            <PgSearchInput
                                class="pg-table-search"
                                modelValue={String(props.searchValue ?? localSearch.value ?? "")}
                                placeholder={props.searchPlaceholder ?? t("Search")}
                                ariaLabel={t("Search")}
                                debounce={0}
                                onUpdate:modelValue={(value: string) => {
                                    localSearch.value = value;
                                    props.setSearchValue?.(value);
                                }}
                            />
                        </div>
                    )}
                    <div class="table-wrapper pg-table-scroll" style={props.tableContainerStyle} onScroll={onScroll}>
                        <table
                            aria-label={typeof props.title === "string" ? t(props.title) : undefined}
                            class="pg-unified-table"
                        >
                            {typeof props.title === "string" && <caption class="pg-sr-only">{t(props.title)}</caption>}
                            <thead>
                                <tr>
                                    {props.selectable && (
                                        <th scope="col" class="pg-col-select">
                                            <label class="pg-table-select" aria-label={t("Select all rows")}>
                                                <PgCheckbox
                                                    density="compact"
                                                    hideDetails
                                                    modelValue={allSelected()}
                                                    indeterminate={someSelected()}
                                                    onUpdate:modelValue={(checked: unknown) => toggleAll(checked)}
                                                />
                                            </label>
                                        </th>
                                    )}
                                    {headerBlock}
                                </tr>
                            </thead>
                            <tbody>{rowsBlock}{emptyBlock}</tbody>
                            {slots?.footer && (
                                <tfoot>
                                    <tr>
                                        <td colspan={columns.value} class="pg-table__footer-cell">
                                            {slots.footer()}
                                        </td>
                                    </tr>
                                </tfoot>
                            )}
                        </table>
                    </div>
                </div>
            );
        };
    },
    {
        props: [
            "Icon",
            "Row",
            "sortBy",
            "sortDirection",
            "onSetSort",
            "onClearSort",
            "placeDividers",
            "data",
            "items",
            "headers",
            "iconName",
            "numberOfItemsPerPage",
            "numberOfItemsPerPageChoices",
            "pageNumber",
            "refresh",
            "rowColor",
            "rowTone",
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
            "loading",
            "onRowClick",
            "rowKey",
            "searchable",
            "searchPlaceholder",
            "emptyTitle",
            "emptyDescription",
            "emptyActionLabel",
            "onEmptyAction",
            "selectable",
            "selectedKeys",
            "onSelectionChange",
            "density",
            "skeletonRows",
        ] as any[],
        slots: ["empty", "footer"],
    },
);

export const PgTable = Table;
export const DataTable = Table;

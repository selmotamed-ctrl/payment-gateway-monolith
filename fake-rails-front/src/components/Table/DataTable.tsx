import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VIcon, VSelect, VTextField } from "vuetify/components";
import { EmptyState } from "@/components/ui/EmptyState";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import TableFilters from "./TableFilters";
import { isFilterActive, type FilterValues, type TableFilter } from "./filters";
import {
  defaultNumberOfItemsPerPageChoices,
  readCell,
  sortRowsByHeader,
  type TableHeader,
} from "./types";

type Row = Record<string, unknown>;

const matchesFilter = (row: Row, filter: TableFilter, value: unknown): boolean => {
  if (!isFilterActive(filter, value)) return true;
  const cell = row[filter.key];

  if (filter.type === "text") {
    return String(cell ?? "").toLowerCase().includes(String(value).toLowerCase());
  }
  if (filter.type === "data-autocomplete" || filter.type === "api-autocomplete") {
    const selected = Array.isArray(value) ? value.map(String) : [String(value)];
    return selected.includes(String(cell ?? ""));
  }
  if (filter.type === "boolean") {
    return Boolean(cell) === (value === true || value === "true");
  }
  if (filter.type === "number-range") {
    const range = value as { min?: string; max?: string };
    const numeric = Number(cell);
    if (Number.isNaN(numeric)) return false;
    if (range.min && numeric < Number(range.min)) return false;
    if (range.max && numeric > Number(range.max)) return false;
    return true;
  }
  if (filter.type === "date") {
    const range = value as { from?: string; to?: string };
    const date = String(cell ?? "").slice(0, 10);
    if (range.from && date < range.from) return false;
    if (range.to && date > range.to) return false;
    return true;
  }
  return true;
};

export const DataTable = defineComponent({
  name: "DataTable",
  props: {
    data: { type: Array as PropType<any[]>, default: () => [] },
    headers: { type: Array as PropType<TableHeader<any>[]>, default: () => [] },
    title: { type: String, default: "" },
    loading: { type: Boolean, default: false },
    searchValue: { type: String as PropType<string | null>, default: undefined },
    setSearchValue: { type: Function as PropType<(text: string | null) => void>, default: undefined },
    numberOfItemsPerPage: { type: Number, default: 10 },
    numberOfItemsPerPageChoices: {
      type: [Array, Boolean] as PropType<false | { label: string; value: number }[]>,
      default: undefined,
    },
    setNumberOfItemsPerPage: { type: Function as PropType<(value: number) => void>, default: undefined },
    showNumber: { type: Boolean, default: false },
    filters: { type: Array as PropType<TableFilter[]>, default: () => [] },
    filterValues: { type: Object as PropType<FilterValues>, default: undefined },
    onFilterChange: { type: Function as PropType<(key: string, value: unknown) => void>, default: undefined },
    onFilterClear: { type: Function as PropType<() => void>, default: undefined },
    filterTotal: { type: Number, default: undefined },
    TopSlot: { type: Function as PropType<(props: { refresh: () => void; reset: () => void; refreshAsIs: () => void }) => JSX.Element>, default: undefined },
  },
  setup(props) {
    const { t } = useLocale();
    const internalSearch = ref<string | null>(null);
    const internalFilters = ref<FilterValues>({});
    const sortBy = ref<string | null>(null);
    const sortDirection = ref<"asc" | "desc">("asc");
    const skip = ref(0);
    const filtersOpen = ref(true);

    const search = computed(() =>
      props.searchValue !== undefined ? props.searchValue : internalSearch.value,
    );
    const filterValues = computed(() => props.filterValues ?? internalFilters.value);
    const perPage = computed(() => props.numberOfItemsPerPage || 10);

    const updateSearch = (value: string | null) => {
      if (props.setSearchValue) {
        props.setSearchValue(value);
      } else {
        internalSearch.value = value;
      }
    };

    const updateFilter = (key: string, value: unknown) => {
      if (props.onFilterChange) {
        props.onFilterChange(key, value);
      } else {
        internalFilters.value = { ...internalFilters.value, [key]: value };
      }
    };

    const clearFilters = () => {
      if (props.onFilterClear) {
        props.onFilterClear();
      } else {
        internalFilters.value = {};
      }
    };

    const headers = computed<TableHeader<any>[]>(() => {
      if (!props.showNumber) return props.headers;
      return [
        {
          key: "__no",
          label: "No.",
          sortable: false,
          minWidth: true,
          value: (_, index) => String(skip.value + index + 1),
        },
        ...props.headers,
      ];
    });

    const filteredRows = computed(() => {
      let rows = (props.data ?? []) as Row[];
      const query = search.value?.trim().toLowerCase();
      if (query) {
        rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query));
      }
      if (props.filters?.length) {
        rows = rows.filter((row) =>
          props.filters.every((filter) => matchesFilter(row, filter, filterValues.value[filter.key])),
        );
      }
      return sortRowsByHeader(rows, headers.value, sortBy.value, sortDirection.value);
    });

    const total = computed(() => filteredRows.value.length);
    const numberOfPages = computed(() => (perPage.value < 1 ? 1 : Math.ceil(total.value / perPage.value) || 1));
    const currentPage = computed(() => (perPage.value < 1 ? 1 : Math.floor(skip.value / perPage.value) + 1));
    const pageRows = computed(() => {
      if (perPage.value < 1) return filteredRows.value;
      return filteredRows.value.slice(skip.value, skip.value + perPage.value);
    });

    const goToPage = (page: number) => {
      if (page < 1 || page > numberOfPages.value) return;
      skip.value = (page - 1) * perPage.value;
    };

    const reset = () => {
      skip.value = 0;
    };
    const refresh = () => {
      skip.value = Math.min(skip.value, Math.max(0, (numberOfPages.value - 1) * perPage.value));
    };

    watch([filteredRows, perPage], () => {
      if (skip.value > Math.max(0, filteredRows.value.length - 1)) {
        skip.value = 0;
      }
    });

    const sort = (header: TableHeader<any>) => {
      if (header.sortable === false || header.key === "__no") return;
      const key = header.sortKey ?? header.key;
      if (sortBy.value === key) {
        sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
      } else {
        sortBy.value = key;
        sortDirection.value = "asc";
      }
      reset();
    };

    const renderCell = (header: TableHeader<any>, row: any, index: number) => {
      if (header.Value) {
        return <header.Value row={row} />;
      }
      if (header.value !== undefined) {
        return readCell(header.value, row, index);
      }
      return String(row[header.key] ?? "");
    };

    return (): VNodeChild => {
      const first = total.value === 0 ? 0 : skip.value + 1;
      const last = Math.min(skip.value + perPage.value, total.value);
      const choices = props.numberOfItemsPerPageChoices === undefined
        ? defaultNumberOfItemsPerPageChoices
        : props.numberOfItemsPerPageChoices || undefined;

      return (
        <SurfaceCard noPadding class="pg-table-card pg-unified-table">
          <div class="pg-table-toolbar">
            <div class="pg-table-toolbar__left">
              <div class="pg-table-toolbar__group">
                {props.title && <span class="pg-table-toolbar__title">{t(props.title)}</span>}
                <span class="pg-record-count pg-tabular">{total.value} {t("records")}</span>
              </div>
            </div>
            <div class="pg-table-toolbar__right">
              <div class="pg-table-toolbar__group pg-table-toolbar__group--end">
                <VTextField
                  class="pg-table-search"
                  density="compact"
                  variant="outlined"
                  hideDetails
                  clearable
                  prependInnerIcon="mdi-magnify"
                  placeholder={t("Search")}
                  modelValue={search.value ?? ""}
                  onUpdate:modelValue={(value: string) => updateSearch(value || null)}
                />
                {props.filters?.length ? (
                  <VBtn
                    size="small"
                    variant={filtersOpen.value ? "tonal" : "outlined"}
                    prependIcon="mdi-filter-variant"
                    onClick={() => (filtersOpen.value = !filtersOpen.value)}
                  >
                    {t("Filters")}
                  </VBtn>
                ) : null}
                <VBtn
                  size="small"
                  variant="text"
                  icon="mdi-refresh"
                  aria-label={t("Refresh")}
                  onClick={refresh}
                />
              </div>
            </div>
          </div>

          {props.TopSlot ? props.TopSlot({ refresh, reset, refreshAsIs: refresh }) : null}

          {props.filters?.length ? (
            <TableFilters
              filters={props.filters}
              values={filterValues.value}
              onChange={updateFilter}
              onClear={clearFilters}
              expanded={filtersOpen.value}
              total={props.filterTotal}
            />
          ) : null}

          {props.loading ? (
            <div class="pg-table-loading">
              <span class="pg-muted">{t("Loading")}…</span>
            </div>
          ) : pageRows.value.length === 0 ? (
            <EmptyState title={t("No Data Found")} description={t("There are no items to display")} icon="mdi-inbox-outline" />
          ) : (
            <div class="table-wrapper">
              <table>
                <thead>
                  <tr>
                    {headers.value.map((header) => {
                      const active = sortBy.value === (header.sortKey ?? header.key);
                      return (
                        <th
                          key={header.key}
                          scope="col"
                          class={header.key === "actions" ? "pg-col-actions" : undefined}
                          style={{
                            width: header.minWidth ? "1px" : undefined,
                            cursor: header.sortable === false ? undefined : "pointer",
                            textAlign: header.key === "actions" ? "end" : undefined,
                          }}
                          aria-sort={
                            header.sortable === false
                              ? undefined
                              : active
                                ? sortDirection.value === "asc"
                                  ? "ascending"
                                  : "descending"
                                : "none"
                          }
                          onClick={() => sort(header)}
                        >
                          <span>{header.label ? t(header.label) : ""}</span>
                          {header.sortable !== false && header.label ? (
                            <VIcon
                              size={13}
                              icon={!active ? "mdi-unfold-more-horizontal" : sortDirection.value === "asc" ? "mdi-chevron-up" : "mdi-chevron-down"}
                              style={{ marginInlineStart: "4px", opacity: active ? 1 : 0.5 }}
                            />
                          ) : null}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.value.map((row, index) => (
                    <tr key={String(row.id ?? row.key ?? index)} class="table-data-row">
                      {headers.value.map((header) => (
                        <td
                          key={header.key}
                          class={header.key === "actions" ? "pg-col-actions" : undefined}
                          style={header.rowCellStyle}
                        >
                          {header.key === "actions" ? (
                            renderCell(header, row, index)
                          ) : (
                            <span class="pg-cell-truncate">{renderCell(header, row, index)}</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div class="pg-table-footer">
            <span class="pg-record-count pg-tabular">
              {t("Showing")} {first}-{last} {t("of")} {total.value}
            </span>
            <div class="pg-pagination">
              {choices && props.setNumberOfItemsPerPage ? (
                <VSelect
                  class="pg-page-size"
                  aria-label={t("Rows per page")}
                  density="compact"
                  variant="outlined"
                  hideDetails
                  items={choices}
                  itemTitle="label"
                  itemValue="value"
                  modelValue={perPage.value}
                  onUpdate:modelValue={(value: number) => props.setNumberOfItemsPerPage?.(value)}
                />
              ) : null}
              <button
                type="button"
                class="pg-pagination-button"
                disabled={currentPage.value <= 1}
                aria-label={t("Previous page")}
                onClick={() => goToPage(currentPage.value - 1)}
              >
                <VIcon icon="mdi-chevron-left" size={16} />
              </button>
              <span class="pg-record-count pg-tabular">
                {currentPage.value} / {numberOfPages.value}
              </span>
              <button
                type="button"
                class="pg-pagination-button"
                disabled={currentPage.value >= numberOfPages.value}
                aria-label={t("Next page")}
                onClick={() => goToPage(currentPage.value + 1)}
              >
                <VIcon icon="mdi-chevron-right" size={16} />
              </button>
            </div>
          </div>
        </SurfaceCard>
      );
    };
  },
});

export default DataTable;

import { computed, defineComponent, onMounted, ref, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VAutocomplete, VBtn, VIcon, VSelect, VTextField } from "vuetify/components";
import {
  activeFilterCount,
  isFilterActive,
  type FilterOption,
  type FilterValues,
  type TableFilter,
} from "./filters";

const filterSummary = (
  filter: TableFilter,
  value: unknown,
  optionMap: Record<string, FilterOption[]>,
  t: (key: string) => string,
): string => {
  if (!isFilterActive(filter, value)) return "";
  if (filter.type === "boolean") {
    return value === "true" || value === true ? t(filter.trueLabel ?? "Yes") : t(filter.falseLabel ?? "No");
  }
  if (filter.type === "number-range") {
    const range = value as { min?: string; max?: string };
    return [range.min, range.max].filter(Boolean).join(" – ");
  }
  if (filter.type === "date") {
    const range = value as { from?: string; to?: string };
    if (range.from && range.to) return `${range.from} → ${range.to}`;
    if (range.from) return `${t("From")} ${range.from}`;
    if (range.to) return `${t("Until")} ${range.to}`;
    return "";
  }
  if (Array.isArray(value)) {
    if (filter.type === "data-autocomplete") {
      return value
        .map((entry) => filter.options.find((option) => option.value === String(entry))?.title ?? entry)
        .join(", ");
    }
    return value.join(", ");
  }
  if (filter.type === "data-autocomplete") {
    return filter.options.find((option) => option.value === String(value))?.title ?? String(value);
  }
  if (filter.type === "api-autocomplete") {
    return optionMap[filter.key]?.find((option) => option.value === String(value))?.title ?? String(value);
  }
  return String(value ?? "");
};

export const TableFilters = defineComponent({
  name: "TableFilters",
  props: {
    filters: { type: Array as PropType<TableFilter[]>, default: () => [] },
    values: { type: Object as PropType<FilterValues>, default: () => ({}) },
    onChange: { type: Function as PropType<(key: string, value: unknown) => void>, required: true },
    onClear: { type: Function as PropType<() => void>, required: true },
    expanded: { type: Boolean, default: true },
    total: { type: Number, default: undefined },
  },
  setup(props) {
    const { t } = useLocale();
    const apiOptions = ref<Record<string, FilterOption[]>>({});
    const apiLoading = ref<Record<string, boolean>>({});

    const active = computed(() =>
      (props.filters ?? []).filter((filter) => isFilterActive(filter, props.values[filter.key])),
    );
    const count = computed(() => activeFilterCount(props.filters ?? [], props.values));

    const loadOptions = async (filter: Extract<TableFilter, { type: "api-autocomplete" }>, search = "") => {
      apiLoading.value = { ...apiLoading.value, [filter.key]: true };
      try {
        const items = await filter.load(search);
        apiOptions.value = { ...apiOptions.value, [filter.key]: items };
      } catch {
        apiOptions.value = { ...apiOptions.value, [filter.key]: [] };
      } finally {
        apiLoading.value = { ...apiLoading.value, [filter.key]: false };
      }
    };

    onMounted(() => {
      for (const filter of props.filters ?? []) {
        if (filter.type === "api-autocomplete") void loadOptions(filter);
      }
    });

    return (): VNodeChild => {
      if (!props.filters?.length) return null;
      return (
        <div class="pg-table-filters">
          {props.expanded && (
            <div
              class="pg-table-filters__grid"
              style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}
            >
              {props.filters.map((filter) => {
                const value = props.values[filter.key];
                const wide = filter.type === "date" || filter.type === "number-range";
                return (
                  <div
                    key={filter.key}
                    class="pg-table-filters__field pg-field-wrapper"
                    style={{ gridColumn: wide ? "span 2" : undefined }}
                  >
                    <label>{t(filter.label)}</label>
                    {filter.type === "boolean" ? (
                      <VSelect
                        items={[
                          { title: t(filter.trueLabel ?? "Yes"), value: "true" },
                          { title: t(filter.falseLabel ?? "No"), value: "false" },
                        ]}
                        itemTitle="title"
                        itemValue="value"
                        modelValue={value ?? null}
                        onUpdate:modelValue={(next: unknown) => props.onChange(filter.key, next)}
                        clearable
                        density="compact"
                        variant="outlined"
                        hideDetails
                        placeholder={t("Any")}
                      />
                    ) : filter.type === "data-autocomplete" ? (
                      <VAutocomplete
                        items={filter.options}
                        itemTitle="title"
                        itemValue="value"
                        multiple={filter.multiple}
                        chips={filter.multiple}
                        clearable
                        density="compact"
                        variant="outlined"
                        hideDetails
                        placeholder={t(filter.placeholder ?? "Any")}
                        modelValue={(value ?? (filter.multiple ? [] : null)) as never}
                        onUpdate:modelValue={(next: unknown) => props.onChange(filter.key, next)}
                      />
                    ) : filter.type === "api-autocomplete" ? (
                      <VAutocomplete
                        items={apiOptions.value[filter.key] ?? []}
                        itemTitle="title"
                        itemValue="value"
                        multiple={filter.multiple}
                        chips={filter.multiple}
                        clearable
                        density="compact"
                        variant="outlined"
                        hideDetails
                        loading={apiLoading.value[filter.key]}
                        placeholder={t(filter.placeholder ?? "Any")}
                        modelValue={(value ?? (filter.multiple ? [] : null)) as never}
                        onUpdate:modelValue={(next: unknown) => props.onChange(filter.key, next)}
                        onUpdate:search={(search: string) => void loadOptions(filter, search)}
                      />
                    ) : filter.type === "date" ? (
                      <div class="pg-filter-range">
                        <div class="pg-filter-range__field">
                          <VTextField
                            type="date"
                            density="compact"
                            variant="outlined"
                            hideDetails
                            modelValue={(value as { from?: string } | undefined)?.from ?? ""}
                            onUpdate:modelValue={(next: string) =>
                              props.onChange(filter.key, { ...(value as object), from: next })
                            }
                          />
                        </div>
                        <div class="pg-filter-range__field">
                          <VTextField
                            type="date"
                            density="compact"
                            variant="outlined"
                            hideDetails
                            modelValue={(value as { to?: string } | undefined)?.to ?? ""}
                            onUpdate:modelValue={(next: string) =>
                              props.onChange(filter.key, { ...(value as object), to: next })
                            }
                          />
                        </div>
                      </div>
                    ) : filter.type === "number-range" ? (
                      <div class="pg-filter-range">
                        <div class="pg-filter-range__field">
                          <VTextField
                            type="number"
                            density="compact"
                            variant="outlined"
                            hideDetails
                            placeholder={t("Min")}
                            suffix={filter.suffix}
                            modelValue={(value as { min?: string } | undefined)?.min ?? ""}
                            onUpdate:modelValue={(next: string) =>
                              props.onChange(filter.key, { ...(value as object), min: next })
                            }
                          />
                        </div>
                        <div class="pg-filter-range__field">
                          <VTextField
                            type="number"
                            density="compact"
                            variant="outlined"
                            hideDetails
                            placeholder={t("Max")}
                            suffix={filter.suffix}
                            modelValue={(value as { max?: string } | undefined)?.max ?? ""}
                            onUpdate:modelValue={(next: string) =>
                              props.onChange(filter.key, { ...(value as object), max: next })
                            }
                          />
                        </div>
                      </div>
                    ) : (
                      <VTextField
                        density="compact"
                        variant="outlined"
                        hideDetails
                        clearable
                        placeholder={t(filter.placeholder ?? "Any")}
                        modelValue={value ?? ""}
                        onUpdate:modelValue={(next: string) => props.onChange(filter.key, next)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {active.value.length > 0 && (
            <div class="pg-table-filters__active">
              <div class="pg-table-filters__chips">
                {active.value.map((filter) => (
                  <span key={filter.key} class="pg-filter-chip">
                    <span class="pg-filter-chip__label">{t(filter.label)}:</span>
                    <span class="pg-filter-chip__value">
                      {filterSummary(filter, props.values[filter.key], apiOptions.value, t)}
                    </span>
                    <button
                      type="button"
                      class="pg-filter-chip__remove"
                      aria-label={`${t("Remove filter")}: ${t(filter.label)}`}
                      onClick={() => props.onChange(filter.key, undefined)}
                    >
                      <VIcon icon="mdi-close" size={12} />
                    </button>
                  </span>
                ))}
              </div>
              <VBtn size="small" variant="text" prependIcon="mdi-filter-remove-outline" onClick={() => props.onClear()}>
                {t("Clear all")}
              </VBtn>
            </div>
          )}
          {props.total !== undefined && (
            <span class="pg-record-count pg-tabular">
              {props.total} {t("records")}
            </span>
          )}
        </div>
      );
    };
  },
});

export default TableFilters;

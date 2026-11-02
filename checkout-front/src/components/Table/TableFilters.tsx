import { dc } from "kt-dc";
import { computed, inject, onBeforeUnmount, onMounted, ref, watchEffect, type InjectionKey, type Ref } from "vue";
import { useDisplay, useLocale } from "vuetify";
import { VAutocomplete, VBtn, VIcon, VTextField } from "vuetify/components";
import DateInput from "@/components/DateInput";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import {
    activeFilterCount,
    isFilterActive,
    type FilterOption,
    type FilterValues,
    type TableFilter,
} from "./filters";

export interface TableFilterSurface {
    activeCount: Ref<number>;
    hasFilters: Ref<boolean>;
    open: Ref<boolean>;
    toggle: () => void;
}

export const tableFilterSurfaceKey: InjectionKey<TableFilterSurface> = Symbol("pg-table-filter-surface");

export const createTableFilterSurface = (initialOpen: boolean): TableFilterSurface => {
    const open = ref(initialOpen);
    return {
        activeCount: ref(0),
        hasFilters: ref(false),
        open,
        toggle: () => {
            open.value = !open.value;
        },
    };
};

const toIsoDate = (value: Date): string => {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
};

const filterSummary = (filter: TableFilter, value: unknown, t: (key: string) => string): string => {
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
            return value.map((entry) => filter.options.find((option) => option.value === String(entry))?.title ?? entry).join(", ");
        }
        return value.join(", ");
    }
    if (filter.type === "data-autocomplete") {
        return filter.options.find((option) => option.value === String(value))?.title ?? String(value);
    }
    return String(value ?? "");
};

/* ------------------------------------------------------------------ controls */

const ApiAutocompleteControl = dc(
    (props: { filter: Extract<TableFilter, { type: "api-autocomplete" }>; value: unknown; onChange: (value: unknown) => void }) => {
        const { t } = useLocale();
        const options = ref<FilterOption[]>([]);
        const loading = ref(false);
        const error = ref<string | null>(null);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let sequence = 0;

        const load = async (search = "") => {
            const mine = ++sequence;
            loading.value = true;
            error.value = null;
            try {
                const items = await props.filter.load(search);
                if (mine === sequence) options.value = items;
            } catch (cause) {
                if (mine === sequence) error.value = extractApiErrorMessage(cause);
            } finally {
                if (mine === sequence) loading.value = false;
            }
        };

        onMounted(() => void load(""));

        return () => (
            <div class="pg-filter-control">
                <VAutocomplete
                    aria-label={t(props.filter.label)}
                    placeholder={t(props.filter.placeholder ?? "Any")}
                    prependInnerIcon={props.filter.icon ?? "mdi-filter-variant"}
                    items={options.value}
                    itemTitle="title"
                    itemValue="value"
                    multiple={props.filter.multiple}
                    chips={props.filter.multiple}
                    clearable
                    density="compact"
                    variant="outlined"
                    hideDetails
                    loading={loading.value}
                    modelValue={(props.value ?? (props.filter.multiple ? [] : null)) as any}
                    onUpdate:modelValue={(value: any) => props.onChange(value)}
                    onUpdate:search={(query: string) => {
                        if (timer) clearTimeout(timer);
                        timer = setTimeout(() => void load(query), 250);
                    }}
                >
                    {{
                        "prepend-inner": () => (
                            <VBtn
                                icon
                                size="x-small"
                                variant="text"
                                aria-label={t("Refresh options")}
                                onClick={() => void load("")}
                            >
                                <VIcon icon="mdi-refresh" size="18" />
                            </VBtn>
                        ),
                    }}
                </VAutocomplete>
                {error.value && (
                    <div role="alert" aria-live="assertive" class="pg-filter-error">
                        <VIcon icon="mdi-alert-circle-outline" size="14" aria-hidden="true" />
                        <span class="pg-filter-error__message">{error.value}</span>
                        <VBtn size="x-small" variant="text" onClick={() => void load("")}>
                            {t("Retry")}
                        </VBtn>
                    </div>
                )}
            </div>
        );
    },
    { props: ["filter", "value", "onChange"] },
);

const DataAutocompleteControl = dc(
    (props: { filter: Extract<TableFilter, { type: "data-autocomplete" | "boolean" }>; value: unknown; onChange: (value: unknown) => void }) => {
        const { t } = useLocale();
        const items = computed<FilterOption[]>(() => {
            if (props.filter.type === "boolean") {
                return [
                    { title: t(props.filter.trueLabel ?? "Yes"), value: "true", tone: "success" },
                    { title: t(props.filter.falseLabel ?? "No"), value: "false", tone: "error" },
                ];
            }
            return props.filter.options;
        });
        const multiple = props.filter.type === "data-autocomplete" && props.filter.multiple === true;
        return () => (
            <VAutocomplete
                aria-label={t(props.filter.label)}
                placeholder={t("Any")}
                prependInnerIcon={props.filter.icon ?? "mdi-filter-variant"}
                items={items.value}
                itemTitle="title"
                itemValue="value"
                multiple={multiple}
                chips={multiple}
                clearable
                density="compact"
                variant="outlined"
                hideDetails
                modelValue={(props.value ?? (multiple ? [] : null)) as any}
                onUpdate:modelValue={(value: any) => props.onChange(value)}
            />
        );
    },
    { props: ["filter", "value", "onChange"] },
);

const DateControl = dc(
    (props: { label: string; value: unknown; onChange: (value: unknown) => void }) => {
        const { t } = useLocale();
        const range = computed(() => (props.value ?? {}) as { from?: string; to?: string });
        const model = computed<Date[]>(() => {
            const from = range.value.from ? new Date(`${range.value.from}T12:00:00`) : undefined;
            const to = range.value.to ? new Date(`${range.value.to}T12:00:00`) : undefined;
            const first = from ?? to;
            const last = to ?? from;
            return first && last ? [first, last] : [];
        });
        const update = (value: Date[] | Date | null) => {
            const dates = (Array.isArray(value) ? value : value ? [value] : []).filter(
                (date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()),
            );
            if (dates.length === 0) {
                props.onChange(undefined);
                return;
            }
            props.onChange({ from: toIsoDate(dates[0]!), to: toIsoDate(dates[dates.length - 1]!) });
        };
        return () => (
            <DateInput
                multiple="range"
                aria-label={t(props.label)}
                placeholder={t("Select date range")}
                prependInnerIcon="mdi-calendar-range"
                density="compact"
                variant="outlined"
                hideDetails
                clearable
                modelValue={model.value}
                onUpdate:modelValue={(value: any) => update(value)}
            />
        );
    },
    { props: ["label", "value", "onChange"] },
);

const NumberRangeControl = dc(
    (props: { filter: Extract<TableFilter, { type: "number-range" }>; value: unknown; onChange: (value: unknown) => void }) => {
        const { t } = useLocale();
        const range = computed(() => (props.value ?? {}) as { min?: string; max?: string });
        return () => (
            <div class="pg-filter-range">
                <div class="pg-filter-range__field">
                    <VTextField
                        aria-label={`${t(props.filter.label)} ${t("Min")}`}
                        placeholder={t("Min")}
                        type="number"
                        density="compact"
                        variant="outlined"
                        hideDetails
                        suffix={props.filter.suffix}
                        modelValue={range.value.min ?? ""}
                        onUpdate:modelValue={(value: string) => props.onChange({ ...range.value, min: value })}
                    />
                </div>
                <div class="pg-filter-range__field">
                    <VTextField
                        aria-label={`${t(props.filter.label)} ${t("Max")}`}
                        placeholder={t("Max")}
                        type="number"
                        density="compact"
                        variant="outlined"
                        hideDetails
                        suffix={props.filter.suffix}
                        modelValue={range.value.max ?? ""}
                        onUpdate:modelValue={(value: string) => props.onChange({ ...range.value, max: value })}
                    />
                </div>
            </div>
        );
    },
    { props: ["filter", "value", "onChange"] },
);

/* -------------------------------------------------------------------- panel */

const TableFilters = dc(
    (props: {
        filters: TableFilter[];
        values: FilterValues;
        onChange: (key: string, value: unknown) => void;
        onClear: () => void;
        total?: number;
    }) => {
        const { t } = useLocale();
        const display = useDisplay();
        const surface = inject(tableFilterSurfaceKey, null);
        const localOpen = ref(!display.mobile.value);
        const open = computed(() => (surface ? surface.open.value : localOpen.value));
        const contentId = `pg-table-filters-${Math.random().toString(36).slice(2, 10)}`;

        // LG gets three roomy columns, XL four; never cram.
        const columns = computed(() => {
            if (display.xl.value) return 4;
            if (display.lg.value) return 3;
            if (display.md.value) return 2;
            return 1;
        });

        const filters = computed(() => props.filters ?? []);
        const count = computed(() => activeFilterCount(filters.value, props.values));
        const active = computed(() => filters.value.filter((filter) => isFilterActive(filter, props.values[filter.key])));

        watchEffect(() => {
            if (!surface) return;
            surface.hasFilters.value = filters.value.length > 0;
            surface.activeCount.value = count.value;
        });

        onBeforeUnmount(() => {
            if (!surface) return;
            surface.hasFilters.value = false;
            surface.activeCount.value = 0;
        });

        const toggle = () => {
            if (surface) {
                surface.toggle();
                return;
            }
            localOpen.value = !localOpen.value;
        };

        return () => {
            if (filters.value.length === 0) {
                return null;
            }
            if (surface && !open.value && active.value.length === 0) {
                return null;
            }

            return (
                <div class="pg-table-filters">
                    {!surface && (
                        <div class="pg-table-filters__toolbar">
                            <VBtn
                                size="small"
                                variant={count.value > 0 ? "tonal" : "outlined"}
                                prependIcon="mdi-filter-variant"
                                aria-expanded={open.value ? "true" : "false"}
                                aria-controls={contentId}
                                onClick={toggle}
                            >
                                {t("Filters")}
                                {count.value > 0 ? <span class="pg-filter-trigger__badge pg-tabular">{count.value}</span> : null}
                            </VBtn>
                            {props.total !== undefined && (
                                <span class="pg-record-count pg-tabular">
                                    {props.total} {t("records")}
                                </span>
                            )}
                        </div>
                    )}

                    {open.value && (
                        <div
                            id={contentId}
                            class="pg-table-filters__grid"
                            style={{ gridTemplateColumns: `repeat(${columns.value}, minmax(0, 1fr))` }}
                        >
                            {filters.value.map((filter) => {
                                const value = props.values[filter.key];
                                const onChange = (next: unknown) => props.onChange(filter.key, next);
                                const wide = filter.type === "date" || filter.type === "number-range";
                                return (
                                    <div
                                        key={filter.key}
                                        class="pg-table-filters__field"
                                        style={{ gridColumn: wide && columns.value > 1 ? "span 2" : undefined }}
                                    >
                                        <span class="pg-filter-label">{t(filter.label)}</span>
                                        {filter.type === "api-autocomplete" ? (
                                            <ApiAutocompleteControl filter={filter} value={value} onChange={onChange} />
                                        ) : filter.type === "data-autocomplete" || filter.type === "boolean" ? (
                                            <DataAutocompleteControl filter={filter} value={value} onChange={onChange} />
                                        ) : filter.type === "date" ? (
                                            <DateControl label={filter.label} value={value} onChange={onChange} />
                                        ) : filter.type === "number-range" ? (
                                            <NumberRangeControl filter={filter} value={value} onChange={onChange} />
                                        ) : (
                                            <VTextField
                                                aria-label={t(filter.label)}
                                                placeholder={t(filter.placeholder ?? "Any")}
                                                prependInnerIcon={filter.icon ?? "mdi-magnify"}
                                                density="compact"
                                                variant="outlined"
                                                hideDetails
                                                clearable
                                                modelValue={value ?? ""}
                                                onUpdate:modelValue={(next: string) => onChange(next)}
                                            />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {active.value.length > 0 && (
                        <div class="pg-table-active-chips pg-table-filters__active">
                            <div class="pg-table-filters__chips">
                                {active.value.map((filter) => (
                                    <span key={filter.key} class="pg-filter-chip">
                                        <span class="pg-filter-chip__label">{t(filter.label)}:</span>
                                        <span class="pg-filter-chip__value">
                                            {filterSummary(filter, props.values[filter.key], t)}
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
                                {t("Clear all filters")}
                            </VBtn>
                        </div>
                    )}
                </div>
            );
        };
    },
    { props: ["filters", "values", "onChange", "onClear", "total"] },
);

export default TableFilters;

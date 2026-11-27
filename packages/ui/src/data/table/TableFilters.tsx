import { createIf } from "@vue/runtime-vapor";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { dc } from "../../lib/dc";
import { computed, inject, onBeforeUnmount, ref, watch, watchEffect, type InjectionKey, type Ref } from "vue";
import { useLocale } from "../../lib/locale";
import { useDisplay } from "../../lib/display";
import { PgAutocomplete } from "../../inputs/PgAutocomplete";
import { PgApiAutocomplete } from "../../inputs/PgApiAutocomplete";
import { PgDateInput, PgDateRangeInput } from "../../inputs/PgDateInput";
import { PgButton as VBtn } from "../../actions/PgButton";
import { PgIcon as VIcon } from "../../actions/PgIcon";
import { PgTextField as VTextField } from "../../inputs/PgTextField";
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

/**
 * Declarative filter schema. The legacy Vuetify-era names
 * (`data-autocomplete`, `api-autocomplete`, `number-range`) are aliases of the
 * 2026 names (`select` / `multiselect`, `apiAutocomplete`, `numberRange`).
 */
type AnyFilter = {
    key: string;
    label: string;
    icon?: string;
    /** Query parameter name (defaults to `key`). */
    query?: string;
    queryFrom?: string;
    queryTo?: string;
    queryMin?: string;
    queryMax?: string;
    type:
        | TableFilter["type"]
        | "select"
        | "multiselect"
        | "daterange"
        | "numberRange"
        | "apiAutocomplete";
    options?: FilterOption[];
    load?: (search: string) => Promise<FilterOption[]>;
    multiple?: boolean;
    /** `date` is a range by default (legacy); `single: true` is one date. */
    single?: boolean;
    range?: boolean;
    placeholder?: string;
    initialOptions?: FilterOption[];
    resolveSelected?: (values: any[]) => Promise<FilterOption[]>;
    trueLabel?: string;
    falseLabel?: string;
    suffix?: string;
};

type FilterKind =
    | "text"
    | "select"
    | "multiselect"
    | "date"
    | "daterange"
    | "boolean"
    | "numberRange"
    | "apiAutocomplete";

const kindOf = (filter: AnyFilter): FilterKind => {
    switch (filter.type) {
        case "data-autocomplete":
            return filter.multiple ? "multiselect" : "select";
        case "select":
        case "multiselect":
        case "daterange":
        case "numberRange":
        case "apiAutocomplete":
            return filter.type;
        case "api-autocomplete":
            return "apiAutocomplete";
        case "number-range":
            return "numberRange";
        case "date":
            return filter.single === true ? "date" : "daterange";
        case "boolean":
            return "boolean";
        default:
            return "text";
    }
};

const asRange = (value: unknown): { from: string; to: string } => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const range = value as Record<string, unknown>;
        return {
            from: String(range.from ?? range.start ?? ""),
            to: String(range.to ?? range.end ?? ""),
        };
    }
    if (typeof value === "string" && value) {
        return { from: value, to: value };
    }
    return { from: "", to: "" };
};

const optionTitle = (filter: AnyFilter, value: unknown): string => {
    const options = filter.options ?? [];
    const option = options.find((entry) => String(entry.value) === String(value));
    return option?.title ?? String(value ?? "");
};

const filterSummary = (
    filter: AnyFilter,
    value: unknown,
    t: (key: string) => string,
    apiLabels: Record<string, string> = {},
): string => {
    if (!isFilterActive(filter as TableFilter, value)) return "";
    const kind = kindOf(filter);
    if (kind === "boolean") {
        return value === "true" || value === true
            ? t(filter.trueLabel ?? "Yes")
            : t(filter.falseLabel ?? "No");
    }
    if (kind === "numberRange") {
        const range = value as { min?: string; max?: string };
        return [range.min, range.max].filter(Boolean).join(" – ");
    }
    if (kind === "date") {
        return String(value ?? "");
    }
    if (kind === "daterange") {
        const range = asRange(value);
        if (range.from && range.to) return `${range.from} → ${range.to}`;
        if (range.from) return `${t("From")} ${range.from}`;
        if (range.to) return `${t("Until")} ${range.to}`;
        return "";
    }
    if (kind === "apiAutocomplete") {
        if (Array.isArray(value)) {
            return value
                .map((entry) => apiLabels[String(entry)] ?? String(entry))
                .join(", ");
        }
        return apiLabels[String(value)] ?? String(value ?? "");
    }
    if (Array.isArray(value)) {
        return value
            .map((entry) => optionTitle(filter, entry))
            .join(", ");
    }
    return optionTitle(filter, value);
};

/* ------------------------------------------------------------------ controls */

const ApiAutocompleteControl = dc(
    (
        props: {
            filter: AnyFilter;
            value: unknown;
            onChange: (value: unknown) => void;
            onOptions: (options: FilterOption[]) => void;
        },
    ) => {
        const { t } = useLocale();
        const load = props.filter.load ?? (async () => []);
        return () => (
            <PgApiAutocomplete
                aria-label={t(props.filter.label)}
                placeholder={t(props.filter.placeholder ?? "Any")}
                items={props.filter.initialOptions ?? (Array.isArray(props.filter.options) ? props.filter.options : [])}
                fetcher={async (query: string) => {
                    const items = await load(query);
                    props.onOptions(items);
                    return { items, hasMore: false };
                }}
                resolveSelected={
                    props.filter.resolveSelected
                        ? async (values: any[]) => props.filter.resolveSelected!(values)
                        : undefined
                }
                itemTitle="title"
                itemValue="value"
                itemSubtitle="subtitle"
                multiple={props.filter.multiple}
                clearable
                density="compact"
                hideDetails
                modelValue={(props.value ?? (props.filter.multiple ? [] : null)) as any}
                onUpdate:modelValue={(value: any) => props.onChange(value)}
                onSelect={() => undefined}
                onOpen={() => undefined}
            />
        );
    },
    {
        props: {
            filter: { type: Object, default: () => ({}) },
            value: { type: null, default: undefined },
            onChange: { type: Function, default: undefined },
            onOptions: { type: Function, default: undefined },
        },
    },
);

const EMPTY_SELECTION: any[] = [];

const SelectControl = dc(
    (
        props: {
            filter: AnyFilter;
            value: unknown;
            onChange: (value: unknown) => void;
        },
    ) => {
        const { t } = useLocale();
        const multiple = computed(() => kindOf(props.filter) === "multiselect");
        const items = computed<FilterOption[]>(() => {
            if (kindOf(props.filter) === "boolean") {
                return [
                    { title: t(props.filter.trueLabel ?? "Yes"), value: "true", tone: "success" },
                    { title: t(props.filter.falseLabel ?? "No"), value: "false", tone: "error" },
                ];
            }
            return props.filter.options ?? [];
        });
        return () => (
            <PgAutocomplete
                aria-label={t(props.filter.label)}
                placeholder={t(props.filter.placeholder ?? "Any")}
                items={items.value}
                itemTitle="title"
                itemValue="value"
                itemSubtitle="subtitle"
                multiple={multiple.value}
                maxVisibleChips={1}
                clearable
                density="compact"
                hideDetails
                modelValue={(props.value ?? (multiple.value ? EMPTY_SELECTION : null)) as any}
                onUpdate:modelValue={(value: any) => props.onChange(value)}
            />
        );
    },
    {
        props: {
            filter: { type: Object, default: () => ({}) },
            value: { type: null, default: undefined },
            onChange: { type: Function, default: undefined },
        },
    },
);

const DateControl = dc(
    (
        props: {
            filter: AnyFilter;
            value: unknown;
            onChange: (value: unknown) => void;
        },
    ) => {
        const { t } = useLocale();
        const single = kindOf(props.filter) === "date";
        const range = computed(() => asRange(props.value));
        return () => {
            if (single) {
                return (
                    <PgDateInput
                        aria-label={t(props.filter.label)}
                        placeholder={t("YYYY-MM-DD")}
                        density="compact"
                        hideDetails
                        clearable
                        modelValue={(props.value as string) ?? null}
                        onUpdate:modelValue={(value: any) => props.onChange(value || undefined)}
                        onClear={() => props.onChange(undefined)}
                    />
                );
            }
            return (
                <PgDateRangeInput
                    aria-label={t(props.filter.label)}
                    placeholder={t("Select date range")}
                    density="compact"
                    hideDetails
                    clearable
                    autoApply={false}
                    modelValue={{
                        start: range.value.from,
                        end: range.value.to,
                    }}
                    onUpdate:modelValue={(value: any) => {
                        if (!value || !value.start) {
                            props.onChange(undefined);
                            return;
                        }
                        props.onChange({ from: value.start, to: value.end || value.start });
                    }}
                    onClear={() => props.onChange(undefined)}
                />
            );
        };
    },
    {
        props: {
            filter: { type: Object, default: () => ({}) },
            value: { type: null, default: undefined },
            onChange: { type: Function, default: undefined },
        },
    },
);

const NumberRangeControl = dc(
    (
        props: {
            filter: AnyFilter;
            value: unknown;
            onChange: (value: unknown) => void;
        },
    ) => {
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
    {
        props: {
            filter: { type: Object, default: () => ({}) },
            value: { type: null, default: undefined },
            onChange: { type: Function, default: undefined },
        },
    },
);

/**
 * One filter control. `getValue` is a stable getter so this component patches
 * its own props when a value changes; the parent filter grid never re-renders,
 * which is what keeps an open multi-select panel open after the first click.
 */
const FilterField = dc(
    (
        props: {
            filter: AnyFilter;
            getValue: (key: string) => unknown;
            onChange: (key: string, value: unknown) => void;
            onOptions: (key: string, options: FilterOption[]) => void;
        },
    ) => {
        const { t } = useLocale();
        const value = computed(() => props.getValue(props.filter.key));
        const kind = kindOf(props.filter);
        const onChange = (next: unknown) => props.onChange(props.filter.key, next);
        return () => {
            if (kind === "apiAutocomplete") {
                return (
                    <div class="pg-filter-control" data-pg-filter-control="apiAutocomplete">
                        <ApiAutocompleteControl
                            filter={props.filter}
                            value={value.value}
                            onChange={onChange}
                            onOptions={(options: FilterOption[]) =>
                                props.onOptions(props.filter.key, options)
                            }
                        />
                    </div>
                );
            }
            if (kind === "select" || kind === "multiselect" || kind === "boolean") {
                return <SelectControl filter={props.filter} value={value.value} onChange={onChange} />;
            }
            if (kind === "date" || kind === "daterange") {
                return <DateControl filter={props.filter} value={value.value} onChange={onChange} />;
            }
            if (kind === "numberRange") {
                return <NumberRangeControl filter={props.filter} value={value.value} onChange={onChange} />;
            }
            return (
                <VTextField
                    aria-label={t(props.filter.label)}
                    placeholder={t(props.filter.placeholder ?? "Any")}
                    prependInnerIcon={props.filter.icon ?? "mdi-magnify"}
                    density="compact"
                    variant="outlined"
                    hideDetails
                    clearable
                    modelValue={(value.value as string) ?? ""}
                    onUpdate:modelValue={(next: string) => onChange(next)}
                />
            );
        };
    },
    {
        props: {
            filter: { type: Object, default: () => ({}) },
            getValue: { type: Function, default: undefined },
            onChange: { type: Function, default: undefined },
            onOptions: { type: Function, default: undefined },
        },
    },
);

/* -------------------------------------------------------------------- panel */

const TableFilters = dc(
    (
        props: {
            filters: AnyFilter[];
            values: FilterValues;
            onChange: (key: string, value: unknown) => void;
            onClear: () => void;
            total?: number;
        },
        _expose,
        _ctx,
    ) => {
        const { t } = useLocale();
        const display = useDisplay();
        const surface = inject(tableFilterSurfaceKey, null);
        const localOpen = ref(!display.mobile.value);
        const open = computed(() => (surface ? surface.open.value : localOpen.value));
        const contentId = `pg-table-filters-${Math.random().toString(36).slice(2, 10)}`;
        // Do not read `props.values` in setup: Vapor would subscribe the
        // creating/parent effect to this prop, and the whole filter surface
        // (including an open autocomplete) would be destroyed and re-created
        // on every selection. The watcher is its own effect.
        const localValues = ref<FilterValues>({});
        watch(
            () => props.values,
            (next) => {
                localValues.value = { ...(next ?? {}) };
            },
            { deep: true, immediate: true },
        );
        const apiLabels = ref<Record<string, Record<string, string>>>({});

        // LG gets three roomy columns, XL four; never cram.
        const columns = computed(() => {
            if (display.xl.value) return 4;
            if (display.lg.value) return 3;
            if (display.md.value) return 2;
            return 1;
        });

        const filters = computed<AnyFilter[]>(() => props.filters ?? []);
        const count = computed(() =>
            activeFilterCount(filters.value as TableFilter[], localValues.value),
        );
        const active = computed(() =>
            filters.value.filter((filter) =>
                isFilterActive(filter as TableFilter, localValues.value[filter.key]),
            ),
        );

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

        const change = (key: string, value: unknown) => {
            const next = { ...localValues.value };
            if (value === undefined || value === null || value === "") delete next[key];
            else next[key] = value;
            localValues.value = next;
            props.onChange?.(key, value);
        };

        const clearAll = () => {
            localValues.value = {};
            apiLabels.value = {};
            props.onClear?.();
        };

        const registerOptions = (key: string, options: FilterOption[]) => {
            if (!options.length) return;
            const labels: Record<string, string> = { ...(apiLabels.value[key] ?? {}) };
            for (const option of options) labels[String(option.value)] = option.title;
            apiLabels.value = { ...apiLabels.value, [key]: labels };
        };

        const getValue = (key: string) => localValues.value[key];

        return () =>
            branch(
                () =>
                    filters.value.length > 0 &&
                    !(surface && !open.value && !active.value.length),
                () => (
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
                                {count.value > 0 ? (
                                    <span class="pg-filter-trigger__badge pg-tabular">
                                        {count.value}
                                    </span>
                                ) : null}
                            </VBtn>
                            {props.total !== undefined && (
                                <span class="pg-record-count pg-tabular">
                                    {props.total} {t("records")}
                                </span>
                            )}
                        </div>
                    )}

                    {branch(
                        () => open.value,
                        () => (
                            <div
                                id={contentId}
                                class="pg-table-filters__grid"
                                style={{
                                    gridTemplateColumns: `repeat(${columns.value}, minmax(0, 1fr))`,
                                }}
                            >
                                {filters.value.map((filter) => {
                                    const kind = kindOf(filter);
                                    const wide =
                                        kind === "date" ||
                                        kind === "daterange" ||
                                        kind === "numberRange";
                                    return (
                                        <div
                                            key={filter.key}
                                            class="pg-table-filters__field"
                                            data-pg-filter={filter.key}
                                            data-pg-filter-kind={kind}
                                            style={{
                                                gridColumn:
                                                    wide && columns.value > 1
                                                        ? "span 2"
                                                        : undefined,
                                            }}
                                        >
                                            {/* Exactly one label per filter: the control never renders its own. */}
                                            <span class="pg-filter-label">
                                                {t(filter.label)}
                                            </span>
                                            <FilterField
                                                filter={filter}
                                                getValue={getValue}
                                                onChange={change}
                                                onOptions={registerOptions}
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        ),
                    )}

                    {active.value.length > 0 && (
                        <div class="pg-table-active-chips pg-table-filters__active">
                            <div class="pg-table-filters__chips">
                                {active.value.map((filter) => (
                                    <span key={filter.key} class="pg-filter-chip">
                                        <span class="pg-filter-chip__label">
                                            {t(filter.label)}:
                                        </span>
                                        <span class="pg-filter-chip__value">
                                            {filterSummary(
                                                filter,
                                                localValues.value[filter.key],
                                                t,
                                                apiLabels.value[filter.key],
                                            )}
                                        </span>
                                        <button
                                            type="button"
                                            class="pg-filter-chip__remove"
                                            aria-label={`${t("Remove filter")}: ${t(filter.label)}`}
                                            onClick={() => change(filter.key, undefined)}
                                        >
                                            <VIcon icon="mdi-close" size={12} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                            <span class="pg-table-filters__clear">
                                <VBtn
                                    size="small"
                                    variant="text"
                                    prependIcon="mdi-filter-remove-outline"
                                    onClick={clearAll}
                                >
                                    {t("Clear all filters")}
                                </VBtn>
                            </span>
                        </div>
                    )}
                </div>
                ),
            );
    },
    {
        props: {
            filters: { type: Array, default: () => [] },
            values: { type: Object, default: () => ({}) },
            onChange: { type: Function, default: undefined },
            onClear: { type: Function, default: undefined },
            total: { type: [Number, String], default: undefined },
        },
        // `onChange`/`onClear` stay props for the existing page contract.
        inheritAttrs: true,
    },
);

export { TableFilters };

export const PgTableFilters = TableFilters;

export default TableFilters;

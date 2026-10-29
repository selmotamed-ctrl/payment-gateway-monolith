import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useDisplay, useLocale, useTheme } from "vuetify";
import { VAutocomplete, VBtn, VChip, VIcon, VTextField } from "vuetify/components";
import DateInput from "@/components/DateInput";
import type { StatusTone } from "@/components/StatusChip";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import {
    activeFilterCount,
    isFilterActive,
    type FilterOption,
    type FilterValues,
    type TableFilter,
} from "./filters";

const toIsoDate = (value: Date): string => {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
};

const toneColor = (theme: ReturnType<typeof useTheme>, tone: StatusTone | undefined): string | undefined => {
    if (!tone) return undefined;
    const colors = theme.current.value.colors as Record<string, string>;
    return colors[tone] ?? colors["on-surface-variant"];
};

const optionTone = (filter: TableFilter, value: unknown): StatusTone | undefined => {
    if (filter.type === "boolean") {
        return value === "true" || value === true ? "success" : "error";
    }
    if (filter.type === "data-autocomplete") {
        const first = Array.isArray(value) ? value[0] : value;
        return filter.options.find((option) => option.value === String(first))?.tone;
    }
    return undefined;
};

const filterSummary = (filter: TableFilter, value: unknown): string => {
    if (!isFilterActive(filter, value)) return "";
    if (filter.type === "boolean") {
        return value === "true" || value === true ? filter.trueLabel ?? "Yes" : filter.falseLabel ?? "No";
    }
    if (filter.type === "number-range") {
        const range = value as { min?: string; max?: string };
        return [range.min, range.max].filter(Boolean).join(" – ");
    }
    if (filter.type === "date") {
        const range = value as { from?: string; to?: string };
        if (range.from && range.to) return `${range.from} → ${range.to}`;
        if (range.from) return `from ${range.from}`;
        if (range.to) return `until ${range.to}`;
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
            <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                <VAutocomplete
                    aria-label={props.filter.label}
                    placeholder={props.filter.placeholder ?? "Any"}
                    prependInnerIcon={props.filter.icon ?? "mdi-filter-variant"}
                    items={options.value}
                    itemTitle="title"
                    itemValue="value"
                    multiple={props.filter.multiple}
                    chips={props.filter.multiple}
                    clearable
                    density="compact"
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
                                aria-label="Refresh options"
                                onClick={() => void load("")}
                            >
                                <VIcon icon="mdi-refresh" size="18" />
                            </VBtn>
                        ),
                    }}
                </VAutocomplete>
                {error.value && (
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "rgb(var(--v-theme-error))", fontSize: "11px" }}>
                        <VIcon icon="mdi-alert-circle-outline" size="14" />
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{error.value}</span>
                        <VBtn size="x-small" variant="text" onClick={() => void load("")}>
                            Retry
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
        const items = computed<FilterOption[]>(() => {
            if (props.filter.type === "boolean") {
                return [
                    { title: props.filter.trueLabel ?? "Yes", value: "true", tone: "success" },
                    { title: props.filter.falseLabel ?? "No", value: "false", tone: "error" },
                ];
            }
            return props.filter.options;
        });
        const multiple = props.filter.type === "data-autocomplete" && props.filter.multiple === true;
        return () => (
            <VAutocomplete
                aria-label={props.filter.label}
                placeholder="Any"
                prependInnerIcon={props.filter.icon ?? "mdi-filter-variant"}
                items={items.value}
                itemTitle="title"
                itemValue="value"
                multiple={multiple}
                chips={multiple}
                clearable
                density="compact"
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
                aria-label={props.label}
                placeholder="Select date range"
                prependInnerIcon="mdi-calendar-range"
                density="compact"
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
        const range = computed(() => (props.value ?? {}) as { min?: string; max?: string });
        return () => (
            <div style={{ display: "flex", gap: "8px", minWidth: 0 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <VTextField
                        aria-label={`${props.filter.label} minimum`}
                        placeholder="Min"
                        type="number"
                        density="compact"
                        hideDetails
                        suffix={props.filter.suffix}
                        modelValue={range.value.min ?? ""}
                        onUpdate:modelValue={(value: string) => props.onChange({ ...range.value, min: value })}
                    />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <VTextField
                        aria-label={`${props.filter.label} maximum`}
                        placeholder="Max"
                        type="number"
                        density="compact"
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
        const theme = useTheme();
        const display = useDisplay();
        const open = ref(!display.mobile.value);

        // LG gets three roomy columns, XL four; never cram.
        const columns = computed(() => {
            if (display.xl.value) return 4;
            if (display.lg.value) return 3;
            if (display.md.value) return 2;
            return 1;
        });

        return () => {
            const filters = props.filters ?? [];
            if (filters.length === 0) {
                return null;
            }
            const count = activeFilterCount(filters, props.values);
            const active = filters.filter((filter) => isFilterActive(filter, props.values[filter.key]));

            return (
                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "14px",
                        padding: "18px 20px 20px",
                        borderRadius: "16px",
                        border: "1px solid var(--fintech-border)",
                        background: "linear-gradient(180deg, rgba(var(--v-theme-surface-variant), 0.5), rgba(var(--v-theme-surface), 0.85))",
                    }}
                >
                    <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                        <VBtn
                            size="small"
                            variant={count > 0 ? "flat" : "tonal"}
                            color={count > 0 ? "primary" : undefined}
                            prependIcon="mdi-filter-variant"
                            onClick={() => (open.value = !open.value)}
                        >
                            {t("Filters")}
                            {count > 0 ? ` (${count})` : ""}
                        </VBtn>

                        {props.total !== undefined && (
                            <span style={{ fontSize: "12px", fontWeight: 600, opacity: 0.6 }}>
                                {props.total} {t("results")}
                            </span>
                        )}

                        <div style={{ flex: 1 }} />

                        {count > 0 && (
                            <VBtn size="small" variant="text" prependIcon="mdi-filter-remove-outline" onClick={() => props.onClear()}>
                                {t("Clear all filters")}
                            </VBtn>
                        )}
                    </div>

                    {active.length > 0 && (
                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                            {active.map((filter) => (
                                <VChip
                                    key={filter.key}
                                    size="small"
                                    variant="tonal"
                                    color={toneColor(theme, optionTone(filter, props.values[filter.key]))}
                                    closable
                                    onClick:close={() => props.onChange(filter.key, undefined)}
                                >
                                    <span style={{ fontWeight: 700, opacity: 0.7, marginInlineEnd: "6px" }}>{filter.label}:</span>
                                    {filterSummary(filter, props.values[filter.key])}
                                </VChip>
                            ))}
                        </div>
                    )}

                    {open.value && (
                        <div
                            style={{
                                display: "grid",
                                gridTemplateColumns: `repeat(${columns.value}, minmax(0, 1fr))`,
                                gap: "22px 20px",
                                alignItems: "start",
                            }}
                        >
                            {filters.map((filter) => {
                                const value = props.values[filter.key];
                                const onChange = (next: unknown) => props.onChange(filter.key, next);
                                const wide = filter.type === "date" || filter.type === "number-range";
                                return (
                                    <div
                                        key={filter.key}
                                        style={{
                                            display: "flex",
                                            flexDirection: "column",
                                            gap: "6px",
                                            minWidth: 0,
                                            gridColumn: wide && columns.value > 1 ? "span 2" : undefined,
                                        }}
                                    >
                                        <span
                                            style={{
                                                fontSize: "11px",
                                                fontWeight: 800,
                                                letterSpacing: "0.06em",
                                                textTransform: "uppercase",
                                                lineHeight: "16px",
                                                opacity: 0.55,
                                            }}
                                        >
                                            {filter.label}
                                        </span>
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
                                                aria-label={filter.label}
                                                placeholder={filter.placeholder ?? "Any"}
                                                prependInnerIcon={filter.icon ?? "mdi-magnify"}
                                                density="compact"
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
                </div>
            );
        };
    },
    { props: ["filters", "values", "onChange", "onClear", "total"] },
);

export default TableFilters;

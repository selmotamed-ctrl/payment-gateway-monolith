import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useDisplay, useLocale, useTheme } from "vuetify";
import { VAutocomplete, VBtn, VChip, VIcon, VTextField } from "vuetify/components";
import { VueDatePicker as VueDatePickerComponent } from "@vuepic/vue-datepicker";

const VueDatePicker = VueDatePickerComponent as any;
import type { StatusTone } from "@/components/StatusChip";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import {
    activeFilterCount,
    isFilterActive,
    type FilterOption,
    type FilterValues,
    type TableFilter,
} from "./filters";

const toneColor = (theme: ReturnType<typeof useTheme>, tone: StatusTone | undefined): string | undefined => {
    if (!tone) return undefined;
    const colors = theme.current.value.colors as Record<string, string>;
    return colors[tone] ?? colors["on-surface-variant"];
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
        if (range.from) return `≥ ${range.from}`;
        if (range.to) return `≤ ${range.to}`;
        return "";
    }
    if (Array.isArray(value)) return value.join(", ");
    if (filter.type === "data-autocomplete") {
        const option = filter.options.find((entry) => entry.value === String(value));
        return option?.title ?? String(value);
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
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <VAutocomplete
                    label={props.filter.label}
                    prependInnerIcon={props.filter.icon ?? "mdi-magnify"}
                    items={options.value}
                    itemTitle="title"
                    itemValue="value"
                    multiple={props.filter.multiple}
                    chips={props.filter.multiple}
                    clearable
                    density="compact"
                    hideDetails
                    loading={loading.value}
                    placeholder={props.filter.placeholder}
                    modelValue={props.value ?? (props.filter.multiple ? [] : null)}
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
                        <span style={{ flex: 1 }}>{error.value}</span>
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
        const theme = useTheme();
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
                label={props.filter.label}
                prependInnerIcon={props.filter.icon ?? "mdi-filter-variant"}
                items={items.value}
                itemTitle="title"
                itemValue="value"
                multiple={multiple}
                chips={multiple}
                clearable
                density="compact"
                hideDetails
                modelValue={props.value ?? (multiple ? [] : null)}
                onUpdate:modelValue={(value: any) => props.onChange(value)}

            />
        );
    },
    { props: ["filter", "value", "onChange"] },
);

const DateControl = dc(
    (props: { filter: Extract<TableFilter, { type: "date" }>; value: unknown; onChange: (value: unknown) => void }) => {
        const { t } = useLocale();
        const current = computed(() => (props.value ?? {}) as { from?: string; to?: string });
        const toIso = (date: Date): string => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, "0");
            const day = String(date.getDate()).padStart(2, "0");
            return `${year}-${month}-${day}`;
        };
        const parse = (value?: string): Date | null => (value ? new Date(`${value}T12:00:00`) : null);
        const setDates = (from?: string, to?: string) =>
            props.onChange({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
        const preset = (days: number) => {
            const end = new Date();
            end.setDate(end.getDate() + days);
            const start = new Date();
            setDates(toIso(start), toIso(end));
        };

        return () => (
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <div style={{ flex: 1 }}>
                        <VueDatePicker
                            modelValue={
                                current.value.from && current.value.to
                                    ? [parse(current.value.from), parse(current.value.to)]
                                    : parse(current.value.from ?? current.value.to)
                            }
                            onUpdate:modelValue={(value: any) => {
                                if (Array.isArray(value)) {
                                    setDates(value[0] ? toIso(value[0]) : undefined, value[1] ? toIso(value[1]) : undefined);
                                } else if (value instanceof Date) {
                                    setDates(toIso(value));
                                } else {
                                    setDates();
                                }
                            }}
                            range={!!(current.value.from && current.value.to)}
                            enableTimePicker={false}
                            autoApply
                            format="yyyy-MM-dd"
                            placeholder={props.filter.label}
                        />
                    </div>
                    <VBtn
                        size="x-small"
                        variant="text"
                        icon="mdi-close"
                        aria-label="Clear date"
                        onClick={() => props.onChange(undefined)}
                    />
                </div>
                <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                    <VBtn size="x-small" variant="text" onClick={() => preset(0)}>
                        {t("Today")}
                    </VBtn>
                    <VBtn size="x-small" variant="text" onClick={() => preset(-7)}>
                        {t("Last 7d")}
                    </VBtn>
                    <VBtn size="x-small" variant="text" onClick={() => preset(-30)}>
                        {t("Last 30d")}
                    </VBtn>
                    <VBtn size="x-small" variant="text" onClick={() => preset(30)}>
                        {t("Next 30d")}
                    </VBtn>
                </div>
            </div>
        );
    },
    { props: ["filter", "value", "onChange"] },
);

const NumberRangeControl = dc(
    (props: { filter: Extract<TableFilter, { type: "number-range" }>; value: unknown; onChange: (value: unknown) => void }) => {
        const range = computed(() => (props.value ?? {}) as { min?: string; max?: string });
        return () => (
            <div style={{ display: "flex", gap: "6px" }}>
                <VTextField
                    label={`${props.filter.label} min`}
                    type="number"
                    density="compact"
                    hideDetails
                    suffix={props.filter.suffix}
                    modelValue={range.value.min ?? ""}
                    onUpdate:modelValue={(value: string) => props.onChange({ ...range.value, min: value })}
                />
                <VTextField
                    label={`${props.filter.label} max`}
                    type="number"
                    density="compact"
                    hideDetails
                    suffix={props.filter.suffix}
                    modelValue={range.value.max ?? ""}
                    onUpdate:modelValue={(value: string) => props.onChange({ ...range.value, max: value })}
                />
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
                        gap: "10px",
                        padding: "12px 14px",
                        borderRadius: "12px",
                        border: "1px solid var(--fintech-border)",
                        background: "rgba(var(--v-theme-surface-variant), 0.35)",
                    }}
                >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
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
                            <span style={{ fontSize: "12px", opacity: 0.6 }}>
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
                                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                                gap: "12px",
                            }}
                        >
                            {filters.map((filter) => {
                                const value = props.values[filter.key];
                                const onChange = (next: unknown) => props.onChange(filter.key, next);
                                if (filter.type === "api-autocomplete") {
                                    return <ApiAutocompleteControl key={filter.key} filter={filter} value={value} onChange={onChange} />;
                                }
                                if (filter.type === "data-autocomplete" || filter.type === "boolean") {
                                    return <DataAutocompleteControl key={filter.key} filter={filter} value={value} onChange={onChange} />;
                                }
                                if (filter.type === "date") {
                                    return <DateControl key={filter.key} filter={filter} value={value} onChange={onChange} />;
                                }
                                if (filter.type === "number-range") {
                                    return <NumberRangeControl key={filter.key} filter={filter} value={value} onChange={onChange} />;
                                }
                                return (
                                    <VTextField
                                        key={filter.key}
                                        label={filter.label}
                                        prependInnerIcon={filter.icon ?? "mdi-magnify"}
                                        density="compact"
                                        hideDetails
                                        clearable
                                        placeholder={filter.placeholder}
                                        modelValue={value ?? ""}
                                        onUpdate:modelValue={(next: string) => onChange(next)}
                                    />
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

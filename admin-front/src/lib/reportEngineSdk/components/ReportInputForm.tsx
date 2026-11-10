import { defineComponent, onMounted, reactive, watch, type PropType } from "vue";
import { useDisplay, useLocale } from "vuetify";
import {
  VAutocomplete,
  VChip,
  VSelect,
  VSwitch,
  VTextField,
} from "vuetify/components";
import { FormField } from "@/components/ui/FormField";
import DateInput from "@/components/DateInput";
import type { ReportDescriptorSpec, ReportInputFieldSpec } from "../types/reportSpec";
import { resolvePreset } from "../utils/inputDefaults";
import { validateReportInputs } from "../utils/inputValidation";

export type AutocompleteLoader = (
  source: string,
  query: string,
  dependentValues?: Record<string, unknown>,
) => Promise<Array<{ value: string; label: string; sublabel?: string; badge?: string }>>;

type Item = { title: string; value: string; subtitle?: string; badge?: string };

const toIsoDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const startOfDayIso = (date: Date): string => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy.toISOString();
};
const endOfDayIso = (date: Date): string => {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy.toISOString();
};

export const ReportInputForm = defineComponent({
  name: "ReportInputForm",
  props: {
    spec: { type: Object as PropType<ReportDescriptorSpec>, required: true },
    modelValue: { type: Object as PropType<Record<string, unknown>>, required: true },
    autocomplete: { type: Function as PropType<AutocompleteLoader>, required: false },
    disabled: { type: Boolean, default: false },
    hiddenInputKeys: { type: Array as PropType<string[]>, default: () => [] },
    /** Report dictionary for report-defined labels; the portal dictionary is only the fallback. */
    translate: { type: Function as PropType<(key: string) => string>, required: false },
  },
  emits: ["update:modelValue", "validityChanged"],
  setup(props, { emit, expose }) {
    const { t } = useLocale();
    const { mobile } = useDisplay();
    const tr = (key: string): string => (props.translate ? props.translate(key) : t(key));
    const items = reactive<Record<string, Item[]>>({});
    const loading = reactive<Record<string, boolean>>({});
    const errors = reactive<Record<string, string>>({});
    const searchTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const valueOf = (key: string): unknown => props.modelValue[key];

    const setValue = (key: string, value: unknown) => {
      emit("update:modelValue", { ...props.modelValue, [key]: value });
    };

    const dependentValuesFor = (field: ReportInputFieldSpec): Record<string, unknown> | undefined => {
      const dependency = field.autocomplete?.depends_on_input;
      const staticFilter = field.autocomplete?.static_filter;
      const dependent: Record<string, unknown> = { ...(staticFilter ?? {}) };
      if (dependency) {
        const value = valueOf(dependency);
        if (value !== undefined && value !== null && value !== "") dependent[dependency] = value;
      }
      return Object.keys(dependent).length > 0 ? dependent : undefined;
    };

    const loadItems = async (field: ReportInputFieldSpec, query: string) => {
      if (!props.autocomplete || !field.autocomplete) return;
      loading[field.key] = true;
      errors[field.key] = "";
      try {
        const result = await props.autocomplete(
          field.autocomplete.source,
          query,
          dependentValuesFor(field),
        );
        items[field.key] = result.map((item) => ({
          title: item.label,
          value: item.value,
          subtitle: item.sublabel,
          badge: item.badge,
        }));
      } catch (caught) {
        items[field.key] = [];
        errors[field.key] = caught instanceof Error ? caught.message : String(caught);
      } finally {
        loading[field.key] = false;
      }
    };

    const onSearch = (field: ReportInputFieldSpec, query: string) => {
      const previous = searchTimers.get(field.key);
      if (previous) clearTimeout(previous);
      searchTimers.set(
        field.key,
        setTimeout(() => {
          void loadItems(field, query);
        }, 250),
      );
    };

    const rangeDates = (field: ReportInputFieldSpec): Date[] => {
      const raw = valueOf(field.key);
      if (raw && typeof raw === "object" && "start" in raw && "end" in raw) {
        const start = new Date(String((raw as { start: unknown }).start));
        const end = new Date(String((raw as { end: unknown }).end));
        const dates = [start, end].filter((date) => !Number.isNaN(date.getTime()));
        return dates.length === 2 ? dates : [];
      }
      return [];
    };

    const setRangeDates = (field: ReportInputFieldSpec, value: unknown) => {
      const dates = (Array.isArray(value) ? value : value ? [value] : []).filter(
        (date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()),
      );
      if (dates.length === 0) {
        setValue(field.key, undefined);
        return;
      }
      const first = dates[0]!;
      const last = dates[dates.length - 1]!;
      setValue(field.key, { start: startOfDayIso(first), end: endOfDayIso(last) });
    };

    const applyPreset = (field: ReportInputFieldSpec, preset: string) => {
      setValue(field.key, resolvePreset({ ...field, default_value: { preset: preset as never } }));
    };

    const rangePresets: Array<{ value: string; label: string }> = [
      { value: "TODAY", label: t("Today") },
      { value: "YESTERDAY", label: t("Yesterday") },
      { value: "LAST_7_DAYS", label: t("Last 7 days") },
      { value: "LAST_30_DAYS", label: t("Last 30 days") },
      { value: "CURRENT_MONTH", label: t("Current month") },
      { value: "PREVIOUS_MONTH", label: t("Previous month") },
    ];
    const singleDatePresets = rangePresets.filter((preset) =>
      preset.value === "TODAY" || preset.value === "YESTERDAY",
    );

    const visibleInputs = (): ReportInputFieldSpec[] =>
      props.spec.inputs.filter((field) => !(props.hiddenInputKeys ?? []).includes(field.key));

    const enumItems = (field: ReportInputFieldSpec): Array<{ title: string; value: string }> =>
      (field.validation?.enum_values ?? []).map((value) => ({
        value,
        title: field.validation?.enum_labels_i18n_prefix
          ? tr(`${field.validation.enum_labels_i18n_prefix}.${value}`)
          : value,
      }));

    const defaultHint = (field: ReportInputFieldSpec): string | undefined => {
      const help = field.help_i18n_key ? tr(field.help_i18n_key) : undefined;
      if (field.validation?.max_range_days) {
        return [help, `${t("Maximum range")}: ${field.validation.max_range_days} ${t("days")}`]
          .filter(Boolean)
          .join(" · ");
      }
      return help;
    };

    const columns = (field: ReportInputFieldSpec): number =>
      mobile.value ? 12 : Math.max(3, Math.min(12, field.layout_col_span));

    const common = (field: ReportInputFieldSpec) => ({
      disabled: props.disabled,
      variant: "outlined" as const,
      hideDetails: "auto" as const,
      placeholder: field.placeholder_i18n_key ? tr(field.placeholder_i18n_key) : undefined,
      error: Boolean(errors[field.key]),
    });

    const validate = (): boolean => {
      const result = validateReportInputs(props.spec, props.modelValue, t);
      for (const key of Object.keys(errors)) {
        if (!(key in result.errors)) delete errors[key];
      }
      Object.assign(errors, result.errors);
      emit("validityChanged", result.valid);
      return result.valid;
    };

    onMounted(() => {
      for (const field of props.spec.inputs) {
        if (field.autocomplete) {
          void loadItems(field, "");
        }
      }
    });

    watch(
      () => props.modelValue,
      (next, previous) => {
        if (!previous) return;
        const patch: Record<string, unknown> = {};
        for (const field of props.spec.inputs) {
          const dependency = field.autocomplete?.depends_on_input;
          if (dependency && next[dependency] !== previous[dependency]) {
            // A changed parent selection makes the old child selection stale.
            patch[field.key] = Array.isArray(valueOf(field.key)) ? [] : undefined;
            void loadItems(field, "");
          }
        }
        if (Object.keys(patch).length > 0) {
          emit("update:modelValue", { ...props.modelValue, ...patch });
        }
      },
    );

    expose({ validate, errors });

    const renderPresetChips = (field: ReportInputFieldSpec, presets: Array<{ value: string; label: string }>) => (
      <div class="d-flex flex-wrap ga-1">
        {presets.map((preset) => (
          <VChip
            key={preset.value}
            size="small"
            color="primary"
            variant="tonal"
            onClick={() => applyPreset(field, preset.value)}
          >
            {preset.label}
          </VChip>
        ))}
      </div>
    );

    const renderField = (field: ReportInputFieldSpec) => {
      const label = tr(field.label_i18n_key);
      const hint = defaultHint(field);
      const value = valueOf(field.key);
      const inputProps = common(field);

      if (field.type === "daterange") {
        return (
          <FormField
            label={label}
            hint={hint}
            error={errors[field.key] || ""}
            required={field.required}
            id={`report-input-${field.key}`}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <DateInput
                multiple="range"
                aria-label={label}
                placeholder={t("Select date range")}
                prependInnerIcon="mdi-calendar-range"
                variant="outlined"
                hideDetails="auto"
                clearable
                disabled={props.disabled}
                modelValue={rangeDates(field)}
                onUpdate:modelValue={(next: unknown) => setRangeDates(field, next)}
              />
              {renderPresetChips(field, rangePresets)}
            </div>
          </FormField>
        );
      }

      if (field.type === "date" || field.type === "datetime") {
        return (
          <FormField
            label={label}
            hint={hint}
            error={errors[field.key] || ""}
            required={field.required}
            id={`report-input-${field.key}`}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <VTextField
                {...inputProps}
                type={field.type === "date" ? "date" : "datetime-local"}
                modelValue={
                  value === undefined || value === null
                    ? ""
                    : field.type === "datetime"
                      ? toLocalDateTimeInput(String(value))
                      : String(value)
                }
                onUpdate:modelValue={(next: string) =>
                  setValue(
                    field.key,
                    next === ""
                      ? null
                      : field.type === "datetime"
                        ? new Date(next).toISOString()
                        : next,
                  )
                }
              />
              {renderPresetChips(field, singleDatePresets)}
            </div>
          </FormField>
        );
      }

      if (field.type === "entity_autocomplete" || field.type === "entity_multi_autocomplete") {
        const multiple = field.type === "entity_multi_autocomplete";
        return (
          <FormField
            label={label}
            hint={hint}
            error={errors[field.key] || ""}
            required={field.required}
            id={`report-input-${field.key}`}
          >
            <VAutocomplete
              {...inputProps}
              multiple={multiple}
              chips={multiple}
              clearable
              items={items[field.key] ?? []}
              itemTitle="title"
              itemValue="value"
              loading={loading[field.key]}
              noDataText={t("No matches")}
              modelValue={multiple ? (Array.isArray(value) ? (value as string[]) : []) : ((value as string | null | undefined) ?? null)}
              onUpdate:modelValue={(next: unknown) => setValue(field.key, next)}
              onUpdate:search={(next: string) => onSearch(field, next)}
            />
          </FormField>
        );
      }

      if (field.type === "enum" || field.type === "multi_enum") {
        const multiple = field.type === "multi_enum";
        return (
          <FormField
            label={label}
            hint={hint}
            error={errors[field.key] || ""}
            required={field.required}
            id={`report-input-${field.key}`}
          >
            <VSelect
              {...inputProps}
              multiple={multiple}
              clearable
              items={enumItems(field)}
              itemTitle="title"
              itemValue="value"
              modelValue={multiple ? (Array.isArray(value) ? (value as string[]) : []) : ((value as string | null | undefined) ?? null)}
              onUpdate:modelValue={(next: unknown) => setValue(field.key, next)}
            />
          </FormField>
        );
      }

      if (field.type === "boolean") {
        return (
          <FormField
            label={label}
            hint={hint}
            error={errors[field.key] || ""}
            required={field.required}
            id={`report-input-${field.key}`}
          >
            <VSwitch
              color="primary"
              hideDetails="auto"
              disabled={props.disabled}
              modelValue={Boolean(value)}
              onUpdate:modelValue={(next: boolean | null) => setValue(field.key, Boolean(next))}
            />
          </FormField>
        );
      }

      const inputType =
        field.type === "number" || field.type === "integer" || field.type === "amount_minor"
          ? "number"
          : "text";
      return (
        <FormField
          label={label}
          hint={hint}
          error={errors[field.key] || ""}
          required={field.required}
          id={`report-input-${field.key}`}
        >
          <VTextField
            {...inputProps}
            type={inputType}
            modelValue={value === undefined || value === null ? "" : String(value)}
            onUpdate:modelValue={(next: string) =>
              setValue(
                field.key,
                inputType === "number" ? (next === "" ? null : Number(next)) : next,
              )
            }
          />
        </FormField>
      );
    };

    return () => (
      <div class="report-input-grid">
        {visibleInputs().map((field) => (
          <div key={field.key} style={{ gridColumn: `span ${columns(field)}`, minWidth: 0 }}>
            {renderField(field)}
          </div>
        ))}
      </div>
    );
  },
});

function toLocalDateTimeInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

export default ReportInputForm;

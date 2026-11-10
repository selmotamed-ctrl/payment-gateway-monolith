import { defineComponent, onMounted, reactive, watch, type PropType } from "vue";
import { useDisplay, useLocale } from "vuetify";
import {
  VAutocomplete,
  VBtn,
  VSelect,
  VSwitch,
  VTextField,
} from "vuetify/components";
import { FormField } from "@/components/ui/FormField";
import type { ReportDescriptorSpec, ReportInputFieldSpec } from "../types/reportSpec";
import { resolvePreset } from "../utils/inputDefaults";

export type AutocompleteLoader = (
  source: string,
  query: string,
  dependentValues?: Record<string, unknown>,
) => Promise<Array<{ value: string; label: string; sublabel?: string; badge?: string }>>;

type Item = { title: string; value: string; subtitle?: string; badge?: string };

export const ReportInputForm = defineComponent({
  name: "ReportInputForm",
  props: {
    spec: { type: Object as PropType<ReportDescriptorSpec>, required: true },
    modelValue: { type: Object as PropType<Record<string, unknown>>, required: true },
    autocomplete: { type: Function as PropType<AutocompleteLoader>, required: false },
    disabled: { type: Boolean, default: false },
    hiddenInputKeys: { type: Array as PropType<string[]>, default: () => [] },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const { t } = useLocale();
    const { mobile } = useDisplay();
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
      if (!dependency) return undefined;
      const value = valueOf(dependency);
      return value === undefined || value === null || value === "" ? undefined : { [dependency]: value };
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

    const dateRange = (field: ReportInputFieldSpec): { start: string; end: string } => {
      const raw = valueOf(field.key);
      if (raw && typeof raw === "object" && "start" in raw && "end" in raw) {
        return {
          start: String((raw as { start: unknown }).start).slice(0, 10),
          end: String((raw as { end: unknown }).end).slice(0, 10),
        };
      }
      return { start: "", end: "" };
    };

    const setDateRange = (field: ReportInputFieldSpec, part: "start" | "end", value: string) => {
      const current = dateRange(field);
      const next = { ...current, [part]: value };
      setValue(field.key, {
        start: next.start ? `${next.start}T00:00:00.000Z` : "",
        end: next.end ? `${next.end}T23:59:59.999Z` : "",
      });
    };

    const applyPreset = (field: ReportInputFieldSpec, preset: string) => {
      setValue(field.key, resolvePreset({ ...field, default_value: { preset: preset as never } }));
    };

    const presetLabels: Array<{ value: string; label: string }> = [
      { value: "TODAY", label: t("Today") },
      { value: "LAST_7_DAYS", label: t("Last 7 days") },
      { value: "LAST_30_DAYS", label: t("Last 30 days") },
      { value: "CURRENT_MONTH", label: t("Current month") },
      { value: "PREVIOUS_MONTH", label: t("Previous month") },
    ];

    const visibleInputs = (): ReportInputFieldSpec[] =>
      props.spec.inputs.filter((field) => !(props.hiddenInputKeys ?? []).includes(field.key));

    const enumItems = (field: ReportInputFieldSpec): Array<{ title: string; value: string }> =>
      (field.validation?.enum_values ?? []).map((value) => ({
        value,
        title: field.validation?.enum_labels_i18n_prefix
          ? t(`${field.validation.enum_labels_i18n_prefix}.${value}`)
          : value,
      }));

    const defaultHint = (field: ReportInputFieldSpec): string | undefined => {
      const help = field.help_i18n_key ? t(field.help_i18n_key) : undefined;
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
      density: "comfortable" as const,
      variant: "outlined" as const,
      hideDetails: "auto" as const,
      placeholder: field.placeholder_i18n_key ? t(field.placeholder_i18n_key) : undefined,
      error: Boolean(errors[field.key]),
    });

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
        for (const field of props.spec.inputs) {
          const dependency = field.autocomplete?.depends_on_input;
          if (dependency && next[dependency] !== previous[dependency]) {
            void loadItems(field, "");
          }
        }
      },
    );

    const renderField = (field: ReportInputFieldSpec) => {
      const label = t(field.label_i18n_key);
      const hint = defaultHint(field);
      const value = valueOf(field.key);
      const inputProps = common(field);

      if (field.type === "daterange") {
        const range = dateRange(field);
        return (
          <FormField
            label={label}
            hint={hint}
            error={errors[field.key] || ""}
            required={field.required}
            id={`report-input-${field.key}`}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "8px" }}>
                <VTextField
                  {...inputProps}
                  type="date"
                  aria-label={`${label} ${t("Start")}`}
                  placeholder={t("Start")}
                  modelValue={range.start}
                  onUpdate:modelValue={(next: string) => setDateRange(field, "start", next)}
                />
                <VTextField
                  {...inputProps}
                  type="date"
                  aria-label={`${label} ${t("End")}`}
                  placeholder={t("End")}
                  modelValue={range.end}
                  onUpdate:modelValue={(next: string) => setDateRange(field, "end", next)}
                />
              </div>
              <div class="d-flex flex-wrap ga-1">
                {presetLabels.map((preset) => (
                  <VBtn
                    key={preset.value}
                    size="x-small"
                    variant="tonal"
                    onClick={() => applyPreset(field, preset.value)}
                  >
                    {preset.label}
                  </VBtn>
                ))}
              </div>
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
              baseColor="grey"
              inset
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
          : field.type === "date"
            ? "date"
            : field.type === "datetime"
              ? "datetime-local"
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
            modelValue={
              value === undefined || value === null
                ? ""
                : field.type === "datetime"
                  ? String(value).slice(0, 16)
                  : String(value)
            }
            onUpdate:modelValue={(next: string) =>
              setValue(
                field.key,
                inputType === "number"
                  ? (next === "" ? null : Number(next))
                  : field.type === "datetime"
                    ? (next === "" ? null : `${next}:00.000Z`)
                    : next,
              )
            }
          />
        </FormField>
      );
    };

    return () => (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
          gap: "16px 20px",
          alignItems: "start",
        }}
      >
        {visibleInputs().map((field) => (
          <div key={field.key} style={{ gridColumn: `span ${columns(field)}`, minWidth: 0 }}>
            {renderField(field)}
          </div>
        ))}
      </div>
    );
  },
});

export default ReportInputForm;

import { computed, defineComponent, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VAutocomplete, VBtn, VIcon, VTextField } from "vuetify/components";

type Rule = (value: unknown) => true | string;

export type FilterField<T = any, Key = string> =
  | { type: "text"; label: string; key: Key; fieldType?: "text" | "email" | "password" | "number" | "phone"; rules?: Rule[] }
  | { type: "data-autocomplete"; label: string; key: Key; items: T[]; multiple?: boolean; itemTitle: (item: T) => string; itemValue: (item: T) => any; rules?: Rule[] }
  | { type: "api-autocomplete"; label: string; key: Key; url: string; apiDataExtractor: (data: any) => any[]; multiple?: boolean; itemTitle: (item: any) => string; itemValue: (item: any) => any; rules?: Rule[] }
  | { type: "date-input"; label: string; key: Key; min?: Date; max?: Date; rules?: Rule[] };

export const FiltersContainer = defineComponent({
  name: "FiltersContainer",
  props: {
    filters: { type: Object as PropType<Record<string, any>>, required: true },
    filtersDescription: { type: Array as PropType<FilterField[]>, default: () => [] },
    setFilter: { type: Function as PropType<(key: string, value: any) => void>, required: true },
    onApply: { type: Function as PropType<() => void>, required: true },
    onClear: { type: Function as PropType<() => void>, required: true },
    loading: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    showActiveFilters: { type: Boolean, default: false },
  },
  setup(props) {
    const { t } = useLocale();

    const active = computed(() =>
      props.filtersDescription.filter((field) => {
        const value = props.filters[field.key];
        return value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
      }),
    );

    const remove = (field: FilterField, value?: string) => {
      const current = props.filters[field.key];
      if (Array.isArray(current) && value !== undefined) {
        props.setFilter(field.key, current.filter((entry) => entry !== value));
        return;
      }
      props.setFilter(field.key, undefined);
    };

    return (): VNodeChild => {
      if (!props.filtersDescription.length) return null;
      return (
        <div class="pg-filters-container">
          {props.showActiveFilters && active.value.length > 0 ? (
            <div class="pg-filters-container__active">
              {active.value.flatMap((field) => {
                const value = props.filters[field.key];
                const values = Array.isArray(value) ? value : [value];
                return values.map((entry) => (
                  <span key={`${field.key}-${String(entry)}`} class="pg-filter-chip">
                    <span class="pg-filter-chip__label">{t(field.label)}:</span>
                    <span class="pg-filter-chip__value">{t(String(entry))}</span>
                    <button
                      type="button"
                      class="pg-filter-chip__remove"
                      aria-label={`${t("Remove")} ${t(String(entry))}`}
                      onClick={() => remove(field, String(entry))}
                    >
                      <VIcon icon="mdi-close" size={12} />
                    </button>
                  </span>
                ));
              })}
            </div>
          ) : null}

          <div class="pg-filters-container__grid">
            {props.filtersDescription.map((field) => {
              const value = props.filters[field.key];
              return (
                <div key={field.key} class="pg-field-wrapper">
                  <label>{t(field.label)}</label>
                  {field.type === "data-autocomplete" ? (
                    <VAutocomplete
                      items={field.items}
                      itemTitle={field.itemTitle}
                      itemValue={field.itemValue}
                      multiple={field.multiple}
                      chips={field.multiple}
                      clearable
                      disabled={props.disabled}
                      density="compact"
                      variant="outlined"
                      hideDetails
                      placeholder={t("Any")}
                      modelValue={(value ?? (field.multiple ? [] : null)) as never}
                      onUpdate:modelValue={(next: unknown) => props.setFilter(field.key, next)}
                    />
                  ) : field.type === "api-autocomplete" ? (
                    <VTextField
                      disabled={props.disabled}
                      density="compact"
                      variant="outlined"
                      hideDetails
                      clearable
                      placeholder={t("Any")}
                      modelValue={value ?? ""}
                      onUpdate:modelValue={(next: string) => props.setFilter(field.key, next || undefined)}
                    />
                  ) : field.type === "date-input" ? (
                    <VTextField
                      type="date"
                      disabled={props.disabled}
                      density="compact"
                      variant="outlined"
                      hideDetails
                      clearable
                      modelValue={value ?? ""}
                      onUpdate:modelValue={(next: string) => props.setFilter(field.key, next || undefined)}
                    />
                  ) : (
                    <VTextField
                      type={field.fieldType ?? "text"}
                      disabled={props.disabled}
                      density="compact"
                      variant="outlined"
                      hideDetails
                      clearable
                      placeholder={t("Any")}
                      modelValue={value ?? ""}
                      onUpdate:modelValue={(next: string) => props.setFilter(field.key, next || undefined)}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div class="pg-filters-container__actions">
            <VBtn variant="text" disabled={props.disabled} onClick={() => props.onClear()}>
              {t("Clear")}
            </VBtn>
            <VBtn variant="flat" loading={props.loading} disabled={props.disabled || props.loading} onClick={() => props.onApply()}>
              {t("Apply filters")}
            </VBtn>
          </div>
        </div>
      );
    };
  },
});

export default FiltersContainer;

import { isEmpty, type RulesList } from "@/utils/clientValidationRules";
import { dc } from "kt-dc";
import { useLocale } from "vuetify";
import { VIcon, VForm } from "vuetify/components";
import { MetaPill } from "@/components/ui/MetaPill";

export type FilterField<T, Key = string> =
    | {
          type: "text";
          label: string;
          rules?: RulesList;
          fieldType?: "phone" | "email" | "password" | "number" | "text";
          key: Key;
      }
    | {
          type: "data-autocomplete";
          label: string;
          rules?: RulesList;
          key: Key;
          items: T[];
          multiple?: boolean;
          itemTitle: (item: T) => string;
          itemValue: (item: T) => any;
      }
    | {
          type: "api-autocomplete";
          url: string;
          apiDataExtractor: (data: any) => any[];
          label: string;
          multiple?: boolean;
          rules?: RulesList;
          key: Key;
          itemTitle: (item: any) => string;
          itemValue: (item: any) => any;
      }
    | {
          type: "date-input";
          label: string;
          rules?: RulesList;
          key: Key;
          min?: Date;
          max?: Date;
      };

const ActiveFilters = dc(
    <T,>(props: {
        showActiveFilters?: boolean;
        filters: {
            [key: string]: any;
        };
        clear: () => void;
        filtersDescriptions: FilterField<T>[];
        setFilters: (key: string, value: any) => void;
    }) => {
        const { t } = useLocale();
        const fieldMap = computed(() => {
            return props.filtersDescriptions.reduce(
                (map, field) => {
                    map[field.key] = field;
                    return map;
                },
                {} as {
                    [key: string]: FilterField<T>;
                },
            );
        });

        const chipLabel = (key: string, value: string) => (
            <>
                <span>{t(fieldMap.value[key]?.label || "")}</span>
                <span style={{ color: "var(--pg-ink-primary)", fontWeight: 600 }}>{t(value)}</span>
            </>
        );

        const removeButton = (key: string, value: string, arrayValue?: string[]) => (
            <button
                type="button"
                class="pg-filter-chip__remove"
                aria-label={`${t("Remove")} ${t(value)}`}
                onClick={(event: MouseEvent) => {
                    event.stopPropagation();
                    if (arrayValue) {
                        props.setFilters(
                            key,
                            arrayValue.filter((entry) => entry !== value),
                        );
                    } else {
                        props.setFilters(key, null);
                    }
                }}
            >
                <VIcon size={12} icon="mdi-close" />
            </button>
        );

        return () => {
            return (
                <div class="pg-filters-container__active">
                    <ThemedText
                        style={{
                            fontSize: "13px",
                            fontWeight: 500,
                            color: "var(--pg-ink-muted)",
                            marginInlineEnd: "4px",
                        }}
                    >
                        {t("Active filters")}:
                    </ThemedText>
                    {props.showActiveFilters &&
                        Object.entries(props.filters).map(([key, value]) => {
                            if (typeof value == "string") {
                                return (
                                    <MetaPill key={key} variant="outlined">
                                        {chipLabel(key, value)}
                                        {removeButton(key, value)}
                                    </MetaPill>
                                );
                            } else if (Array.isArray(value) && value.length > 0 && typeof value[0] == "string") {
                                return value.map((v) => (
                                    <MetaPill key={`${key}${v}`} variant="outlined">
                                        {chipLabel(key, v)}
                                        {removeButton(key, v, value)}
                                    </MetaPill>
                                ));
                            }
                            return null;
                        })}

                    <Button
                        variant="text"
                        label="Clear All"
                        onClick={props.clear}
                        style={{
                            marginInlineStart: "auto",
                            color: "var(--pg-ink-secondary)",
                            fontSize: "13px",
                            fontWeight: 500,
                            textTransform: "none",
                        }}
                    />
                </div>
            );
        };
    },
    {
        props: ["showActiveFilters", "clear", "filters", "filtersDescriptions", "setFilters"] as any,
    },
);

const FilterContainer = dc(
    <
        T extends {
            [key: string]: any;
        },
    >(props: {
        filters: T;
        showActiveFilters?: boolean;
        setFilter: (key: keyof T, value: any) => void;
        onApply: () => void;
        onClear: () => void;
        loading: boolean;
        disabled: boolean;
        filtersDescription: FilterField<any, keyof T>[];
    }) => {
        const { t } = useLocale();
        const valid = ref(false);
        return () => {
            if (!props.filtersDescription.length) {
                return <></>;
            }
            return (
                <div class="pg-filters-container">
                    <ActiveFilters<any>
                        clear={props.onClear}
                        filters={props.filters}
                        filtersDescriptions={props.filtersDescription as any}
                        setFilters={props.setFilter}
                    ></ActiveFilters>

                    <VForm
                        disabled={props.disabled}
                        onSubmit={(e) => {
                            e.preventDefault();
                            props.onApply();
                        }}
                        modelValue={valid.value}
                        onUpdate:modelValue={(v) => {
                            valid.value = !!v;
                        }}
                    >
                        <div class="pg-filters-container__grid">
                            {props.filtersDescription.map((f) => {
                                let filterField: JSX.Element = <></>;

                                if (f.type == "text") {
                                    filterField = (
                                        <TextField
                                            modelValue={props.filters[f.key]}
                                            onUpdate:modelValue={(v) => {
                                                props.setFilter(f.key, isEmpty(v) ? undefined : v);
                                            }}
                                            clearable
                                            onClick:clear={() => {
                                                props.setFilter(f.key, undefined);
                                            }}
                                            type={f.fieldType}
                                            rules={f.rules}
                                            label={undefined}
                                            placeholder={t(f.label)}
                                            name={f.key?.toString()}
                                        ></TextField>
                                    );
                                } else if (f.type == "data-autocomplete") {
                                    filterField = (
                                        <Autocomplete
                                            name={f.key?.toString()}
                                            label={undefined}
                                            placeholder={t(f.label)}
                                            items={f.items}
                                            itemTitle={f.itemTitle}
                                            itemValue={f.itemValue}
                                            modelValue={props.filters[f.key]}
                                            onUpdate:modelValue={(v) => {
                                                props.setFilter(f.key, isEmpty(v) ? undefined : v);
                                            }}
                                            multiple={f.multiple}
                                            chips={f.multiple}
                                            closableChips={f.multiple}
                                            clearable
                                            onClick:clear={() => {
                                                props.setFilter(f.key, undefined);
                                            }}
                                            rules={f.rules}
                                        ></Autocomplete>
                                    );
                                } else if (f.type == "api-autocomplete") {
                                    filterField = (
                                        <ApiAutocomplete
                                            apiDataExtractor={f.apiDataExtractor}
                                            url={f.url}
                                            name={f.key?.toString()}
                                            label={undefined}
                                            placeholder={t(f.label)}
                                            itemTitle={f.itemTitle}
                                            itemValue={f.itemValue}
                                            modelValue={props.filters[f.key]}
                                            onUpdate:modelValue={(v) => {
                                                props.setFilter(f.key, isEmpty(v) ? undefined : v);
                                            }}
                                            multiple={f.multiple}
                                            chips={f.multiple}
                                            closableChips={f.multiple}
                                            clearable
                                            onClick:clear={() => {
                                                props.setFilter(f.key, undefined);
                                            }}
                                            rules={f.rules}
                                        ></ApiAutocomplete>
                                    );
                                } else if (f.type == "date-input") {
                                    filterField = (
                                        <DateInput
                                            name={f.key?.toString()}
                                            rules={f.rules}
                                            label={undefined}
                                            placeholder={t(f.label)}
                                            modelValue={props.filters[f.key]}
                                            onUpdate:modelValue={(v) => {
                                                props.setFilter(f.key, isEmpty(v) ? undefined : v);
                                            }}
                                            clearable
                                            onClick:clear={() => {
                                                props.setFilter(f.key, undefined);
                                            }}
                                        ></DateInput>
                                    );
                                }

                                return (
                                    <div class="pg-field-wrapper" key={f.key}>
                                        <label
                                            style={{
                                                fontSize: "12.5px",
                                                fontWeight: 500,
                                                color: "var(--pg-ink-primary)",
                                            }}
                                        >
                                            {t(f.label)}
                                        </label>
                                        {filterField}
                                    </div>
                                );
                            })}
                        </div>
                    </VForm>

                    <div class="pg-filters-container__actions">
                        <Button
                            variant="text"
                            label="Apply Filters"
                            disabled={!valid.value || props.loading}
                            loading={props.loading}
                            onClick={() => {
                                props.onApply();
                            }}
                        ></Button>
                    </div>
                </div>
            );
        };
    },
    {
        props: ["disabled", "showActiveFilters", "filters", "filtersDescription", "loading", "onApply", "onClear", "setFilter"] as any,
    },
);
export default FilterContainer;

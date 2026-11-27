import {PgText as ThemedText} from "@pg/ui";
import {PgButton as Button} from "@pg/ui";
import {PgTextField as TextField} from "@pg/ui";
import {PgAutocomplete as Autocomplete} from "@pg/ui";
import {PgApiAutocomplete as ApiAutocomplete} from "@pg/ui";
import {PgDateInput as DateInput} from "@pg/ui";
import { computed, ref } from "vue";
import { isEmpty, type RulesList } from "@/utils/clientValidationRules";
import { dc } from "@/utils/dc";
import { useLocale } from "@/utils/vael-compat";
import {PgChip, PgForm} from "@pg/ui";

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
                                    <PgChip
                                        key={key}
                                        closable
                                        onClick:close={() => {
                                            props.setFilters(key, null);
                                        }}
                                        density="compact"
                                        variant="tonal"
                                    >
                                        {t(fieldMap.value[key]?.label || "")} {t(value)}
                                    </PgChip>
                                );
                            } else if (Array.isArray(value) && value.length > 0 && typeof value[0] == "string") {
                                return value.map((v) => {
                                    return (
                                        <PgChip
                                            key={`${key}${v}`}
                                            closable
                                            onClick:close={() => {
                                                const filtered = value.filter((entry) => entry !== v);
                                                props.setFilters(key, filtered);
                                            }}
                                            density="compact"
                                            variant="tonal"
                                        >
                                            {t(fieldMap.value[key]?.label || "")} {t(v)}
                                        </PgChip>
                                    );
                                });
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
            return (!props.filtersDescription.length ? <></> : (
                <div class="pg-filters-container">
                    <ActiveFilters<any>
                        clear={props.onClear}
                        filters={props.filters}
                        filtersDescriptions={props.filtersDescription as any}
                        setFilters={props.setFilter}
                    ></ActiveFilters>

                    <PgForm
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
                    </PgForm>

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
            ));
        };
    },
    {
        props: ["disabled", "showActiveFilters", "filters", "filtersDescription", "loading", "onApply", "onClear", "setFilter"] as any,
    },
);
export default FilterContainer;

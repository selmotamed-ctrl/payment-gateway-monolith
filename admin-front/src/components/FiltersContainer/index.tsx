import { isEmpty, type RulesList } from "@/utils/clientValidationRules";
import { dc } from "kt-dc";
import { useLocale, useTheme } from "vuetify";
import { VChip, VForm } from "vuetify/components";

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
        const theme = useTheme();
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
            const isDark = theme.current.value.dark;
            const colors = theme.current.value.colors;
            return (
                <>
                    <ThemedView
                        style={{
                            flexDirection: "row",
                            flexWrap: "wrap",
                            gap: "8px",
                            alignItems: "center",
                            padding: "12px 16px",
                            backgroundColor: isDark ? colors["surface-variant"] : "#f8fafc",
                            borderRadius: "8px",
                            border: isDark ? "1px solid rgba(255, 255, 255, 0.1)" : "1px solid #e2e8f0",
                        }}
                    >
                        <ThemedText
                            style={{
                                fontSize: "14px",
                                fontWeight: "500",
                                color: colors["on-surface-variant"],
                                marginRight: "4px",
                            }}
                        >
                            {t("Active filters")}:
                        </ThemedText>
                        {props.showActiveFilters &&
                            Object.entries(props.filters).map(([key, value], index) => {
                                let uniqueKey = key;
                                if (typeof value == "string") {
                                    return (
                                        <VChip
                                            key={uniqueKey}
                                            closable
                                            onClick:close={() => {
                                                props.setFilters(key, null);
                                            }}
                                            density="compact"
                                            variant="tonal"
                                        >
                                            {t(fieldMap.value[key]?.label || "")} {t(value)}
                                        </VChip>
                                    );
                                } else if (Array.isArray(value) && value.length > 0 && typeof value[0] == "string") {
                                    return value.map((v) => {
                                        let uniqueKey = `${key}${v}`;

                                        return (
                                            <VChip
                                                key={uniqueKey}
                                                closable
                                                onClick:close={() => {
                                                    const filtered = value.filter((_v) => {
                                                        return v !== _v;
                                                    });
                                                    props.setFilters(key, filtered);
                                                }}
                                                density="compact"
                                                variant="tonal"
                                            >
                                                {t(fieldMap.value[key]?.label || "")} {t(v)}
                                            </VChip>
                                        );
                                    });
                                }
                            })}

                        {/* Clear All Button */}
                        <Button
                            variant="text"
                            label="Clear All"
                            onClick={props.clear}
                            style={{
                                marginLeft: "auto",
                                color: colors["on-surface-variant"],
                                fontSize: "14px",
                                fontWeight: "500",
                                textTransform: "none",
                            }}
                        />
                    </ThemedView>
                </>
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
                <ThemedView
                    style={{
                        gap: "16px",
                        padding: "16px 0px",
                    }}
                >
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
                        <ThemedView
                            style={{
                                flexDirection: "row",
                                gap: "16px",
                                alignItems: "flex-start",
                                flexWrap: "wrap",
                            }}
                        >
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
                                            label={t(f.label)}
                                            name={f.key?.toString()}
                                        ></TextField>
                                    );
                                } else if (f.type == "data-autocomplete") {
                                    filterField = (
                                        <Autocomplete
                                            name={f.key?.toString()}
                                            label={t(f.label)}
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
                                            label={t(f.label)}
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
                                            label={t(f.label)}
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
                                    <ThemedView
                                        key={f.key}
                                        style={{
                                            flex: "1",
                                            minWidth: "200px",
                                        }}
                                    >
                                        {filterField}
                                    </ThemedView>
                                );
                            })}
                        </ThemedView>
                    </VForm>

                    <Button
                        variant="text"
                        label="Apply Filters"
                        disabled={!valid.value || props.loading}
                        loading={props.loading}
                        onClick={() => {
                            props.onApply();
                        }}
                    ></Button>
                </ThemedView>
            );
        };
    },
    {
        props: ["disabled", "showActiveFilters", "filters", "filtersDescription", "loading", "onApply", "onClear", "setFilter"] as any,
    },
);
export default FilterContainer;

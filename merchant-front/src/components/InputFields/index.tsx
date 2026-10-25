import type { RulesList } from "@/utils/clientValidationRules";
import { bytesValueToReadable } from "@/utils/common";
import { fileToBase64 } from "@/utils/FileToB64";
import { dc } from "kt-dc";
import { useLocale } from "vuetify";
import { VFileInput } from "vuetify/components";
import { isEmpty } from "@/utils/clientValidationRules";

export const _1mb = 1024 * 1024;

export type Field<T, Form> = (
    | {
          type: "b64-file-input";
          allowedMimeTypes: string[];
          maximumSizeInBytes: number;
      }
    | {
          type: "data-autocomplete";
          items: T[];
          multiple?: boolean;
          itemTitle: (item: T) => string;
          itemValue: (item: T) => any;
      }
    | {
          type: "api-autocomplete";
          url: string;
          apiDataExtractor: (data: any) => any[];
          multiple?: boolean;
          itemTitle: (item: any) => string;
          itemValue: (item: any) => any;
      }
    | {
          type: "date-input";
          min?: Date;
          max?: Date;
      }
    | {
          type: "text";
          fieldType?: "password" | "number" | "text";
      }
) & {
    required?: boolean;
    disabled?: boolean;
    label: string;
    constantSet?:
        | {
              key: string;
              value: any;
          }
        | ((v: any) => void);
    clearKey?: string;
    loading?: boolean;
    rules?: RulesList;
    fieldKey: keyof Form;
    form: Form;
    setField: (key: keyof Form, value: any) => void;
    clearField: (key: keyof Form) => void;
};
export type InputFieldDescriptor<
    T = any,
    Form = {
        [key: string]: any;
    },
> = (
    | {
          type: "b64-file-input";
          allowedMimeTypes: string[];
          maximumSizeInBytes: number;
      }
    | {
          type: "data-autocomplete";
          items: T[];
          multiple?: boolean;
          itemTitle: (item: T) => string;
          itemValue: (item: T) => any;
      }
    | {
          type: "api-autocomplete";
          url: string;
          apiDataExtractor: (data: any) => any[];
          multiple?: boolean;
          itemTitle: (item: any) => string;
          itemValue: (item: any) => any;
      }
    | {
          type: "date-input";
          min?: Date;
          max?: Date;
      }
    | {
          type: "text";
          fieldType?: "phone" | "password" | "number" | "text" | "email";
      }
) & {
    required?: boolean;
    label: string;
    rules?: RulesList;
    constantSet?:
        | {
              key: string;
              value: any;
          }
        | ((v: any) => void);

    clearKey?: string;
    fieldKey: keyof Form;
};
const InputField = dc(
    <T, Form>(props: Field<T, Form>) => {
        const locale = useLocale();
        const setConstants = (v: any) => {
            if (typeof props.constantSet == "object") {
                props.setField(props.constantSet.key as any, props.constantSet.value);
            } else if (typeof props.constantSet == "function") {
                props.constantSet(v);
            }
        };
        return () => {
            const t = locale.t;
            const f = props;

            console.log("rendering field", f);
            if (f.type == "b64-file-input") {
                return (
                    <VFileInput
                        onUpdate:modelValue={(v) => {
                            if (isEmpty(v)) {
                                props.setField((f.clearKey || f.fieldKey) as any, null);
                                return;
                            }
                            if (Array.isArray(v) && v.length) {
                                const file = v[0]!;
                                fileToBase64(file).then((b64) => {
                                    f.setField(f.fieldKey, b64);
                                });
                                setConstants(file);
                            } else if (v instanceof File) {
                                const file = v;
                                fileToBase64(file).then((b64) => {
                                    f.setField(f.fieldKey, b64);
                                });
                                setConstants(file);
                            }
                        }}
                        name={f.fieldKey as string}
                        label={t(f.label)}
                        showSize
                        rules={[
                            ...(f.rules || []),
                            (v) => {
                                if (isEmpty(v)) {
                                    return true;
                                }

                                let file: undefined | File = undefined;
                                if (Array.isArray(v) && v.length) {
                                    file = v[0]!;
                                } else if (v instanceof File) {
                                    file = v;
                                }
                                if (!file) {
                                    return t("File not found");
                                }

                                if (f.maximumSizeInBytes && f.maximumSizeInBytes < file.size) {
                                    return t(
                                        `File is too large it must be smaller than {{${bytesValueToReadable(f.maximumSizeInBytes)}}}, your file size is {{${file.size}}}`,
                                    );
                                }

                                if (f.allowedMimeTypes?.length && !f.allowedMimeTypes.includes(file.type)) {
                                    return t(`File must be one the following types {{${f.allowedMimeTypes.join(", ")}}}`);
                                }

                                return true;
                            },
                        ]}
                        clearable
                        onClick:clear={() => {
                            props.setField((f.clearKey || f.fieldKey) as any, null);
                        }}
                        class={f.required ? "required-field" : undefined}
                        // @ts-ignore
                        accept={f.allowedMimeTypes?.join(", ")}
                    ></VFileInput>
                );
            } else if (f.type == "text") {
                return (
                    <TextField
                        name={f.fieldKey as string}
                        label={t(f.label)}
                        onUpdate:modelValue={(v) => {
                            if (isEmpty(v)) {
                                props.setField((f.clearKey || f.fieldKey) as any, null);
                                return;
                            }
                            f.setField(props.fieldKey, v);
                            setConstants(v);
                        }}
                        modelValue={f.form[f.fieldKey]}
                        rules={f.rules}
                        clearable
                        onClick:clear={() => {
                            props.setField((f.clearKey || f.fieldKey) as any, null);
                        }}
                        class={f.required ? "required-field" : undefined}
                        type={f.fieldType}
                    ></TextField>
                );
            } else if (f.type == "api-autocomplete") {
                <ApiAutocomplete
                    apiDataExtractor={f.apiDataExtractor}
                    url={f.url}
                    name={f.fieldKey?.toString()}
                    label={t(f.label)}
                    itemTitle={f.itemTitle}
                    itemValue={f.itemValue}
                    modelValue={f.form[f.fieldKey]}
                    onUpdate:modelValue={(v) => {
                        if (isEmpty(v)) {
                            props.setField((f.clearKey || f.fieldKey) as any, null);
                            return;
                        }
                        f.setField(props.fieldKey, v);
                        setConstants(v);
                    }}
                    multiple={f.multiple}
                    chips={f.multiple}
                    closableChips={f.multiple}
                    clearable
                    onClick:clear={() => {
                        props.setField((f.clearKey || f.fieldKey) as any, null);
                    }}
                    rules={f.rules}
                ></ApiAutocomplete>;
            } else if (f.type == "data-autocomplete") {
                return (
                    <Autocomplete
                        name={f.fieldKey?.toString()}
                        label={t(f.label)}
                        items={f.items}
                        itemTitle={f.itemTitle}
                        itemValue={f.itemValue}
                        modelValue={props.form[f.fieldKey] as any}
                        onUpdate:modelValue={(v) => {
                            if (isEmpty(v)) {
                                props.setField((f.clearKey || f.fieldKey) as any, null);
                                return;
                            }
                            f.setField(props.fieldKey, v);
                            setConstants(v);
                        }}
                        multiple={f.multiple}
                        chips={f.multiple}
                        closableChips={f.multiple}
                        clearable
                        onClick:clear={() => {
                            props.setField((f.clearKey || f.fieldKey) as any, null);
                        }}
                        rules={f.rules}
                    ></Autocomplete>
                );
            } else if (f.type == "date-input") {
                return (
                    <DateInput
                        name={f.fieldKey?.toString()}
                        rules={f.rules}
                        label={t(f.label)}
                        modelValue={props.form[f.fieldKey]}
                        onUpdate:modelValue={(v) => {
                            if (isEmpty(v)) {
                                props.setField((f.clearKey || f.fieldKey) as any, null);
                                return;
                            }
                            f.setField(props.fieldKey, v);
                            setConstants(v);
                        }}
                        clearable
                        onClick:clear={() => {
                            props.setField((f.clearKey || f.fieldKey) as any, undefined);
                        }}
                    ></DateInput>
                );
            }
        };
    },
    {
        props: [
            ...new Set([
                "type",
                "allowedMimeTypes",
                "maximumSizeInBytes",
                "type",
                "items",
                "multiple",
                "constantSet",
                "itemTitle",
                "itemValue",
                "type",
                "url",
                "apiDataExtractor",
                "multiple",
                "itemTitle",
                "clearKey",
                "itemValue",
                "type",
                "min",
                "max",
                "type",
                "fieldType",
                "required",
                "label",
                "rules",
                "fieldKey",
                "form",
                "required",
                "disabled",
                "label",
                "loading",
                "rules",
                "fieldKey",
                "form",
                "setField",
                "clearField",
            ]),
        ] as any,
    },
);

const InputFields = dc(
    <
        T,
        Form extends {
            [key: string]: any;
        },
    >(props: {
        form: Form;
        setField: (key: keyof Form, value: any) => void;
        fields: (InputFieldDescriptor<T, Form> & {
            upperSlot?: () => JSX.Element;
            lowerSlot?: () => JSX.Element;
        })[];
        disabled?: boolean;
        loading?: boolean;
    }) => {
        return () => {
            return (
                <ThemedView style={{ gap: "22px" }}>
                    {props.fields.map((f) => {
                        return (
                            <>
                                {f.upperSlot?.()}
                                <InputField
                                    {...(f as any)}
                                    fieldKey={f.fieldKey}
                                    setField={props.setField}
                                    form={props.form}
                                    disabled={props.disabled}
                                    loading={props.loading}
                                ></InputField>
                                {f.lowerSlot?.()}
                            </>
                        );
                    })}
                </ThemedView>
            );
        };
    },
    {
        props: ["clearField", "loading", "disabled", "fields", "form", "setField"] as any,
    },
);

export default InputFields;

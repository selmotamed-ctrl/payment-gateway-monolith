import { computed, defineComponent, onMounted, ref, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VAutocomplete, VFileInput, VSelect, VSwitch, VTextarea, VTextField } from "vuetify/components";
import { api } from "@/utils/api";

type Rule = (value: unknown) => true | string;
type Form = Record<string, any>;

type InputFieldDescriptor = {
  type: "text" | "date-input" | "b64-file-input" | "data-autocomplete" | "api-autocomplete" | "select" | "switch";
  fieldKey: string;
  label: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  fieldType?: "text" | "password" | "number" | "email" | "phone";
  rules?: Rule[];
  multiple?: boolean;
  items?: any[];
  itemTitle?: string | ((item: any) => string);
  itemValue?: string | ((item: any) => any);
  url?: string;
  apiDataExtractor?: (data: any) => any[];
  clearKey?: string;
  hint?: string;
};

const ApiAutocompleteField = defineComponent({
  name: "ApiAutocompleteField",
  props: {
    descriptor: { type: Object as PropType<InputFieldDescriptor>, required: true },
    modelValue: { type: [String, Number, Object, Array] as PropType<any>, default: null },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const items = ref<any[]>([]);
    const loading = ref(false);

    const load = async () => {
      if (!props.descriptor.url) return;
      loading.value = true;
      try {
        const payload = await api<any>(props.descriptor.url);
        items.value = props.descriptor.apiDataExtractor ? props.descriptor.apiDataExtractor(payload) : [];
      } finally {
        loading.value = false;
      }
    };

    onMounted(() => void load());

    return (): VNodeChild => (
      <VAutocomplete
        items={items.value}
        itemTitle={props.descriptor.itemTitle}
        itemValue={props.descriptor.itemValue}
        modelValue={props.modelValue}
        onUpdate:modelValue={(value: unknown) => emit("update:modelValue", value)}
        multiple={props.descriptor.multiple}
        chips={props.descriptor.multiple}
        clearable
        loading={loading.value}
        disabled={props.disabled}
        density="compact"
        variant="outlined"
        hideDetails
        placeholder={props.descriptor.placeholder}
      />
    );
  },
});

const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? "").split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

export const InputFields = defineComponent({
  name: "InputFields",
  props: {
    form: { type: Object as PropType<Form>, required: true },
    setField: { type: Function as PropType<(key: string, value: any) => void>, required: true },
    fields: { type: Array as PropType<InputFieldDescriptor[]>, default: () => [] },
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
  },
  setup(props) {
    const { t } = useLocale();
    const visibleFields = computed(() => props.fields ?? []);

    return (): VNodeChild => (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px 20px", alignItems: "start" }}>
        {visibleFields.value.map((field) => {
          const value = props.form[field.fieldKey];
          const disabled = props.disabled || field.disabled;
          const update = (next: any) => props.setField(field.fieldKey, next);

          return (
            <div key={field.fieldKey} class="pg-field-wrapper">
              <label>
                {t(field.label)}
                {field.required ? <span style={{ color: "var(--pg-status-danger-dot)", marginInlineStart: "3px" }}>*</span> : null}
              </label>
              {field.type === "switch" ? (
                <VSwitch
                  modelValue={Boolean(value)}
                  onUpdate:modelValue={(next: boolean | null) => update(next === true)}
                  disabled={disabled}
                  density="compact"
                  hideDetails
                  label={field.placeholder}
                />
              ) : field.type === "select" ? (
                <VSelect
                  items={field.items ?? []}
                  itemTitle={field.itemTitle as string | undefined}
                  itemValue={field.itemValue as string | undefined}
                  modelValue={value ?? null}
                  onUpdate:modelValue={(next: unknown) => update(next)}
                  multiple={field.multiple}
                  clearable
                  disabled={disabled}
                  density="compact"
                  variant="outlined"
                  hideDetails
                  placeholder={field.placeholder ?? t(field.label)}
                />
              ) : field.type === "data-autocomplete" ? (
                <VAutocomplete
                  items={field.items ?? []}
                  itemTitle={field.itemTitle}
                  itemValue={field.itemValue}
                  modelValue={value ?? null}
                  onUpdate:modelValue={(next: unknown) => update(next)}
                  multiple={field.multiple}
                  chips={field.multiple}
                  clearable
                  disabled={disabled}
                  density="compact"
                  variant="outlined"
                  hideDetails
                  placeholder={field.placeholder ?? t(field.label)}
                />
              ) : field.type === "api-autocomplete" ? (
                <ApiAutocompleteField
                  descriptor={field}
                  modelValue={value ?? null}
                  disabled={disabled}
                  onUpdate:modelValue={(next: unknown) => update(next)}
                />
              ) : field.type === "b64-file-input" ? (
                <VFileInput
                  disabled={disabled}
                  density="compact"
                  variant="outlined"
                  hideDetails
                  clearable
                  onUpdate:modelValue={(files: File[] | File | null) => {
                    const file = Array.isArray(files) ? files[0] : files instanceof File ? files : null;
                    if (!file) {
                      update(null);
                      return;
                    }
                    void toBase64(file).then(update);
                  }}
                />
              ) : field.type === "date-input" ? (
                <VTextField
                  type="date"
                  modelValue={value ?? ""}
                  onUpdate:modelValue={(next: string) => update(next || null)}
                  clearable
                  disabled={disabled}
                  density="compact"
                  variant="outlined"
                  hideDetails
                />
              ) : (
                <VTextField
                  type={field.fieldType ?? "text"}
                  modelValue={value ?? ""}
                  onUpdate:modelValue={(next: string) => update(next)}
                  clearable
                  disabled={disabled}
                  density="compact"
                  variant="outlined"
                  hideDetails
                  placeholder={field.placeholder ?? t(field.label)}
                  rules={field.rules as any}
                />
              )}
            </div>
          );
        })}
      </div>
    );
  },
});

export default InputFields;

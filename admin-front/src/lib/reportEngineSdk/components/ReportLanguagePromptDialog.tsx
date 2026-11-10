import { defineComponent, ref, watch, type PropType } from "vue";
import { VRadio, VRadioGroup } from "vuetify/components";
import { useLocale } from "vuetify";
import { FormModal } from "@/components/ui";
import { buildLocaleOptions } from "../utils/localeMeta";

export const ReportLanguagePromptDialog = defineComponent({
  name: "ReportLanguagePromptDialog",
  props: {
    modelValue: { type: Boolean, required: true },
    availableLocales: { type: Array as PropType<string[]>, required: true },
    defaultLocale: { type: String, default: "en" },
    reportTitleMap: { type: Object as PropType<Record<string, string>>, default: () => ({}) },
    loading: { type: Boolean, default: false },
  },
  emits: ["update:modelValue", "confirmLocale"],
  setup(props, { emit }) {
    const { t } = useLocale();
    const initial = () => props.defaultLocale || props.availableLocales[0] || "en";
    const chosen = ref<string>(initial());

    // Always start from the report's default locale; reopening must not keep
    // the previous choice (C12).
    watch(
      () => [props.modelValue, props.defaultLocale] as const,
      ([open]) => {
        if (open) chosen.value = initial();
      },
      { immediate: true },
    );

    const confirm = () => {
      emit("confirmLocale", chosen.value);
      emit("update:modelValue", false);
    };

    return () => (
      <FormModal
        modelValue={props.modelValue}
        title={t("Select Report Language")}
        subtitle={t("Choose the language and layout direction for this report")}
        size="sm"
        submitLabel={t("Generate Report")}
        onSubmit={confirm}
        onUpdate:modelValue={(value: boolean) => emit("update:modelValue", value)}
      >
        <VRadioGroup
          modelValue={chosen.value}
          onUpdate:modelValue={(value: string | null) => (chosen.value = value ?? initial())}
          hideDetails
        >
          {buildLocaleOptions(props.availableLocales, props.reportTitleMap).map((option) => (
            <VRadio
              key={option.locale}
              value={option.locale}
              label={`${option.nativeName} [${option.locale.toUpperCase()} — ${option.direction}]${
                option.localizedTitle ? ` — ${option.localizedTitle}` : ""
              }`}
              class="mb-2"
            />
          ))}
        </VRadioGroup>
      </FormModal>
    );
  },
});

export default ReportLanguagePromptDialog;

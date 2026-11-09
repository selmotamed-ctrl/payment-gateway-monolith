import { defineComponent, ref, type PropType } from "vue";
import { VBtn, VCard, VCardActions, VCardText, VCardTitle, VDialog, VRadio, VRadioGroup } from "vuetify/components";
import { buildLocaleOptions } from "../utils/localeMeta";

export const ReportLanguagePromptDialog = defineComponent({
  name: "ReportLanguagePromptDialog",
  props: {
    modelValue: { type: Boolean, required: true },
    availableLocales: { type: Array as PropType<string[]>, required: true },
    defaultLocale: { type: String, default: "en" },
    reportTitleMap: { type: Object as PropType<Record<string, string>>, default: () => ({}) },
  },
  emits: ["update:modelValue", "confirmLocale"],
  setup(props, { emit }) {
    const chosen = ref<string>(props.defaultLocale || props.availableLocales[0] || "en");

    const confirm = () => {
      emit("confirmLocale", chosen.value);
      emit("update:modelValue", false);
    };

    return () => (
      <VDialog
        modelValue={props.modelValue}
        maxWidth="480"
        onUpdate:modelValue={(val: boolean) => emit("update:modelValue", val)}
      >
        <VCard class="pa-4">
          <VCardTitle class="text-h6 font-weight-bold">
            Select Report Output Language / اختر لغة التقرير
          </VCardTitle>
          <VCardText>
            <p class="text-body-2 text-medium-emphasis mb-4">
              This report specification includes multiple translation dictionaries. Choose the language and
              layout direction for generation:
            </p>
            <VRadioGroup modelValue={chosen.value} onUpdate:modelValue={(value: string | null) => (chosen.value = value ?? "en")} hideDetails>
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
          </VCardText>
          <VCardActions class="justify-end ga-2 mt-2">
            <VBtn variant="text" onClick={() => emit("update:modelValue", false)}>
              Cancel
            </VBtn>
            <VBtn color="primary" variant="flat" prependIcon="mdi-translate" onClick={confirm}>
              Generate Report
            </VBtn>
          </VCardActions>
        </VCard>
      </VDialog>
    );
  },
});

export default ReportLanguagePromptDialog;

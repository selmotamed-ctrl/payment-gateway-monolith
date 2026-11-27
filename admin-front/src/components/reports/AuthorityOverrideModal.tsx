import { computed, ref, watch, type PropType } from "vue";
import { defineComponent } from "@/utils/dc";
import { useLocale } from "@/utils/vael-compat";
import {VAlert, PgCheckbox, PgAutocomplete, PgTextarea} from "@pg/ui";
import {FormField, FormModal} from "@pg/ui";

export const OVERRIDE_JUSTIFICATION_MIN = 15;

export type AuthorityOverridePayload = {
  allowedRoles: string[];
  allowedAuthorities: string[];
  justification: string;
  allowConfidentialAmlBypass: boolean;
};

/** Security Admin authority override for one saved report version (justification >= 15 characters, audited). */
export const AuthorityOverrideModal = defineComponent({
  name: "AuthorityOverrideModal",
  props: {
    modelValue: { type: Boolean, required: true },
    roles: { type: Array as PropType<string[]>, required: true },
    authorities: { type: Array as PropType<string[]>, required: true },
    initialRoles: { type: Array as PropType<string[]>, default: () => [] },
    initialAuthorities: { type: Array as PropType<string[]>, default: () => [] },
    /** Version label shown in the subtitle, e.g. "MERCHANT_SALES v3". */
    target: { type: String, default: "" },
    loading: { type: Boolean, default: false },
    errorMessage: { type: String, default: "" },
  },
  emits: ["update:modelValue", "submit"],
  setup(props, { emit }) {
    const { t } = useLocale();
    const roles = ref<string[]>([]);
    const authorities = ref<string[]>([]);
    const justification = ref("");
    const amlBypass = ref(false);
    const touched = ref(false);

    watch(
      () => props.modelValue,
      (open) => {
        if (!open) return;
        roles.value = [...props.initialRoles];
        authorities.value = [...props.initialAuthorities];
        justification.value = "";
        amlBypass.value = false;
        touched.value = false;
      },
      { immediate: true },
    );

    const justificationProblem = computed(() =>
      justification.value.trim().length < OVERRIDE_JUSTIFICATION_MIN
        ? t("Justification (minimum 15 characters)")
        : "",
    );

    const submit = () => {
      touched.value = true;
      if (justificationProblem.value) return;
      const payload: AuthorityOverridePayload = {
        allowedRoles: roles.value,
        allowedAuthorities: authorities.value,
        justification: justification.value.trim(),
        allowConfidentialAmlBypass: amlBypass.value,
      };
      emit("submit", payload);
    };

    return () => (
      <FormModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(value: boolean) => emit("update:modelValue", value)}
        title={t("Security Admin Authority Override")}
        subtitle={props.target}
        size="md"
        loading={props.loading}
        errorMessage={props.errorMessage}
        submitLabel={t("Apply Security Admin Override")}
        onSubmit={submit}
      >
        <FormField label={t("Allowed roles")}>
          <PgAutocomplete
            modelValue={roles.value}
            onUpdate:modelValue={(value: string[]) => (roles.value = value)}
            items={props.roles}
            multiple
            chips
          />
        </FormField>
        <FormField label={t("Allowed authorities")}>
          <PgAutocomplete
            modelValue={authorities.value}
            onUpdate:modelValue={(value: string[]) => (authorities.value = value)}
            items={props.authorities}
            multiple
            chips
          />
        </FormField>
        <PgCheckbox
          color="primary"
          hideDetails
          label={t("Allow confidential AML bypass (requires MLRO/Security sign-off)")}
          modelValue={amlBypass.value}
          onUpdate:modelValue={(value: boolean | null) => (amlBypass.value = Boolean(value))}
        />
        {amlBypass.value && (
          <VAlert type="info" variant="tonal">
            {t("AML bypass requested; a different MLRO or Security Admin must approve it")}
          </VAlert>
        )}
        <FormField
          label={t("Justification")}
          required
          hint={t("At least 15 characters. Recorded in the audit trail.")}
          error={touched.value ? justificationProblem.value : ""}
        >
          <PgTextarea
            modelValue={justification.value}
            onUpdate:modelValue={(value: string) => (justification.value = value)}
            rows={3}
            autoGrow
            hideDetails
          />
        </FormField>
      </FormModal>
    );
  },
});

export default AuthorityOverrideModal;

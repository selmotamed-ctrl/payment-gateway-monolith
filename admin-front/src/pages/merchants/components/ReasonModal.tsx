import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VTextarea } from "vuetify/components";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { REASON_MAX_LENGTH, reasonProblem, reasonProblemMessage, type GovernanceMode } from "../commerceGovernance";

/**
 * Reason prompt for every commerce mutation (contract section 1): an immediate
 * restrictive action and a four-eyes proposal both need a justification of at
 * least 10 characters, validated here exactly like the server does.
 */
export const ReasonModal = defineComponent({
    name: "ReasonModal",
    props: {
        modelValue: { type: Boolean, required: true },
        title: { type: String, required: true },
        description: { type: String, default: "" },
        submitLabel: { type: String, required: true },
        mode: { type: String as PropType<GovernanceMode>, default: "immediate" },
        danger: { type: Boolean, default: false },
        loading: { type: Boolean, default: false },
        errorMessage: { type: String, default: "" },
    },
    emits: ["update:modelValue", "submit"],
    setup(props, { emit, slots }) {
        const { t } = useLocale();
        const reason = ref("");
        const touched = ref(false);
        watch(
            () => props.modelValue,
            (open) => {
                if (open) {
                    reason.value = "";
                    touched.value = false;
                }
            },
        );
        const problem = computed(() => reasonProblem(reason.value));
        const submit = () => {
            touched.value = true;
            if (problem.value) return;
            emit("submit", reason.value.trim());
        };
        return (): VNodeChild => (
            <FormModal
                modelValue={props.modelValue}
                onUpdate:modelValue={(value: boolean) => emit("update:modelValue", value)}
                title={props.title}
                size="md"
                danger={props.danger}
                loading={props.loading}
                errorMessage={props.errorMessage}
                submitLabel={props.submitLabel}
                cancelLabel={t("Cancel")}
                onSubmit={submit}
            >
                {props.description && <p style={{ margin: 0, fontSize: "13px", color: "var(--pg-ink-secondary)", lineHeight: 1.5 }}>{props.description}</p>}
                {slots.default?.()}
                <VAlert type={props.mode === "approval" ? "info" : "warning"} variant="tonal" density="compact">
                    {props.mode === "approval"
                        ? t("This change is submitted for four-eyes approval. It is applied only after an independent checker approves it.")
                        : t("This takes effect immediately and is recorded in the audit trail.")}
                </VAlert>
                <FormField
                    label={t("Reason")}
                    required
                    sensitiveMakerChecker={props.mode === "approval"}
                    hint={t("At least 10 characters. Recorded in the audit trail.")}
                    error={touched.value && problem.value ? t(reasonProblemMessage(problem.value)) : ""}
                >
                    <VTextarea
                        modelValue={reason.value}
                        onUpdate:modelValue={(value: string) => (reason.value = value)}
                        rows={3}
                        autoGrow
                        {...{ maxlength: REASON_MAX_LENGTH }}
                        hideDetails
                    />
                </FormField>
            </FormModal>
        );
    },
});

export default ReasonModal;

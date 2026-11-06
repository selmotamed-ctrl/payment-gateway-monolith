import { defineComponent, ref, watch, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VSelect, VTextField, VTextarea } from "vuetify/components";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { showSnackBar } from "@/utils/snackBar";
import { reportCommerceError } from "../governedRequest";
import {
    KYB_DOC_TYPES,
    KYB_DOC_TYPE_LABELS,
    buildRevalidationBody,
    emptyRevalidationForm,
    validateRevalidation,
    type RevalidationErrors,
    type RevalidationForm,
} from "../revalidation";

/** "Request KYB revalidation": asks the merchant to re-upload a document by a due date (kyb:write). */
export const RevalidationModal = defineComponent({
    name: "RevalidationModal",
    props: {
        modelValue: { type: Boolean, required: true },
        merchantId: { type: String, required: true },
    },
    emits: ["update:modelValue", "done"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const form = ref<RevalidationForm>(emptyRevalidationForm());
        const errors = ref<RevalidationErrors>({});
        const saving = ref(false);
        const errorMessage = ref("");
        watch(
            () => props.modelValue,
            (open) => {
                if (open) {
                    form.value = emptyRevalidationForm();
                    errors.value = {};
                    errorMessage.value = "";
                }
            },
        );
        const submit = async () => {
            errors.value = validateRevalidation(form.value);
            if (Object.keys(errors.value).length > 0) return;
            saving.value = true;
            errorMessage.value = "";
            try {
                await api.post(urlsMap.merchantRevalidations(props.merchantId), buildRevalidationBody(form.value));
                showSnackBar({ type: "success", message: "KYB revalidation requested" });
                emit("update:modelValue", false);
                emit("done");
            } catch (cause) {
                errorMessage.value = reportCommerceError(cause);
            } finally {
                saving.value = false;
            }
        };
        const field = (key: keyof RevalidationErrors) => (errors.value[key] ? t(errors.value[key] as string) : "");
        return (): VNodeChild => (
            <FormModal
                modelValue={props.modelValue}
                onUpdate:modelValue={(value: boolean) => emit("update:modelValue", value)}
                title={t("Request KYB revalidation")}
                size="md"
                loading={saving.value}
                errorMessage={errorMessage.value}
                submitLabel={t("Send request")}
                cancelLabel={t("Cancel")}
                onSubmit={() => void submit()}
            >
                <VAlert type="info" variant="tonal" density="compact">
                    {t("The merchant is notified and the KYB status returns to pending until the document is re-submitted and reviewed.")}
                </VAlert>
                <FormField label={t("Document type")} required error={field("docType")}>
                    <VSelect
                        modelValue={form.value.docType}
                        onUpdate:modelValue={(value: RevalidationForm["docType"]) => (form.value.docType = value)}
                        items={KYB_DOC_TYPES.map((type) => ({ title: t(KYB_DOC_TYPE_LABELS[type]), value: type }))}
                        hideDetails
                    />
                </FormField>
                <FormField label={t("Due date (YYYY-MM-DD)")} required error={field("dueAt")}>
                    <VTextField modelValue={form.value.dueAt} onUpdate:modelValue={(value: string) => (form.value.dueAt = value)} {...{ dir: "ltr" }} hideDetails />
                </FormField>
                <FormField label={t("Message to the merchant")} required error={field("message")}>
                    <VTextarea modelValue={form.value.message} onUpdate:modelValue={(value: string) => (form.value.message = value)} rows={3} autoGrow {...{ maxlength: 1000 }} hideDetails />
                </FormField>
            </FormModal>
        );
    },
});

export default RevalidationModal;

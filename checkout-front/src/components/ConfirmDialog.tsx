import { ref, type VNode } from "vue";
import { VBtn, VForm } from "vuetify/components";
import { useLocale } from "vuetify";
import { dc } from "kt-dc";
import { extractApiError, UnknownError, type ApiError } from "@/utils/errors/extractor";
import { AlertView } from "./AlertView";
import { FormModal } from "@/components/ui/FormModal";
import type { JSONObject } from "kt-common";

export interface ConfirmOptions {
    title: string;
    message: string;
    submitButtonLabel?: string;
    type: "error" | "warning" | "primary";
    slot?: (props: { form: globalThis.Ref<JSONObject, JSONObject> }) => JSX.Element;
    onConfirm?: (form: JSONObject) => void | Promise<void>;
}

export const AwaitedConfirmationDialog = dc<{}, { show(opts: ConfirmOptions): Promise<boolean> }>(function (_, expose) {
    const visible = ref(false);
    const title = ref<string>("");
    const message = ref<string>("");
    let resolver: (value: boolean) => void = () => {};
    const type = ref<ConfirmOptions["type"]>("primary");
    const valid = ref(true);
    const slot = ref(null as null | ((props: { form: globalThis.Ref<JSONObject, JSONObject> }) => JSX.Element));
    const submitButtonLabel = ref(null as null | string);
    const providedOnConfirm = ref(null as null | ((form: JSONObject) => void | Promise<void>));
    const loading = ref(false);
    const apiError = ref(null as null | ApiError);
    const form = ref({} as JSONObject);

    function show(opts: ConfirmOptions): Promise<boolean> {
        title.value = opts.title;
        message.value = opts.message;
        loading.value = false;
        visible.value = true;
        type.value = opts.type;
        form.value = {};
        apiError.value = null;
        providedOnConfirm.value = opts.onConfirm || null;
        submitButtonLabel.value = opts.submitButtonLabel || "Confirm";
        slot.value = opts.slot || null;
        if (!opts.slot) {
            valid.value = true;
        }
        return new Promise((resolve) => {
            resolver = resolve;
        });
    }

    async function onConfirm() {
        resolver(true);
        if (providedOnConfirm.value) {
            loading.value = true;
            apiError.value = null;
            try {
                await providedOnConfirm.value(form.value);
                visible.value = false;
            } catch (error) {
                console.error(error);
                const e = extractApiError(error) || UnknownError;
                apiError.value = e;
            } finally {
                loading.value = false;
            }
        } else {
            visible.value = false;
        }
    }

    function onCancel() {
        visible.value = false;
        resolver(false);
    }

    const { t } = useLocale();

    expose({ show });

    const submitLabel = () => t(submitButtonLabel.value || "Confirm");

    return (): VNode => (
        <FormModal
            modelValue={visible.value}
            onUpdate:modelValue={(value: boolean) => {
                if (value) {
                    visible.value = true;
                    return;
                }
                if (loading.value) {
                    visible.value = true;
                    return;
                }
                if (visible.value) onCancel();
            }}
            title={t(title.value)}
            loading={loading.value}
            danger={type.value === "error"}
            onSubmit={() => {
                if (valid.value && !loading.value) void onConfirm();
            }}
            v-slots={{
                footer: () => (
                    <>
                        <VBtn variant="outlined" disabled={loading.value} onClick={onCancel}>
                            {t("Cancel")}
                        </VBtn>
                        <VBtn
                            variant="flat"
                            color={type.value}
                            loading={loading.value}
                            disabled={!valid.value || loading.value}
                            aria-label={submitLabel()}
                            onClick={() => void onConfirm()}
                        >
                            {submitLabel()}
                        </VBtn>
                    </>
                ),
            }}
        >
            <p style={{ margin: 0, fontSize: "13.5px", lineHeight: 1.6, color: "var(--pg-ink-secondary)", whiteSpace: "pre-wrap" }}>
                {t(message.value)}
            </p>
            {slot.value && (
                <VForm
                    modelValue={valid.value}
                    onUpdate:modelValue={(value: boolean | null) => {
                        valid.value = !!value;
                    }}
                >
                    {slot.value?.({ form })}
                </VForm>
            )}
            <AlertView type="error" message={apiError.value?.error} messages={apiError.value?.errors}></AlertView>
        </FormModal>
    );
});

export default AwaitedConfirmationDialog;

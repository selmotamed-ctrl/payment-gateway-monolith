import { defineComponent, ref, type VNode } from "vue";
import { VDialog, VCard, VCardTitle, VCardText, VCardActions, VForm } from "vuetify/components";
import { useLocale } from "vuetify";
import { dc } from "kt-dc";
import { extractApiError, UnknownError, type ApiError } from "@/utils/errors/extractor";
import { AlertView } from "./AlertView";
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
    let resolver: (value: boolean) => void;
    const type = ref("primary" as string);
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

    return (): VNode => (
        <VDialog
            style={{
                zIndex: 100,
            }}
            modelValue={visible.value}
            onUpdate:modelValue={(v: boolean | null) => (visible.value = !!v)}
            persistent
            max-width="650"
        >
            {{
                default: () => (
                    <VCard>
                        <VCardTitle class="text-h6">{t(title.value)}</VCardTitle>
                        <VCardText>{t(message.value)}</VCardText>
                        {slot.value && (
                            <VCardText>
                                <VForm
                                    modelValue={valid.value}
                                    onUpdate:modelValue={(v) => {
                                        valid.value = !!v;
                                    }}
                                >
                                    {slot.value?.({ form })}
                                </VForm>
                            </VCardText>
                        )}
                        <VCardText>
                            <AlertView type="error" message={apiError.value?.error} messages={apiError.value?.errors}></AlertView>
                        </VCardText>
                        <VCardActions class="justify-end">
                            <Button disabled={loading.value} variant="text" onClick={onCancel}>
                                {t("Cancel")}
                            </Button>
                            <Button variant="text" loading={loading.value} disabled={!valid.value || loading.value} color={type.value} onClick={onConfirm}>
                                {t("Confirm")}
                            </Button>
                        </VCardActions>
                    </VCard>
                ),
            }}
        </VDialog>
    );
});

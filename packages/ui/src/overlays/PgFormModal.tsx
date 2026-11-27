import { ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { PgDialog } from "./PgDialog";
import { PgButton } from "../actions/PgButton";

const WIDTHS = { sm: 460, md: 580, lg: 760, xl: 980 } as const;

export type PgFormModalSize = keyof typeof WIDTHS;

/**
 * Standard form modal: title/subtitle header, scrollable 24px body, footer with
 * Cancel/Save. `onSubmit` renders a real `<form>` so Enter submits.
 */
export const PgFormModal = dc(
    (props: Record<string, any>, _expose, { emit, slots }) => {
        const { t } = useLocale();
        const titleId = useId();
        const submit = (event?: Event) => {
            event?.preventDefault();
            if (!props.loading) void props.onSubmit?.();
        };
        const close = () => {
            if (!props.loading) emit?.("update:modelValue", false);
        };
        return () => {
            const body = (
                <form
                    class="pg-form-modal__form"
                    onSubmit={submit}
                    novalidate={props.novalidate ? true : undefined}
                >
                    <div class="pg-dialog__body">
                        {props.errorMessage && (
                            <div class="pg-alert pg-alert--danger" role="alert">
                                <span class="pg-alert__body">{props.errorMessage}</span>
                            </div>
                        )}
                        {slots.default?.()}
                    </div>
                    {(slots.footer || props.onSubmit) && (
                        <div class="pg-dialog__footer">
                            {slots.footer ? (
                                slots.footer()
                            ) : (
                                <>
                                    <PgButton variant="outlined" disabled={props.loading} onClick={close}>
                                        {props.cancelLabel || t("Cancel")}
                                    </PgButton>
                                    <PgButton
                                        type="submit"
                                        variant={props.danger ? "danger" : "primary"}
                                        loading={props.loading}
                                        disabled={props.loading}
                                    >
                                        {props.submitLabel || t("Save Changes")}
                                    </PgButton>
                                </>
                            )}
                        </div>
                    )}
                </form>
            );
            return (
                <PgDialog
                    modelValue={props.modelValue}
                    onUpdate:modelValue={(value: boolean) => emit?.("update:modelValue", value)}
                    maxWidth={WIDTHS[(props.size as PgFormModalSize) ?? "md"]}
                    size={props.size ?? "md"}
                    persistent={props.loading}
                    title={props.title}
                    subtitle={props.subtitle}
                    ariaLabel={props.title}
                    class="pg-form-modal"
                >
                    {body}
                </PgDialog>
            );
        };
    },
    {
        props: {
            modelValue: { type: Boolean, required: true },
            title: { type: String, required: true },
            subtitle: { type: String, default: "" },
            size: { type: String, default: "md" },
            submitLabel: { type: String, default: "" },
            cancelLabel: { type: String, default: "" },
            loading: { type: Boolean, default: false },
            danger: { type: Boolean, default: false },
            errorMessage: { type: String, default: "" },
            onSubmit: { type: Function as unknown as () => (() => void | Promise<void>) | undefined, default: undefined },
        },
        emits: ["update:modelValue"],
    },
);

export const FormModal = PgFormModal;

/** Standard & destructive confirmation service component (`show()` exposed). */
export const PgConfirmDialog = dc<Record<string, any>, { show(options: any): Promise<boolean> }>(
    (_props, expose) => {
        const { t } = useLocale();
        const visible = ref(false);
        const title = ref("");
        const message = ref("");
        const type = ref<"error" | "warning" | "primary">("primary");
        const loading = ref(false);
        const apiError = ref("");
        const submitLabel = ref("");
        let resolver: (value: boolean) => void = () => undefined;

        const cancel = () => {
            visible.value = false;
            resolver(false);
        };
        expose?.({
            show(options: any) {
                title.value = options.title;
                message.value = options.message;
                type.value = options.type ?? "primary";
                submitLabel.value = options.submitButtonLabel || "Confirm";
                visible.value = true;
                loading.value = false;
                apiError.value = "";
                return new Promise<boolean>((resolve) => {
                    resolver = resolve;
                });
            },
        });

        return () => (
            <PgFormModal
                modelValue={visible.value}
                onUpdate:modelValue={(value: boolean) => {
                    if (!value && !loading.value) cancel();
                }}
                title={t(title.value)}
                size="sm"
                danger={type.value === "error"}
                loading={loading.value}
                submitLabel={t(submitLabel.value || "Confirm")}
                onSubmit={async () => {
                    resolver(true);
                    visible.value = false;
                }}
            >
                <p class="pg-confirm__message">{t(message.value)}</p>
                {apiError.value && <div class="pg-alert pg-alert--danger">{apiError.value}</div>}
            </PgFormModal>
        );
    },
);

export default PgConfirmDialog;

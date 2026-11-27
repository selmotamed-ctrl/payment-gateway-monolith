import { computed, onBeforeUnmount, ref, watch } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { PgDialog } from "./PgDialog";
import { PgForm } from "../layout/PgShellPrimitives";
import { PgTextField } from "../inputs/PgTextField";
import { PgAlert } from "../feedback/PgAlert";
import { PgIcon } from "../actions/PgIcon";

const WIDTHS = { sm: 460, md: 580, lg: 760, xl: 960 } as const;

export type PgFormModalSize = keyof typeof WIDTHS;

const firstInvalidControl = (form: HTMLFormElement): HTMLElement | null => {
    const controls = [...form.querySelectorAll<HTMLElement>("input, textarea, select")];
    const invalid = controls.find((control) => {
        try {
            return !(control as HTMLInputElement).checkValidity();
        } catch {
            return false;
        }
    });
    return invalid ?? null;
};

/**
 * Validates the internal form before anything is emitted. Two contracts are
 * honoured because both exist in the portals:
 *
 * - native controls (`required`, `pattern`, `min`, …) through `checkValidity()`,
 * - `@pg/ui` controls that only carry `aria-required` / `aria-invalid`.
 */
const validateForm = (form: HTMLFormElement | null): boolean => {
    if (!form) return true;
    let valid = true;
    try {
        valid = form.checkValidity();
    } catch {
        valid = true;
    }

    const ariaControls = [...form.querySelectorAll<HTMLElement>("[aria-required='true'], [aria-invalid='true']")];
    for (const control of ariaControls) {
        if (control.getAttribute("aria-invalid") === "true") valid = false;
        if (control.getAttribute("aria-required") !== "true") continue;
        const input = control as HTMLInputElement;
        if (input.disabled || input.type === "hidden") continue;
        if (input.type === "checkbox" || input.type === "radio") {
            if (!input.checked) valid = false;
        } else if (!String(input.value ?? "").trim()) {
            valid = false;
        }
    }

    if (!valid) {
        const target = firstInvalidControl(form) ?? form.querySelector<HTMLElement>("[aria-required='true'], [aria-invalid='true']");
        target?.focus?.();
    }
    return valid;
};

/**
 * Standard create/edit modal: fixed header, scrollable body with an internal
 * validated `PgForm`, sticky footer. `onSubmit` (the legacy prop) and `submit`
 * (the 2026 event) fire only after validation passes.
 */
export const PgFormModal = dc(
    (props: Record<string, any>, _expose, { attrs, emit, slots }) => {
        const { t } = useLocale();
        const formHost = ref<HTMLElement | null>(null);
        const formApi = ref<any>(null);
        const visible = ref(Boolean(props.modelValue));
        const busy = computed(() => Boolean(props.loading));
        const errorText = computed(() => props.error || props.errorMessage || "");
        const formElement = () => formHost.value?.querySelector("form") ?? null;
        let submitToken = 0;

        watch(
            () => props.modelValue,
            (value) => {
                if (value !== undefined) visible.value = Boolean(value);
            },
        );

        /** Native + aria-required controls (raw inputs and PgFieldShell controls). */
        const validateNative = () => validateForm(formElement());

        /** Footer path: run the PgForm registry first, then native validation. */
        const validateAll = async () => {
            const api = formApi.value;
            if (api?.validate) {
                try {
                    const result = await api.validate();
                    if (!result?.valid) return false;
                } catch {
                    return false;
                }
            }
            return validateNative();
        };

        const submit = async (event?: Event) => {
            event?.preventDefault();
            if (busy.value) return;
            const token = ++submitToken;
            const valid = await validateAll();
            if (token !== submitToken) return;
            if (!valid) {
                emit?.("invalid");
                return;
            }
            emit?.("submit");
        };

        /** PgForm emits only after its registered controls validate. */
        const onFormSubmit = (event: Event) => {
            event.preventDefault();
            if (busy.value) return;
            submitToken += 1;
            if (!validateNative()) {
                emit?.("invalid");
                return;
            }
            emit?.("submit");
        };

        const cancel = () => {
            if (busy.value) return;
            visible.value = false;
            emit?.("cancel");
            emit?.("update:modelValue", false);
        };

        return () => {
            const footer = slots.footer
                ? slots.footer()
                : slots.footerExtra || props.onSubmit
                  ? (
                        <>
                            <div class="pg-dialog__footer-status">{slots.footerExtra?.()}</div>
                            <button
                                type="button"
                                class="pg-btn pg-btn--md pg-btn--outlined"
                                disabled={busy.value}
                                onClick={cancel}
                            >
                                {props.cancelLabel || t("Cancel")}
                            </button>
                            <button
                                type="button"
                                class={[
                                    "pg-btn pg-btn--md",
                                    props.danger ? "pg-btn--danger" : "pg-btn--primary",
                                    busy.value ? "pg-btn--loading" : "",
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                                disabled={busy.value}
                                aria-busy={busy.value ? "true" : undefined}
                                onClick={() => void submit()}
                            >
                                {busy.value && <span class="pg-btn__spinner" aria-hidden="true" />}
                                <span class="pg-btn__label">{props.submitLabel || t("Save Changes")}</span>
                            </button>
                        </>
                    )
                  : undefined;

            const dialogSlots: Record<string, any> = {
                default: () => (
                    <div ref={formHost}>
                        <PgForm
                            ref={formApi}
                            class="pg-form-modal__form"
                            disabled={busy.value}
                            aria-busy={busy.value ? "true" : undefined}
                            onSubmit={onFormSubmit}
                        >
                            {errorText.value && <PgAlert tone="danger" message={errorText.value} />}
                            {slots.default?.()}
                            <button
                                type="submit"
                                class="pg-form-modal__submit-proxy"
                                tabindex={-1}
                                aria-hidden="true"
                            />
                        </PgForm>
                    </div>
                ),
            };
            if (footer) {
                // Custom footers live outside `.pg-form-modal__form` because
                // the dialog owns the footer slot. A `type="submit"` button in
                // that footer still has to submit the form: delegate the click
                // to the same validated submit path as the built-in footer.
                dialogSlots.footer = () => (
                    <div
                        class="pg-form-modal__footer-host"
                        onClick={(event: MouseEvent) => {
                            const target = event.target as Element | null;
                            const button = target?.closest?.('button[type="submit"]');
                            if (!button || busy.value) return;
                            event.preventDefault();
                            void submit();
                        }}
                    >
                        {footer}
                    </div>
                );
            }

            return (
                <PgDialog
                    modelValue={visible.value}
                    onUpdate:modelValue={(value: boolean) => {
                        if (!value && busy.value) return;
                        visible.value = value;
                        emit?.("update:modelValue", value);
                    }}
                    title={props.title}
                    subtitle={props.subtitle}
                    size={props.size ?? "md"}
                    maxWidth={props.maxWidth ?? WIDTHS[(props.size as PgFormModalSize) ?? "md"]}
                    persistent={Boolean(props.persistent || busy.value)}
                    class={["pg-form-modal", attrs.class].filter(Boolean).join(" ")}
                    contentClass={props.contentClass}
                >
                    {dialogSlots}
                </PgDialog>
            );
        };
    },
    {
        props: {
            modelValue: { type: Boolean, default: false },
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            size: { type: String, default: "md" },
            maxWidth: { type: [Number, String], default: undefined },
            submitLabel: { type: String, default: "" },
            cancelLabel: { type: String, default: "" },
            loading: { type: Boolean, default: false },
            danger: { type: Boolean, default: false },
            error: { type: String, default: "" },
            errorMessage: { type: String, default: "" },
            persistent: { type: Boolean, default: false },
            novalidate: { type: Boolean, default: false },
            contentClass: { type: String, default: "" },
            onSubmit: { type: Function as unknown as () => (() => void | Promise<void>) | undefined, default: undefined },
        },
        emits: ["update:modelValue", "submit", "cancel", "invalid"],
        slots: ["default", "footer", "footerExtra"],
        inheritAttrs: true,
    },
);

export const FormModal = PgFormModal;

export type PgConfirmTone = "danger" | "warning" | "info" | "brand";

const TONE_ICON: Record<PgConfirmTone, string> = {
    danger: "mdi-alert-circle-outline",
    warning: "mdi-alert-outline",
    info: "mdi-information-outline",
    brand: "mdi-shield-check-outline",
};

const normalizeTone = (value: unknown, fallback: PgConfirmTone = "danger"): PgConfirmTone => {
    switch (String(value ?? "").toLowerCase()) {
        case "danger":
        case "error":
            return "danger";
        case "warning":
            return "warning";
        case "info":
            return "info";
        case "brand":
        case "primary":
            return "brand";
        default:
            return fallback;
    }
};

/**
 * Confirmation service. Supports both the imperative `show(options)` API used
 * by `showConfirm()` and declarative props.
 *
 * Safety: for `tone="danger"` initial focus lands on Cancel (not Confirm), and a
 * `requireText` lock keeps Confirm disabled until the exact string is typed.
 * While confirming, Escape, the backdrop, Cancel and the close button are
 * disabled by the persistent loading modal.
 */
export const PgConfirmDialog = dc<Record<string, any>, { show(options?: any): Promise<boolean> }>(
    (props, expose, { emit, slots }) => {
        const { t } = useLocale();
        const visible = ref(Boolean(props.modelValue));
        const tone = ref<PgConfirmTone | null>(null);
        const title = ref("");
        const message = ref("");
        const confirmLabel = ref("");
        const cancelLabel = ref("");
        const requireText = ref("");
        const typed = ref("");
        const errorText = ref("");
        const loading = ref(false);
        let resolver: ((value: boolean) => void) | null = null;
        let confirmHandler: (() => void | Promise<void>) | null = null;

        const busy = computed(() => Boolean(props.loading || loading.value));
        const effectiveTone = computed<PgConfirmTone>(() => tone.value ?? normalizeTone(props.tone || props.type, "danger"));
        const lockText = computed(() => String(requireText.value || props.requireText || ""));
        const locked = computed(() => Boolean(lockText.value) && typed.value !== lockText.value);
        const confirmDisabled = computed(() => busy.value || locked.value);
        const displayTitle = computed(() => title.value || props.title || t("Confirm"));
        const displayMessage = computed(() => message.value || props.message || "");
        const displayConfirmLabel = computed(
            () => confirmLabel.value || props.confirmLabel || props.submitButtonLabel || t("Confirm"),
        );
        const displayCancelLabel = computed(() => cancelLabel.value || props.cancelLabel || t("Cancel"));

        watch(
            () => props.modelValue,
            (value) => {
                if (value === undefined) return;
                if (value) {
                    if (!visible.value) {
                        typed.value = "";
                        errorText.value = "";
                    }
                    visible.value = true;
                    return;
                }
                visible.value = false;
                typed.value = "";
                resolver?.(false);
                resolver = null;
            },
        );

        watch(
            () => props.error,
            (value) => {
                errorText.value = value ? String(value) : "";
            },
        );

        const settle = (result: boolean, event?: "confirm" | "cancel") => {
            const resolve = resolver;
            resolver = null;
            visible.value = false;
            typed.value = "";
            errorText.value = "";
            loading.value = false;
            emit?.("update:modelValue", false);
            if (event === "confirm") emit?.("confirm");
            if (event === "cancel") emit?.("cancel");
            resolve?.(result);
        };

        const cancel = () => {
            if (busy.value) return;
            settle(false, "cancel");
        };

        const confirm = async () => {
            if (confirmDisabled.value) return;
            errorText.value = "";
            const handler = confirmHandler;
            if (handler) {
                loading.value = true;
                try {
                    await handler();
                } catch (error) {
                    errorText.value = error instanceof Error ? error.message : String(error);
                    loading.value = false;
                    return;
                }
                loading.value = false;
            }
            settle(true, "confirm");
        };

        expose?.({
            show(options: any = {}) {
                if (resolver) {
                    resolver(false);
                    resolver = null;
                }
                title.value = options.title ?? props.title ?? "";
                message.value = options.message ?? props.message ?? "";
                tone.value = normalizeTone(options.tone ?? options.type ?? props.tone ?? props.type, "danger");
                confirmLabel.value = options.confirmLabel ?? options.submitButtonLabel ?? props.confirmLabel ?? "";
                cancelLabel.value = options.cancelLabel ?? props.cancelLabel ?? "";
                requireText.value = options.requireText ?? options.require_text ?? props.requireText ?? "";
                errorText.value = options.error ?? "";
                loading.value = Boolean(options.loading ?? false);
                confirmHandler = typeof options.onConfirm === "function" ? options.onConfirm : null;
                typed.value = "";
                visible.value = true;
                emit?.("update:modelValue", true);
                return new Promise<boolean>((resolve) => {
                    resolver = resolve;
                });
            },
        });

        // A caller unmounting the service must not leave a pending `await` alive.
        onBeforeUnmount(() => {
            if (resolver) {
                resolver(false);
                resolver = null;
            }
        });

        return () => (
            <PgDialog
                modelValue={visible.value}
                onUpdate:modelValue={(value: boolean) => {
                    if (!value) {
                        if (busy.value) return;
                        settle(false, "cancel");
                    }
                }}
                title={displayTitle.value}
                size="sm"
                maxWidth={460}
                persistent={busy.value}
                role="alertdialog"
                ariaLabel={displayTitle.value}
                class={["pg-confirm-dialog", `pg-confirm-dialog--${effectiveTone.value}`].join(" ")}
            >
                {{
                    default: () => (
                        <div class="pg-confirm">
                            <div class="pg-confirm__hero">
                                <span
                                    class={["pg-confirm__icon", `pg-confirm__icon--${effectiveTone.value}`]}
                                    aria-hidden="true"
                                >
                                    <PgIcon icon={TONE_ICON[effectiveTone.value]} size={22} />
                                </span>
                                <p class="pg-confirm__message">{t(displayMessage.value)}</p>
                            </div>
                            {slots.default?.()}
                            {lockText.value && (
                                <div class="pg-confirm__lock">
                                    <PgTextField
                                        modelValue={typed.value}
                                        onUpdate:modelValue={(value: string) => (typed.value = value ?? "")}
                                        label={`${t("Confirm")}: ${lockText.value}`}
                                        placeholder={lockText.value}
                                        autocomplete="off"
                                        hideDetails
                                    />
                                </div>
                            )}
                            {errorText.value && <PgAlert tone="danger" message={errorText.value} />}
                        </div>
                    ),
                    footer: () => (
                        <>
                            <button
                                type="button"
                                class="pg-btn pg-btn--md pg-btn--outlined pg-confirm__cancel"
                                autofocus={effectiveTone.value === "danger" ? true : undefined}
                                disabled={busy.value}
                                onClick={cancel}
                            >
                                <span class="pg-btn__label">{displayCancelLabel.value}</span>
                            </button>
                            <button
                                type="button"
                                class={[
                                    "pg-btn pg-btn--md",
                                    effectiveTone.value === "danger" ? "pg-btn--danger" : "pg-btn--primary",
                                    busy.value ? "pg-btn--loading" : "",
                                    "pg-confirm__confirm",
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                                disabled={confirmDisabled.value}
                                aria-busy={busy.value ? "true" : undefined}
                                onClick={confirm}
                            >
                                {busy.value && <span class="pg-btn__spinner" aria-hidden="true" />}
                                <span class="pg-btn__label">{displayConfirmLabel.value}</span>
                            </button>
                        </>
                    ),
                }}
            </PgDialog>
        );
    },
    {
        props: {
            modelValue: { type: Boolean, default: false },
            title: { type: String, default: "" },
            message: { type: String, default: "" },
            tone: { type: String, default: "" },
            type: { type: String, default: "" },
            confirmLabel: { type: String, default: "" },
            submitButtonLabel: { type: String, default: "" },
            cancelLabel: { type: String, default: "" },
            loading: { type: Boolean, default: false },
            requireText: { type: String, default: "" },
            error: { type: String, default: "" },
        },
        emits: ["update:modelValue", "confirm", "cancel"],
        slots: ["default"],
    },
);

export default PgConfirmDialog;

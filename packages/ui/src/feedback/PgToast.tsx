import { computed } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { PgIcon } from "../actions/PgIcon";
import { dismissToast, pauseToast, resumeToast, useToasts, type ToastItem } from "./toastStore";

const TONE_ICON: Record<string, string> = {
    success: "mdi-check-circle-outline",
    info: "mdi-information-outline",
    primary: "mdi-information-outline",
    warning: "mdi-alert-outline",
    danger: "mdi-alert-circle-outline",
};

const ToastCard = dc(
    (props: { toast: ToastItem }, _expose, { emit }) => {
        const { t } = useLocale();
        const progress = computed(() =>
            props.toast.durationMs <= 0 ? 0 : Math.max(0, (props.toast.remainingMs / props.toast.durationMs) * 100),
        );
        return () => (
            <div
                class={["pg-toast", `pg-toast--${props.toast.tone}`]}
                role={props.toast.tone === "danger" ? "alert" : "status"}
                aria-live={props.toast.tone === "danger" ? "assertive" : "polite"}
                onMouseenter={() => pauseToast(props.toast.id)}
                onMouseleave={() => resumeToast(props.toast.id)}
                onFocusin={() => pauseToast(props.toast.id)}
                onFocusout={() => resumeToast(props.toast.id)}
            >
                <span class="pg-toast__icon" aria-hidden="true">
                    <PgIcon icon={TONE_ICON[props.toast.tone] ?? TONE_ICON.info} size={18} />
                </span>
                <div class="pg-toast__content">
                    {props.toast.title && <p class="pg-toast__title">{props.toast.title}</p>}
                    <p class="pg-toast__message">{t(props.toast.message)}</p>
                </div>
                <div class="pg-toast__actions">
                    {props.toast.actionLabel && (
                        <button
                            type="button"
                            class="pg-toast__action"
                            onClick={() => {
                                props.toast.onAction?.();
                                dismissToast(props.toast.id);
                            }}
                        >
                            {t(props.toast.actionLabel)}
                        </button>
                    )}
                    <button
                        type="button"
                        class="pg-toast__close"
                        aria-label={t("Close")}
                        onClick={() => dismissToast(props.toast.id)}
                    >
                        <PgIcon icon="mdi-close" size={15} />
                    </button>
                </div>
                {props.toast.durationMs > 0 && (
                    <span
                        class={["pg-toast__timer", props.toast.paused ? "pg-toast__timer--paused" : ""]}
                        style={{ transform: `scaleX(${progress.value / 100})` }}
                        aria-hidden="true"
                    />
                )}
            </div>
        );
    },
    { props: { toast: { type: Object as () => ToastItem, required: true } } },
);

/** Mount once in `<PgProvider>`; renders the shared toast stack. */
export const PgToaster = dc(() => {
    const { toasts } = useToasts();
    return () => (
        <div class="pg-toast-stack" aria-label="Notifications">
            {toasts.value.map((toast) => (
                <ToastCard key={toast.id} toast={toast} />
            ))}
        </div>
    );
});

export const PgToast = PgToaster;
export const Toaster = PgToaster;

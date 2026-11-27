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

const ASSERTIVE_TONES = new Set(["danger", "warning"]);

const ToastCard = dc(
    (props: { toast: ToastItem }, _expose) => {
        const { t } = useLocale();
        const assertive = computed(() => ASSERTIVE_TONES.has(props.toast.tone));
        let hovering = false;
        let focused = false;

        const pause = () => pauseToast(props.toast.id);
        const resumeWhenIdle = () => {
            if (!hovering && !focused) resumeToast(props.toast.id);
        };

        /**
         * The countdown is a CSS animation so it moves every frame without a
         * timer. Pausing freezes the animation; resuming starts it at the exact
         * elapsed offset with only the remaining duration left.
         */
        const timerStyle = () => {
            if (props.toast.durationMs <= 0) return undefined;
            const elapsed = Math.max(0, props.toast.durationMs - props.toast.remainingMs);
            return {
                animationDuration: `${Math.max(0, props.toast.remainingMs)}ms`,
                animationDelay: `${-elapsed}ms`,
            };
        };

        return () => (
            <div
                class={["pg-toast", `pg-toast--${props.toast.tone}`]}
                role={assertive.value ? "alert" : "status"}
                aria-live={assertive.value ? "assertive" : "polite"}
                aria-atomic="true"
                onMouseenter={() => {
                    hovering = true;
                    pause();
                }}
                onMouseleave={() => {
                    hovering = false;
                    resumeWhenIdle();
                }}
                onFocusin={() => {
                    focused = true;
                    pause();
                }}
                onFocusout={() => {
                    focused = false;
                    resumeWhenIdle();
                }}
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
                        class={["pg-toast__timer", props.toast.paused ? "pg-toast__timer--paused" : ""]
                            .filter(Boolean)
                            .join(" ")}
                        style={timerStyle()}
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

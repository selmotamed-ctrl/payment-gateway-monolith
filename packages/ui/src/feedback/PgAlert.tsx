import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { PgIcon } from "../actions/PgIcon";

export type AlertTone = "success" | "warning" | "danger" | "info" | "neutral";

const TYPE_TO_TONE: Record<string, AlertTone> = {
    error: "danger",
    danger: "danger",
    warning: "warning",
    success: "success",
    info: "info",
    primary: "info",
    neutral: "neutral",
    secondary: "neutral",
};

const TONE_ICON: Record<AlertTone, string> = {
    success: "mdi-check-circle-outline",
    warning: "mdi-alert-outline",
    danger: "mdi-alert-circle-outline",
    info: "mdi-information-outline",
    neutral: "mdi-information-outline",
};

/**
 * The single alert/banner component. Every tone maps 1:1 to the semantic
 * `--pg-status-*` tokens, so sandbox banners, validation errors, KYB notices and
 * inline hints all share the same polished visual quality.
 */
export const PgAlert = dc(
    (props: Record<string, any>, _expose, { attrs, emit, slots }) => {
        const { t } = useLocale();
        const tone = (): AlertTone => {
            const requested = props.tone || props.type || props.color || "info";
            return TYPE_TO_TONE[requested] ?? "info";
        };
        const close = () => {
            emit?.("update:modelValue", false);
            emit?.("clear");
        };
        return () => {
            const currentTone = tone();
            return (
                <div
                    {...attrs}
                    class={[
                        "pg-alert",
                        `pg-alert--${currentTone}`,
                        props.density === "compact" ? "pg-alert--compact" : "",
                        attrs.class,
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    role={currentTone === "danger" || currentTone === "warning" ? "alert" : "status"}
                    aria-live={currentTone === "danger" ? "assertive" : "polite"}
                    aria-atomic="true"
                >
                    <span class="pg-alert__icon" aria-hidden="true">
                        {props.icon ? <PgIcon icon={props.icon} size={18} /> : <PgIcon icon={TONE_ICON[currentTone]} size={18} />}
                    </span>
                    <div class="pg-alert__content">
                        {(props.title || props.heading) && <div class="pg-alert__title">{props.title || props.heading}</div>}
                        <div class="pg-alert__body">
                            {props.message ? t(props.message) : null}
                            {Array.isArray(props.messages) && props.messages.length > 0 ? (
                                <ul class="pg-alert__list">
                                    {props.messages.map((message: string, index: number) => (
                                        <li key={index}>{t(message)}</li>
                                    ))}
                                </ul>
                            ) : null}
                            {slots.default?.()}
                        </div>
                        {slots.actions ? <div class="pg-alert__actions">{slots.actions()}</div> : null}
                    </div>
                    {(props.closable || props.dismissible) && (
                        <button type="button" class="pg-alert__close" aria-label={t("Dismiss")} onClick={close}>
                            <PgIcon icon="mdi-close" size={16} />
                        </button>
                    )}
                </div>
            );
        };
    },
    {
        props: {
            tone: { type: String, default: "" },
            type: { type: String, default: "" },
            color: { type: String, default: "" },
            title: { type: String, default: "" },
            heading: { type: String, default: "" },
            message: { type: String, default: "" },
            messages: { type: Array as () => string[], default: () => [] },
            icon: { type: String, default: "" },
            closable: { type: Boolean, default: false },
            dismissible: { type: Boolean, default: false },
            density: { type: String, default: "" },
            modelValue: { type: Boolean, default: true },
        },
        emits: ["update:modelValue", "clear"],
        inheritAttrs: true,
    },
);

export const VAlert = PgAlert;
export const AlertView = PgAlert;

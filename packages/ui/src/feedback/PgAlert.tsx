import { ref, watch } from "vue";
import { createIf } from "@vue/runtime-vapor";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { PgIcon } from "../actions/PgIcon";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;

export type AlertTone = "info" | "success" | "warning" | "danger" | "neutral";

const TYPE_TO_TONE: Record<string, AlertTone> = {
    error: "danger",
    danger: "danger",
    warning: "warning",
    warn: "warning",
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

const ASSERTS = new Set<AlertTone>(["danger", "warning"]);

/**
 * The single alert/banner component. Every tone maps 1:1 to the semantic
 * `--pg-status-*` tokens, so sandbox banners, validation errors, KYB notices and
 * inline hints all share the same polished visual quality.
 *
 * `modelValue` (v-model) and `open` both control visibility; dismissing hides
 * the banner immediately even when the caller does not bind either prop.
 */
export const PgAlert = dc(
    (props: Record<string, any>, _expose, { attrs, emit, slots }) => {
        const { t } = useLocale();
        const dismissed = ref(false);

        const controlledOpen = () => props.open !== undefined && props.open !== null;
        const visible = () => {
            if (dismissed.value) return false;
            if (controlledOpen()) return Boolean(props.open);
            return props.modelValue !== false;
        };

        watch(
            () => [props.open, props.modelValue],
            () => {
                if (controlledOpen() ? Boolean(props.open) : props.modelValue !== false) {
                    dismissed.value = false;
                }
            },
        );

        const tone = (): AlertTone => {
            const requested = String(props.tone || props.type || props.color || "info").toLowerCase();
            return TYPE_TO_TONE[requested] ?? "info";
        };

        const close = () => {
            dismissed.value = true;
            emit?.("update:modelValue", false);
            emit?.("update:open", false);
            emit?.("close");
            emit?.("clear");
        };

        return () =>
            branch(
                () => visible(),
                () => {
                    const currentTone = tone();
                    const assertive = ASSERTS.has(currentTone);
                    return (
                        <div
                            {...attrs}
                            class={[
                                "pg-alert",
                                `pg-alert--${currentTone}`,
                                props.density === "compact" || props.compact ? "pg-alert--compact" : "",
                                attrs.class,
                            ]
                                .filter(Boolean)
                                .join(" ")}
                            role={assertive ? "alert" : "status"}
                            aria-live={assertive ? "assertive" : "polite"}
                            aria-atomic="true"
                        >
                            <span class="pg-alert__icon" aria-hidden="true">
                                {props.icon ? (
                                    <PgIcon icon={props.icon} size={18} />
                                ) : (
                                    <PgIcon icon={TONE_ICON[currentTone]} size={18} />
                                )}
                            </span>
                            <div class="pg-alert__content">
                                {(props.title || props.heading) && (
                                    <div class="pg-alert__title">{props.title || props.heading}</div>
                                )}
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
                            </div>
                            {slots.actions ? <div class="pg-alert__actions">{slots.actions()}</div> : null}
                            {(props.closable || props.dismissible) && (
                                <button type="button" class="pg-alert__close" aria-label={t("Dismiss")} onClick={close}>
                                    <PgIcon icon="mdi-close" size={16} />
                                </button>
                            )}
                        </div>
                    );
                },
            );
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
            compact: { type: Boolean, default: false },
            modelValue: { type: Boolean, default: true },
            open: { type: [Boolean, Object], default: undefined },
        },
        emits: ["update:modelValue", "update:open", "close", "clear"],
        inheritAttrs: true,
    },
);

export const VAlert = PgAlert;
export const AlertView = PgAlert;

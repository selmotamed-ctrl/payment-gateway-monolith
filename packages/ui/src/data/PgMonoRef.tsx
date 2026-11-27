import { computed, onBeforeUnmount, ref } from "vue";
import { dc } from "../lib/dc";
import { usePgUiConfig } from "../lib/config";
import { copyToClipboard } from "../lib/dom";
import { useLocale } from "../lib/locale";
import { PgIcon } from "../actions/PgIcon";

const COPIED_MS = 1600;

/**
 * Monospace financial reference chip with one-click copy.
 *
 * The visible label may be truncated, but the clipboard always receives the
 * complete value. Copying stops propagation so a nested row click never fires,
 * and the success check announces itself through a polite live region.
 */
export const PgMonoRef = dc(
    (
        props: { value?: string | number; truncate?: number; copyable?: boolean },
        _expose,
        { attrs, emit },
    ) => {
        const config = usePgUiConfig();
        const { t } = useLocale();
        const copied = ref(false);
        let timer: ReturnType<typeof setTimeout> | undefined;

        const fullValue = computed(() =>
            props.value === null || props.value === undefined ? "" : String(props.value),
        );
        const hasValue = computed(() => fullValue.value.trim().length > 0);
        const isCopied = computed(() => copied.value && hasValue.value);
        const truncated = computed(() => {
            const value = fullValue.value;
            const truncate = Number(props.truncate) || 0;
            if (!value) return "—";
            return truncate > 0 && value.length > truncate ? `${value.slice(0, truncate)}…` : value;
        });

        const copy = async (event: Event) => {
            event.stopPropagation();
            if (!hasValue.value || props.copyable === false) return;
            const value = fullValue.value;
            const ok = config.copyText ? await config.copyText(value) : await copyToClipboard(value);
            if (!ok) return;
            copied.value = true;
            emit?.("copied", value);
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => (copied.value = false), COPIED_MS);
        };

        onBeforeUnmount(() => {
            if (timer) clearTimeout(timer);
        });

        return () => (
            <button
                {...attrs}
                type="button"
                class={[
                    "pg-mono-ref",
                    isCopied.value ? "pg-mono-ref--copied" : "",
                    props.copyable === false ? "pg-mono-ref--static" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                title={fullValue.value || t("Empty")}
                aria-label={
                    !hasValue.value
                        ? t("Empty")
                        : isCopied.value
                          ? `${t("Copied")}: ${fullValue.value}`
                          : `${t("Copy")}: ${fullValue.value}`
                }
                aria-live="polite"
                disabled={!hasValue.value}
                onClick={(event: MouseEvent) => void copy(event)}
            >
                <span class="pg-mono-ref__value" dir="ltr">
                    {truncated.value}
                </span>
                {props.copyable !== false && hasValue.value && (
                    <PgIcon
                        class={isCopied.value ? "pg-mono-ref__check" : "pg-mono-ref__copy"}
                        size={isCopied.value ? 14 : 12}
                        icon={isCopied.value ? "mdi-check" : "mdi-content-copy"}
                        color={isCopied.value ? "success" : "muted"}
                    />
                )}
                <span class="pg-sr-only" aria-live="polite">
                    {isCopied.value ? t("Copied") : ""}
                </span>
            </button>
        );
    },
    {
        props: {
            value: { type: [String, Number], default: "" },
            truncate: { type: Number, default: 0 },
            copyable: { type: Boolean, default: true },
        },
        emits: ["copied"],
        inheritAttrs: true,
    },
);

export const MonoRef = PgMonoRef;

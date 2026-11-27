import { onBeforeUnmount, ref } from "vue";
import { dc } from "../lib/dc";
import { usePgUiConfig } from "../lib/config";
import { copyToClipboard } from "../lib/dom";
import { useLocale } from "../lib/locale";
import { PgIcon } from "../actions/PgIcon";

/** Monospace reference chip with one-click copy. */
export const PgMonoRef = dc(
    (props: { value?: string; truncate?: number; copyable?: boolean; onCopied?: (value: string) => void }, _expose, { attrs }) => {
        const config = usePgUiConfig();
        const { t } = useLocale();
        const copied = ref(false);
        let timer: ReturnType<typeof setTimeout> | undefined;

        const copy = async () => {
            if (!props.value || !props.copyable) return;
            const ok = config.copyText ? await config.copyText(props.value) : await copyToClipboard(props.value);
            if (!ok) return;
            copied.value = true;
            props.onCopied?.(props.value);
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => (copied.value = false), 1400);
        };
        onBeforeUnmount(() => timer && clearTimeout(timer));

        return () => (
            <button
                {...attrs}
                type="button"
                class={["pg-mono-ref", attrs.class].filter(Boolean).join(" ")}
                title={props.value || undefined}
                aria-label={copied.value ? t("Copied") : props.value ? `${t("Copy")} ${props.value}` : t("Empty")}
                aria-live="polite"
                disabled={!props.value}
                onClick={() => void copy()}
            >
                <span>
                    {props.value
                        ? props.truncate && props.value.length > props.truncate
                            ? `${props.value.slice(0, props.truncate)}…`
                            : props.value
                        : "—"}
                </span>
                {props.copyable && props.value && (
                    <PgIcon
                        size={12}
                        icon={copied.value ? "mdi-check" : "mdi-content-copy"}
                        color={copied.value ? "success" : "muted"}
                    />
                )}
            </button>
        );
    },
    {
        props: {
            value: { type: String, default: "" },
            truncate: { type: Number, default: 0 },
            copyable: { type: Boolean, default: true },
            onCopied: { type: Function as unknown as () => ((value: string) => void) | undefined, default: undefined },
        },
        inheritAttrs: true,
    },
);

export const MonoRef = PgMonoRef;

import { onBeforeUnmount, ref } from "vue";
import { dc } from "../lib/dc";
import { usePgUiConfig } from "../lib/config";
import { copyToClipboard } from "../lib/dom";
import { useLocale } from "../lib/locale";
import { PgIcon } from "../actions/PgIcon";
import { PgTooltip } from "../overlays/PgTooltip";
import { PgMoneyText } from "./PgMoneyText";
import { PgStatusBadge } from "../feedback/PgStatusBadge";
import { isEmpty } from "../lib/rules";

export type PgFieldType = "text" | "mono" | "money" | "date" | "status" | "boolean";

export type PgFieldItem = {
    /** 2026 label. `text` remains the Vuetify-era spelling. */
    label?: string;
    text?: string;
    value?: unknown;
    type?: PgFieldType;
    /** Legacy shortcut for `type="mono"`. */
    mono?: boolean;
    copyable?: boolean;
    copyOnClick?: boolean;
    hint?: string;
    source?: string;
    currency?: string;
    span?: 1 | 2 | "full";
    interactive?: boolean;
    /** Legacy navigation handler; also carries the emitted `click` listener. */
    onClick?: () => void | Promise<void>;
};

let fieldSequence = 0;

const plainValue = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
};

/**
 * Seamless read-only detail tile. A `PgFieldsSection` paints the 1px hairline
 * grid behind these tiles; each tile supplies its own surface so zero floating
 * gaps are ever exposed. Copyable and mono tiles copy the full value on click
 * (or Enter/Space) and pop an emerald check for 1.6 s.
 */
export const PgField = dc(
    (props: PgFieldItem, _expose, { attrs, emit, slots }) => {
        const config = usePgUiConfig();
        const { t } = useLocale();
        const fieldId = `pg-field-${++fieldSequence}`;
        const labelId = `${fieldId}-label`;
        const copied = ref(false);
        let timer: ReturnType<typeof setTimeout> | undefined;

        const label = (): string => props.label || props.text || "";
        const fieldType = (): PgFieldType => props.type ?? (props.mono ? "mono" : "text");
        const hasValue = (): boolean => !isEmpty(props.value);
        const isCopyable = (): boolean => Boolean(props.copyable || props.copyOnClick || fieldType() === "mono");
        const hasClickListener = (): boolean => {
            const listener = (attrs as { onClick?: unknown }).onClick;
            return typeof listener === "function" || Array.isArray(listener);
        };
        const interactive = (): boolean =>
            Boolean(props.interactive) || (hasValue() && (isCopyable() || hasClickListener()));

        const copy = async () => {
            if (!hasValue() || !isCopyable()) return;
            const value = plainValue(props.value);
            if (!value) return;
            const ok = config.copyText ? await config.copyText(value) : await copyToClipboard(value);
            if (!ok) return;
            copied.value = true;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => (copied.value = false), 1600);
        };

        const activate = () => {
            if (!interactive()) return;
            if (!hasClickListener() && isCopyable()) void copy();
            emit?.("click");
        };

        onBeforeUnmount(() => {
            if (timer) clearTimeout(timer);
        });

        const valueContent = () => {
            if (slots.value) return slots.value();
            if (slots.default) return slots.default();
            if (!hasValue()) return "—";
            const value = props.value;
            const type = fieldType();
            if (type === "money") {
                return <PgMoneyText amount={value as string | number} currency={props.currency} size="md" />;
            }
            if (type === "status") {
                return <PgStatusBadge status={plainValue(value)} showDot={false} />;
            }
            if (type === "boolean") {
                const on = value === true || value === "true" || value === 1 || value === "1";
                return (
                    <span class={["pg-field-item__boolean", on ? "pg-field-item__boolean--on" : "pg-field-item__boolean--off"].join(" ")}>
                        <PgIcon icon={on ? "mdi-check-circle" : "mdi-close-circle"} size={15} color={on ? "success" : "muted"} />
                        {t(on ? "Yes" : "No")}
                    </span>
                );
            }
            if (type === "mono") {
                return (
                    <span class="pg-field-item__mono pg-mono" dir="ltr">
                        {plainValue(value)}
                    </span>
                );
            }
            if (type === "date") {
                return (
                    <span class="pg-field-item__date" dir="ltr">
                        {plainValue(value)}
                    </span>
                );
            }
            return <span class="pg-field-item__text">{plainValue(value)}</span>;
        };

        return () => (
            <div
                {...attrs}
                class={[
                    "pg-field-item",
                    interactive() ? "pg-field-item--interactive" : "",
                    props.span === "full" ? "pg-field-item--span-full" : "",
                    props.span === 2 ? "pg-field-item--span-2" : "",
                    copied.value ? "pg-field-item--copied" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                role={interactive() ? "button" : undefined}
                tabindex={interactive() ? 0 : undefined}
                aria-label={interactive() ? `${t(label())}: ${plainValue(props.value) || t("Empty")}` : undefined}
                aria-labelledby={interactive() ? undefined : labelId}
                onClick={(event: MouseEvent) => {
                    if ((event.target as HTMLElement | null)?.closest(".pg-field-item__help")) return;
                    if (interactive() && !hasClickListener() && isCopyable()) event.stopPropagation();
                    activate();
                }}
                onKeydown={(event: KeyboardEvent) => {
                    if (!interactive()) return;
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        activate();
                    }
                }}
            >
                <div class="pg-field-item__label-row">
                    <span id={labelId} class="pg-field-item__label">
                        {t(label())}
                    </span>
                    {isCopyable() && hasValue() && (
                        <PgIcon
                            class={copied.value ? "pg-field-item__copy-check" : "pg-field-item__copy-icon"}
                            icon={copied.value ? "mdi-check" : "mdi-content-copy"}
                            size={13}
                            color={copied.value ? "success" : "faint"}
                        />
                    )}
                    {[props.hint, props.source ? `${t("Source")}: ${props.source}` : undefined].filter(Boolean).length > 0 && (
                        <PgTooltip
                            text={[props.hint, props.source ? `${t("Source")}: ${props.source}` : undefined].filter(Boolean).join("\n\n")}
                            maxWidth={420}
                        >
                            <button
                                type="button"
                                class="pg-field-item__help"
                                aria-label={`${t(label())} ${t("help")}`}
                                onClick={(event: MouseEvent) => event.stopPropagation()}
                            >
                                <PgIcon icon="mdi-help-circle-outline" size={14} />
                            </button>
                        </PgTooltip>
                    )}
                </div>
                <div
                    class={[
                        "pg-field-item__value",
                        hasValue() ? "" : "pg-field-item__value--empty",
                        interactive() ? "pg-field-item__value--interactive" : "",
                    ]
                        .filter(Boolean)
                        .join(" ")}
                >
                    {valueContent()}
                </div>
            </div>
        );
    },
    {
        props: {
            label: { type: String, default: "" },
            text: { type: String, default: "" },
            value: { type: null as unknown as any, default: null },
            type: { type: String, default: "" },
            mono: { type: Boolean, default: false },
            copyable: { type: Boolean, default: false },
            copyOnClick: { type: Boolean, default: false },
            hint: { type: String, default: "" },
            source: { type: String, default: "" },
            currency: { type: String, default: "" },
            span: { type: [Number, String], default: 1 },
            interactive: { type: Boolean, default: false },
        },
        emits: ["click"],
        slots: ["default", "value"],
        inheritAttrs: true,
    },
);

export const Field = PgField;

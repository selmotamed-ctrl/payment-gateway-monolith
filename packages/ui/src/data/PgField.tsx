import { dc } from "../lib/dc";
import { copyToClipboard } from "../lib/dom";
import { useLocale } from "../lib/locale";
import { PgIcon } from "../actions/PgIcon";
import { PgTooltip } from "../overlays/PgTooltip";
import { showToast } from "../feedback/toastStore";
import { isEmpty } from "../lib/rules";

export type PgFieldItem = {
    value?: string | null | number;
    text: string;
    onClick?: () => void | Promise<void>;
    copyOnClick?: boolean;
    hint?: string;
    source?: string;
};

let fieldSequence = 0;

/** Spacious key-value field with copy-on-click and an optional help tooltip. */
export const PgField = dc(
    (props: PgFieldItem, _expose, { attrs }) => {
        const { t } = useLocale();
        const fieldId = `pg-field-${++fieldSequence}`;
        const labelId = `${fieldId}-label`;
        const helpId = `${fieldId}-help`;
        return () => {
            const hasValue = !isEmpty(props.value);
            const interactive = hasValue && Boolean(props.onClick || props.copyOnClick);
            const activate = () => {
                if (props.onClick) void props.onClick();
                else if (props.copyOnClick && hasValue) {
                    void copyToClipboard(String(props.value));
                    showToast({ tone: "success", message: `${props.text} copied` });
                }
            };
            const hintText = [props.hint, props.source ? `${t("Source")}: ${props.source}` : undefined].filter(Boolean).join("\n\n");
            return (
                <div {...attrs} class={["pg-field-item", interactive ? "pg-field-item--interactive" : "", attrs.class].filter(Boolean).join(" ")}>
                    <div class="pg-field-item__label-row">
                        <p id={labelId} class="pg-field-item__label">{t(props.text || "")}</p>
                        {interactive && props.copyOnClick && <PgIcon icon="mdi-content-copy" size={13} color="faint" />}
                        {hintText && (
                            <PgTooltip text={hintText} maxWidth={420}>
                                <button
                                    id={helpId}
                                    type="button"
                                    class="pg-field-item__help"
                                    aria-label={`${t(props.text)} ${t("help")}`}
                                >
                                    <PgIcon icon="mdi-help-circle-outline" size={14} />
                                </button>
                            </PgTooltip>
                        )}
                    </div>
                    <div
                        onClick={interactive ? activate : undefined}
                        onKeydown={
                            interactive
                                ? (event: KeyboardEvent) => {
                                      if (event.key === "Enter" || event.key === " ") {
                                          event.preventDefault();
                                          activate();
                                      }
                                  }
                                : undefined
                        }
                        role={interactive ? "button" : undefined}
                        tabindex={interactive ? 0 : undefined}
                        aria-labelledby={interactive ? undefined : labelId}
                        aria-label={interactive ? `${t(props.text)}: ${String(props.value)}` : undefined}
                        class={["pg-field-item__value", hasValue ? "" : "pg-field-item__value--empty", interactive ? "pg-field-item__value--interactive" : ""]
                            .filter(Boolean)
                            .join(" ")}
                    >
                        {hasValue ? t(String(props.value)) : `— ${t("Empty")} —`}
                    </div>
                </div>
            );
        };
    },
    {
        props: {
            value: { type: [String, Number], default: null },
            text: { type: String, required: true },
            onClick: { type: Function as unknown as () => (() => void | Promise<void>) | undefined, default: undefined },
            copyOnClick: { type: Boolean, default: false },
            hint: { type: String, default: "" },
            source: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);

export const Field = PgField;

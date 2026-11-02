import { dc } from "kt-dc";
import { useLocale, useTheme } from "vuetify";
import { ThemedView } from "../ThemedView";
import { copyToClipboard } from "@/utils/common";
import { isEmpty } from "@/utils/clientValidationRules";
import { showSnackBar } from "@/utils/snackBar";
import { VIcon, VTooltip } from "vuetify/components";

let fieldIdSequence = 0;

export type FieldProps = {
    value?: string | null | number;
    text: string;
    onClick?: () => void | Promise<void>;
    copyOnClick?: boolean;
    /** Plain-language explanation shown from a help icon beside the label. */
    hint?: string;
    /** Exact database source or derivation, e.g. `operator_cases.kind`. */
    source?: string;
};

export const Field = dc(
    (props: FieldProps) => {
        const { t } = useLocale();
        const theme = useTheme();
        const fieldId = `pg-field-${++fieldIdSequence}`;
        const labelId = `${fieldId}-label`;
        const helpId = `${fieldId}-help`;

        return () => {
            const cc = theme.current.value.colors;
            const hasValue = !isEmpty(props.value);
            const isInteractive = hasValue && (props.onClick || props.copyOnClick);
            const isEmptyValue = !hasValue;

            const handleClick = () => {
                if (props.onClick) {
                    props.onClick();
                } else if (props.copyOnClick && hasValue) {
                    copyToClipboard(String(props.value));
                    showSnackBar({
                        type: "success",
                        message: `${props.text} copied`,
                    });
                }
            };

            return (
                <ThemedView
                    class={isInteractive ? "field-wrapper-interactive" : undefined}
                    style={{
                        flexDirection: "column",
                        gap: "8px",
                        transition: "all 0.2s ease-in-out",
                    }}
                >
                    <ThemedView
                        style={{
                            display: "flex",
                            gap: "6px",
                        }}
                        class="print-hide"
                    >
                        <p
                            id={labelId}
                            style={{
                                color: cc.onSurfaceVariant,
                                fontSize: "12px",
                                fontWeight: "500",
                                letterSpacing: "0.15px",
                                margin: 0,
                                textTransform: "uppercase",
                                opacity: 0.75,
                            }}
                        >
                            {t(props.text || "")}
                        </p>
                        {isInteractive && props.copyOnClick && (
                            <VIcon
                                aria-hidden="true"
                                size="14"
                                class="field-copy-icon"
                                style={{
                                    color: cc.onSurfaceVariant,
                                    opacity: 0.5,
                                    transition: "all 0.2s ease-in-out",
                                }}
                            >
                                mdi-content-copy
                            </VIcon>
                        )}
                        {(props.hint || props.source) && (
                            <VTooltip
                                location="top"
                                maxWidth={420}
                                text={[
                                    props.hint,
                                    props.source ? `${t("Source")}: ${props.source}` : undefined,
                                ]
                                    .filter(Boolean)
                                    .join("\n\n")}
                            >
                                {{
                                    activator: ({ props: activatorProps }: { props: Record<string, unknown> }) => (
                                        <VIcon
                                            {...activatorProps}
                                            {...{
                                                id: helpId,
                                                tabindex: 0,
                                                role: "button",
                                                "aria-label": `${t(props.text)} ${t("help")}`,
                                            }}
                                            icon="mdi-help-circle-outline"
                                            size="14"
                                            style={{ color: cc.onSurfaceVariant, opacity: 0.5, cursor: "help" }}
                                        />
                                    ),
                                }}
                            </VTooltip>
                        )}
                    </ThemedView>
                    <ThemedView
                        onClick={isInteractive ? handleClick : undefined}
                        onKeydown={
                            isInteractive
                                ? (event: KeyboardEvent) => {
                                      if (event.key === "Enter" || event.key === " ") {
                                          event.preventDefault();
                                          handleClick();
                                      }
                                  }
                                : undefined
                        }
                        {...(isInteractive
                            ? {
                                  role: "button",
                                  tabindex: 0,
                                  "aria-label": `${t(props.text)}: ${String(props.value)}${props.copyOnClick ? ` (${t("copy")})` : ""}`,
                              }
                            : { "aria-labelledby": labelId })}
                        style={{
                            minHeight: "24px",
                            display: "flex",
                            transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                            cursor: isInteractive ? "pointer" : "default",
                            color: isEmptyValue ? cc.onSurfaceVariant : cc.onSurface,
                            fontSize: isEmptyValue ? "14px" : "15px",
                            fontWeight: isEmptyValue ? "400" : "500",
                            lineHeight: "24px",
                            opacity: isEmptyValue ? 0.6 : 1,
                        }}
                        class={isInteractive ? "field-interactive" : undefined}
                    >
                        {hasValue ? t(String(props.value)) : `— ${t("Empty")} —`}
                    </ThemedView>
                </ThemedView>
            );
        };
    },
    {
        props: ["onClick", "text", "value", "copyOnClick", "hint", "source"],
    },
);

export default Field;

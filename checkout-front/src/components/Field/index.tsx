import { dc } from "kt-dc";
import { useLocale, useTheme } from "vuetify";
import { ThemedView } from "../ThemedView";
import { copyToClipboard } from "@/utils/common";
import { isEmpty } from "@/utils/clientValidationRules";
import { showSnackBar } from "@/utils/snackBar";
import { VDivider, VIcon } from "vuetify/components";

export type FieldProps = {
    value?: string | null | number;
    text: string;
    onClick?: () => void | Promise<void>;
    copyOnClick?: boolean;
};

export const Field = dc(
    (props: FieldProps) => {
        const { t } = useLocale();
        const theme = useTheme();

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
                    </ThemedView>
                    <ThemedView
                        onClick={isInteractive ? handleClick : undefined}
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
        props: ["onClick", "text", "value", "copyOnClick"],
    },
);

export default Field;

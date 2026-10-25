import { useLocale, useTheme } from "vuetify";
import { ThemedView } from "../ThemedView";
import { VIcon } from "vuetify/components";
import { Field } from "../Field";
import { dc } from "kt-dc";
import type { StyleValue } from "vue";

export type AlertViewProps = {
    type?: "success" | "warning" | "error" | "primary";
    message?: string;
    messages?: string[];
    onClear?: () => void;
    style?: StyleValue;
};

export const AlertView = dc(
    (props: AlertViewProps) => {
        const theme = useTheme();
        const { t } = useLocale();
        return () => {
            if (!props.message || !props.type) {
                return <></>;
            }

            let backgroundColor: string;
            switch (props.type) {
                case "error":
                    backgroundColor = theme.current.value.colors.error;
                    break;
                case "success":
                    backgroundColor = theme.current.value.colors.success;
                    break;
                case "primary":
                    backgroundColor = theme.current.value.colors.primary;
                    break;
                case "warning":
                    backgroundColor = theme.current.value.colors.warning;
                    break;
            }

            let prefix: string;
            switch (props.type) {
                case "error":
                    prefix = "Error";
                    break;
                case "success":
                    prefix = "Success";
                    break;
                case "warning":
                    prefix = "Warning";
                    break;
                case "primary":
                    prefix = "info";
                    break;
            }

            return (
                <ThemedView
                    style={[
                        {
                            backgroundColor: backgroundColor + "22",
                            borderRadius: "12px",
                            padding: "12px",
                            border: `solid 1px ${backgroundColor}`,
                            gap: "12px",
                            color: backgroundColor,
                        },
                        props.style,
                    ]}
                >
                    <ThemedView
                        style={{
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "end",
                        }}
                    >
                        {props.onClear && (
                            <ThemedView onClick={props.onClear}>
                                <VIcon icon={"mdi-close"}></VIcon>
                            </ThemedView>
                        )}
                    </ThemedView>
                    <ThemedView
                        style={{
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "start",
                        }}
                    >
                        <Field text={prefix} value={props.message}></Field>
                    </ThemedView>
                    {props.messages && (
                        <ThemedView
                            style={{
                                padding: "0px 22px",
                                gap: "12px",
                            }}
                        >
                            <ul
                                style={{
                                    gap: "12px",
                                    display: "flex",
                                    flexDirection: "column",
                                }}
                            >
                                {props.messages.map((m, index) => {
                                    return <li key={String(index)}>{t(m)}</li>;
                                })}
                            </ul>
                        </ThemedView>
                    )}
                </ThemedView>
            );
        };
    },
    {
        props: ["onClear", "message", "type", "messages", "style"],
    },
);

export default AlertView;

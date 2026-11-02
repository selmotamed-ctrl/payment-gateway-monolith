import { useLocale } from "vuetify";
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

const TONE = {
    error: {
        background: "var(--pg-status-danger-bg)",
        border: "var(--pg-status-danger-border)",
        text: "var(--pg-status-danger-text)",
        prefix: "Error",
    },
    success: {
        background: "var(--pg-status-success-bg)",
        border: "var(--pg-status-success-border)",
        text: "var(--pg-status-success-text)",
        prefix: "Success",
    },
    warning: {
        background: "var(--pg-status-warning-bg)",
        border: "var(--pg-status-warning-border)",
        text: "var(--pg-status-warning-text)",
        prefix: "Warning",
    },
    primary: {
        background: "var(--pg-status-info-bg)",
        border: "var(--pg-status-info-border)",
        text: "var(--pg-status-info-text)",
        prefix: "Info",
    },
} as const;

export const AlertView = dc(
    (props: AlertViewProps) => {
        const { t } = useLocale();
        return () => {
            if (!props.message || !props.type) {
                return <></>;
            }

            const tone = TONE[props.type];

            return (
                <ThemedView
                    role="alert"
                    style={[
                        {
                            backgroundColor: tone.background,
                            borderRadius: "var(--pg-radius-md)",
                            padding: "12px",
                            border: `1px solid ${tone.border}`,
                            gap: "12px",
                            color: tone.text,
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
                            <button
                                type="button"
                                class="alert-view__dismiss"
                                aria-label={t("Close")}
                                onClick={props.onClear}
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    border: 0,
                                    background: "transparent",
                                    color: "inherit",
                                    cursor: "pointer",
                                    padding: 0,
                                }}
                            >
                                <VIcon icon={"mdi-close"}></VIcon>
                            </button>
                        )}
                    </ThemedView>
                    <ThemedView
                        style={{
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "start",
                        }}
                    >
                        <Field text={tone.prefix} value={props.message}></Field>
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
                                    margin: 0,
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

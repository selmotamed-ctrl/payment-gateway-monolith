import { ref } from "vue";
import { dc } from "@/utils/dc";
import { useLocale } from "@/utils/vael-compat";
import { useTheme } from "@/utils/vuetify-compat";
import {PgDivider, PgMenu, PgSpinner, PgTooltip} from "@pg/ui";
import {ThemedView} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import {PgIcon as Icon} from "@pg/ui";

type Action = {
    action: () => void | Promise<void>;
    iconName?: string;
    label?: string;
    if?: () => boolean;
    backgroundColor?: string;
    textColor?: string;
    disabled?: () => boolean;
    tooltip?: () => string | null;
};

export const ActionsList = dc(
    (props: { actions: Action[]; loading?: boolean; disabled?: boolean }) => {
        const currentTheme = useTheme().current;
        const open = ref(false);
        const { t } = useLocale();
        return () => {
            const theme = currentTheme.value.colors;
            const actions = props.actions?.filter((a) => {
                if (typeof a.if != "function") {
                    return true;
                }
                return a.if();
            });

            return (!actions.length ? <></> : (
                <>
                    <PgMenu
                        modelValue={open.value && !props.disabled}
                        onUpdate:modelValue={(v) => {
                            open.value = v;
                        }}
                        disabled={props.disabled}
                    >
                        {{
                            default: () => {
                                return (
                                    <>
                                        <ThemedView
                                            style={{
                                                minWidth: "300px",
                                                gap: "12px",
                                                padding: "12px",
                                                borderRadius: "12px",
                                                border: "solid 1px #00000022",
                                                backgroundColor: theme.background,
                                            }}
                                        >
                                            {actions
                                                ?.map((action, index) => {
                                                    let backgroundColor = action.backgroundColor || theme.primary;

                                                    const tooltip = action.tooltip?.();
                                                    const disabled = action.disabled?.();
                                                    if (disabled) {
                                                        backgroundColor = theme.secondary;
                                                    }

                                                    return (
                                                        <>
                                                            <ThemedView
                                                                key={`${index}`}
                                                                style={{
                                                                    width: "100%",
                                                                    borderRadius: "8px",
                                                                    // minHeight: 30,
                                                                    padding: "8px",
                                                                    color: backgroundColor,
                                                                    flexDirection: "row",
                                                                    alignItems: "center",
                                                                    gap: "12px",
                                                                    justifyContent: "space-between",
                                                                }}
                                                                onClick={() => {
                                                                    if (disabled) {
                                                                        return;
                                                                    }
                                                                    action.action();
                                                                    open.value = false;
                                                                }}
                                                                disabled={action.disabled ? action.disabled() : undefined}
                                                            >
                                                                {tooltip && (
                                                                    <>
                                                                        <PgTooltip activator={"parent"}>
                                                                            <ThemedView>{t(tooltip)}</ThemedView>
                                                                        </PgTooltip>
                                                                    </>
                                                                )}

                                                                {action.label && (
                                                                    <>
                                                                        <ThemedText
                                                                            style={{
                                                                                // marginTop: action.label.match(/[gjpqy]/)  ? 0 : 2,
                                                                                fontWeight: "600",
                                                                                fontSize: "12px",
                                                                                lineHeight: "12px",
                                                                                // color: textColor,
                                                                            }}
                                                                        >
                                                                            {t(action.label)}
                                                                        </ThemedText>
                                                                    </>
                                                                )}

                                                                {action.iconName && (
                                                                    <>
                                                                        <Icon icon={action.iconName} color={backgroundColor} size={12}></Icon>
                                                                    </>
                                                                )}
                                                            </ThemedView>
                                                            {index < actions.length - 1 && (
                                                                <>
                                                                    <PgDivider></PgDivider>
                                                                </>
                                                            )}
                                                        </>
                                                    );
                                                })
                                                .filter((e) => !!e)}
                                        </ThemedView>
                                    </>
                                );
                            },
                            activator: (slotProps: any) => {
                                return (
                                    <ThemedView
                                        style={{
                                            paddingBottom: "1px",
                                        }}
                                        {...slotProps?.props}
                                        disabled={props.disabled}
                                    >
                                        {!props.loading ? (
                                            <Icon icon="mdi-dots-horizontal" size={32}></Icon>
                                        ) : (
                                            <PgSpinner indeterminate></PgSpinner>
                                        )}
                                    </ThemedView>
                                );
                            },
                        }}
                    </PgMenu>
                </>
            ));
        };
    },
    {
        props: ["actions", "disabled", "loading"],
    },
);
export default ActionsList;

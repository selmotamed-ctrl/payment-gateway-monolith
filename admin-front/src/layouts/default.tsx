import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { drawer, toggleDrawer, toggleTheme } from "@/state/app/index";
import {
    VAppBar,
    VAvatar,
    VBtn,
    VIcon,
    VList,
    VListItem,
    VListSubheader,
    VMain,
    VMenu,
    VNavigationDrawer,
    VToolbar,
    VTooltip,
} from "vuetify/components";
import LogoSvg from "@/assets/images/logo.svg";
import { useDisplay, useLocale, useTheme } from "vuetify";
import { logout, user } from "@/state/user";
import { useSections } from "./sections";
import { setLocale } from "@/plugins/localization";
import { showSnackBar } from "@/utils/snackBar";
import { dc } from "kt-dc";
import { RouterView } from "vue-router";
import { Fragment } from "vue";

const DefaultLayout = dc(() => {
    const { t, isRtl } = useLocale();
    const theme = useTheme();
    const display = useDisplay();
    const sections = useSections();

    return () => {
        const isDark = theme.current.value.dark;
        const mobile = display.mobile.value;

        return (
            <>
            <VNavigationDrawer
                v-model={drawer.value}
                permanent={!mobile}
                temporary={mobile}
                width={280}
                color={isDark ? "#0b1524" : "#ffffff"}
                style={{
                    borderInlineEnd: isDark ? "1px solid rgba(226,232,240,0.08)" : "1px solid rgba(15,23,42,0.08)",
                }}
            >
                <ThemedView
                    style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: "12px",
                        padding: "18px 20px",
                    }}
                >
                    <img src={LogoSvg} alt="logo" width={"36px"} height={"36px"} />
                    <ThemedView style={{ flexDirection: "column" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>
                            {t("Payment Gateway")}
                        </ThemedText>
                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>
                            {t("Admin Back Office")}
                        </ThemedText>
                    </ThemedView>
                </ThemedView>

                <VList density="comfortable" style={{ padding: "8px 12px", flex: 1, overflowY: "auto" }}>
                    {sections.map((section) => (
                        <Fragment key={section.title}>
                            <VListSubheader style={{ fontSize: "11px", letterSpacing: "0.6px" }}>{section.title}</VListSubheader>
                            {section.routes.map((route) => (
                                <VListItem
                                    key={route.name}
                                    to={{ name: route.name }}
                                    exact={false}
                                    prependIcon={route.icon}
                                    title={route.label}
                                    rounded="lg"
                                    style={{ marginBottom: "2px" }}
                                />
                            ))}
                        </Fragment>
                    ))}
                </VList>
            </VNavigationDrawer>

            <VAppBar flat height={"64px"} style={{ background: isDark ? "#0b1524" : "#ffffff" }}>
                <VToolbar style={{ gap: "12px" }}>
                    <VBtn icon variant="text" onClick={() => toggleDrawer()} aria-label={t("Toggle Drawer")}>
                        <VIcon icon={"mdi-menu"} />
                    </VBtn>
                    <ThemedView style={{ flex: 1 }} />

                    <VTooltip text={isDark ? t("Light Mode") : t("Dark Mode")} location="bottom">
                        {{
                            activator: ({ props }: any) => (
                                <VBtn
                                    {...props}
                                    icon
                                    variant="text"
                                    onClick={() => toggleTheme()}
                                    aria-label={t("Toggle theme")}
                                >
                                    <VIcon icon={isDark ? "mdi-weather-sunny" : "mdi-weather-night"} />
                                </VBtn>
                            ),
                        }}
                    </VTooltip>

                    <VMenu>
                        {{
                            activator: ({ props }: any) => (
                                <VBtn {...props} icon variant="text" aria-label={t("Language")}>
                                    <VIcon icon={"mdi-translate"} />
                                </VBtn>
                            ),
                            default: () => (
                                <VList density="compact">
                                    <VListItem
                                        title="العربية"
                                        prependIcon="mdi-check"
                                        onClick={() => setLocale("ar")}
                                    />
                                    <VListItem
                                        title="English"
                                        prependIcon={isRtl.value ? "mdi-circle-outline" : "mdi-check"}
                                        onClick={() => setLocale("en")}
                                    />
                                </VList>
                            ),
                        }}
                    </VMenu>

                    <VMenu>
                        {{
                            activator: ({ props }: any) => (
                                <ThemedView {...props} style={{ flexDirection: "row", alignItems: "center", gap: "10px" }}>
                                    <VAvatar
                                        size={"34px"}
                                        color="primary"
                                        style={{
                                            background: `linear-gradient(135deg, ${theme.current.value.colors.primary}, ${theme.current.value.colors.accent})`,
                                            color: "white",
                                            fontWeight: "800",
                                        }}
                                    >
                                        {(user.value?.userInfo?.name || user.value?.userInfo?.username || "U")
                                            .charAt(0)
                                            .toUpperCase()}
                                    </VAvatar>
                                    <ThemedView style={{ flexDirection: "column", alignItems: "flex-start" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                                            {user.value?.userInfo?.name || user.value?.userInfo?.username || "User"}
                                        </ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>
                                            {user.value?.userInfo?.role || ""}
                                        </ThemedText>
                                    </ThemedView>
                                </ThemedView>
                            ),
                            default: () => (
                                <VList density="compact">
                                    <VListItem
                                        title={t("Logout")}
                                        prependIcon="mdi-logout"
                                        onClick={() => {
                                            showSnackBar({ type: "primary", message: t("Logout") });
                                            void logout();
                                        }}
                                    />
                                </VList>
                            ),
                        }}
                    </VMenu>
                </VToolbar>
            </VAppBar>

            <VMain style={{ background: theme.current.value.colors.background, minHeight: "100vh" }}>
                <RouterView />
            </VMain>
            </>
        );
    };
});

export default DefaultLayout;

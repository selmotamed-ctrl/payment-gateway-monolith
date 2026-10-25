import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import router from "@/router";
import { drawer, toggleDrawer, toggleTheme } from "@/state/app/index";
import { Transition } from "vue";
import {
    VAvatar,
    VDivider,
    VIcon,
    VList,
    VListGroup,
    VListItem,
    VListSubheader,
    VMenu,
    VProgressCircular,
    VTooltip,
} from "vuetify/components";
import LogoSvg from "@/assets/images/logo.svg";
import { useDisplay, useLocale, useTheme } from "vuetify";
import { loggingOut, logout, setUserState, user, type User } from "@/state/user";
import { routesAuthorities, useSections } from "./sections";
import { setLocale } from "@/plugins/localization";
import { extractApiError } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { appScale, setAppScale, toggleAppScale } from "@/utils/appScale";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { hasOneOfAuthorities, type UserAuthoritiesMapType } from "@/pages/user/core/users/roles/authorities";
import { dc } from "kt-dc";

type Menu = MenuItem[];

type MenuItem =
    | {
          label: string;
          icon?: string;
          type?: undefined;
          action: () => void | Promise<void>;
      }
    | {
          type: "menu";
          label: string;
          icon?: string;
          subMenu: Menu;
      };

const AccountActions = defineComponent(() => {
    const local = useLocale();
    const theme = useTheme();

    return () => {
        const { t } = local;
        const isDark = theme.current.value.dark;
        const accountActions: Menu = [
            {
                action() {
                    toggleTheme();
                },
                icon: isDark ? "mdi-weather-sunny" : "mdi-weather-night",
                label: isDark ? t("Light Mode") : t("Dark Mode"),
            },
            {
                label: t("App Scale"),
                type: "menu",
                icon: "mdi-magnify-plus-outline",
                subMenu: [
                    {
                        label: "90%",
                        action: () => {
                            setAppScale(0.8);
                        },
                    },
                    {
                        label: "100%",
                        action: () => {
                            setAppScale(0.9);
                        },
                    },
                    {
                        label: "110%",
                        action: () => {
                            setAppScale(1.0);
                        },
                    },
                    {
                        label: t("Toggle Scale"),
                        action: () => {
                            toggleAppScale();
                        },
                    },
                ],
            },
            {
                label: t("Language"),
                type: "menu",
                icon: "mdi-translate",
                subMenu: [
                    {
                        label: "العربية",
                        action: () => {
                            setLocale("ar");
                            // local.current.value = "ar";
                            // setTimeout(() => {
                            //     location.reload();
                            // }, 0.8e3);
                        },
                    },
                    {
                        label: "English",
                        action: () => {
                            setLocale("en");
                        },
                    },
                ],
            },
            {
                action() {
                    console.log("[LOGOUT] from default layout because user pressed it");

                    logout();
                },
                icon: "mdi-logout",
                label: t("Logout"),
            },
        ];
        return (
            <ThemedView
                style={{
                    gap: "16px",
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    flex: 1,
                }}
            >
                <ThemedView>
                    <ThemedView
                        style={{
                            cursor: "pointer",
                            flexDirection: "row",
                            alignItems: "center",
                            borderRadius: "14px",
                            padding: "8px 12px",
                            gap: "12px",
                            minWidth: "180px",
                            background: theme.current.value.dark ? "rgba(15, 27, 45, 0.86)" : "rgba(255, 255, 255, 0.86)",
                            backdropFilter: "blur(18px)",
                            border: theme.current.value.dark ? "1px solid rgba(226, 232, 240, 0.1)" : "1px solid rgba(15, 23, 42, 0.08)",
                            transition: "all 0.2s ease",
                            boxShadow: theme.current.value.dark ? "0 12px 28px rgba(0, 0, 0, 0.18)" : "0 12px 28px rgba(15, 23, 42, 0.06)",
                        }}
                        class={"account-actions-trigger"}
                        id="account-actions"
                    >
                        <VAvatar
                            size={36}
                            style={{
                                background: `linear-gradient(135deg, ${theme.current.value.colors.primary} 0%, ${theme.current.value.colors.accent} 100%)`,
                                color: "white",
                                fontWeight: "800",
                            }}
                        >
                            {user.value?.userInfo?.username?.charAt(0)?.toUpperCase() || "U"}
                        </VAvatar>
                        <ThemedView style={{ flexDirection: "column", gap: "2px", alignItems: "flex-start" }}>
                            <ThemedText
                                type="defaultSemiBold"
                                style={{
                                    fontSize: "14px",
                                    color: theme.current.value.colors["on-surface"],
                                }}
                            >
                                {user.value?.userInfo?.name || user.value?.userInfo?.username || "User"}
                            </ThemedText>
                            <ThemedText
                                style={{
                                    fontSize: "12px",
                                    color: theme.current.value.colors["on-surface-variant"],
                                    opacity: 0.8,
                                }}
                            >
                                {user.value?.userInfo?.userType || ""}
                            </ThemedText>
                        </ThemedView>
                        <VIcon
                            size={20}
                            icon={"mdi-chevron-down"}
                            style={{
                                marginLeft: "auto",
                                transition: "transform 0.3s ease",
                            }}
                            class="chevron-icon"
                        ></VIcon>
                    </ThemedView>

                    <VMenu activator="#account-actions" location="bottom end" offset={8}>
                        {{
                            default: () => {
                                return (
                                    <>
                                        <VList
                                            minWidth={"280px"}
                                            density={"comfortable"}
                                            style={{
                                                padding: "8px",
                                                background: theme.current.value.dark ? "rgba(15, 27, 45, 0.98)" : "rgba(255, 255, 255, 0.98)",
                                                backdropFilter: "blur(20px)",
                                                borderRadius: "14px",
                                                border: theme.current.value.dark ? "1px solid rgba(226, 232, 240, 0.1)" : "1px solid rgba(15, 23, 42, 0.08)",
                                                boxShadow: theme.current.value.dark
                                                    ? "0 8px 32px rgba(0, 0, 0, 0.5)"
                                                    : "0 8px 32px rgba(0, 0, 0, 0.12)",
                                            }}
                                        >
                                            {accountActions.map((action, index) => {
                                                return <MenuItem key={String(index)} item={action}></MenuItem>;
                                            })}
                                        </VList>
                                    </>
                                );
                            },
                        }}
                    </VMenu>
                </ThemedView>
            </ThemedView>
        );
    };
});

const MenuItem = defineComponent(
    (props: { item: MenuItem }) => {
        const item = props.item;
        const theme = useTheme();

        return () => {
            if (item.type === undefined) {
                return (
                    <VListItem
                        onClick={item.action}
                        style={{
                            borderRadius: "12px",
                            margin: "4px 0",
                            transition: "all 0.2s ease",
                        }}
                        class="menu-item-hover"
                    >
                        <VListItem
                            title={item.label}
                            prependIcon={item.icon}
                            style={{
                                padding: "12px 16px",
                            }}
                        ></VListItem>
                    </VListItem>
                );
            }
            if (item.type == "menu") {
                return (
                    <VMenu submenu>
                        {{
                            activator: ({ props }: { props: any }) => {
                                return (
                                    <>
                                        <VListItem
                                            {...props}
                                            style={{
                                                borderRadius: "12px",
                                                margin: "4px 0",
                                                transition: "all 0.2s ease",
                                            }}
                                            class="menu-item-hover"
                                        >
                                            <VListItem
                                                title={item.label}
                                                prependIcon={item.icon}
                                                appendIcon="mdi-chevron-right"
                                                style={{
                                                    padding: "12px 16px",
                                                }}
                                            ></VListItem>
                                        </VListItem>
                                    </>
                                );
                            },
                            default: () => {
                                return (
                                    <>
                                        <VList
                                            minWidth={"250px"}
                                            density={"comfortable"}
                                            style={{
                                                padding: "8px",
                                                background: theme.current.value.dark ? "rgba(30, 30, 30, 0.98)" : "rgba(255, 255, 255, 0.98)",
                                                backdropFilter: "blur(20px)",
                                                borderRadius: "16px",
                                                boxShadow: theme.current.value.dark
                                                    ? "0 8px 32px rgba(0, 0, 0, 0.5)"
                                                    : "0 8px 32px rgba(0, 0, 0, 0.12)",
                                            }}
                                        >
                                            {item.subMenu.map((action, index) => {
                                                return <MenuItem key={String(index)} item={action}></MenuItem>;
                                            })}
                                        </VList>
                                    </>
                                );
                            },
                        }}
                    </VMenu>
                );
            }
        };
    },
    {
        props: ["item"],
    },
);

const ScaleIndicator = defineComponent(() => {
    const theme = useTheme();

    return () => {
        const currentScale = appScale.value;

        return (
            <VTooltip text={`App Scale: ${Math.round(currentScale * 100)}% (Ctrl/Cmd + +/- to adjust)`} location="bottom">
                {{
                    activator: ({ props }: any) => (
                        <ThemedView
                            {...props}
                            style={{
                                flexDirection: "row",
                                alignItems: "center",
                                gap: "6px",
                                padding: "6px 12px",
                                borderRadius: "8px",
                                background: theme.current.value.dark ? "rgba(226, 232, 240, 0.06)" : "rgba(15, 23, 42, 0.04)",
                                border: theme.current.value.dark ? "1px solid rgba(226, 232, 240, 0.1)" : "1px solid rgba(15, 23, 42, 0.08)",
                                cursor: "pointer",
                                transition: "all 0.2s ease",
                            }}
                            onClick={() => toggleAppScale()}
                        >
                            <VIcon
                                size={16}
                                style={{
                                    color: theme.current.value.colors["on-surface-variant"],
                                }}
                            >
                                mdi-magnify-plus-outline
                            </VIcon>
                            <ThemedText
                                style={{
                                    fontSize: "12px",
                                    fontWeight: "600",
                                    color: theme.current.value.colors["on-surface-variant"],
                                }}
                            >
                                {Math.round(currentScale * 100)}%
                            </ThemedText>
                        </ThemedView>
                    ),
                }}
            </VTooltip>
        );
    };
});

const AppBarLogo = defineComponent(() => {
    const { t } = useLocale();
    const theme = useTheme();
    const display = useDisplay();

    return () => {
        const isMobile = display.mobile.value;

        return (
            <ThemedView
                style={{
                    display: "flex",
                    flexDirection: "row",
                    alignItems: "center",
                    gap: isMobile ? "12px" : "20px",
                }}
            >
                <VTooltip text={t("Toggle Drawer")} location="bottom">
                    {{
                        activator: ({ props }: any) => (
                            <ThemedView
                                {...props}
                                onClick={() => toggleDrawer()}
                                style={{
                                    flexDirection: "row",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: "8px",
                                    width: "44px",
                                    height: "44px",
                                    borderRadius: "12px",
                                    padding: "0px",
                                    background: theme.current.value.dark ? "rgba(15, 27, 45, 0.86)" : "rgba(255, 255, 255, 0.86)",
                                    backdropFilter: "blur(18px)",
                                    border: theme.current.value.dark ? "1px solid rgba(226, 232, 240, 0.1)" : "1px solid rgba(15, 23, 42, 0.08)",
                                    cursor: "pointer",
                                    transition: "all 0.2s ease",
                                    boxShadow: theme.current.value.dark ? "0 12px 28px rgba(0, 0, 0, 0.18)" : "0 12px 28px rgba(15, 23, 42, 0.06)",
                                }}
                                class="menu-toggle-button"
                            >
                                <VIcon
                                    size={22}
                                    style={{
                                        color: theme.current.value.colors.primary,
                                    }}
                                >
                                    mdi-menu
                                </VIcon>
                            </ThemedView>
                        ),
                    }}
                </VTooltip>
                <ThemedView
                    style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: "12px",
                        paddingLeft: "10px",
                        borderLeft: theme.current.value.dark ? "1px solid rgba(226, 232, 240, 0.1)" : "1px solid rgba(15, 23, 42, 0.08)",
                        flex: 1,
                        minWidth: 0,
                    }}
                >
                    <img
                        src={LogoSvg}
                        alt="Sarraf Logo"
                        style={{
                            height: isMobile ? "44px" : "48px",
                            width: "auto",
                            maxWidth: isMobile ? "180px" : "200px",
                            objectFit: "contain",
                            filter: theme.current.value.dark ? "brightness(1.1) contrast(1.1)" : "brightness(0.95) contrast(1.05)",
                            transition: "all 0.3s ease",
                        }}
                    />
                </ThemedView>
            </ThemedView>
        );
    };
});

const RoutesList = defineComponent(() => {
    const theme = useTheme();
    const sections = useSections();
    const { t } = useLocale();

    const filteredSections = computed(() => {
        const filteredSections = sections.filter((s) => {
            if (typeof s.if !== "function") {
                return true;
            }
            return s.if();
        });
        for (const s of filteredSections) {
            s.routes = s.routes.filter((r) => {
                const requiredAuthorities = routesAuthorities[r.name];
                if (requiredAuthorities?.length) {
                    const hasAuthority = hasOneOfAuthorities(requiredAuthorities);
                    if (!hasAuthority) {
                        return false;
                    }
                }

                if (typeof r.if !== "function") {
                    return true;
                }
                return r.if();
            });
        }
        return filteredSections.filter((s) => {
            return s.routes.length > 0;
        });
    });

    const sectionsOpened = ref(
        filteredSections.value.map((s, index) => {
            return String(index);
        }),
    );
    const display = useDisplay();

    return () => {
        const cr = router.currentRoute.value;
        return (
            <VList
                style={{
                    padding: "24px 16px",
                    overflowY: "auto",
                }}
                class={"bg-transparent"}
                density={"comfortable"}
                opened={sectionsOpened.value}
                onUpdate:opened={(v) => {
                    sectionsOpened.value = v;
                }}
            >
                {filteredSections.value.map((section, index) => {
                    const routes = section.routes;
                    return (
                        <ThemedView
                            key={section.title}
                            style={{
                                gap: "10px",
                                paddingBottom: "18px",
                            }}
                        >
                            <VListGroup value={String(index)}>
                                {{
                                    activator: ({ props }: any) => {
                                        return (
                                            <VListItem
                                                {...props}
                                                baseColor="white"
                                                style={{
                                                    width: "100%",
                                                    borderRadius: "10px",
                                                    marginBottom: "8px",
                                                    padding: "10px 14px",
                                                    background: "rgba(255, 255, 255, 0.04)",
                                                    transition: "all 0.2s ease",
                                                }}
                                                class="section-header-hover"
                                            >
                                                <ThemedText
                                                    type="subtitle"
                                                    style={{
                                                        fontSize: "13px",
                                                        letterSpacing: "0px",
                                                        textTransform: "uppercase",
                                                        color: "rgba(226, 232, 240, 0.82)",
                                                        opacity: 1,
                                                    }}
                                                >
                                                    {t(section.title)}
                                                </ThemedText>
                                            </VListItem>
                                        );
                                    },
                                    default: () => {
                                        return (
                                            <ThemedView
                                                style={{
                                                    gap: "6px",
                                                    padding: "6px 0px 0px 6px",
                                                }}
                                            >
                                                {routes.map((r) => {
                                                    const isFocused = cr?.name == r.name;
                                                    const drawerRouteHref = router.resolve({
                                                        name: r.name,
                                                    }).href;
                                                    return (
                                                        <a
                                                            href={drawerRouteHref}
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                            }}
                                                            style={{
                                                                textDecoration: "none",
                                                            }}
                                                        >
                                                            <VListItem
                                                                prependIcon={r.icon}
                                                                baseColor="white"
                                                                disabled={isFocused}
                                                                key={r.name}
                                                                style={{
                                                                    borderRadius: "12px",
                                                                    margin: "2px 0",
                                                                    padding: "12px 14px",
                                                                    transition: "all 0.2s ease",
                                                                    background: isFocused
                                                                        ? "linear-gradient(135deg, rgba(15, 107, 255, 0.24), rgba(45, 212, 191, 0.14))"
                                                                        : "transparent",
                                                                    borderLeft: isFocused ? `4px solid ${theme.current.value.colors.accent}` : "4px solid transparent",
                                                                    boxShadow: isFocused ? "0 12px 28px rgba(0, 0, 0, 0.14)" : "none",
                                                                    transform: isFocused ? "translateX(2px)" : "translateX(0)",
                                                                }}
                                                                class={isFocused ? "route-item-active" : "route-item"}
                                                                onClick={() => {
                                                                    try {
                                                                        if (isFocused) {
                                                                            return;
                                                                        }
                                                                        router.push({
                                                                            name: r.name,
                                                                        });
                                                                    } catch (error) {
                                                                    } finally {
                                                                        if (display.mobile.value) {
                                                                            toggleDrawer();
                                                                        }
                                                                    }
                                                                }}
                                                            >
                                                                <ThemedText
                                                                    type="defaultSemiBold"
                                                                    style={{
                                                                        fontSize: "14px",
                                                                        color: "white",
                                                                        transition: "color 0.2s ease",
                                                                    }}
                                                                >
                                                                    {t(r.label)}
                                                                </ThemedText>
                                                            </VListItem>
                                                        </a>
                                                    );
                                                })}
                                            </ThemedView>
                                        );
                                    },
                                }}
                            </VListGroup>
                        </ThemedView>
                    );
                })}
            </VList>
        );
    };
});

const Drawer = defineComponent(() => {
    const theme = useTheme();
    const display = useDisplay();
    const { t } = useLocale();
    return () => {
        const mobile = display.mobile.value;

        const content = (
            <>
                <ThemedView
                    style={{
                        width: "320px",
                        gap: "0px",
                        minHeight: "100%",
                        overflowY: "auto",
                        background:
                            "radial-gradient(circle at 20% 0%, rgba(45, 212, 191, 0.18), transparent 28%), linear-gradient(180deg, #0a1424 0%, #101d33 52%, #08111f 100%)",
                        borderRight: "1px solid rgba(226, 232, 240, 0.1)",
                    }}
                >
                    <ThemedView
                        style={{
                            padding: "24px 20px 18px",
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "12px",
                            borderBottom: "1px solid rgba(226, 232, 240, 0.1)",
                        }}
                        onClick={() => {
                            drawer.value = false;
                        }}
                    >
                        <ThemedText
                            type="title"
                            style={{
                                fontSize: "20px",
                                fontWeight: "800",
                                background: `linear-gradient(135deg, #ffffff 0%, #8ee9df 100%)`,
                                WebkitBackgroundClip: "text",
                                WebkitTextFillColor: "transparent",
                                backgroundClip: "text",
                            }}
                        >
                            {t("Navigation")}
                        </ThemedText>
                        <VIcon color="white">mdi-view-dashboard</VIcon>
                    </ThemedView>
                    <RoutesList></RoutesList>
                </ThemedView>
            </>
        );

        if (mobile) {
            return (
                <ThemedView
                    style={{
                        position: "absolute",
                        top: "0px",
                        bottom: "0px",
                        left: "0px",
                        right: "0px",
                        flexDirection: "row",
                        alignItems: "stretch",
                        zIndex: 1000,
                        height: "100%",
                        width: drawer.value ? "100%" : "0px",
                    }}
                >
                    <ThemedView
                        style={{
                            transform: "all 0.4s",
                            height: "100%",
                            overflow: "hidden",
                        }}
                    >
                        {content}
                    </ThemedView>
                    <ThemedView
                        style={{
                            zIndex: 1000,
                            flex: 1,
                            width: drawer.value ? undefined : "0px",
                            height: "100%",
                            background: "#00000033",
                        }}
                        onClick={() => {
                            drawer.value = false;
                        }}
                    ></ThemedView>
                </ThemedView>
            );
        }

        return (
            <>
                <ThemedView
                    style={{
                        transform: "all 0.4s",
                        flex: 1,
                        overflow: "hidden",
                        width: drawer.value ? "320px" : "0px",
                        ...(mobile
                            ? {
                                  background: theme.current.value.dark ? "rgba(18, 18, 18, 0.85)" : "rgba(255, 255, 255, 0.85)",
                                  height: "100%",
                                  backdropFilter: "blur(10px)",
                                  zIndex: 1000,
                                  position: "absolute",
                                  top: "0px",
                                  left: "0px",
                              }
                            : {}),
                    }}
                >
                    {content}
                </ThemedView>
            </>
        );
    };
});

const DashboardLayout = defineComponent<{}>(() => {
    const { t } = useLocale();
    const theme = useTheme();

    const loadingUser = ref(false);
    const display = useDisplay();
    const checkUser = async () => {
        if (loadingUser.value) {
            return;
        }
        console.log("Existing User", user.value);
        await nextTick();
        if (!user.value?.token || !user.value?.userInfo) {
            console.log("[LOGOUT] default layout user has no token or user info");
            logout();
            return;
        }

        loadingUser.value = true;

        try {
            const me: {
                user: User;
                grantedAuthoritiesMap: UserAuthoritiesMapType;
            } = (await api.get(urlsMap.profileMe)).data;

            console.log("ME", me);

            setUserState({
                authoritiesMap: me.grantedAuthoritiesMap || {},
                token: user.value.token,
                userInfo: me.user,
            });
        } catch (error) {
            console.error(error);
            const e = extractApiError(error);
            if (e) {
                showSnackBar({
                    message: e.error,
                    type: "error",
                });
                logout();
            }
        } finally {
            loadingUser.value = false;
        }
    };

    onMounted(() => {
        checkUser();
    });

    const hideDrawer = computed((): boolean => {
        return loadingUser.value || loggingOut.value;
    });

    return () => {
        const mobile = display.mobile.value;
        if (loggingOut.value) {
            return (
                <ThemedView
                    style={{
                        width: "100%",
                        height: "100vh",
                        padding: "12px",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "24px",
                        background: theme.current.value.dark
                            ? "linear-gradient(135deg, #0a0a0a 0%, #121212 100%)"
                            : "linear-gradient(135deg, #f5f7fa 0%, #e8ecf0 100%)",
                    }}
                >
                    <ThemedView
                        style={{
                            flexDirection: "column",
                            alignItems: "center",
                            gap: "16px",
                            padding: "32px",
                            borderRadius: "20px",
                            background: theme.current.value.dark ? "rgba(30, 30, 30, 0.95)" : "rgba(255, 255, 255, 0.95)",
                            backdropFilter: "blur(10px)",
                            boxShadow: theme.current.value.dark ? "0 8px 32px rgba(0, 0, 0, 0.5)" : "0 8px 32px rgba(0, 0, 0, 0.1)",
                        }}
                    >
                        <VProgressCircular
                            indeterminate
                            size={48}
                            width={4}
                            style={{
                                color: theme.current.value.colors.primary,
                            }}
                        ></VProgressCircular>
                        <ThemedText
                            type="defaultSemiBold"
                            style={{
                                fontSize: "16px",
                                color: theme.current.value.colors["on-surface"],
                            }}
                        >
                            {t("Logging Out")}
                        </ThemedText>
                    </ThemedView>
                </ThemedView>
            );
        }

        if (loadingUser.value) {
            return (
                <ThemedView
                    style={{
                        width: "100%",
                        height: "100vh",
                        padding: "12px",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "24px",
                        background: theme.current.value.dark
                            ? "linear-gradient(135deg, #0a0a0a 0%, #121212 100%)"
                            : "linear-gradient(135deg, #f5f7fa 0%, #e8ecf0 100%)",
                    }}
                >
                    <ThemedView
                        style={{
                            flexDirection: "column",
                            alignItems: "center",
                            gap: "16px",
                            padding: "32px",
                            borderRadius: "20px",
                            background: theme.current.value.dark ? "rgba(30, 30, 30, 0.95)" : "rgba(255, 255, 255, 0.95)",
                            backdropFilter: "blur(10px)",
                            boxShadow: theme.current.value.dark ? "0 8px 32px rgba(0, 0, 0, 0.5)" : "0 8px 32px rgba(0, 0, 0, 0.1)",
                        }}
                    >
                        <VProgressCircular
                            indeterminate
                            size={48}
                            width={4}
                            style={{
                                color: theme.current.value.colors.primary,
                            }}
                        ></VProgressCircular>
                        <ThemedText
                            type="defaultSemiBold"
                            style={{
                                fontSize: "16px",
                                color: theme.current.value.colors["on-surface"],
                            }}
                        >
                            {t("Loading User")}
                        </ThemedText>
                    </ThemedView>
                </ThemedView>
            );
        }

        let mainView = (
            <router-view>
                {{
                    default: (props: any) => {
                        return (
                            <Transition duration={0.5} name="fade" mode="out-in">
                                <ThemedView style={{ flex: 1 }} key={router.currentRoute.value.fullPath}>
                                    {props.Component}
                                </ThemedView>
                            </Transition>
                        );
                    },
                }}
            </router-view>
        );

        return (
            <ThemedView
                style={{
                    height: "100%",
                }}
            >
                <ThemedView
                    style={{
                        flexDirection: "row",
                        background: theme.current.value.dark
                            ? "radial-gradient(circle at 88% 4%, rgba(45, 212, 191, 0.08), transparent 24%), radial-gradient(circle at 52% 0%, rgba(94, 161, 255, 0.09), transparent 30%), #08111f"
                            : "radial-gradient(circle at 88% 4%, rgba(45, 212, 191, 0.13), transparent 24%), radial-gradient(circle at 52% 0%, rgba(15, 107, 255, 0.1), transparent 30%), #f4f7fb",
                        position: "relative",
                        overflow: "hidden",
                        flex: 1,
                        alignItems: "stretch", // make children stretch vertically
                        // do NOT set width: "100%" here — let flex do the sizing
                    }}
                >
                    <ThemedView
                        id="drawer"
                        style={{
                            flex: 0, // drawer fixed width (already was)
                        }}
                    >
                        {!hideDrawer.value && <Drawer />}
                    </ThemedView>
                    <ThemedView
                        style={{
                            flexDirection: "column",
                            gap: "0px",
                            width: "100%",
                            overflowX: "hidden",
                            flex: 1,
                        }}
                    >
                        {mobile || true ? (
                            <></>
                        ) : (
                            <ThemedView
                                id="app-bar"
                                style={{
                                    flexDirection: "row",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    gap: "12px",
                                    padding: mobile ? "14px 12px 8px" : "18px 28px 12px",
                                    position: "sticky",
                                    top: "0px",
                                    zIndex: 20,
                                    background: theme.current.value.dark ? "rgba(8, 17, 31, 0.78)" : "rgba(244, 247, 251, 0.78)",
                                    backdropFilter: "blur(18px)",
                                    borderBottom: theme.current.value.dark ? "1px solid rgba(226, 232, 240, 0.08)" : "1px solid rgba(15, 23, 42, 0.06)",
                                }}
                            >
                                <AppBarLogo></AppBarLogo>
                                {!mobile ? (
                                    <>
                                        <SearchBar></SearchBar>
                                    </>
                                ) : (
                                    <></>
                                )}
                                <AccountActions></AccountActions>
                            </ThemedView>
                        )}
                        <ThemedView
                            style={{
                                flexDirection: "row",
                                flex: 1,
                                background: "transparent",
                                position: "relative",
                                overflow: "hidden",
                                alignItems: "stretch", // make children stretch vertically
                                // do NOT set width: "100%" here — let flex do the sizing
                            }}
                        >
                            {/* MAIN: let it shrink; allow scrolling inside it */}
                            <ThemedView
                                id="page-content"
                                style={{
                                    overflowY: "auto",
                                    minWidth: 0,
                                    flex: 1,
                                    overflowX: "hidden", // allow internal scrolling instead of page overflow

                                    boxSizing: "border-box",
                                }}
                            >
                                {mobile || true ? (
                                    <>
                                        <ThemedView
                                            id="app-bar"
                                            style={{
                                                flexDirection: "row",
                                                justifyContent: "space-between",
                                                alignItems: "center",
                                                gap: "12px",
                                                padding: mobile ? "14px 12px 8px" : "18px 28px 12px",
                                                position: "sticky",
                                                top: "0px",
                                                zIndex: 20,
                                                background: theme.current.value.dark ? "rgba(8, 17, 31, 0.78)" : "rgba(244, 247, 251, 0.78)",
                                                backdropFilter: "blur(18px)",
                                                borderBottom: theme.current.value.dark ? "1px solid rgba(226, 232, 240, 0.08)" : "1px solid rgba(15, 23, 42, 0.06)",
                                            }}
                                        >
                                            <AppBarLogo></AppBarLogo>

                                            {!mobile ? (
                                                <>
                                                    <SearchBar></SearchBar>
                                                </>
                                            ) : (
                                                <></>
                                            )}
                                            <AccountActions></AccountActions>
                                        </ThemedView>
                                        {mobile ? (
                                            <>
                                                <SearchBar></SearchBar>
                                            </>
                                        ) : (
                                            <></>
                                        )}
                                    </>
                                ) : (
                                    <></>
                                )}

                                {mainView}
                            </ThemedView>
                        </ThemedView>
                    </ThemedView>
                </ThemedView>
            </ThemedView>
        );
    };
});

const SearchBar = dc(() => {
    const { t } = useLocale();
    const theme = useTheme();
    const display = useDisplay();
    const sections = useSections();
    const routes = computed(() => {
        return sections
            .filter((s) => {
                if (typeof s.if == "function" && !s.if()) {
                    return false;
                }
                return true;
            })
            .map((s) => {
                s.routes = s.routes.filter((r) => {
                    if (typeof r.if == "function" && !r.if()) {
                        return false;
                    }
                    return true;
                });
                return s;
            })
            .filter((s) => {
                return s.routes.length > 0;
            })
            .reduce(
                (list, s) => {
                    list.push(
                        ...s.routes.map((r) => {
                            return {
                                ...r,
                                section: s,
                            };
                        }),
                    );
                    return list;
                },
                [] as ((typeof sections)[0]["routes"][0] & {
                    section: (typeof sections)[0];
                })[],
            )
            .map((r) => {
                const result = {
                    ...r,
                    labelArabic: t(r.label),
                    descriptionArabic: t(r.description ?? ""),
                };

                return {
                    ...result,
                    _json: JSON.stringify(result),
                };
            });
    });

    const search = ref(null as null | string);
    const filteredResult = computed(() => {
        const s = search.value;
        if (!s) {
            return [];
        }
        return routes.value.filter((r) => {
            return r._json.includes(s);
        });
    });

    return () => {
        const mobile = display.mobile.value;

        return (
            <>
                <ThemedView
                    style={{
                        width: "100%",
                        maxWidth: "620px",
                        padding: mobile ? "8px 12px 12px" : "0px",
                        alignSelf: "center",
                    }}
                >
                    <TextField
                        modelValue={search.value}
                        onUpdate:modelValue={(v) => {
                            search.value = v;
                        }}
                        density={"compact"}
                        key="search"
                        hideDetails
                        prependInnerIcon={"mdi-magnify"}
                        color="primary"
                        placeholder={t("Search") + "..."}
                        bgColor={theme.current.value.dark ? "rgba(15, 27, 45, 0.82)" : "rgba(255, 255, 255, 0.82)"}
                        variant="outlined"
                    >
                        <VMenu
                            closeOnBack
                            location="bottom"
                            maxHeight={"400px"}
                            activator={"parent"}
                            modelValue={!!search.value}
                            closeOnContentClick={false}
                        >
                            <VList
                                rounded
                                style={{
                                    border: theme.current.value.dark ? "1px solid rgba(226, 232, 240, 0.1)" : "1px solid rgba(15, 23, 42, 0.08)",
                                    boxShadow: theme.current.value.dark ? "0 18px 50px rgba(0, 0, 0, 0.32)" : "0 18px 50px rgba(15, 23, 42, 0.12)",
                                }}
                            >
                                <VListSubheader>{t("Results")}</VListSubheader>

                                {filteredResult.value.map((r) => {
                                    return (
                                        <VListItem
                                            onClick={() => {
                                                router.push({
                                                    name: r.name,
                                                });
                                                search.value = "";
                                            }}
                                        >{`${t(r.section.title)}  ${t(r.label)}`}</VListItem>
                                    );
                                })}
                            </VList>
                        </VMenu>
                    </TextField>
                </ThemedView>
            </>
        );
    };
});

export default DashboardLayout;

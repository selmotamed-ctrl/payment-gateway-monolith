import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { RouterView, useRoute } from "vue-router";
import {
    VAppBar,
    VAvatar,
    VBtn,
    VChip,
    VDivider,
    VIcon,
    VList,
    VListItem,
    VListSubheader,
    VMain,
    VMenu,
    VNavigationDrawer,
    VTooltip,
} from "vuetify/components";
import { useDisplay, useLocale, useTheme } from "vuetify";
import LogoSvg from "@/assets/images/logo.svg";
import { logout, user } from "@/state/user";
import { toggleTheme } from "@/state/app/index";
import { setLocale } from "@/plugins/localization";
import { showSnackBar } from "@/utils/snackBar";
import { useSections } from "./sections";

const DefaultLayout = dc(() => {
    const { t, current: locale } = useLocale();
    const theme = useTheme();
    const display = useDisplay();
    const route = useRoute();
    const sections = useSections();
    const collapsedSections = ref<number[]>([]);

    const isSectionCollapsed = (index: number) => collapsedSections.value.includes(index);

    const toggleSection = (index: number) => {
        collapsedSections.value = isSectionCollapsed(index)
            ? collapsedSections.value.filter((entry) => entry !== index)
            : [...collapsedSections.value, index];
    };

    // A 280px permanent drawer needs room; below 960px it becomes temporary.
    const isCompact = computed(() => display.smAndDown.value);
    const drawerOpen = ref(!display.smAndDown.value);

    watch(
        () => isCompact.value,
        (compact) => {
            drawerOpen.value = !compact;
        },
    );

    // A temporary drawer must never survive a navigation.
    watch(
        () => route.fullPath,
        () => {
            if (isCompact.value) {
                drawerOpen.value = false;
            }
        },
    );

    const isDark = computed(() => theme.current.value.dark);
    const activeLabel = computed(() => {
        for (const section of sections.value) {
            for (const item of section.routes) {
                if (item.name === route.name) {
                    return item.label;
                }
            }
        }
        return "";
    });

    const displayName = computed(
        () => user.value?.userInfo?.name || user.value?.userInfo?.username || "User",
    );
    const role = computed(() => user.value?.userInfo?.role || "");
    const initial = computed(() => displayName.value.charAt(0).toUpperCase());

    return () => (
        <>
            <VAppBar flat height={64} color="surface" class="pg-app-bar">
                <VBtn
                    icon
                    variant="text"
                    aria-label={t("Toggle navigation")}
                    onClick={() => (drawerOpen.value = !drawerOpen.value)}
                >
                    <VIcon icon={drawerOpen.value ? "mdi-menu-open" : "mdi-menu"} />
                </VBtn>

                <div class="pg-app-bar__brand">
                    <img src={LogoSvg} alt="" width={26} height={26} />
                    <span class="pg-app-bar__title">{activeLabel.value || t("Payment Gateway")}</span>
                </div>

                <div class="pg-spacer" />

                <VTooltip text={isDark.value ? t("Light Mode") : t("Dark Mode")} location="bottom">
                    {{
                        activator: ({ props }: any) => (
                            <VBtn {...props} icon variant="text" aria-label={t("Toggle theme")} onClick={() => toggleTheme()}>
                                <VIcon icon={isDark.value ? "mdi-weather-sunny" : "mdi-weather-night"} />
                            </VBtn>
                        ),
                    }}
                </VTooltip>

                <VMenu location="bottom end">
                    {{
                        activator: ({ props }: any) => (
                            <VBtn {...props} icon variant="text" aria-label={t("Language")}>
                                <VIcon icon="mdi-translate" />
                            </VBtn>
                        ),
                        default: () => (
                            <VList density="compact" class="pg-menu">
                                <VListItem
                                    title="العربية"
                                    prependIcon="mdi-web"
                                    active={locale.value === "ar"}
                                    onClick={() => setLocale("ar")}
                                />
                                <VListItem
                                    title="English"
                                    prependIcon="mdi-web"
                                    active={locale.value === "en"}
                                    onClick={() => setLocale("en")}
                                />
                            </VList>
                        ),
                    }}
                </VMenu>

                <VMenu location="bottom end">
                    {{
                        activator: ({ props }: any) => (
                            <VBtn {...props} variant="text" rounded="pill" class="pg-user-btn" aria-label={t("Account")}>
                                <VAvatar size={30} class="pg-avatar">
                                    {initial.value}
                                </VAvatar>
                                <span class="pg-user-btn__name">{displayName.value}</span>
                            </VBtn>
                        ),
                        default: () => (
                            <VList density="compact" class="pg-menu">
                                <VListItem
                                    title={displayName.value}
                                    subtitle={role.value}
                                    prependIcon="mdi-account-circle-outline"
                                />
                                <VDivider />
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
            </VAppBar>

            <VNavigationDrawer
                modelValue={drawerOpen.value}
                onUpdate:modelValue={(value: boolean) => (drawerOpen.value = value)}
                permanent={!isCompact.value}
                temporary={isCompact.value}
                width={280}
                color="surface"
                class="pg-drawer"
            >
                <div class="pg-drawer__brand">
                    <img src={LogoSvg} alt="" width={38} height={38} />
                    <div class="pg-drawer__brand-text">
                        <span class="pg-drawer__title">{t("Payment Gateway")}</span>
                        <span class="pg-drawer__subtitle">{t("Merchant Portal")}</span>
                    </div>
                </div>
                <VDivider />

                <VList nav density="comfortable" class="pg-nav">
                    {sections.value.map((section, index) => {
                        const collapsed = isSectionCollapsed(index);
                        return (
                            <div key={`${section.title}-${index}`} class="pg-nav__group">
                                <div
                                    class="pg-nav__section-wrap"
                                    role="button"
                                    tabindex={0}
                                    aria-expanded={!collapsed}
                                    onClick={() => toggleSection(index)}
                                    onKeydown={(event: KeyboardEvent) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            toggleSection(index);
                                        }
                                    }}
                                >
                                    <VListSubheader
                                        class={["pg-nav__section", { "pg-nav__section--collapsed": collapsed }]}
                                    >
                                        <span class="pg-nav__section-title">{section.title}</span>
                                        <VIcon
                                            icon={collapsed ? "mdi-chevron-down" : "mdi-chevron-up"}
                                            size={18}
                                        />
                                    </VListSubheader>
                                </div>
                                {!collapsed &&
                                    section.routes.map((item) => (
                                        <VListItem
                                            key={item.name}
                                            to={{ name: item.name }}
                                            prependIcon={item.icon}
                                            title={item.label}
                                            rounded="lg"
                                            activeColor="primary"
                                        />
                                    ))}
                            </div>
                        );
                    })}
                </VList>

                <div class="pg-drawer__footer">
                    <VChip size="small" variant="tonal" color="primary" prependIcon="mdi-shield-account-outline">
                        {role.value || t("Operator")}
                    </VChip>
                </div>
            </VNavigationDrawer>

            <VMain class="pg-main">
                <RouterView />
            </VMain>
        </>
    );
});

export default DefaultLayout;

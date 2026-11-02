import { dc } from "kt-dc";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
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
    VProgressLinear,
    VTooltip,
} from "vuetify/components";
import { useDisplay, useLocale, useTheme } from "vuetify";
import LogoSvg from "@/assets/images/logo.svg";
import { logout, user } from "@/state/user";
import { routeLoading } from "@/state/route";
import { toggleTheme } from "@/state/app/index";
import { setLocale } from "@/plugins/localization";
import { showSnackBar } from "@/utils/snackBar";
import { GlobalGuideSearchModal } from "@/components/guide/GlobalGuideSearchModal";
import { ContextualHelpDrawer } from "@/components/guide/ContextualHelpDrawer";
import { useSections } from "./sections";

const DefaultLayout = dc(() => {
    const { t, current: locale } = useLocale();
    const theme = useTheme();
    const display = useDisplay();
    const route = useRoute();
    const router = useRouter();
    const sections = useSections();
    const guideSearchOpen = ref(false);
    const helpDrawerOpen = ref(false);
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
            void nextTick(() => {
                const main = document.getElementById("pg-main-content");
                main?.focus({ preventScroll: true });
            });
        },
    );

    const isDark = computed(() => theme.current.value.dark);
    const activeLabel = computed(() => {
        const targetName = route.meta.parentName ?? route.name;
        for (const section of sections.value) {
            for (const item of section.routes) {
                if (item.name === targetName) {
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

    const onGlobalKeydown = (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            guideSearchOpen.value = true;
        }
        if (event.key === "Escape") {
            guideSearchOpen.value = false;
        }
        const target = event.target as HTMLElement | null;
        const typing =
            target?.tagName === "INPUT" ||
            target?.tagName === "TEXTAREA" ||
            target?.tagName === "SELECT" ||
            target?.isContentEditable === true;
        if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === "?") {
            event.preventDefault();
            helpDrawerOpen.value = true;
        }
    };

    onMounted(() => window.addEventListener("keydown", onGlobalKeydown));
    onBeforeUnmount(() => window.removeEventListener("keydown", onGlobalKeydown));

    return () => (
        <>
            <a
                href="#pg-main-content"
                class="pg-skip-link"
                onClick={(event: MouseEvent) => {
                    event.preventDefault();
                    const main = document.getElementById("pg-main-content");
                    main?.focus();
                    main?.scrollIntoView({ block: "start" });
                }}
            >
                {t("Skip to content")}
            </a>
            <VAppBar flat height={64} color="surface" class="pg-app-bar">
                <VBtn
                    icon
                    variant="text"
                    aria-label={t("Toggle navigation")}
                    aria-expanded={drawerOpen.value ? "true" : "false"}
                    aria-controls="pg-navigation-drawer"
                    onClick={() => (drawerOpen.value = !drawerOpen.value)}
                >
                    <VIcon icon={drawerOpen.value ? "mdi-menu-open" : "mdi-menu"} />
                </VBtn>

                <div class="pg-app-bar__brand">
                    <img src={LogoSvg} alt="" width={26} height={26} />
                    <span class="pg-app-bar__title">{activeLabel.value || t("Payment Gateway")}</span>
                </div>

                <div class="pg-spacer" />

                <VBtn
                    icon
                    variant="text"
                    aria-label={t("Instant guide search (Ctrl+K)")}
                    onClick={() => (guideSearchOpen.value = true)}
                >
                    <VIcon icon="mdi-magnify" />
                </VBtn>

                <VBtn
                    variant="text"
                    prependIcon="mdi-help-circle-outline"
                    class="pg-help-btn"
                    aria-label={t("Help & SOP")}
                    onClick={() => (helpDrawerOpen.value = true)}
                >
                    {t("Help & SOP (?)")}
                </VBtn>

                <VTooltip text={isDark.value ? t("Light Mode") : t("Dark Mode")} location="bottom">
                    {{
                        activator: ({ props }: any) => (
                            <VBtn
                                {...props}
                                icon
                                variant="text"
                                {...{
                                    "aria-label": isDark.value ? t("Switch to light mode") : t("Switch to dark mode"),
                                    "aria-pressed": isDark.value ? "true" : "false",
                                }}
                                onClick={() => toggleTheme()}
                            >
                                <VIcon icon={isDark.value ? "mdi-weather-sunny" : "mdi-weather-night"} />
                            </VBtn>
                        ),
                    }}
                </VTooltip>

                <VMenu location="bottom end">
                    {{
                        activator: ({ props }: any) => (
                            <VBtn
                                {...props}
                                icon
                                variant="text"
                                {...{
                                    "aria-label": `${t("Language")}: ${locale.value === "ar" ? "العربية" : "English"}`,
                                    "aria-haspopup": "menu",
                                }}
                            >
                                <VIcon icon="mdi-translate" />
                            </VBtn>
                        ),
                        default: () => (
                            <VList density="compact" class="pg-menu" {...{ role: "menu" }}>
                                <VListItem
                                    title="العربية"
                                    prependIcon={locale.value === "ar" ? "mdi-check" : "mdi-web"}
                                    active={locale.value === "ar"}
                                    {...{ role: "menuitemradio", "aria-checked": locale.value === "ar" ? "true" : "false" }}
                                    onClick={() => setLocale("ar")}
                                />
                                <VListItem
                                    title="English"
                                    prependIcon={locale.value === "en" ? "mdi-check" : "mdi-web"}
                                    active={locale.value === "en"}
                                    {...{ role: "menuitemradio", "aria-checked": locale.value === "en" ? "true" : "false" }}
                                    onClick={() => setLocale("en")}
                                />
                            </VList>
                        ),
                    }}
                </VMenu>

                <VMenu location="bottom end">
                    {{
                        activator: ({ props }: any) => (
                            <VBtn {...props} variant="text" rounded="pill" class="pg-user-btn" aria-label={t("Account")} aria-haspopup="menu">
                                <VAvatar size={30} class="pg-avatar">
                                    {initial.value}
                                </VAvatar>
                                <span class="pg-user-btn__name">{displayName.value}</span>
                            </VBtn>
                        ),
                        default: () => (
                            <VList density="compact" class="pg-menu" {...{ role: "menu" }}>
                                <VListItem
                                    title={displayName.value}
                                    subtitle={role.value}
                                    prependIcon="mdi-account-circle-outline"
                                />
                                <VDivider />
                                <VListItem
                                    title={t("Logout")}
                                    prependIcon="mdi-logout"
                                    {...{ role: "menuitem" }}
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
                {...{ id: "pg-navigation-drawer" }}
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
                        <span class="pg-drawer__subtitle">{t("Admin Back Office")}</span>
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
                                            active={route.name === item.name || route.meta.parentName === item.name}
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

            {routeLoading.value && (
                <div class="pg-route-progress" role="status" aria-live="polite" aria-label={t("Loading page")}>
                    <VProgressLinear indeterminate color="primary" height={3} aria-hidden="true" />
                </div>
            )}
            <VMain
                class="pg-main"
                {...{ id: "pg-main-content", tabindex: "-1", "aria-busy": routeLoading.value ? "true" : "false" }}
            >
                <RouterView />
            </VMain>

            <GlobalGuideSearchModal
                modelValue={guideSearchOpen.value}
                onUpdate:modelValue={(value: boolean) => (guideSearchOpen.value = value)}
                onSelect={(entry: any) => {
                    guideSearchOpen.value = false;
                    void router.push({ name: "AdminGuide", query: { entry: entry.id } });
                }}
            />

            <ContextualHelpDrawer
                modelValue={helpDrawerOpen.value}
                routeName={String(route.meta.parentName ?? route.name ?? "")}
                onUpdate:modelValue={(value: boolean) => (helpDrawerOpen.value = value)}
                onOpenFullGuide={() => {
                    helpDrawerOpen.value = false;
                    void router.push({ name: "AdminGuide" });
                }}
            />
        </>
    );
});

export default DefaultLayout;

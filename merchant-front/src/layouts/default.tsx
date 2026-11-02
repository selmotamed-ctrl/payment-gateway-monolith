import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import {
    VAppBar,
    VAvatar,
    VBtn,
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
import { StatusBadge } from "@/components/ui/StatusBadge";

const DefaultLayout = dc(() => {
    const { t, current: locale } = useLocale();
    const theme = useTheme();
    const display = useDisplay();
    const route = useRoute();
    const router = useRouter();
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
    const isMaker = computed(() => Boolean(user.value?.userInfo?.isMaker));
    const isChecker = computed(() => Boolean(user.value?.userInfo?.isChecker));
    const breadcrumbs = computed(() => {
        const list: { label: string; to?: string }[] = [{ label: t("Payment Gateway"), to: "/portal" }];
        const parentName = route.meta.parentName ? String(route.meta.parentName) : "";
        if (parentName) {
            for (const section of sections.value) {
                const parent = section.routes.find((item) => item.name === parentName);
                if (parent) {
                    list.push({ label: parent.label });
                    break;
                }
            }
        }
        if (activeLabel.value && list[list.length - 1]?.label !== activeLabel.value) {
            list.push({ label: activeLabel.value });
        }
        return list;
    });

    return () => (
        <>
            <VAppBar flat height={56} color="surface" class="pg-app-bar">
                <VBtn
                    icon
                    variant="text"
                    aria-label={t("Toggle navigation")}
                    onClick={() => (drawerOpen.value = !drawerOpen.value)}
                >
                    <VIcon icon={drawerOpen.value ? "mdi-menu-open" : "mdi-menu"} />
                </VBtn>

                <div class="pg-app-bar__brand">
                    <img src={LogoSvg} alt="" width={24} height={24} />
                    <span class="pg-app-bar__title">{activeLabel.value || t("Payment Gateway")}</span>
                </div>

                <nav class="pg-breadcrumb" aria-label={t("Breadcrumb")}>
                    {breadcrumbs.value.map((crumb, idx) => (
                        <span key={`${crumb.label}-${idx}`} class="pg-breadcrumb__item">
                            {idx > 0 && <span class="pg-breadcrumb__sep">/</span>}
                            <span>{crumb.label}</span>
                        </span>
                    ))}
                </nav>

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
                width={248}
                color="surface"
                class="pg-drawer"
            >
                <div class="pg-drawer__brand">
                    <div class="pg-drawer__brand-mark">
                        <img src={LogoSvg} alt="" width={18} height={18} />
                    </div>
                    <div class="pg-drawer__brand-text">
                        <span class="pg-drawer__title">{t("Payment Gateway")}</span>
                        <span class="pg-drawer__subtitle">{t("Merchant Portal")}</span>
                    </div>
                    <StatusBadge status="LIVE" label="LIVE" toneOverride="success" showDot={false} />
                </div>
                <div class="pg-drawer__search">
                    <button type="button" class="pg-search-pill" onClick={() => void router.push({ name: "MerchantGuide" })}>
                        <VIcon icon="mdi-magnify" size={16} />
                        <span class="pg-search-pill__label">{t("Search guide, rails, cases…")}</span>
                        <span class="pg-search-pill__kbd">?</span>
                    </button>
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
                                            rounded="md"
                                            class={["pg-nav-item", route.name === item.name ? "pg-keycap-active" : ""]}
                                            active={route.name === item.name}
                                        />
                                    ))}
                            </div>
                        );
                    })}
                </VList>

                <div class="pg-drawer__footer">
                    <div class="pg-operator-card">
                        <div class="pg-operator-card__avatar">{initial.value}</div>
                        <div class="pg-operator-card__identity">
                            <span class="pg-operator-card__name">{displayName.value}</span>
                            <span class="pg-operator-card__email">
                                {user.value?.userInfo?.email || user.value?.userInfo?.phone || role.value || t("Merchant")}
                            </span>
                            <div class="pg-operator-card__meta">
                                <StatusBadge status={role.value || "MERCHANT"} label={role.value || t("Merchant")} />
                                <span class="pg-operator-card__dot" title={t("Maker")} style={{ opacity: isMaker.value ? 1 : 0.25 }} />
                                <span class="pg-operator-card__dot pg-operator-card__dot--checker" title={t("Checker")} style={{ opacity: isChecker.value ? 1 : 0.25 }} />
                            </div>
                        </div>
                        <VBtn
                            icon="mdi-logout"
                            variant="text"
                            size="x-small"
                            aria-label={t("Logout")}
                            onClick={() => {
                                showSnackBar({ type: "primary", message: t("Logout") });
                                void logout();
                            }}
                        />
                    </div>
                </div>
            </VNavigationDrawer>

            <VMain class="pg-main">
                <RouterView />
            </VMain>
        </>
    );
});

export default DefaultLayout;

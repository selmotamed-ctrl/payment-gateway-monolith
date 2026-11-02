import { dc } from "kt-dc";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
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
    VProgressLinear,
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
import {
    GlobalGuideSearchModal,
    type MerchantGuideSearchEntry,
} from "@/components/guide/GlobalGuideSearchModal";
import { ContextualHelpDrawer } from "@/components/guide/ContextualHelpDrawer";

const DefaultLayout = dc(() => {
    const { t, current: locale } = useLocale();
    const theme = useTheme();
    const display = useDisplay();
    const route = useRoute();
    const router = useRouter();
    const sections = useSections();
    const guideSearchOpen = ref(false);
    const helpDrawerOpen = ref(false);
    const routeLoading = ref(false);
    const collapsedSections = ref<number[]>([]);

    let removeBeforeEach: (() => void) | undefined;
    let removeAfterEach: (() => void) | undefined;
    let removeErrorHandler: (() => void) | undefined;

    const isSectionCollapsed = (index: number) => collapsedSections.value.includes(index);

    const toggleSection = (index: number) => {
        collapsedSections.value = isSectionCollapsed(index)
            ? collapsedSections.value.filter((entry) => entry !== index)
            : [...collapsedSections.value, index];
    };

    const isCompact = computed(() => display.smAndDown.value);
    const drawerOpen = ref(!display.smAndDown.value);

    watch(
        () => isCompact.value,
        (compact) => {
            drawerOpen.value = !compact;
        },
    );

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

    const navItems = computed(() => sections.value.flatMap((section) => section.routes));
    const findNavItem = (name: unknown) => navItems.value.find((item) => item.name === String(name ?? ""));

    const activeNavItem = computed(() => {
        const parentName = route.meta.parentName ? String(route.meta.parentName) : "";
        if (parentName) {
            const parent = findNavItem(parentName);
            if (parent) {
                return parent;
            }
        }
        const exact = findNavItem(route.name);
        if (exact) {
            return exact;
        }
        let best: (typeof navItems.value)[number] | undefined;
        let bestLength = -1;
        for (const item of navItems.value) {
            const path = router.resolve({ name: item.name }).path.replace(/\/+$/, "");
            if (route.path === path || route.path.startsWith(`${path}/`)) {
                if (path.length > bestLength) {
                    best = item;
                    bestLength = path.length;
                }
            }
        }
        return best;
    });

    const routeTitle = computed(() => {
        const exact = findNavItem(route.name);
        if (exact) {
            return exact.label;
        }
        if (route.name === "PosScreen") {
            return t("POS Screen");
        }
        return "";
    });

    const activeLabel = computed(() => activeNavItem.value?.label ?? "");

    const isDark = computed(() => theme.current.value.dark);
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
            const parent = findNavItem(parentName);
            if (parent) {
                list.push({ label: parent.label, to: router.resolve({ name: parent.name }).path });
            }
        } else if (activeNavItem.value && activeNavItem.value.name !== route.name) {
            list.push({
                label: activeNavItem.value.label,
                to: router.resolve({ name: activeNavItem.value.name }).path,
            });
        }
        const current = routeTitle.value || activeLabel.value;
        if (current && list[list.length - 1]?.label !== current) {
            list.push({ label: current });
        }
        return list;
    });

    const openGuideSearchEntry = (entry: MerchantGuideSearchEntry) => {
        guideSearchOpen.value = false;
        void router.push({ name: entry.routeName, query: { chapter: entry.id } });
    };

    const openFullGuide = () => {
        helpDrawerOpen.value = false;
        const developerRoute = route.name === "DeveloperTokens" || route.name === "MerchantDeveloperGuide";
        void router.push({ name: developerRoute ? "MerchantDeveloperGuide" : "MerchantGuide" });
    };

    const onGlobalKeydown = (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            guideSearchOpen.value = true;
        }
        if (event.key === "Escape") {
            guideSearchOpen.value = false;
            helpDrawerOpen.value = false;
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

    onMounted(() => {
        window.addEventListener("keydown", onGlobalKeydown);
        removeBeforeEach = router.beforeEach(() => {
            routeLoading.value = true;
            return true;
        });
        removeAfterEach = router.afterEach(() => {
            routeLoading.value = false;
        });
        removeErrorHandler = router.onError(() => {
            routeLoading.value = false;
        });
    });

    onBeforeUnmount(() => {
        window.removeEventListener("keydown", onGlobalKeydown);
        removeBeforeEach?.();
        removeAfterEach?.();
        removeErrorHandler?.();
    });

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
            <VAppBar flat height={56} color="surface" class="pg-app-bar">
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
                    <img src={LogoSvg} alt="" width={24} height={24} />
                    <span class="pg-app-bar__title">
                        {routeTitle.value || activeLabel.value || t("Payment Gateway")}
                    </span>
                </div>

                <nav class="pg-breadcrumb" aria-label={t("Breadcrumb")}>
                    {breadcrumbs.value.map((crumb, idx) => (
                        <span key={`${crumb.label}-${idx}`} class="pg-breadcrumb__item">
                            {idx > 0 && <span class="pg-breadcrumb__sep">/</span>}
                            {crumb.to ? (
                                <RouterLink to={crumb.to}>{crumb.label}</RouterLink>
                            ) : (
                                <span aria-current={idx === breadcrumbs.value.length - 1 ? "page" : undefined}>
                                    {crumb.label}
                                </span>
                            )}
                        </span>
                    ))}
                </nav>

                <div class="pg-spacer" />

                <VBtn
                    icon
                    variant="text"
                    size="small"
                    style={{ width: "32px", height: "32px" }}
                    aria-label={t("Search guide, rails, cases…")}
                    onClick={() => (guideSearchOpen.value = true)}
                >
                    <VIcon icon="mdi-magnify" />
                </VBtn>

                <VBtn
                    variant="text"
                    size="small"
                    prependIcon="mdi-help-circle-outline"
                    class="pg-help-btn"
                    style={{ height: "32px" }}
                    aria-label={t("SOP & Help")}
                    onClick={() => (helpDrawerOpen.value = true)}
                >
                    <span class="pg-help-btn__label">{t("SOP & Help")}</span>
                </VBtn>

                <VTooltip text={isDark.value ? t("Light Mode") : t("Dark Mode")} location="bottom">
                    {{
                        activator: ({ props }: any) => (
                            <VBtn
                                {...props}
                                icon
                                variant="text"
                                size="small"
                                style={{ width: "32px", height: "32px" }}
                                {...{
                                    "aria-label": t("Toggle theme"),
                                    "aria-pressed": isDark.value ? "true" : "false",
                                }}
                                onClick={() => toggleTheme()}
                            >
                                <VIcon icon={isDark.value ? "mdi-weather-sunny" : "mdi-weather-night"} />
                            </VBtn>
                        ),
                    }}
                </VTooltip>

                <div
                    role="group"
                    aria-label={t("Language")}
                    style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}
                >
                    <VBtn
                        size="small"
                        variant="text"
                        style={{
                            width: "32px",
                            minWidth: "32px",
                            height: "32px",
                            padding: 0,
                            backgroundColor:
                                locale.value === "ar" ? "var(--pg-bg-surface-subtle)" : "transparent",
                        }}
                        aria-label="العربية"
                        aria-pressed={locale.value === "ar" ? "true" : "false"}
                        onClick={() => setLocale("ar")}
                    >
                        AR
                    </VBtn>
                    <VBtn
                        size="small"
                        variant="text"
                        style={{
                            width: "32px",
                            minWidth: "32px",
                            height: "32px",
                            padding: 0,
                            backgroundColor:
                                locale.value === "en" ? "var(--pg-bg-surface-subtle)" : "transparent",
                        }}
                        aria-label="English"
                        aria-pressed={locale.value === "en" ? "true" : "false"}
                        onClick={() => setLocale("en")}
                    >
                        EN
                    </VBtn>
                </div>

                <VMenu location="bottom end">
                    {{
                        activator: ({ props }: any) => (
                            <VBtn
                                {...props}
                                variant="text"
                                rounded="pill"
                                class="pg-user-btn"
                                aria-label={t("Account")}
                                aria-haspopup="menu"
                            >
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
                    <button type="button" class="pg-search-pill" onClick={() => (guideSearchOpen.value = true)}>
                        <VIcon icon="mdi-magnify" size={16} />
                        <span class="pg-search-pill__label">{t("Search guide, rails, cases…")}</span>
                        <span class="pg-search-pill__kbd">Ctrl K</span>
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
                                            class={[
                                                "pg-nav-item",
                                                activeNavItem.value?.name === item.name ? "pg-keycap-active" : "",
                                            ]}
                                            active={activeNavItem.value?.name === item.name}
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

            {routeLoading.value && (
                <div class="pg-route-progress" role="status" aria-live="polite" aria-label={t("Loading")}>
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
                onSelect={openGuideSearchEntry}
            />

            <ContextualHelpDrawer
                modelValue={helpDrawerOpen.value}
                routeName={String(route.meta.parentName ?? route.name ?? "")}
                onUpdate:modelValue={(value: boolean) => (helpDrawerOpen.value = value)}
                onOpenFullGuide={openFullGuide}
            />
        </>
    );
});

export default DefaultLayout;

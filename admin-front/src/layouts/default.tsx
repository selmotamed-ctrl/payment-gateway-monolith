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
import { hasOneOfAuthorities, logout, user } from "@/state/user";
import { routeLoading } from "@/state/route";
import { toggleTheme } from "@/state/app/index";
import { setLocale } from "@/plugins/localization";
import { showSnackBar } from "@/utils/snackBar";
import { GlobalGuideSearchModal } from "@/components/guide/GlobalGuideSearchModal";
import { GlobalSearchPalette } from "@/components/search/GlobalSearchPalette";
import { clearGlobalSearchCache } from "@/components/search/api";
import type { NavigationSectionItem } from "@/components/search/localCommands";
import { searchGuide } from "@/content/guide/search";
import { ContextualHelpDrawer } from "@/components/guide/ContextualHelpDrawer";
import { routesAuthorities, routesRoles, useSections } from "./sections";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";

const DefaultLayout = dc(() => {
    const { t, current: locale } = useLocale();
    const theme = useTheme();
    const display = useDisplay();
    const route = useRoute();
    const router = useRouter();
    const sections = useSections();
    const guideSearchOpen = ref(false);
    const globalSearchOpen = ref(false);
    const globalSearchFocusSignal = ref(0);
    const globalSearchTrigger = ref<HTMLButtonElement | null>(null);
    const isMacPlatform = /Mac|iPhone|iPad/i.test(navigator.platform || "");
    const searchShortcutLabel = isMacPlatform ? "⌘ K" : "Ctrl K";
    const searchShortcutAria = isMacPlatform ? "⌘K" : "Ctrl+K";
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
    const isMaker = computed(() => Boolean(user.value?.userInfo?.isMaker));
    const isChecker = computed(() => Boolean(user.value?.userInfo?.isChecker));
    const canViewLedger = computed(() => hasOneOfAuthorities(["profit.read", "liquidity.read"]));
    const navigationItems = computed<NavigationSectionItem[]>(() =>
        sections.value.map((section) => ({
            title: section.title,
            routes: section.routes.map((item) => ({
                title: item.label,
                routeName: item.name,
                icon: item.icon,
                sectionTitle: section.title,
            })),
        })),
    );
    const searchAccessContext = computed(() => ({
        role: String(user.value?.userInfo?.role ?? ""),
        authorities: new Set(
            Object.entries(user.value?.userInfo?.authoritiesMap ?? {})
                .filter(([, enabled]) => enabled === true)
                .map(([authority]) => authority),
        ),
        visibleRouteNames: new Set(
            sections.value.flatMap((section) => section.routes.map((item) => item.name)),
        ),
        routesAuthorities: routesAuthorities as unknown as Record<string, readonly string[] | null | undefined>,
        routesRoles: routesRoles as unknown as Record<string, readonly string[] | null | undefined>,
    }));
    const openGlobalSearch = () => {
        if (globalSearchOpen.value) {
            globalSearchFocusSignal.value += 1;
            return;
        }
        globalSearchOpen.value = true;
    };
    const ledgerInvariant = ref<{ drift: string; currency: string; ok: boolean } | null>(null);
    let invariantTimer: ReturnType<typeof setInterval> | undefined;

    const loadLedgerInvariant = async () => {
        if (!canViewLedger.value) return;
        try {
            const response = await api.get(urlsMap.financeInvariantCheck);
            const data = response.data?.data ?? response.data ?? {};
            ledgerInvariant.value = {
                drift: String(data.drift ?? "0"),
                currency: String(data.currency ?? "LYD"),
                ok: data.ok !== false,
            };
        } catch {
            ledgerInvariant.value = null;
        }
    };

    const breadcrumbs = computed(() => {
        const list: { label: string; to?: string }[] = [{ label: t("Payment Gateway"), to: "/" }];
        const parentName = route.meta.parentName ? String(route.meta.parentName) : "";
        if (parentName) {
            for (const section of sections.value) {
                const parent = section.routes.find((item) => item.name === parentName);
                if (parent) {
                    list.push({ label: parent.label, to: `/` });
                    break;
                }
            }
        }
        if (activeLabel.value && list[list.length - 1]?.label !== activeLabel.value) {
            list.push({ label: activeLabel.value });
        }
        return list;
    });

    const onGlobalKeydown = (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            openGlobalSearch();
        }
        if (event.key === "Escape") {
            if (globalSearchOpen.value) {
                globalSearchOpen.value = false;
            } else if (guideSearchOpen.value) {
                guideSearchOpen.value = false;
            } else if (helpDrawerOpen.value) {
                helpDrawerOpen.value = false;
            }
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
        clearGlobalSearchCache();
        window.addEventListener("keydown", onGlobalKeydown);
        void loadLedgerInvariant();
        invariantTimer = setInterval(() => void loadLedgerInvariant(), 60_000);
    });
    onBeforeUnmount(() => {
        window.removeEventListener("keydown", onGlobalKeydown);
        if (invariantTimer) clearInterval(invariantTimer);
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
                    <span class="pg-app-bar__title">{activeLabel.value || t("Payment Gateway")}</span>
                </div>

                <nav class="pg-breadcrumb" aria-label={t("Breadcrumb")}>
                    {breadcrumbs.value.map((crumb, idx) => (
                        <span key={`${crumb.label}-${idx}`} class="pg-breadcrumb__item">
                            {idx > 0 && <span class="pg-breadcrumb__sep">/</span>}
                            {crumb.to ? <RouterLink to={crumb.to}>{crumb.label}</RouterLink> : <span>{crumb.label}</span>}
                        </span>
                    ))}
                </nav>

                <div class="pg-spacer" />

                {ledgerInvariant.value && (
                    <RouterLink
                        to="/finance/liquidity"
                        class="pg-invariant-pill"
                        title={t("Live ledger invariant drift")}
                    >
                        <span
                            class="pg-invariant-pill__dot"
                            style={{ background: ledgerInvariant.value.ok ? "var(--pg-status-success-dot)" : "var(--pg-status-danger-dot)" }}
                        />
                        <MoneyDisplay
                            amount={ledgerInvariant.value.drift}
                            currency={ledgerInvariant.value.currency}
                            size="sm"
                        />
                        <span>{t("Drift")}</span>
                    </RouterLink>
                )}

                <button
                    ref={globalSearchTrigger}
                    type="button"
                    class="pg-global-search-trigger"
                    aria-label={`${t("Search everything")} (${searchShortcutAria})`}
                    onClick={openGlobalSearch}
                >
                    <VIcon icon="mdi-magnify" size={18} />
                    <span class="pg-global-search-trigger__label">{t("Search everything…")}</span>
                    <kbd class="pg-command-kbd">{searchShortcutLabel}</kbd>
                </button>

                <VBtn
                    variant="text"
                    prependIcon="mdi-help-circle-outline"
                    class="pg-help-btn"
                    aria-label={t("Help & SOP")}
                    onClick={() => (helpDrawerOpen.value = true)}
                >
                    <span class="pg-help-btn__label">{t("Help & SOP (?)")}</span>
                </VBtn>

                <VTooltip text={isDark.value ? t("Light Mode") : t("Dark Mode")} location="bottom">
                    {{
                        activator: ({ props }: any) => (
                            <VBtn
                                {...props}
                                icon
                                variant="text"
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
                        <span class="pg-drawer__subtitle">{t("Admin Back Office")}</span>
                    </div>
                    <StatusBadge status="LAN" label="LAN" toneOverride="neutral" showDot={false} />
                </div>
                <div class="pg-drawer__search">
                    <button type="button" class="pg-search-pill" onClick={() => (guideSearchOpen.value = true)}>
                        <VIcon icon="mdi-book-search-outline" size={16} />
                        <span class="pg-search-pill__label">{t("Search guide…")}</span>
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
                                                route.name === item.name || route.meta.parentName === item.name
                                                    ? "pg-keycap-active"
                                                    : "",
                                            ]}
                                            active={route.name === item.name || route.meta.parentName === item.name}
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
                                {user.value?.userInfo?.email || user.value?.userInfo?.phone || role.value || t("Operator")}
                            </span>
                            <div class="pg-operator-card__meta">
                                <StatusBadge status={role.value || "OPERATOR"} label={role.value || t("Operator")} />
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

            <GlobalSearchPalette
                modelValue={globalSearchOpen.value}
                onUpdate:modelValue={(value: boolean) => (globalSearchOpen.value = value)}
                locale={locale.value === "ar" ? "ar" : "en"}
                accessContext={searchAccessContext.value}
                navigationItems={navigationItems.value}
                searchGuideFn={(query: string) => searchGuide(query, 5)}
                triggerElement={globalSearchTrigger.value}
                focusSignal={globalSearchFocusSignal.value}
            />

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

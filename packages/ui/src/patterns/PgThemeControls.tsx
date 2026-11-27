import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { dc } from "../lib/dc";
import { currentLocale, setLocale, useLocale } from "../lib/locale";
import { setThemeMode, themeMode, type ThemeMode } from "../lib/theme";
import { PgButton } from "../actions/PgButton";
import { PgIcon } from "../actions/PgIcon";
import { PgMenu } from "../overlays/PgMenu";

type ThemeOption = { mode: ThemeMode; icon: string; labelKey: string };

const THEME_OPTIONS = (): ThemeOption[] => [
    { mode: "system", icon: "mdi-theme-light-dark", labelKey: "System" },
    { mode: "light", icon: "mdi-weather-sunny", labelKey: "Light" },
    { mode: "dark", icon: "mdi-weather-night", labelKey: "Dark" },
];

const LANGUAGE_OPTIONS = [
    { code: "en" as const, label: "English", icon: "mdi-alpha-e" },
    { code: "ar" as const, label: "العربية", icon: "mdi-alpha-a" },
];

const themeIcon = (mode: ThemeMode): string =>
    mode === "system" ? "mdi-theme-light-dark" : mode === "dark" ? "mdi-weather-night" : "mdi-weather-sunny";

/**
 * Explicit System / Light / Dark menu used in every portal header. Renders on
 * top of `PgMenu`'s activator slot and exposes `menuitemradio` options.
 */
export const PgThemeMenu = dc(
    (
        props: {
            variant?: string;
            size?: string;
            iconSize?: number | string;
            compact?: boolean;
            buttonClass?: string;
            modelValue?: boolean;
        },
        _expose,
        { attrs, emit },
    ) => {
        const { t } = useLocale();
        const internal = ref(false);
        const isOpen = () => (props.modelValue === undefined ? internal.value : Boolean(props.modelValue));
        const setOpen = (value: boolean) => {
            internal.value = value;
            emit?.("update:modelValue", value);
        };
        const options = computed(THEME_OPTIONS);
        const activeIcon = computed(() => themeIcon(themeMode.value));
        const choose = (mode: ThemeMode) => {
            setThemeMode(mode);
            emit?.("themeChange", mode);
            setOpen(false);
        };

        return () => (
            <PgMenu modelValue={isOpen()} onUpdate:modelValue={(value: boolean) => setOpen(value)} location="bottom end">
                {{
                    activator: (slotProps: any) => (
                        <PgButton
                            {...(slotProps?.props ?? {})}
                            {...attrs}
                            icon
                            variant={props.variant || "text"}
                            size={props.size || "sm"}
                            class={[
                                "pg-theme-trigger",
                                props.compact ? "pg-theme-trigger--compact" : "",
                                props.buttonClass,
                                attrs.class,
                            ]
                                .filter(Boolean)
                                .join(" ")}
                            ariaLabel={t("Theme")}
                            title={t("Theme")}
                            aria-haspopup="menu"
                            data-pg-theme-trigger
                        >
                            <PgIcon icon={activeIcon.value} size={props.iconSize ?? (props.compact ? 18 : 20)} />
                        </PgButton>
                    ),
                    default: () => (
                        <div class="pg-theme-menu pg-menu-list" role="none">
                            {options.value.map((option) => {
                                return (
                                    <button
                                        key={option.mode}
                                        type="button"
                                        role="menuitemradio"
                                        aria-checked={themeMode.value === option.mode ? "true" : "false"}
                                        class="pg-menu-item"
                                        data-theme-option={option.mode}
                                        onClick={() => choose(option.mode)}
                                    >
                                        <PgIcon icon={option.icon} size={17} />
                                        <span class="pg-menu-item__label">{t(option.labelKey)}</span>
                                        {themeMode.value === option.mode ? (
                                            <PgIcon icon="mdi-check" size={16} class="pg-menu-item__check" />
                                        ) : null}
                                    </button>
                                );
                            })}
                        </div>
                    ),
                }}
            </PgMenu>
        );
    },
    {
        props: {
            variant: { type: String, default: "text" },
            size: { type: String, default: "sm" },
            iconSize: { type: [Number, String], default: 20 },
            compact: { type: Boolean, default: false },
            buttonClass: { type: String, default: "" },
            modelValue: { type: Boolean, default: undefined },
        },
        emits: ["update:modelValue", "themeChange"],
        inheritAttrs: true,
    },
);

export const ThemeMenu = PgThemeMenu;

/**
 * Language + theme cluster for app bars and public auth screens.
 *
 * Language selection goes through `setLocale()` (persists `locale-name` and
 * flips `<html lang|dir>`) and also updates the host `vue-i18n` instance when
 * one is installed. Theme selection goes through `setThemeMode()`.
 */
export const PgThemeLanguageControls = dc(
    (
        props: {
            variant?: string;
            size?: string;
            compact?: boolean;
            showLanguage?: boolean;
            showTheme?: boolean;
            iconSize?: number | string;
        },
        _expose,
        { attrs, emit },
    ) => {
        let i18n: { locale: { value: string } } | null = null;
        try {
            i18n = useI18n({ useScope: "global" }) as unknown as { locale: { value: string } };
        } catch {
            i18n = null;
        }
        const { t } = useLocale();
        const languageOpen = ref(false);
        const themeOpen = ref(false);
        const current = computed(() => (i18n ? String(i18n.locale.value) : currentLocale.value));
        const triggerSize = computed(() => props.size || (props.compact ? "sm" : "md"));

        const chooseLocale = (locale: "en" | "ar") => {
            setLocale(locale);
            if (i18n && String(i18n.locale.value) !== locale) i18n.locale.value = locale;
            currentLocale.value = locale;
            emit?.("localeChange", locale);
            languageOpen.value = false;
        };

        return () => (
            <div
                {...attrs}
                class={["pg-theme-language", props.compact ? "pg-theme-language--compact" : "", attrs.class]
                    .filter(Boolean)
                    .join(" ")}
                data-pg-theme-language
            >
                {props.showLanguage === false ? null : (
                    <PgMenu
                        modelValue={languageOpen.value}
                        onUpdate:modelValue={(value: boolean) => {
                            languageOpen.value = value;
                            if (value) themeOpen.value = false;
                        }}
                        location="bottom end"
                    >
                        {{
                            activator: (slotProps: any) => (
                                <PgButton
                                    {...(slotProps?.props ?? {})}
                                    icon
                                    variant={props.variant || "outlined"}
                                    size={triggerSize.value}
                                    class={["pg-theme-trigger", props.compact ? "pg-theme-trigger--compact" : ""]
                                        .filter(Boolean)
                                        .join(" ")}
                                    ariaLabel={t("Language")}
                                    title={t("Language")}
                                    aria-haspopup="menu"
                                    data-pg-language-trigger
                                >
                                    {props.compact ? (
                                        <span class="pg-theme-trigger__code" dir="ltr">
                                            {current.value === "ar" ? "ع" : "EN"}
                                        </span>
                                    ) : (
                                        <PgIcon icon="mdi-translate" size={props.iconSize ?? 19} />
                                    )}
                                </PgButton>
                            ),
                            default: () => (
                                <div class="pg-menu-list" role="none">
                                    {LANGUAGE_OPTIONS.map((language) => {
                                        return (
                                            <button
                                                key={language.code}
                                                type="button"
                                                role="menuitemradio"
                                                aria-checked={current.value === language.code ? "true" : "false"}
                                                class="pg-menu-item"
                                                data-locale-option={language.code}
                                                onClick={() => chooseLocale(language.code)}
                                            >
                                                <PgIcon icon={language.icon} size={17} />
                                                <span class="pg-menu-item__label">{language.label}</span>
                                                {current.value === language.code ? (
                                                    <PgIcon icon="mdi-check" size={16} class="pg-menu-item__check" />
                                                ) : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            ),
                        }}
                    </PgMenu>
                )}
                {props.showTheme === false ? null : (
                    <PgThemeMenu
                        variant={props.variant || "outlined"}
                        size={triggerSize.value}
                        compact={props.compact}
                        iconSize={props.iconSize}
                        modelValue={themeOpen.value}
                        onUpdate:modelValue={(value: boolean) => {
                            themeOpen.value = value;
                            if (value) languageOpen.value = false;
                        }}
                        onThemeChange={(mode: ThemeMode) => emit?.("themeChange", mode)}
                    />
                )}
            </div>
        );
    },
    {
        props: {
            variant: { type: String, default: "outlined" },
            size: { type: String, default: "" },
            compact: { type: Boolean, default: false },
            showLanguage: { type: Boolean, default: true },
            showTheme: { type: Boolean, default: true },
            iconSize: { type: [Number, String], default: 19 },
        },
        emits: ["localeChange", "themeChange"],
        inheritAttrs: true,
    },
);

export const ThemeAndLanguageControls = PgThemeLanguageControls;

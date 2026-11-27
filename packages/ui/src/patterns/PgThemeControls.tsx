import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { setThemeMode, themeMode, type ThemeMode } from "../lib/theme";
import { PgButton } from "../actions/PgButton";
import { PgIcon } from "../actions/PgIcon";
import { PgMenu } from "../overlays/PgMenu";

/** Explicit System / Light / Dark menu used in every portal header. */
export const PgThemeMenu = dc(
    (props: { buttonClass?: string; size?: string; iconSize?: number | string; variant?: string }, _expose, { attrs }) => {
        const { t } = useLocale();
        const open = ref(false);
        const options = computed<Array<{ mode: ThemeMode; icon: string; label: string }>>(() => [
            { mode: "system", icon: "mdi-theme-light-dark", label: t("System") },
            { mode: "light", icon: "mdi-weather-sunny", label: t("Light") },
            { mode: "dark", icon: "mdi-weather-night", label: t("Dark") },
        ]);
        const activeIcon = computed(() =>
            themeMode.value === "system" ? "mdi-theme-light-dark" : themeMode.value === "dark" ? "mdi-weather-night" : "mdi-weather-sunny",
        );
        return () => (
            <PgMenu modelValue={open.value} onUpdate:modelValue={(value: boolean) => (open.value = value)}>
                {{
                    activator: ({ props: activatorProps }: any) => (
                        <PgButton
                            {...activatorProps}
                            {...attrs}
                            icon
                            variant={props.variant ?? "text"}
                            size={props.size ?? "sm"}
                            class={props.buttonClass}
                            ariaLabel={t("Theme")}
                            title={t("Theme")}
                        >
                            <PgIcon icon={activeIcon.value} size={props.iconSize ?? 20} />
                        </PgButton>
                    ),
                    default: () => (
                        <div class="pg-menu-list" role="none">
                            {options.value.map((option) => (
                                <button
                                    key={option.mode}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={themeMode.value === option.mode ? "true" : "false"}
                                    class="pg-menu-item"
                                    onClick={() => {
                                        setThemeMode(option.mode);
                                        open.value = false;
                                    }}
                                >
                                    <PgIcon icon={option.icon} size={17} />
                                    <span>{option.label}</span>
                                    {themeMode.value === option.mode && <PgIcon icon="mdi-check" size={16} class="pg-menu-item__check" />}
                                </button>
                            ))}
                        </div>
                    ),
                }}
            </PgMenu>
        );
    },
    {
        props: {
            buttonClass: { type: String, default: "" },
            size: { type: String, default: "sm" },
            iconSize: { type: [Number, String], default: 20 },
            variant: { type: String, default: "text" },
        },
        inheritAttrs: true,
    },
);

export const ThemeMenu = PgThemeMenu;

/** Language + theme control cluster. */
export const PgThemeLanguageControls = dc(
    (_props, _expose, { attrs }) => {
        const i18n = useI18n({ useScope: "global" });
        const languageOpen = ref(false);
        const current = computed(() => String(i18n.locale.value));
        const choose = (locale: "en" | "ar") => {
            i18n.locale.value = locale;
            if (typeof window !== "undefined") window.localStorage.setItem("locale-name", locale);
            if (typeof document !== "undefined") {
                document.documentElement.setAttribute("lang", locale);
                document.documentElement.setAttribute("dir", locale === "ar" ? "rtl" : "ltr");
            }
            languageOpen.value = false;
        };
        return () => (
            <div {...attrs} class={["pg-theme-language", attrs.class].filter(Boolean).join(" ")}>
                <PgMenu modelValue={languageOpen.value} onUpdate:modelValue={(value: boolean) => (languageOpen.value = value)}>
                    {{
                        activator: ({ props: activatorProps }: any) => (
                            <PgButton {...activatorProps} icon variant="outlined" size="sm" ariaLabel="Language" title="Language">
                                <PgIcon icon="mdi-translate" size={19} />
                            </PgButton>
                        ),
                        default: () => (
                            <div class="pg-menu-list">
                                {[
                                    { code: "en", label: "English", icon: "mdi-alpha-e" },
                                    { code: "ar", label: "العربية", icon: "mdi-alpha-a" },
                                ].map((language) => (
                                    <button
                                        key={language.code}
                                        type="button"
                                        role="menuitemradio"
                                        aria-checked={current.value === language.code ? "true" : "false"}
                                        class="pg-menu-item"
                                        onClick={() => choose(language.code as "en" | "ar")}
                                    >
                                        <PgIcon icon={language.icon} size={17} />
                                        <span>{language.label}</span>
                                        {current.value === language.code && <PgIcon icon="mdi-check" size={16} class="pg-menu-item__check" />}
                                    </button>
                                ))}
                            </div>
                        ),
                    }}
                </PgMenu>
                <PgThemeMenu />
            </div>
        );
    },
    { inheritAttrs: true },
);

export const ThemeAndLanguageControls = PgThemeLanguageControls;

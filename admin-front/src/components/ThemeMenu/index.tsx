import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VIcon, VList, VListItem, VMenu } from "vuetify/components";
import { setThemeMode, themeMode, type ThemeMode } from "@/state/theme";

type ThemeMenuProps = {
    /** Optional class for the activator button (the landing header reuses its own icon button). */
    buttonClass?: string;
    size?: "small" | "default" | "large";
    iconSize?: number | string;
};

/**
 * Explicit theme mode menu: System follows the operating system, Light and Dark
 * pin the theme. It is used in the app headers, the auth/login shell and the
 * public landing header, so every surface can switch all three modes.
 */
const ThemeMenu = dc(
    (props: ThemeMenuProps) => {
        const { t } = useLocale();
        const menu = ref(false);

        const options = computed<Array<{ mode: ThemeMode; icon: string; label: string }>>(() => [
            { mode: "system", icon: "mdi-theme-light-dark", label: t("System") },
            { mode: "light", icon: "mdi-weather-sunny", label: t("Light") },
            { mode: "dark", icon: "mdi-weather-night", label: t("Dark") },
        ]);

        const activeIcon = computed(() => {
            if (themeMode.value === "system") return "mdi-theme-light-dark";
            return themeMode.value === "dark" ? "mdi-weather-night" : "mdi-weather-sunny";
        });

        const choose = (mode: ThemeMode) => {
            setThemeMode(mode);
            menu.value = false;
        };

        return () => (
            <VMenu
                modelValue={menu.value}
                onUpdate:modelValue={(value: boolean) => (menu.value = value)}
                location="bottom end"
                offset={8}
            >
                {{
                    activator: ({ props: activatorProps }: { props: Record<string, unknown> }) => (
                        <VBtn
                            {...activatorProps}
                            icon
                            variant="text"
                            size={props.size ?? "small"}
                            class={props.buttonClass}
                            aria-label={t("Theme")}
                        >
                            <VIcon icon={activeIcon.value} size={props.iconSize} />
                        </VBtn>
                    ),
                    default: () => (
                        <VList density="comfortable" minWidth="180">
                            {options.value.map((option) => (
                                <VListItem
                                    key={option.mode}
                                    title={option.label}
                                    prependIcon={option.icon}
                                    appendIcon={themeMode.value === option.mode ? "mdi-check" : undefined}
                                    onClick={() => choose(option.mode)}
                                />
                            ))}
                        </VList>
                    ),
                }}
            </VMenu>
        );
    },
    { props: ["buttonClass", "size", "iconSize"] },
);

export default ThemeMenu;

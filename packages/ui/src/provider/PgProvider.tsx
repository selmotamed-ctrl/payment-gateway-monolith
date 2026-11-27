import { computed, watch } from "vue";
import { createKeyedFragment } from "@vue/runtime-vapor";
import { ConfigProvider } from "vael-ui/vapor";
import { dc } from "../lib/dc";
import { setLocale, registerLocaleHost, syncDocumentLocale, useLocale } from "../lib/locale";
import { providePgUiConfig, type PgUiConfig } from "../lib/config";
import { initTheme, isThemeMode, resolvedTheme, setThemeMode, useTheme } from "../lib/theme";
import { PgToaster } from "../feedback/PgToast";

/**
 * Single root provider for every portal.
 *
 * It supplies the host API/config services, keeps `<html lang|dir>` and
 * `data-theme` synchronized, bridges the `--pg-*` palette onto vael-ui for the
 * remaining vael-form inputs (strictly bridged, never used by page code) and
 * mounts the one toast stack.
 */
export const PgProvider = dc(
    (props: { config?: PgUiConfig; initialTheme?: "system" | "light" | "dark"; initialLocale?: "en" | "ar" }, _expose, { slots }) => {
        providePgUiConfig(props.config ?? {});
        registerLocaleHost(props.config?.i18n);
        initTheme();
        if (isThemeMode(props.initialTheme)) setThemeMode(props.initialTheme);
        if (props.initialLocale) setLocale(props.initialLocale);
        const { current } = useLocale();
        syncDocumentLocale(String(current.value));
        watch(
            () => String(current.value),
            (next) => syncDocumentLocale(next),
        );
        const theme = useTheme();
        const bridgeTheme = computed(() => {
            const colors = theme.current.value.colors;
            return {
                primary: colors.primary,
                danger: colors.error,
                success: colors.success,
                warning: colors.warning,
                info: colors.info,
                background: colors.background,
                surface: colors.surface,
                radius: "8px",
                fontSize: "13px",
                dark: resolvedTheme.value === "dark",
            };
        });
        return () => (
            <ConfigProvider
                theme={bridgeTheme.value}
                locale={String(current.value)}
                size="md"
                loaderType="ring"
                indicator="glide"
            >
                <PgToaster />
                {/*
                 * Re-key the whole application tree on a locale change. Vapor's
                 * fine-grained slots keep computed label arrays cached, so a
                 * language switch would otherwise leave the navigation, app bar
                 * and pages rendered in the previous language. A keyed fragment
                 * disposes the subtree once and rebuilds it fully translated.
                 */}
                {createKeyedFragment(() => String(current.value), () => slots.default?.())}
            </ConfigProvider>
        );
    },
    {
        props: {
            config: { type: Object as () => PgUiConfig, default: () => ({}) },
            initialTheme: { type: String, default: "" },
            initialLocale: { type: String, default: "" },
        },
        slots: ["default"],
        inheritAttrs: false,
    },
);

export default PgProvider;

import { computed } from "vue";
import { ConfigProvider } from "vael-ui/vapor";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { providePgUiConfig, type PgUiConfig } from "../lib/config";
import { resolvedTheme } from "../lib/theme";
import { PgToaster } from "../feedback/PgToast";

/**
 * Single root provider for every portal. Supplies the host API/config services,
 * maps the 2026 palette onto vael-ui's theme and mounts the one toast stack.
 */
export const PgProvider = dc(
    (props: { config?: PgUiConfig }, _expose, { slots }) => {
        providePgUiConfig(props.config ?? {});
        const { current } = useLocale();
        const theme = computed(() => ({
            primary: resolvedTheme.value === "dark" ? "#f4f4f5" : "#0f172a",
            danger: resolvedTheme.value === "dark" ? "#f87171" : "#dc2626",
            success: resolvedTheme.value === "dark" ? "#4ade80" : "#16a34a",
            warning: resolvedTheme.value === "dark" ? "#fbbf24" : "#d97706",
            info: resolvedTheme.value === "dark" ? "#60a5fa" : "#2563eb",
            radius: "8px",
            fontSize: "13px",
        }));
        return () => (
            <ConfigProvider theme={theme.value} locale={current.value} size="md" loaderType="ring" indicator="glide">
                <PgToaster />
                {slots.default?.()}
            </ConfigProvider>
        );
    },
    {
        props: { config: { type: Object as () => PgUiConfig, default: () => ({}) } },
        slots: ["default"],
    },
);

export default PgProvider;

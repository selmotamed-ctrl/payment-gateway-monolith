import { computed } from "vue";
import { useLocale } from "@/utils/vael-compat";
import {
    ConfigProvider,
    DialogHost,
    PopoverHost,
    Toaster,
    TooltipHost,
} from "vael-ui/vapor";
import { dc } from "@/utils/dc";
import { resolvedTheme } from "@/state/theme";

/**
 * vael-ui root: theme, locale and the four global hosts.
 *
 * `display: contents` on ConfigProvider keeps the existing VApp layout intact
 * while the rest of the application is migrated.
 */
export const VaelProvider = dc(
    (_props, _expose, { slots }) => {
        const { current } = useLocale();
        const theme = computed(() => ({
            primary: resolvedTheme.value === "dark" ? "#f8fafc" : "#0f172a",
            danger: resolvedTheme.value === "dark" ? "#f87171" : "#dc2626",
            radius: "6px",
            fontSize: "13px",
        }));

        return () => (
            <ConfigProvider
                theme={theme.value}
                locale={current.value}
                size="md"
                loaderType="ring"
                indicator="glide"
            >
                <Toaster />
                <TooltipHost />
                <DialogHost />
                <PopoverHost />
                {slots.default?.()}
            </ConfigProvider>
        );
    },
    { slots: ["default"] },
);

export default VaelProvider;

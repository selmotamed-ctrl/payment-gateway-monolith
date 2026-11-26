import { computed } from "vue";
import { useDisplay } from "@/utils/vael-compat";

export const useDefaultPadding = () => {
    const display = useDisplay();
    const padding = computed(() => {
        const mobile = display.mobile.value;
        return mobile ? "12px" : "22px";
    });
    return padding;
};

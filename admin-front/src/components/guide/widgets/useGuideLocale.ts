import { computed } from "vue";
import { useLocale } from "@/utils/vael-compat";

export const useGuideLocale = () => {
    const { current } = useLocale();
    const isArabic = computed(() => current.value === "ar");
    const L = (english: string, arabic: string): string => (isArabic.value ? arabic : english);
    return { isArabic, L };
};

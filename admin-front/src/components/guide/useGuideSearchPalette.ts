import { ref } from "vue";

const open = ref(false);

export const useGuideSearchPalette = () => ({
    searchOpen: open,
    openGuideSearch: () => {
        open.value = true;
    },
    closeGuideSearch: () => {
        open.value = false;
    },
});

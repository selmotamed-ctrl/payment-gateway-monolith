import { ref } from "vue";

const open = ref(false);
const routeName = ref("");

export const useContextHelp = () => ({
    open,
    routeName,
    openContextHelp: (name: string) => {
        routeName.value = name;
        open.value = true;
    },
    closeContextHelp: () => {
        open.value = false;
    },
});

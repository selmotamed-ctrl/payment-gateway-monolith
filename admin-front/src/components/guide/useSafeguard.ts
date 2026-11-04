import { ref } from "vue";

type Resolver = (value: boolean) => void;

const open = ref(false);
const cardId = ref("");
let resolver: Resolver | null = null;

export const openSafeguard = (id: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
        if (resolver) {
            resolver(false);
        }
        resolver = resolve;
        cardId.value = id;
        open.value = true;
    });

export const resolveSafeguard = (value: boolean): void => {
    open.value = false;
    const current = resolver;
    resolver = null;
    current?.(value);
};

export const useSafeguard = (id: string) => ({
    confirm: () => openSafeguard(id),
});

export const useSafeguardState = () => ({
    open,
    cardId,
    resolveSafeguard,
});
